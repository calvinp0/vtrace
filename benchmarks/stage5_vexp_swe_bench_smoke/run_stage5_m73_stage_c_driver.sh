#!/usr/bin/env bash
# M73 — Stage C fresh-baseline driver.
#
# Runs the established Stage 5 BASELINE condition (`--protocol baseline`, no VTRACE context /
# capsule / digest / contract / gate) over the 73 fresh-required instances from
# stage5_m73_stage_c_fixture.json, SEQUENTIALLY (the runner writes a shared
# results/_agent_stream.jsonl that concurrent runs would clobber), then runs a separate Docker
# --mode evaluate per label.
#
# Baseline artifacts are captured under runs/<label>/raw/baseline/ (NOT raw/vtrace/).
#
# Resumable: a baseline run is skipped if its raw/baseline/swebench-*.jsonl already exists;
# a Docker eval is skipped if raw/baseline/_eval.meta.json already exists.
#
# Hard cap: 73 baseline live runs. NO treatment. NO corrective/revision/oracle arms.
# Operational retries (transient infra / provider quota aborts before a usable artifact) are
# handled by simply re-running this script — completed instances are skipped, aborted ones retry.
#
# Usage:
#   run_stage5_m73_stage_c_driver.sh treat    # phase 1: sequential baseline runs
#   run_stage5_m73_stage_c_driver.sh evaluate # phase 2: sequential docker evals
set -uo pipefail

ROOT="/home/calvin/code/vtrace"
VEXP="/home/calvin/code/vexp-swe-bench"
OUT="$ROOT/benchmarks/stage5_vexp_swe_bench_smoke/results"
RUNNER="$ROOT/benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_vexp_swe_bench_smoke.ts"
FIXTURE="$OUT/stage5_m73_stage_c_fixture.json"
LEDGER="$OUT/_m73_stage_c_driver_ledger.jsonl"   # untracked operational ledger
DATASET="$VEXP/data/swe-bench-100.jsonl"

cd "$ROOT" || exit 2
mode="${1:-treat}"

# instance_id<TAB>run_label, in fixture order
mapfile -t LINES < <(python3 -c "
import json
d=json.load(open('$FIXTURE'))
for i in d['instances']:
    print(i['instance_id']+'\t'+i['run_label'])
")

stamp() { date -u +%Y-%m-%dT%H:%M:%SZ; }

# baseline artifacts land in raw/baseline/
result_file() { # run_label -> path of baseline swebench jsonl if present
  ls "$OUT/runs/$1/raw/baseline/"swebench-*.jsonl 2>/dev/null | head -1
}

if [[ "$mode" == "treat" ]]; then
  n=0; total=${#LINES[@]}
  for line in "${LINES[@]}"; do
    inst="${line%%$'\t'*}"; label="${line##*$'\t'}"
    n=$((n+1))
    if [[ -n "$(result_file "$label")" ]]; then
      echo "[$n/$total] SKIP (already has result): $inst"
      echo "{\"ts\":\"$(stamp)\",\"phase\":\"treat\",\"i\":$n,\"instance\":\"$inst\",\"label\":\"$label\",\"status\":\"skip_existing\"}" >> "$LEDGER"
      continue
    fi
    echo "[$n/$total] RUN baseline: $inst -> $label  ($(stamp))"
    echo "{\"ts\":\"$(stamp)\",\"phase\":\"treat\",\"i\":$n,\"instance\":\"$inst\",\"label\":\"$label\",\"status\":\"start\"}" >> "$LEDGER"
    bun "$RUNNER" \
      --mode run-protocol \
      --protocol baseline \
      --vexp-swe-bench-dir "$VEXP" \
      --instances "$inst" \
      --run-label "$label" \
      --out "$OUT" \
      > "$OUT/runs/_m73_${label}.stdout.log" 2> "$OUT/runs/_m73_${label}.stderr.log"
    rc=$?
    patch="no"; [[ -n "$(result_file "$label")" ]] && patch="yes"
    echo "[$n/$total] DONE rc=$rc result_present=$patch: $inst"
    echo "{\"ts\":\"$(stamp)\",\"phase\":\"treat\",\"i\":$n,\"instance\":\"$inst\",\"label\":\"$label\",\"status\":\"done\",\"rc\":$rc,\"result_present\":\"$patch\"}" >> "$LEDGER"
  done
  echo "BASELINE TREATMENT PHASE COMPLETE ($(stamp))"

elif [[ "$mode" == "evaluate" ]]; then
  n=0; total=${#LINES[@]}
  for line in "${LINES[@]}"; do
    inst="${line%%$'\t'*}"; label="${line##*$'\t'}"
    n=$((n+1))
    rf="$(result_file "$label")"
    if [[ -z "$rf" ]]; then
      echo "[$n/$total] NO RESULT, skip eval: $inst"
      echo "{\"ts\":\"$(stamp)\",\"phase\":\"eval\",\"i\":$n,\"instance\":\"$inst\",\"label\":\"$label\",\"status\":\"no_result\"}" >> "$LEDGER"
      continue
    fi
    if [[ -f "$OUT/runs/$label/raw/baseline/_eval.meta.json" ]]; then
      echo "[$n/$total] SKIP eval (already evaluated): $inst"
      echo "{\"ts\":\"$(stamp)\",\"phase\":\"eval\",\"i\":$n,\"instance\":\"$inst\",\"label\":\"$label\",\"status\":\"skip_existing\"}" >> "$LEDGER"
      continue
    fi
    echo "[$n/$total] EVAL: $inst -> $label  ($(stamp))"
    echo "{\"ts\":\"$(stamp)\",\"phase\":\"eval\",\"i\":$n,\"instance\":\"$inst\",\"label\":\"$label\",\"status\":\"start\"}" >> "$LEDGER"
    bun "$RUNNER" \
      --mode evaluate \
      --eval-mode docker \
      --vexp-swe-bench-dir "$VEXP" \
      --run-label "$label" \
      --eval-dataset "$DATASET" \
      --out "$OUT" \
      > "$OUT/runs/_m73_eval_${label}.stdout.log" 2> "$OUT/runs/_m73_eval_${label}.stderr.log"
    rc=$?
    echo "[$n/$total] EVAL DONE rc=$rc: $inst"
    echo "{\"ts\":\"$(stamp)\",\"phase\":\"eval\",\"i\":$n,\"instance\":\"$inst\",\"label\":\"$label\",\"status\":\"done\",\"rc\":$rc}" >> "$LEDGER"
  done
  echo "EVAL PHASE COMPLETE ($(stamp))"
else
  echo "unknown mode: $mode (use treat|evaluate)"; exit 2
fi
