#!/usr/bin/env bash
# M183 — the current-product paired live requalification.
#
#   A  BASELINE             the ordinary coding agent, ordinary tools, nothing else
#   B  VTRACE_ORIENTATION   the same, plus one automatically delivered current
#                           compact orientation packet
#
# THE TWO ARMS RUN THE SAME COMMAND. Byte for byte: same protocol, same flags,
# same budgets, same guards, same dataset. The ONLY difference is one environment
# variable, and its value is a file containing the bytes a real default
# `run_pipeline` reply carries. That is the whole treatment (§10).
#
# WHY NOT M173's WIRING. M173's arm B carried M168's mandate — "call run_pipeline
# FIRST", "ALWAYS FIRST" — plus an MCP tool inventory arm A did not have. §7
# forbids the first and §6 holds the second fixed. So the mandate is gone, the
# MCP config is gone, and what remains is the product's own output.
#
# Runs are SEQUENTIAL. The first pass writes a SHARED results/_agent_stream.jsonl.
# Never parallelise.
#
# Resumable: an arm is skipped when its result row already exists.
#
# SPEND. There is no cap in this file. The cap is read from
# stage5_m183_cost_authorization.json, which exists only once a human has
# authorised one, and the driver refuses to spawn without it. A cap this script
# could raise, or default, would not be a cap.
#
# THE GUARD IS PROTOCOL-AWARE, NOT EXTRAPOLATED (§25). M173's guard projected a
# running average over every remaining arm and stopped the sweep after one
# expensive pair, from a sample of one. This one does no extrapolation at all: the
# external harness enforces a hard $3/instance cost limit, so a pair cannot cost
# more than $6, and the guard starts a pair only when the remaining headroom
# covers that worst case. It therefore stops exactly when the cap can no longer
# guarantee a whole pair — never earlier because one task was dear.
#
# RERUN POLICY (§29): retries fire ONLY for infrastructure failures matched by
# ABORT_RE. A bad patch, an ignored orientation, a wrong focus, a turn-limit stop
# or an unfavourable cost is a RESULT.
#
#   run_stage5_m183_driver.sh orient       # generate every treatment, no spend
#   run_stage5_m183_driver.sh treat [N]    # live runs over the frozen 30
#   run_stage5_m183_driver.sh evaluate     # docker grading, both arms
#   run_stage5_m183_driver.sh spend        # report spend without running anything
set -uo pipefail

ROOT="/home/calvin/code/vtrace"
VEXP="/home/calvin/code/vexp-swe-bench"
OUT="$ROOT/benchmarks/stage5_vexp_swe_bench_smoke/results"
RUNNER="$ROOT/benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_vexp_swe_bench_smoke.ts"
WIRING="$ROOT/benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m183_arm_wiring.ts"
ORIENTER="$ROOT/benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m183_orientation.ts"
PAIR_ORDER="$OUT/stage5_m183_pair_order.json"
AUTHORIZATION="$OUT/stage5_m183_cost_authorization.json"
LEDGER="$OUT/_m183_driver_ledger.jsonl"
PROGRESS="$OUT/stage5_m183_live_progress.jsonl"
LOGDIR="$OUT/_m183_logs"
ORIENTDIR="$OUT/_m183_orientation"
WORKSPACES="$OUT/workspaces/m183_orientation"
EVAL_TMPDIR="$OUT/_m183_eval_tmp"
DATASET="$OUT/_m160_corpus/swe_bench_verified.jsonl"
EXPECTED_TESTBED_PREFIX="/home/calvin/miniforge3/envs/vexp_swebench"
MAX_RETRIES=4
ABORT_RE='rate.?limit|overloaded|quota|insufficient|429|529|Could not authenticate|authentication|ECONNRESET|fetch failed|socket hang up|terminated|ETIMEDOUT|503 |502 '

# The external harness's own per-instance ceiling (vexp-swe-bench/src/cli.ts
# defaults: --cost-limit 3, --max-turns 250). Identical in both arms; §24 says
# preserve it and record it rather than invent a new one.
PER_INSTANCE_COST_LIMIT_USD=3
PAIR_WORST_CASE_USD=6      # 2 x the enforced per-instance ceiling. Not an estimate.

ARMS=(baseline vtrace_orientation)

mkdir -p "$LOGDIR" "$ORIENTDIR"

spend_cap() {
  if [ ! -f "$AUTHORIZATION" ]; then echo "NONE"; return; fi
  python3 -c "
import json
doc=json.load(open('$AUTHORIZATION'))
cap=doc.get('hardCapUsd')
print(cap if isinstance(cap,(int,float)) and cap>0 else 'NONE')
"
}

log() { printf '{"ts":"%s","phase":"%s","instance":"%s","arm":"%s","label":"%s","attempt":%s,"status":"%s"}\n' \
  "$(date -Iseconds)" "$1" "$2" "$3" "$4" "$5" "$6" >> "$LEDGER"; }

label_for() { printf 'm183_%s_%s' "$1" "$(echo "$2" | tr -- '-' '_')"; }
raw_glob_for() { printf '%s/runs/%s/raw/*' "$OUT" "$1"; }
already_done() { compgen -G "$(raw_glob_for "$1")/swebench-*.jsonl" > /dev/null 2>&1; }
already_graded() { compgen -G "$(raw_glob_for "$1")/_eval.meta.json" > /dev/null 2>&1; }

instances() {
  python3 - "$PAIR_ORDER" <<'PY'
import json, sys
for row in json.load(open(sys.argv[1]))["schedule"]:
    print(f"{row['order']}\t{row['instanceId']}\t{','.join(row['armOrder'])}")
PY
}

# Actual spend, read from the result rows themselves rather than from any running
# tally the driver keeps.
spend_so_far() {
  python3 - "$OUT" <<'PY'
import glob, json, os, sys
out = sys.argv[1]
total, runs = 0.0, 0
for path in glob.glob(os.path.join(out, "runs", "m183_*", "raw", "*", "swebench-*.jsonl")):
    for line in open(path):
        line = line.strip()
        if not line:
            continue
        try:
            row = json.loads(line)
        except Exception:
            continue
        cost = row.get("costUsd")
        if isinstance(cost, (int, float)):
            total += float(cost)
            runs += 1
print(f"{total:.4f} {runs}")
PY
}

# Fail closed BEFORE STARTING A TASK, not before each arm.
#
# The granularity is deliberate. A guard evaluated per spawn can stop between a
# task's two arms, and a task with one arm is worse than a task with none: it
# censors the pair, and a censored pair is exactly what the paired comparison
# cannot use. An incomplete BALANCED sweep is the preferred failure.
task_cost_guard() {
  local remaining_tasks="$1"
  local cap spent runs headroom
  cap="$(spend_cap)"
  if [ "$cap" = "NONE" ]; then
    echo "  [STOP ] no authorised cap at $AUTHORIZATION — refusing to spawn a paid agent"
    log spend_guard "-" "-" "-" 0 "no_authorization"
    return 1
  fi
  read -r spent runs <<< "$(spend_so_far)"
  headroom="$(python3 -c "print(f'{float('$cap') - float('$spent'):.4f}')")"
  echo "  [spend] \$$spent over $runs completed arms; headroom \$$headroom of cap \$$cap; $remaining_tasks tasks remain"
  if python3 -c "import sys; sys.exit(0 if float('$headroom') >= float('$PAIR_WORST_CASE_USD') else 1)"; then
    return 0
  fi
  echo "  [STOP ] headroom \$$headroom cannot guarantee one more pair at the enforced worst case \$$PAIR_WORST_CASE_USD"
  log spend_guard "-" "-" "-" 0 "cap_reached:spent=$spent:headroom=$headroom:cap=$cap:remaining_tasks=$remaining_tasks"
  return 1
}

progress() {
  local spent runs
  read -r spent runs <<< "$(spend_so_far)"
  printf '{"ts":"%s","event":"%s","instance":"%s","completedArms":%s,"spentUsd":%s,"remainingPlannedPairs":%s}\n' \
    "$(date -Iseconds)" "$1" "$2" "$runs" "$spent" "$3" >> "$PROGRESS"
}

# ── orientation (no spend) ──────────────────────────────────────────

cmd_orient() {
  local n=0 ok=0 fail=0
  while IFS=$'\t' read -r order inst arms; do
    n=$((n + 1))
    if [ -f "$ORIENTDIR/${inst}.trigger.md" ]; then
      echo "  [skip] $inst (orientation already generated)"
      ok=$((ok + 1)); continue
    fi
    if [ ! -d "$WORKSPACES/$inst/.vtrace" ]; then
      echo "  [FAIL] $inst — no prepared workspace index; run run_stage5_m183_prepare.ts first"
      fail=$((fail + 1)); continue
    fi
    if (cd "$ROOT" && bun "$ORIENTER" "$inst" "$WORKSPACES/$inst" "$ORIENTDIR" \
        >> "$LOGDIR/orient.stdout.log" 2>> "$LOGDIR/orient.stderr.log"); then
      echo "  [ok  ] $inst $(tail -1 "$LOGDIR/orient.stdout.log")"
      ok=$((ok + 1))
    else
      echo "  [FAIL] $inst — orientation generation failed (see $LOGDIR/orient.stderr.log)"
      fail=$((fail + 1))
    fi
  done < <(instances)
  echo "orientation: $ok generated, $fail failed, of $n planned"
  [ "$fail" -eq 0 ]
}

# ── live sweep ──────────────────────────────────────────────────────

run_arm() {
  local arm="$1" inst="$2"
  local label; label="$(label_for "$arm" "$inst")"

  if already_done "$label"; then
    echo "  [skip] $arm $inst (already has a result row)"
    log treat "$inst" "$arm" "$label" 0 skip_existing
    return 0
  fi

  local -a envassign=()
  local wiring_out
  if ! wiring_out="$(cd "$ROOT" && bun "$WIRING" "$arm" "$label" "$inst" 2>"$LOGDIR/${label}.wiring.stderr.log")"; then
    echo "  [FAIL] $arm $inst — could not build arm wiring"
    log treat "$inst" "$arm" "$label" 0 wiring_failed
    return 1
  fi
  while IFS= read -r line; do [ -n "$line" ] && envassign+=("$line"); done <<< "$wiring_out"

  if [ "$arm" != "baseline" ] && [ ${#envassign[@]} -eq 0 ]; then
    echo "  [FAIL] $arm $inst — treatment arm emitted no wiring"
    log treat "$inst" "$arm" "$label" 0 empty_wiring
    return 1
  fi
  if [ "$arm" = "baseline" ] && [ ${#envassign[@]} -ne 0 ]; then
    echo "  [FAIL] $arm $inst — baseline emitted wiring, which would leak the treatment"
    log treat "$inst" "$arm" "$label" 0 baseline_leakage
    return 1
  fi

  # IDENTICAL in both arms. `--protocol baseline` in the treatment arm too: the
  # harness must not build, inject or index anything, because the orientation is
  # already a finished artifact and the harness's own capsule path is a different
  # treatment entirely.
  local common=(
    --mode run-protocol
    --protocol baseline
    --vexp-swe-bench-dir "$VEXP"
    --instances "$inst"
    --run-label "$label"
    --swe-bench-data "$DATASET"
    --vexp-run-data "$DATASET"
    --context-policy force-no-context
    # M183 measures investigation, so no arm may carry the harness's own
    # anti-search nudges. OFF in both arms, as in M168 and M173.
    --disable-token-discipline
    --disable-tool-use-discipline
    --disable-pivot-check
    --disable-edit-guard
    --disable-patch-verify
    --disable-context-instruction
    # M89 mandatory env guard — fails closed before spawn without these.
    --stage5-env-guard
    --stage5-env-drift-check
    --expected-testbed-prefix "$EXPECTED_TESTBED_PREFIX"
    # M90A mandatory agent shell guard / host-pip firewall.
    --stage5-agent-shell-guard
    --stage5-host-pip-firewall
    --out "$OUT"
  )

  local attempt=1
  while (( attempt <= MAX_RETRIES )); do
    echo "  [run ] $arm $inst (attempt $attempt)"
    log treat "$inst" "$arm" "$label" "$attempt" start
    if [ ${#envassign[@]} -eq 0 ]; then
      bun "$RUNNER" "${common[@]}" \
        > "$LOGDIR/${label}.stdout.log" 2> "$LOGDIR/${label}.stderr.log"
    else
      env "${envassign[@]}" bun "$RUNNER" "${common[@]}" \
        > "$LOGDIR/${label}.stdout.log" 2> "$LOGDIR/${label}.stderr.log"
    fi
    if already_done "$label"; then
      log treat "$inst" "$arm" "$label" "$attempt" done
      echo "  [ok  ] $arm $inst"
      return 0
    fi
    if grep -qiE "$ABORT_RE" "$LOGDIR/${label}.stderr.log" 2>/dev/null; then
      log treat "$inst" "$arm" "$label" "$attempt" infra_retry
      echo "  [infra] $arm $inst — provider/infra failure, retrying"
      attempt=$((attempt + 1))
      sleep 30
      continue
    fi
    log treat "$inst" "$arm" "$label" "$attempt" failed
    echo "  [FAIL] $arm $inst — non-infrastructure failure, NOT retried"
    return 1
  done
  log treat "$inst" "$arm" "$label" "$attempt" exhausted
  return 1
}

cmd_treat() {
  local limit="${1:-99}"
  local -a lines=()
  while IFS= read -r line; do lines+=("$line"); done < <(instances)
  local total=${#lines[@]}
  local n=0
  for line in "${lines[@]}"; do
    (( n >= limit )) && break
    IFS=$'\t' read -r order inst arms <<< "$line"
    n=$((n + 1))

    local a_label b_label
    a_label="$(label_for baseline "$inst")"
    b_label="$(label_for vtrace_orientation "$inst")"
    if already_done "$a_label" && already_done "$b_label"; then
      echo "== [$n/$total] $inst — pair already complete, skipping"
      continue
    fi

    # The treatment must exist BEFORE either arm is paid for. Discovering a
    # missing orientation after the baseline has run would leave a censored pair.
    if [ ! -f "$ORIENTDIR/${inst}.trigger.md" ]; then
      echo "== [$n/$total] $inst — NO ORIENTATION; skipping the whole pair rather than censoring it"
      log treat "$inst" "-" "-" 0 missing_orientation
      continue
    fi

    local remaining=0
    for later in "${lines[@]:$((n - 1))}"; do
      local li; li="$(printf '%s' "$later" | cut -f2)"
      if ! already_done "$(label_for baseline "$li")" || ! already_done "$(label_for vtrace_orientation "$li")"; then
        remaining=$((remaining + 1))
      fi
    done

    if ! task_cost_guard "$remaining"; then
      echo "== sweep stopped by the spend guard BEFORE task $n/$total ($inst) — no pair left half-run"
      progress cap_reached "$inst" "$remaining"
      return 2
    fi

    echo "== [$n/$total] $inst  (arm order: $arms)"
    progress pair_start "$inst" "$remaining"
    IFS=',' read -ra armlist <<< "$arms"
    for armlabel in "${armlist[@]}"; do
      run_arm "$armlabel" "$inst"
      # A wiring fault or a baseline that emitted treatment is an APPARATUS
      # defect and stops the sweep. An agent that failed, produced a bad patch or
      # hit its turn limit is a RESULT and does not.
      if grep -q "\"status\":\"\(wiring_failed\|empty_wiring\|baseline_leakage\)\"" \
         <(tail -3 "$LEDGER" 2>/dev/null) 2>/dev/null; then
        echo "== sweep stopped by an APPARATUS defect on $armlabel $inst"
        progress apparatus_defect "$inst" "$remaining"
        return 3
      fi
    done
    progress pair_done "$inst" "$((remaining - 1))"
  done
}

cmd_evaluate() {
  while IFS=$'\t' read -r order inst arms; do
    for arm in "${ARMS[@]}"; do
      local label; label="$(label_for "$arm" "$inst")"
      if ! already_done "$label"; then
        echo "  [skip-eval] $arm $inst (no result row)"; continue
      fi
      if already_graded "$label"; then
        echo "  [skip-eval] $arm $inst (already graded)"; continue
      fi
      echo "  [eval] $arm $inst"
      log evaluate "$inst" "$arm" "$label" 1 start
      # The external harness copies whole repositories into mkdtemp. On the
      # default /tmp — a 32G tmpfs — M173 exhausted the filesystem's INODES
      # mid-sweep while free bytes still looked healthy. Grading is post-hoc and
      # touches nothing the run protocol froze, so it is pointed at disk.
      mkdir -p "$EVAL_TMPDIR"
      TMPDIR="$EVAL_TMPDIR" bun "$RUNNER" --mode evaluate --eval-mode docker \
        --vexp-swe-bench-dir "$VEXP" --run-label "$label" \
        --swe-bench-data "$DATASET" --eval-dataset "$DATASET" --out "$OUT" \
        > "$LOGDIR/${label}.eval.stdout.log" 2> "$LOGDIR/${label}.eval.stderr.log"
      rm -rf "$EVAL_TMPDIR"/vexp-swebench-* /tmp/vexp-swebench-* 2>/dev/null
      log evaluate "$inst" "$arm" "$label" 1 done
    done
  done < <(instances)
}

cmd_spend() {
  local spent runs cap
  read -r spent runs <<< "$(spend_so_far)"
  cap="$(spend_cap)"
  echo "spent \$$spent over $runs completed arms (authorised cap \$$cap, 60 arms planned)"
}

case "${1:-}" in
  orient)   cmd_orient ;;
  treat)    cmd_treat "${2:-99}" ;;
  evaluate) cmd_evaluate ;;
  spend)    cmd_spend ;;
  *) echo "usage: $0 {orient|treat [N]|evaluate|spend}"; exit 2 ;;
esac
