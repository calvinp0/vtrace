#!/usr/bin/env bash
# M164-C — the paired conditional-utility sweep.
#
# Two arms over M162's frozen twelve, holding the callable architecture fixed and
# varying only whether the task prompt carries the required first-action trigger:
#
#   TOOLS_NEUTRAL_POLICY   tools + M162's byte-identical suite policy
#   TOOLS_TASK_TRIGGER     the same, plus the frozen M163 trigger
#
# TOOLS_ONLY is not run: M163 measured 0/12 adoption for it AND for NEUTRAL, so
# it has nothing left to distinguish. NEUTRAL is RERUN rather than compared
# against M163's stored NEUTRAL, because the product generation changed at the
# readiness seam between the two and a cross-generation pairing would confound
# the treatment with time, model and runtime drift.
#
# Arm wiring comes from M163's OWN `run_stage5_m163_arm_wiring.ts` — the same
# frozen builder the offline parity tests assert against, and the same one that
# produced the trigger bytes whose hash M164's protocol recomputed and matched.
# A shell-side copy would be free to drift from the thing under test.
#
# All five historical Stage 5 policy blocks stay disabled on BOTH arms.
# STAGE5_TOKEN_DISCIPLINE in particular is OFF: it dictates search and edit
# policy and would confound the evidence-utility question.
#
# Runs are SEQUENTIAL. The first pass writes a SHARED results/_agent_stream.jsonl.
# Never parallelise.
#
# Resumable: an arm is skipped when its result row already exists.
#
# SPEND. Hard live-agent cap of $22 across the 24 arms, authorized for M164-C.
# The cap is enforced BEFORE each spawn, against actual recorded costUsd plus a
# running-average projection for the arms not yet run. If the projection breaches
# the cap the sweep stops and reports; it never raises it.
#
# RERUN POLICY (frozen: stage5_m164_rerun_policy.md): retries fire ONLY for
# infrastructure failures matched by ABORT_RE. A bad patch, a malformed query the
# agent produced, weak evidence, an ignored trigger, or an unwelcome grade is a
# RESULT and is never rerun.
#
#   run_stage5_m164_driver.sh treat [N]   # live runs over the frozen 12
#   run_stage5_m164_driver.sh evaluate    # docker grading, both arms
#   run_stage5_m164_driver.sh spend       # report spend without running anything
set -uo pipefail

ROOT="/home/calvin/code/vtrace"
VEXP="/home/calvin/code/vexp-swe-bench"
OUT="$ROOT/benchmarks/stage5_vexp_swe_bench_smoke/results"
RUNNER="$ROOT/benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_vexp_swe_bench_smoke.ts"
# M163's wiring builder, reused deliberately: both M164 arms are M163 arms, and
# rebuilding them here would be a second source of truth for the frozen bytes.
WIRING="$ROOT/benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m163_arm_wiring.ts"
MANIFEST="$OUT/stage5_m163_manifest.json"
SCHEDULE="$OUT/stage5_m164_schedule.json"
LEDGER="$OUT/_m164_driver_ledger.jsonl"
LOGDIR="$OUT/_m164_logs"
DATASET="$OUT/_m160_corpus/swe_bench_verified.jsonl"
EXPECTED_TESTBED_PREFIX="/home/calvin/miniforge3/envs/vexp_swebench"
MAX_RETRIES=4
ABORT_RE='rate.?limit|overloaded|quota|insufficient|429|529|Could not authenticate|authentication|ECONNRESET|fetch failed|socket hang up|terminated|ETIMEDOUT|503 |502 '

ARMS=(tools_neutral_policy tools_task_trigger)
SPEND_CAP=22.0
TOTAL_ARMS=24

mkdir -p "$LOGDIR"

log() { printf '{"ts":"%s","phase":"%s","instance":"%s","arm":"%s","label":"%s","attempt":%s,"status":"%s"}\n' \
  "$(date -Iseconds)" "$1" "$2" "$3" "$4" "$5" "$6" >> "$LEDGER"; }

label_for() { printf 'm164_%s_%s' "$1" "$(echo "$2" | tr -- '-' '_')"; }

raw_dir_for() { printf '%s/runs/%s/raw/vtrace' "$OUT" "$1"; }

already_done() { compgen -G "$(raw_dir_for "$1")/swebench-*.jsonl" > /dev/null 2>&1; }

# Actual spend so far, read from the result rows themselves rather than from any
# running tally the driver keeps: a tally that drifts from the artifacts is worse
# than no tally.
spend_so_far() {
  python3 - "$OUT" <<'PY'
import glob, json, os, sys
out = sys.argv[1]
total, runs = 0.0, 0
for path in glob.glob(os.path.join(out, "runs", "m164_*", "raw", "vtrace", "swebench-*.jsonl")):
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
avg = spent / runs if runs else 0.75
print(f'{spent + avg * max(0, total - runs):.4f}')
")"
  echo "  [spend] \$$spent over $runs arms; projected total \$$projected against cap \$$SPEND_CAP"
  python3 -c "
import sys
sys.exit(0 if float('$projected') <= $SPEND_CAP and float('$spent') < $SPEND_CAP else 1)
" && return 0
  echo "  [STOP ] projected spend \$$projected would breach the \$$SPEND_CAP cap — stopping, not raising it"
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

  local -a envassign=()
  local wiring_out
  if ! wiring_out="$(cd "$ROOT" && bun "$WIRING" "$arm" "$label" "$inst" 2>"$LOGDIR/${label}.wiring.stderr.log")"; then
    echo "  [FAIL] $arm $inst — could not build arm wiring"
    log treat "$inst" "$arm" "$label" 0 wiring_failed
    return 1
  fi
  while IFS= read -r line; do [ -n "$line" ] && envassign+=("$line"); done <<< "$wiring_out"

  local common=(
    --mode run-protocol
    --protocol vtrace-indexed
    --vexp-swe-bench-dir "$VEXP"
    --instances "$inst"
    --run-label "$label"
    --swe-bench-data "$DATASET"
    --vexp-run-data "$DATASET"
    --show-vtrace-index-log
    # No arm receives a static capsule. The index is still built, so its cost is
    # paid and measured identically on both, and the MCP server has an index to
    # answer from — which, since 7dc9385a, it may now actually read.
    --context-policy force-no-context
    --capsule-engine v2
    --capsule-intent debug
    --disable-token-discipline
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
    env "${envassign[@]}" bun "$RUNNER" "${common[@]}" \
      > "$LOGDIR/${label}.stdout.log" 2> "$LOGDIR/${label}.stderr.log"
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

arm_id_for() {
  case "$1" in
    TOOLS_NEUTRAL_POLICY) printf 'tools_neutral_policy' ;;
    TOOLS_TASK_TRIGGER)   printf 'tools_task_trigger' ;;
    *) printf '%s' "$1" ;;
  esac
}

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
      echo "  [eval] $arm $inst"
      log evaluate "$inst" "$arm" "$label" 1 start
      bun "$RUNNER" --mode evaluate --eval-mode docker \
        --vexp-swe-bench-dir "$VEXP" --run-label "$label" \
        --swe-bench-data "$DATASET" --eval-dataset "$DATASET" --out "$OUT" \
        > "$LOGDIR/${label}.eval.stdout.log" 2> "$LOGDIR/${label}.eval.stderr.log"
      log evaluate "$inst" "$arm" "$label" 1 done
    done
  done < <(python3 - "$MANIFEST" <<'PY'
import json, sys
for case in json.load(open(sys.argv[1]))["cases"]:
    print(case["instanceId"])
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
