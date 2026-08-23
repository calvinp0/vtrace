#!/usr/bin/env bash
# M173 — the two-arm compact-orientation requalification.
#
#   A  BASELINE         --protocol baseline, no VTRACE anything
#   B  VTRACE_COMPACT   M168's clean-arm mandate, against the M172 compact default
#
# The arms differ by the mandate and the MCP config. B differs from M168's arm C
# in nothing this script controls: what changed is which bytes `run_pipeline`
# returns, and that changed in the product at b173df2d.
#
# The harness's shared anti-loop tool-use-discipline block is DISABLED on both
# arms, exactly as in M168. It names no VTRACE artifact, but it is
# investigation-policy text and this experiment measures investigation.
#
# Arm wiring comes from run_stage5_m173_arm_wiring.ts, the same frozen builder
# the offline tests and the smoke controls assert against.
#
# Runs are SEQUENTIAL. The first pass writes a SHARED results/_agent_stream.jsonl.
# Never parallelise.
#
# Resumable: an arm is skipped when its result row already exists.
#
# SPEND. There is no cap in this file. The cap is read from
# stage5_m173_cost_authorization.json, which exists only once a human has
# authorised one, and the driver refuses to spawn without it. A cap this script
# could raise, or default, would not be a cap.
#
# RERUN POLICY (§61): retries fire ONLY for infrastructure failures matched by
# ABORT_RE. A bad patch, an ignored mandate, a wrong pivot, a turn-limit stop or
# an unfavourable cost is a RESULT.
#
#   run_stage5_m173_driver.sh treat [N]   # live runs over the frozen 12
#   run_stage5_m173_driver.sh evaluate    # docker grading, both arms
#   run_stage5_m173_driver.sh spend       # report spend without running anything
set -uo pipefail

ROOT="/home/calvin/code/vtrace"
VEXP="/home/calvin/code/vexp-swe-bench"
OUT="$ROOT/benchmarks/stage5_vexp_swe_bench_smoke/results"
RUNNER="$ROOT/benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_vexp_swe_bench_smoke.ts"
WIRING="$ROOT/benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m173_arm_wiring.ts"
SCHEDULE="$OUT/stage5_m173_schedule.json"
AUTHORIZATION="$OUT/stage5_m173_cost_authorization.json"
LEDGER="$OUT/_m173_driver_ledger.jsonl"
LOGDIR="$OUT/_m173_logs"
EVAL_TMPDIR="$OUT/_m173_eval_tmp"
DATASET="$OUT/_m160_corpus/swe_bench_verified.jsonl"
EXPECTED_TESTBED_PREFIX="/home/calvin/miniforge3/envs/vexp_swebench"
MAX_RETRIES=4
ABORT_RE='rate.?limit|overloaded|quota|insufficient|429|529|Could not authenticate|authentication|ECONNRESET|fetch failed|socket hang up|terminated|ETIMEDOUT|503 |502 '

ARMS=(baseline vtrace_compact)
TOTAL_ARMS=24

mkdir -p "$LOGDIR"

# The authorised cap, or nothing. Read fresh on every guard evaluation so an
# operator lowering it mid-sweep takes effect; there is no path that raises it.
spend_cap() {
  if [ ! -f "$AUTHORIZATION" ]; then
    echo "NONE"
    return
  fi
  python3 -c "
import json,sys
doc=json.load(open('$AUTHORIZATION'))
cap=doc.get('hardCapUsd')
print(cap if isinstance(cap,(int,float)) and cap>0 else 'NONE')
"
}

log() { printf '{"ts":"%s","phase":"%s","instance":"%s","arm":"%s","label":"%s","attempt":%s,"status":"%s"}\n' \
  "$(date -Iseconds)" "$1" "$2" "$3" "$4" "$5" "$6" >> "$LEDGER"; }

label_for() { printf 'm173_%s_%s' "$1" "$(echo "$2" | tr -- '-' '_')"; }
# The runner files artifacts under raw/<condition>: raw/vtrace for the treatment
# arm, raw/baseline for --protocol baseline. Globbing the condition rather than
# hard-coding it keeps a completed baseline from looking like a failed run.
raw_glob_for() { printf '%s/runs/%s/raw/*' "$OUT" "$1"; }
already_done() { compgen -G "$(raw_glob_for "$1")/swebench-*.jsonl" > /dev/null 2>&1; }
already_graded() { compgen -G "$(raw_glob_for "$1")/_eval.meta.json" > /dev/null 2>&1; }

# Actual spend so far, read from the result rows themselves rather than from any
# running tally the driver keeps.
spend_so_far() {
  python3 - "$OUT" <<'PY'
import glob, json, os, sys
out = sys.argv[1]
total, runs = 0.0, 0
for path in glob.glob(os.path.join(out, "runs", "m173_*", "raw", "*", "swebench-*.jsonl")):
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
#
# Two conditions, both required:
#
#   REMAINDER   the running average projected over every arm still to run must
#               fit inside the cap. This is what stops the sweep early enough to
#               report rather than late enough to truncate.
#   PAIR RESERVE  the headroom must cover one whole pair at the worst pair cost
#               this harness has actually recorded, so a pair that is started
#               cannot finish outside the cap.
#
# Neither condition can raise the cap; the only outcome of failing either is to
# stop and write the pressure report.
PAIR_RESERVE=3.20   # M168's worst observed A+C pair was $2.98; this is that, rounded up.

task_cost_guard() {
  local remaining_tasks="$1"
  local cap spent runs verdict
  cap="$(spend_cap)"
  if [ "$cap" = "NONE" ]; then
    echo "  [STOP ] no authorised cap at $AUTHORIZATION — refusing to spawn a paid agent"
    log spend_guard "-" "-" "-" 0 "no_authorization"
    return 1
  fi
  read -r spent runs <<< "$(spend_so_far)"
  verdict="$(python3 -c "
spent, runs, cap = float('$spent'), int('$runs'), float('$cap')
remaining_tasks, reserve = int('$remaining_tasks'), float('$PAIR_RESERVE')
avg = spent / runs if runs else 0.80
projected = spent + avg * 2 * remaining_tasks
headroom = cap - spent
ok = projected <= cap and headroom >= reserve
print(f\"{'OK' if ok else 'STOP'} {projected:.4f} {headroom:.4f} {avg:.4f}\")
")"
  read -r decision projected headroom avg <<< "$verdict"
  echo "  [spend] \$$spent over $runs arms (avg \$$avg); projecting \$$projected for the remaining $remaining_tasks tasks against cap \$$cap"
  if [ "$decision" = "OK" ]; then return 0; fi
  echo "  [STOP ] projected \$$projected / headroom \$$headroom cannot complete the remaining $remaining_tasks tasks within \$$cap"
  log spend_guard "-" "-" "-" 0 "cap_pressure:spent=$spent:projected=$projected:headroom=$headroom:cap=$cap:remaining_tasks=$remaining_tasks"
  bun "$ROOT/benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m173_cap_pressure.ts" || true
  return 1
}

run_arm() {
  local arm="$1" inst="$2"
  local label; label="$(label_for "$arm" "$inst")"

  if already_done "$label"; then
    echo "  [skip] $arm $inst (already has a result row)"
    log treat "$inst" "$arm" "$label" 0 skip_existing
    return 0
  fi

  # No per-arm spend gate here on purpose: the gate is at task entry, so a pair
  # that has begun always finishes. See task_cost_guard.

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

  local protocol="vtrace-indexed"
  [ "$arm" = "baseline" ] && protocol="baseline"

  local common=(
    --mode run-protocol
    --protocol "$protocol"
    --vexp-swe-bench-dir "$VEXP"
    --instances "$inst"
    --run-label "$label"
    --swe-bench-data "$DATASET"
    --vexp-run-data "$DATASET"
    --show-vtrace-index-log
    # No arm receives a static capsule. B still builds the index, so the MCP
    # server has something to answer from; the mandated call is the only way
    # context reaches the model.
    --context-policy force-no-context
    --capsule-engine v2
    --capsule-intent debug
    # M173 measures investigation, so no arm may carry the harness's own
    # anti-search nudge. OFF in both arms, as in M168.
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
  while IFS= read -r line; do lines+=("$line"); done < <(python3 - "$SCHEDULE" <<'PY'
import json, sys
for row in json.load(open(sys.argv[1]))["schedule"]:
    print(f"{row['order']}\t{row['instanceId']}\t{','.join(row['armOrder'])}")
PY
)
  local total=${#lines[@]}
  local n=0
  for line in "${lines[@]}"; do
    (( n >= limit )) && break
    IFS=$'\t' read -r order inst arms <<< "$line"
    n=$((n + 1))

    # Tasks whose pair is already complete cost nothing and are never gated.
    local a_label b_label
    a_label="$(label_for baseline "$inst")"
    b_label="$(label_for vtrace_compact "$inst")"
    if already_done "$a_label" && already_done "$b_label"; then
      echo "== [$n/$total] $inst — pair already complete, skipping"
      continue
    fi

    # Remaining tasks that still need at least one arm, INCLUDING this one.
    local remaining=0
    for later in "${lines[@]:$((n - 1))}"; do
      local li; li="$(printf '%s' "$later" | cut -f2)"
      if ! already_done "$(label_for baseline "$li")" || ! already_done "$(label_for vtrace_compact "$li")"; then
        remaining=$((remaining + 1))
      fi
    done

    if ! task_cost_guard "$remaining"; then
      echo "== sweep stopped by the spend guard BEFORE task $n/$total ($inst) — no pair left half-run"
      return 2
    fi

    echo "== [$n/$total] $inst  (arm order: $arms)"
    IFS=',' read -ra armlist <<< "$arms"
    for armlabel in "${armlist[@]}"; do
      run_arm "$armlabel" "$inst"
      # A wiring fault or a baseline that emitted treatment is an APPARATUS
      # defect (§59) and stops the sweep. An agent that failed, produced a bad
      # patch or hit its turn limit is a RESULT (§60) and does not: run_arm
      # already declined to retry it, and the run continues.
      if grep -q "\"status\":\"\(wiring_failed\|empty_wiring\|baseline_leakage\)\"" \
         <(tail -3 "$LEDGER" 2>/dev/null) 2>/dev/null; then
        echo "== sweep stopped by an APPARATUS defect on $armlabel $inst"
        return 3
      fi
    done
  done
}

cmd_evaluate() {
  while IFS=$'\t' read -r inst; do
    for arm in "${ARMS[@]}"; do
      local label; label="$(label_for "$arm" "$inst")"
      if ! already_done "$label"; then
        echo "  [skip-eval] $arm $inst (no result row)"
        continue
      fi
      if already_graded "$label"; then
        echo "  [skip-eval] $arm $inst (already graded)"
        continue
      fi
      echo "  [eval] $arm $inst"
      log evaluate "$inst" "$arm" "$label" 1 start
      # The external harness copies whole repositories into mkdtemp. On the
      # default /tmp — a 32G tmpfs — twenty of those exhausted the filesystem's
      # INODES mid-sweep while free bytes still looked healthy, and four runs
      # died with ENOSPC before the agent spawned. Grading is post-hoc and
      # touches nothing the run protocol froze, so it is pointed at disk.
      mkdir -p "$EVAL_TMPDIR"
      TMPDIR="$EVAL_TMPDIR" bun "$RUNNER" --mode evaluate --eval-mode docker \
        --vexp-swe-bench-dir "$VEXP" --run-label "$label" \
        --swe-bench-data "$DATASET" --eval-dataset "$DATASET" --out "$OUT" \
        > "$LOGDIR/${label}.eval.stdout.log" 2> "$LOGDIR/${label}.eval.stderr.log"
      # Sweep the harness's abandoned working directories rather than letting
      # them accumulate across twenty-four gradings.
      rm -rf "$EVAL_TMPDIR"/vexp-swebench-* /tmp/vexp-swebench-* 2>/dev/null
      log evaluate "$inst" "$arm" "$label" 1 done
    done
  done < <(python3 - "$SCHEDULE" <<'PY'
import json, sys
for row in json.load(open(sys.argv[1]))["schedule"]:
    print(row["instanceId"])
PY
)
}

cmd_spend() {
  local spent runs cap
  read -r spent runs <<< "$(spend_so_far)"
  cap="$(spend_cap)"
  echo "spent \$$spent over $runs completed arms (authorised cap \$$cap, $TOTAL_ARMS arms planned)"
}

case "${1:-}" in
  treat)    cmd_treat "${2:-99}" ;;
  evaluate) cmd_evaluate ;;
  spend)    cmd_spend ;;
  *) echo "usage: $0 {treat [N]|evaluate|spend}"; exit 2 ;;
esac
