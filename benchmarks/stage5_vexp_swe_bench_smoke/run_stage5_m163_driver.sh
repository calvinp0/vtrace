#!/usr/bin/env bash
# M163-C — sequential three-arm live driver: TOOLS_ONLY vs TOOLS_NEUTRAL_POLICY
# vs TOOLS_TASK_TRIGGER.
#
# WHAT DIFFERS FROM M162's DRIVER, AND WHY
# -----------------------------------------
# M162 varied the ARCHITECTURE (no evidence / static capsule / callable tools)
# and found the callable arm never called anything. M163 holds the callable
# architecture fixed on ALL THREE arms and varies only the policy the agent is
# given about the tools it already has:
#
#   tools_only            --no-suite-policy on the server. Tool schemas, nothing else.
#   tools_neutral_policy  the server serves VTRACE_TOOL_SUITE_POLICY (M162's exact bytes).
#   tools_task_trigger    the above, plus one required initial orientation call
#                         appended to the prompt via VTRACE_TASK_TRIGGER_FILE.
#
# Every arm runs --context-policy force-no-context, so no arm receives a static
# capsule and turn-0 VTRACE evidence is zero by construction on all three. The
# MCP config, tool restriction, allow-list and repo binding are produced by
# `run_stage5_m163_arm_wiring.ts` — the same frozen builder the offline parity
# tests assert against — so the shell cannot drift from the thing under test.
#
# All five historical Stage 5 policy blocks stay disabled on EVERY arm, exactly
# as in M161/M162. STAGE5_TOKEN_DISCIPLINE in particular is OFF: it dictates
# search and edit policy and would confound the evidence-utility question.
#
# Runs are SEQUENTIAL. The first pass writes a SHARED results/_agent_stream.jsonl.
# Never parallelise.
#
# Resumable: an arm is skipped when its result row already exists.
#
# RERUN POLICY (frozen: stage5_m163_rerun_policy.md): retries fire ONLY for
# infrastructure/provider failures matched by ABORT_RE. A bad patch, weak
# evidence, an ignored tool, or a VIOLATED TRIGGER is a RESULT and is never
# rerun — TRIGGER_NOT_COMPLIED is one of the two outcomes the arm exists to
# produce.
#
#   run_stage5_m163_driver.sh treat [N]   # live runs over the frozen 12
#   run_stage5_m163_driver.sh evaluate    # docker grading, all three arms
set -uo pipefail

ROOT="/home/calvin/code/vtrace"
VEXP="/home/calvin/code/vexp-swe-bench"
OUT="$ROOT/benchmarks/stage5_vexp_swe_bench_smoke/results"
RUNNER="$ROOT/benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_vexp_swe_bench_smoke.ts"
WIRING="$ROOT/benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m163_arm_wiring.ts"
MANIFEST="$OUT/stage5_m163_manifest.json"
SCHEDULE="$OUT/stage5_m163_arm_schedule.json"
LEDGER="$OUT/_m163_driver_ledger.jsonl"
LOGDIR="$OUT/_m163_logs"
DATASET="$OUT/_m160_corpus/swe_bench_verified.jsonl"
EXPECTED_TESTBED_PREFIX="/home/calvin/miniforge3/envs/vexp_swebench"
MAX_RETRIES=4
ABORT_RE='rate.?limit|overloaded|quota|insufficient|429|529|Could not authenticate|authentication|ECONNRESET|fetch failed|socket hang up|terminated|ETIMEDOUT|503 |502 '

ARMS=(tools_only tools_neutral_policy tools_task_trigger)

mkdir -p "$LOGDIR"

log() { printf '{"ts":"%s","phase":"%s","instance":"%s","arm":"%s","label":"%s","attempt":%s,"status":"%s"}\n' \
  "$(date -Iseconds)" "$1" "$2" "$3" "$4" "$5" "$6" >> "$LEDGER"; }

label_for() { printf 'm163_%s_%s' "$1" "$(echo "$2" | tr -- '-' '_')"; }

# Every M163 arm runs the vtrace protocol, so every raw row lands under
# raw/vtrace. Checking the wrong directory would report a finished arm as failed
# and spend twice.
raw_dir_for() { printf '%s/runs/%s/raw/vtrace' "$OUT" "$1"; }

already_done() { compgen -G "$(raw_dir_for "$1")/swebench-*.jsonl" > /dev/null 2>&1; }

# One arm of one case. $1 = arm, $2 = instance_id
run_arm() {
  local arm="$1" inst="$2"
  local label; label="$(label_for "$arm" "$inst")"

  if already_done "$label"; then
    echo "  [skip] $arm $inst (already has a result row)"
    log treat "$inst" "$arm" "$label" 0 skip_existing
    return 0
  fi

  # Frozen wiring: MCP config file written here, env assignments returned.
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
    # paid and measured identically on all three, and the MCP server has an index
    # to answer from.
    --context-policy force-no-context
    --capsule-engine v2
    --capsule-intent debug
    # All five historical Stage 5 policy blocks OFF on every arm, passed
    # identically so the parity control is symmetric.
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

# Map the schedule's public arm labels back to the internal ids the wiring uses.
arm_id_for() {
  case "$1" in
    TOOLS_ONLY)           printf 'tools_only' ;;
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

case "${1:-}" in
  treat)    cmd_treat "${2:-99}" ;;
  evaluate) cmd_evaluate ;;
  *) echo "usage: $0 {treat [N]|evaluate}"; exit 2 ;;
esac
