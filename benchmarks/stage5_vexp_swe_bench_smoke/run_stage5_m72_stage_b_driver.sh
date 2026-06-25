#!/usr/bin/env bash
# M72 — Stage B 50-treatment driver (remaining 50 of the frozen M70B matrix; 49 valid + 1
# skipped django-10973).
#
# Runs the frozen M70/M70B structured-bounded + pivot-confidence TREATMENT (exact flags below)
# over the Stage B instances from stage5_m72_stage_b_fixture.json, SEQUENTIALLY (the runner
# writes a shared results/_agent_stream.jsonl + _vtrace_instructions.md that concurrent runs
# would clobber), then runs a separate Docker --mode evaluate per label.
#
# Resumable: a treatment run is skipped if its swebench-*.jsonl already exists; a Docker eval is
# skipped if _eval.meta.json already exists for the vtrace condition.
#
# Hard cap: 49 distinct Stage B treatment live runs (<= 50-instance authorization). No baselines.
# No corrective/revision/oracle arms. No Stage C. No replacement tasks. No variance replicates.
#
# Operational retries (transient infra/quota before a usable artifact) re-run the SAME instance,
# SAME condition; they are logged separately in the ledger as status:"retry". Stop at 10.
#
# Usage:
#   run_stage5_m72_stage_b_driver.sh treat    # phase 1: sequential treatment runs
#   run_stage5_m72_stage_b_driver.sh evaluate # phase 2: sequential docker evals
set -uo pipefail

ROOT="/home/calvin/code/vtrace"
VEXP="/home/calvin/code/vexp-swe-bench"
OUT="$ROOT/benchmarks/stage5_vexp_swe_bench_smoke/results"
RUNNER="$ROOT/benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_vexp_swe_bench_smoke.ts"
FIXTURE="$OUT/stage5_m72_stage_b_fixture.json"
LEDGER="$OUT/_m72_stage_b_driver_ledger.jsonl"   # untracked operational ledger
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

result_file() { # run_label -> path of swebench jsonl if present
  ls "$OUT/runs/$1/raw/vtrace/"swebench-*.jsonl 2>/dev/null | head -1
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
    echo "[$n/$total] RUN treatment: $inst -> $label  ($(stamp))"
    echo "{\"ts\":\"$(stamp)\",\"phase\":\"treat\",\"i\":$n,\"instance\":\"$inst\",\"label\":\"$label\",\"status\":\"start\"}" >> "$LEDGER"
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
      --out "$OUT" \
      > "$OUT/runs/_m72_${label}.stdout.log" 2> "$OUT/runs/_m72_${label}.stderr.log"
    rc=$?
    patch="no"; [[ -n "$(result_file "$label")" ]] && patch="yes"
    echo "[$n/$total] DONE rc=$rc result_present=$patch: $inst"
    echo "{\"ts\":\"$(stamp)\",\"phase\":\"treat\",\"i\":$n,\"instance\":\"$inst\",\"label\":\"$label\",\"status\":\"done\",\"rc\":$rc,\"result_present\":\"$patch\"}" >> "$LEDGER"
  done
  echo "TREATMENT PHASE COMPLETE ($(stamp))"

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
    if [[ -f "$OUT/runs/$label/raw/vtrace/_eval.meta.json" ]]; then
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
      > "$OUT/runs/_m72_eval_${label}.stdout.log" 2> "$OUT/runs/_m72_eval_${label}.stderr.log"
    rc=$?
    echo "[$n/$total] EVAL DONE rc=$rc: $inst"
    echo "{\"ts\":\"$(stamp)\",\"phase\":\"eval\",\"i\":$n,\"instance\":\"$inst\",\"label\":\"$label\",\"status\":\"done\",\"rc\":$rc}" >> "$LEDGER"
  done
  echo "EVAL PHASE COMPLETE ($(stamp))"
else
  echo "unknown mode: $mode (use treat|evaluate)"; exit 2
fi
