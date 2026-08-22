#!/usr/bin/env bash
# M168-E — the three-arm VTRACE policy ablation.
#
#   A  BASELINE        --protocol baseline, no VTRACE anything
#   B  VTRACE_STRICT   mandate + VEXP prohibition text + Grep|Glob denial hook
#   C  VTRACE_CLEAN    mandate only
#
# B and C share the frozen commit, MCP config, tool inventory, allowed tools and
# prompt channel; they differ by 191 characters of prohibition and one hook.
#
# The harness's shared anti-loop tool-use-discipline block is DISABLED on all
# three arms. It names no VTRACE artifact, but it is investigation-policy text
# ("prefer one focused search", "do not run long grep/find loops") and this
# experiment manipulates investigation policy — leaving it on would measure the
# increment over an existing nudge rather than the effect itself.
# A carries none of it and, being --protocol baseline, builds no index either —
# an asymmetry in local CPU work, not in model cost.
#
# Arm wiring comes from run_stage5_m168_arm_wiring.ts, the same frozen builder
# the offline tests and the smoke controls assert against. A shell-side copy
# would be free to drift from the thing under test.
#
# Runs are SEQUENTIAL. The first pass writes a SHARED results/_agent_stream.jsonl.
# Never parallelise.
#
# Resumable: an arm is skipped when its result row already exists.
#
# SPEND. Hard live-agent cap of $60 across the 36 arms, authorized for M168-E.
# Enforced BEFORE each spawn against actual recorded costUsd plus a running
# average projection for the arms not yet run. If the projection breaches the
# cap the sweep stops and reports; it never raises it.
#
# RERUN POLICY (frozen: stage5_m168_rerun_policy.md): retries fire ONLY for
# infrastructure failures matched by ABORT_RE. A bad patch, an ignored mandate,
# a blocked-search spiral, a turn-limit stop or an unwelcome grade is a RESULT.
#
#   run_stage5_m168_driver.sh treat [N]   # live runs over the frozen 12
#   run_stage5_m168_driver.sh evaluate    # docker grading, all three arms
#   run_stage5_m168_driver.sh spend       # report spend without running anything
set -uo pipefail

ROOT="/home/calvin/code/vtrace"
VEXP="/home/calvin/code/vexp-swe-bench"
OUT="$ROOT/benchmarks/stage5_vexp_swe_bench_smoke/results"
RUNNER="$ROOT/benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_vexp_swe_bench_smoke.ts"
WIRING="$ROOT/benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m168_arm_wiring.ts"
SCHEDULE="$OUT/stage5_m168_arm_schedule.json"
LEDGER="$OUT/_m168_driver_ledger.jsonl"
LOGDIR="$OUT/_m168_logs"
DATASET="$OUT/_m160_corpus/swe_bench_verified.jsonl"
EXPECTED_TESTBED_PREFIX="/home/calvin/miniforge3/envs/vexp_swebench"
MAX_RETRIES=4
ABORT_RE='rate.?limit|overloaded|quota|insufficient|429|529|Could not authenticate|authentication|ECONNRESET|fetch failed|socket hang up|terminated|ETIMEDOUT|503 |502 '

ARMS=(baseline vtrace_strict vtrace_clean)
SPEND_CAP=60.0
TOTAL_ARMS=36

mkdir -p "$LOGDIR"

log() { printf '{"ts":"%s","phase":"%s","instance":"%s","arm":"%s","label":"%s","attempt":%s,"status":"%s"}\n' \
  "$(date -Iseconds)" "$1" "$2" "$3" "$4" "$5" "$6" >> "$LEDGER"; }

label_for() { printf 'm168_%s_%s' "$1" "$(echo "$2" | tr -- '-' '_')"; }
# The runner files artifacts under raw/<condition>: raw/vtrace for the treatment
# arms, raw/baseline for --protocol baseline. Globbing the condition rather than
# hard-coding it keeps a completed baseline from looking like a failed run — which
# would otherwise burn three retries per baseline task.
raw_glob_for() { printf '%s/runs/%s/raw/*' "$OUT" "$1"; }
already_done() { compgen -G "$(raw_glob_for "$1")/swebench-*.jsonl" > /dev/null 2>&1; }
already_graded() { compgen -G "$(raw_glob_for "$1")/_eval.meta.json" > /dev/null 2>&1; }

# Actual spend so far, read from the result rows themselves rather than from any
# running tally the driver keeps: a tally that drifts from the artifacts is
# worse than no tally.
spend_so_far() {
  python3 - "$OUT" <<'PY'
import glob, json, os, sys
out = sys.argv[1]
total, runs = 0.0, 0
for path in glob.glob(os.path.join(out, "runs", "m168_*", "raw", "*", "swebench-*.jsonl")):
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

# Fail closed BEFORE spawning: if the projected total at the current running
# average would breach the cap, stop rather than discover it afterwards.
cost_guard() {
  local spent runs projected
  read -r spent runs <<< "$(spend_so_far)"
  projected="$(python3 -c "
spent, runs, total, cap = float('$spent'), int('$runs'), $TOTAL_ARMS, $SPEND_CAP
avg = spent / runs if runs else 0.80
print(f'{spent + avg * max(0, total - runs):.4f}')
")"
  echo "  [spend] \$$spent over $runs arms; projected total \$$projected against cap \$$SPEND_CAP"
  python3 -c "
import sys
sys.exit(0 if float('$projected') <= $SPEND_CAP and float('$spent') < $SPEND_CAP else 1)
" && return 0
  echo "  [STOP ] projected \$$projected would breach the \$$SPEND_CAP cap — stopping, not raising it"
  log spend_guard "-" "-" "-" 0 "cap_would_breach:spent=$spent:projected=$projected"
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

  cost_guard || return 2

  # Arm wiring. The baseline legitimately emits nothing; anything else failing
  # to emit is a wiring fault and stops that arm rather than running it blind.
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
    # No arm receives a static capsule. B and C still build the index, so the
    # MCP server has something to answer from and the local cost is paid
    # identically on both; the mandated call is the only way context reaches
    # the model.
    --context-policy force-no-context
    --capsule-engine v2
    --capsule-intent debug
    # M168 manipulates investigation policy, so no arm may carry the harness's
    # own anti-search nudge: the shared tool-use-discipline block is policy text
    # of exactly the kind under test. OFF in all three arms, asserted after the
    # fact by run_stage5_m168_prompt_parity.ts rather than trusted.
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

arm_id_for() { printf '%s' "$(echo "$1" | tr '[:upper:]' '[:lower:]')"; }

cmd_treat() {
  local limit="${1:-99}"
  local n=0
  while IFS=$'\t' read -r order inst arms; do
    (( n >= limit )) && break
    n=$((n + 1))
    echo "== [$n] $inst  (arm order: $arms)"
    IFS=',' read -ra armlist <<< "$arms"
    for armlabel in "${armlist[@]}"; do
      run_arm "$(arm_id_for "$armlabel")" "$inst"
      local status=$?
      if (( status == 2 )); then
        echo "== sweep stopped by the spend guard"
        return 2
      fi
    done
  done < <(python3 - "$SCHEDULE" <<'PY'
import json, sys
for row in json.load(open(sys.argv[1]))["schedule"]:
    print(f"{row['order']}\t{row['instanceId']}\t{','.join(row['armOrder'])}")
PY
)
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
      bun "$RUNNER" --mode evaluate --eval-mode docker \
        --vexp-swe-bench-dir "$VEXP" --run-label "$label" \
        --swe-bench-data "$DATASET" --eval-dataset "$DATASET" --out "$OUT" \
        > "$LOGDIR/${label}.eval.stdout.log" 2> "$LOGDIR/${label}.eval.stderr.log"
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
  local spent runs
  read -r spent runs <<< "$(spend_so_far)"
  echo "spent \$$spent over $runs completed arms (cap \$$SPEND_CAP, $TOTAL_ARMS arms planned)"
}

case "${1:-}" in
  treat)    cmd_treat "${2:-99}" ;;
  evaluate) cmd_evaluate ;;
  spend)    cmd_spend ;;
  *) echo "usage: $0 {treat [N]|evaluate|spend}"; exit 2 ;;
esac
