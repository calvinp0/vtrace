#!/usr/bin/env bash
# M162-D — sequential three-arm live driver: BASELINE vs STATIC vs CALLABLE.
#
# WHAT DIFFERS FROM M161's DRIVER, AND WHY
# -----------------------------------------
# M161 ran two arms. M162 adds a third that receives NO static evidence and
# instead gets the frozen two-tool VTRACE MCP surface, so the comparison
# separates "VTRACE's repository intelligence" from "the static injection
# architecture that delivered it".
#
#   BASELINE  --protocol baseline
#             no index, no capsule, no MCP server.
#
#   STATIC    --protocol vtrace-indexed --context-policy force-inject
#             byte-identical to M161's clean capsule arm.
#
#   CALLABLE  --protocol vtrace-indexed --context-policy force-no-context
#             the SAME indexing path, so the index exists and its build cost is
#             paid and measured, but nothing is injected. The agent instead
#             receives the frozen MCP server via VTRACE_MCP_CONFIG. Zero turn-0
#             VTRACE evidence tokens by construction.
#
# All five historical Stage 5 policy blocks stay disabled on EVERY arm, exactly
# as in M161, so the parity control asserts their absence symmetrically.
#
# The MCP config is written per task BEFORE the run, pointing at the workspace
# path the runner will create for that label. That path is a pure function of
# the label and instance id, so the server is bound to the agent's own worktree
# and cannot answer about a shared clone.
#
# Runs are SEQUENTIAL. The first pass writes a SHARED results/_agent_stream.jsonl,
# and M155/M156 already learned what saturating this machine does to
# measurements. Never parallelise.
#
# Resumable: an arm is skipped when its result row already exists.
#
# RERUN POLICY (frozen: stage5_m162_protocol.json): retries fire ONLY for
# infrastructure/provider failures matched by ABORT_RE. A bad patch, an ignored
# tool, a poor context, or an unlucky baseline is a RESULT and is never rerun.
#
#   run_stage5_m162_pilot_driver.sh treat [N]   # live runs over the frozen 12
#   run_stage5_m162_pilot_driver.sh evaluate    # docker grading, all three arms
set -uo pipefail

ROOT="/home/calvin/code/vtrace"
VEXP="/home/calvin/code/vexp-swe-bench"
OUT="$ROOT/benchmarks/stage5_vexp_swe_bench_smoke/results"
RUNNER="$ROOT/benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_vexp_swe_bench_smoke.ts"
MANIFEST="$OUT/stage5_m162_pilot_manifest.json"
SCHEDULE="$OUT/stage5_m162_arm_schedule.json"
LEDGER="$OUT/_m162_pilot_ledger.jsonl"
LOGDIR="$OUT/_m162_pilot_logs"
MCPDIR="$OUT/_m162_mcp_configs"
DATASET="$OUT/_m160_corpus/swe_bench_verified.jsonl"
EXPECTED_TESTBED_PREFIX="/home/calvin/miniforge3/envs/vexp_swebench"
CLI_ENTRY="$ROOT/src/cli/index.ts"
MAX_RETRIES=4
ABORT_RE='rate.?limit|overloaded|quota|insufficient|429|529|Could not authenticate|authentication|ECONNRESET|fetch failed|socket hang up|terminated|ETIMEDOUT|503 |502 '

mkdir -p "$LOGDIR" "$MCPDIR"

log() { printf '{"ts":"%s","phase":"%s","instance":"%s","arm":"%s","label":"%s","attempt":%s,"status":"%s"}\n' \
  "$(date -Iseconds)" "$1" "$2" "$3" "$4" "$5" "$6" >> "$LEDGER"; }

label_for() { printf 'm162_%s_%s' "$1" "$(echo "$2" | tr -- '-' '_')"; }

# The runner writes baseline rows under raw/baseline and both VTRACE-protocol
# arms under raw/vtrace. Checking the wrong directory would report a finished
# arm as failed and rerun it, spending twice and breaking the frozen policy.
raw_dir_for() {
  case "$1" in
    baseline) printf '%s/runs/%s/raw/baseline' "$OUT" "$2" ;;
    *)        printf '%s/runs/%s/raw/vtrace'   "$OUT" "$2" ;;
  esac
}

already_done() {
  compgen -G "$(raw_dir_for "$1" "$2")/swebench-*.jsonl" > /dev/null 2>&1
}

# The workspace the runner will create for this label. A pure function of the
# label and instance id, so the MCP config can be written before the run and
# still bind to the agent's own worktree.
workspace_for() { printf '%s/workspaces/%s/%s' "$OUT" "$1" "$2"; }

write_mcp_config() {
  local label="$1" inst="$2" ws
  ws="$(workspace_for "$label" "$inst")"
  python3 - "$MCPDIR/${label}.json" "$CLI_ENTRY" "$ws" <<'PY'
import json, sys
out, cli, ws = sys.argv[1], sys.argv[2], sys.argv[3]
json.dump({"mcpServers": {"vtrace": {"command": "bun", "args": [
    cli, "mcp-serve", "--repo", ws, "--tools", "get_code_context,get_impact_graph",
]}}}, open(out, "w"))
PY
  printf '%s' "$MCPDIR/${label}.json"
}

# One arm of one case. $1 = baseline|static|callable, $2 = instance_id
run_arm() {
  local arm="$1" inst="$2"
  local label; label="$(label_for "$arm" "$inst")"

  if already_done "$arm" "$label"; then
    echo "  [skip] $arm $inst (already has a result row)"
    log treat "$inst" "$arm" "$label" 0 skip_existing
    return 0
  fi

  local common=(
    --mode run-protocol
    --vexp-swe-bench-dir "$VEXP"
    --instances "$inst"
    --run-label "$label"
    --swe-bench-data "$DATASET"
    --vexp-run-data "$DATASET"
    # All five historical Stage 5 policy blocks stay OFF on every arm (M161's
    # clean distinction). Passed identically so parity is symmetric.
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

  local treatment=()
  local -a envassign=()
  case "$arm" in
    baseline)
      treatment=(--protocol baseline)
      ;;
    static)
      # Byte-identical to M161's VTRACE arm.
      treatment=(
        --protocol vtrace-indexed
        --show-vtrace-index-log
        --context-policy force-inject
        --capsule-engine v2
        --capsule-intent debug
        --capsule-budget 8000
        --inject-capsule-digest
        --digest-decision-contract
        --bounded-digest-decisions
        --compact-digest-injection
        --pivot-confidence-gate
      )
      ;;
    callable)
      # Same indexing path so the index exists and its cost is measured, but
      # nothing injected. The tools arrive through the MCP config instead.
      local cfg; cfg="$(write_mcp_config "$label" "$inst")"
      treatment=(
        --protocol vtrace-indexed
        --show-vtrace-index-log
        --context-policy force-no-context
        --capsule-engine v2
        --capsule-intent debug
      )
      envassign=(
        "VTRACE_MCP_CONFIG=$cfg"
        "VTRACE_MCP_ALLOWED_TOOLS=mcp__vtrace__get_code_context,mcp__vtrace__get_impact_graph"
      )
      ;;
  esac

  local attempt=1
  while (( attempt <= MAX_RETRIES )); do
    echo "  [run ] $arm $inst (attempt $attempt)"
    log treat "$inst" "$arm" "$label" "$attempt" start
    env "${envassign[@]}" bun "$RUNNER" "${common[@]}" "${treatment[@]}" \
      > "$LOGDIR/${label}.stdout.log" 2> "$LOGDIR/${label}.stderr.log"
    if already_done "$arm" "$label"; then
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
  local n=0
  while IFS=$'\t' read -r order inst arms; do
    (( n >= limit )) && break
    n=$((n + 1))
    echo "== [$n] $inst  (arm order: $arms)"
    IFS=',' read -ra armlist <<< "$arms"
    for arm in "${armlist[@]}"; do
      run_arm "$arm" "$inst"
    done
  done < <(python3 - "$SCHEDULE" <<'PY'
import json, sys
sched = json.load(open(sys.argv[1]))["schedule"]
for row in sched:
    print(f"{row['order']}\t{row['instanceId']}\t{','.join(row['armOrder'])}")
PY
)
}

cmd_evaluate() {
  while IFS=$'\t' read -r inst; do
    for arm in baseline static callable; do
      local label; label="$(label_for "$arm" "$inst")"
      if ! already_done "$arm" "$label"; then
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
