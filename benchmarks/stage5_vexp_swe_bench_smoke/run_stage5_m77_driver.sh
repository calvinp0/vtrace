#!/usr/bin/env bash
# M77 — sequential live driver for the tool-loop-guard INJECT-mode validation slice.
# Treatment = exact M73 structured-bounded + pivot-confidence flags PLUS --tool-loop-guard-mode inject.
# Runs are SEQUENTIAL (the first pass writes a SHARED results/_agent_stream.jsonl; concurrent live
# runs clobber it). Resumable: a treatment run is skipped if its swebench-*.jsonl already exists.
#
# Operational retry policy: if a launch fails (rc!=0) AND produces NO result file AND the stderr
# shows a provider/infra abort signature, retry the SAME instance under a SEPARATE `_retryN` label
# (recorded separately, not a replacement, not a variance replicate). Global cap: 4 retry launches.
#
#   run_stage5_m77_driver.sh treat      # phase 1: sequential live treatment runs
#   run_stage5_m77_driver.sh evaluate   # phase 2: sequential docker evals of produced patches
set -uo pipefail

ROOT="/home/calvin/code/vtrace"
VEXP="/home/calvin/code/vexp-swe-bench"
OUT="$ROOT/benchmarks/stage5_vexp_swe_bench_smoke/results"
RUNNER="$ROOT/benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_vexp_swe_bench_smoke.ts"
SPLIT="$OUT/stage5_m77_tool_loop_guard_live_split.json"
LEDGER="$OUT/_m77_driver_ledger.jsonl"            # untracked operational ledger
LOGDIR="$OUT/_m77_logs"
DATASET="$VEXP/data/swe-bench-100.jsonl"
MAX_RETRIES=4
ABORT_RE='rate.?limit|overloaded|quota|insufficient|429|529|Could not authenticate|authentication|ECONNRESET|fetch failed|socket hang up|terminated|ETIMEDOUT|503 |502 '

mkdir -p "$LOGDIR"
cd "$ROOT" || exit 2
mode="${1:-treat}"

# instance_id<TAB>group, in split (group A,B,C,D) order
mapfile -t LINES < <(python3 -c "
import json
d=json.load(open('$SPLIT'))
for c in d['cases']:
    print(c['instance_id']+'\t'+c['validation_group'])
")

stamp() { date -u +%Y-%m-%dT%H:%M:%SZ; }
safe() { echo "$1" | tr -c 'a-zA-Z0-9' '_'; }
result_file() { ls "$OUT/runs/$1/raw/vtrace/"swebench-*.jsonl 2>/dev/null | head -1; }
ran_meta() { [[ -f "$OUT/runs/$1/raw/vtrace/_run.meta.json" ]]; }

run_treatment() { # instance, label  -> rc
  local inst="$1" label="$2"
  bun "$RUNNER" \
    --mode run-protocol \
    --protocol vtrace-indexed \
    --vexp-swe-bench-dir "$VEXP" \
    --instances "$inst" \
    --run-label "$label" \
    --show-vtrace-index-log \
    --context-policy force-inject \
    --capsule-engine v2 \
    --capsule-intent debug \
    --capsule-budget 8000 \
    --inject-capsule-digest \
    --digest-decision-contract \
    --bounded-digest-decisions \
    --compact-digest-injection \
    --pivot-confidence-gate \
    --tool-loop-guard-mode inject \
    --out "$OUT" \
    > "$LOGDIR/${label}.stdout.log" 2> "$LOGDIR/${label}.stderr.log"
  return $?
}

if [[ "$mode" == "treat" ]]; then
  n=0; total=${#LINES[@]}; retries_used=0
  for line in "${LINES[@]}"; do
    inst="${line%%$'\t'*}"; grp="${line##*$'\t'}"
    n=$((n+1))
    base="m77_tool_loop_guard_inject_$(safe "$inst")"
    if [[ -n "$(result_file "$base")" ]]; then
      echo "[$n/$total] SKIP (already has result): $inst"
      continue
    fi
    label="$base"; attempt=0
    while : ; do
      echo "[$n/$total] grp=$grp RUN ($label) attempt=$attempt: $inst  ($(stamp))"
      echo "{\"ts\":\"$(stamp)\",\"phase\":\"treat\",\"i\":$n,\"instance\":\"$inst\",\"group\":\"$grp\",\"label\":\"$label\",\"attempt\":$attempt,\"status\":\"start\"}" >> "$LEDGER"
      run_treatment "$inst" "$label"; rc=$?
      rf="$(result_file "$label")"
      if [[ -n "$rf" ]]; then
        echo "[$n/$total] DONE rc=$rc result_present=yes label=$label: $inst"
        echo "{\"ts\":\"$(stamp)\",\"phase\":\"treat\",\"i\":$n,\"instance\":\"$inst\",\"group\":\"$grp\",\"label\":\"$label\",\"attempt\":$attempt,\"status\":\"done\",\"rc\":$rc,\"result_present\":\"yes\"}" >> "$LEDGER"
        break
      fi
      # No result file. Decide: provider/infra abort (retry) vs ran-but-no-patch (accept, classify later).
      aborted="no"
      if ! ran_meta "$label" && grep -qiE "$ABORT_RE" "$LOGDIR/${label}.stderr.log" 2>/dev/null; then aborted="yes"; fi
      if [[ "$aborted" == "yes" && $retries_used -lt $MAX_RETRIES ]]; then
        retries_used=$((retries_used+1)); attempt=$((attempt+1))
        label="${base}_retry${attempt}"
        echo "[$n/$total] ABORT (provider/infra) rc=$rc -> operational retry ${attempt} (global ${retries_used}/${MAX_RETRIES}): $inst"
        echo "{\"ts\":\"$(stamp)\",\"phase\":\"treat\",\"i\":$n,\"instance\":\"$inst\",\"group\":\"$grp\",\"label\":\"$label\",\"attempt\":$attempt,\"status\":\"operational_abort_retry\",\"rc\":$rc,\"global_retries_used\":$retries_used}" >> "$LEDGER"
        continue
      fi
      # Not retried: either ran-but-no-patch, or retry budget exhausted.
      echo "[$n/$total] DONE rc=$rc result_present=no aborted=$aborted label=$label: $inst"
      echo "{\"ts\":\"$(stamp)\",\"phase\":\"treat\",\"i\":$n,\"instance\":\"$inst\",\"group\":\"$grp\",\"label\":\"$label\",\"attempt\":$attempt,\"status\":\"done\",\"rc\":$rc,\"result_present\":\"no\",\"aborted\":\"$aborted\"}" >> "$LEDGER"
      break
    done
  done
  echo "TREATMENT PHASE COMPLETE ($(stamp)); operational_retries_used=$retries_used"

elif [[ "$mode" == "evaluate" ]]; then
  n=0; total=${#LINES[@]}
  for line in "${LINES[@]}"; do
    inst="${line%%$'\t'*}"; grp="${line##*$'\t'}"
    n=$((n+1))
    # Evaluate every label that produced a result for this instance (base + any retry).
    for label in "m77_tool_loop_guard_inject_$(safe "$inst")" "m77_tool_loop_guard_inject_$(safe "$inst")"_retry{1,2,3,4}; do
      rf="$(result_file "$label")"; [[ -z "$rf" ]] && continue
      if [[ -f "$OUT/runs/$label/raw/vtrace/_eval.meta.json" ]]; then
        echo "[$n/$total] EVAL SKIP (already evaluated): $label"; continue
      fi
      echo "[$n/$total] grp=$grp EVAL ($label): $inst  ($(stamp))"
      echo "{\"ts\":\"$(stamp)\",\"phase\":\"eval\",\"i\":$n,\"instance\":\"$inst\",\"label\":\"$label\",\"status\":\"start\"}" >> "$LEDGER"
      bun "$RUNNER" \
        --mode evaluate --eval-mode docker \
        --vexp-swe-bench-dir "$VEXP" \
        --eval-dataset "$DATASET" \
        --run-label "$label" \
        --out "$OUT" \
        > "$LOGDIR/eval_${label}.stdout.log" 2> "$LOGDIR/eval_${label}.stderr.log"
      rc=$?
      echo "[$n/$total] EVAL DONE rc=$rc: $label"
      echo "{\"ts\":\"$(stamp)\",\"phase\":\"eval\",\"i\":$n,\"instance\":\"$inst\",\"label\":\"$label\",\"status\":\"done\",\"rc\":$rc}" >> "$LEDGER"
    done
  done
  echo "EVAL PHASE COMPLETE ($(stamp))"
else
  echo "usage: $0 treat|evaluate" >&2; exit 2
fi
