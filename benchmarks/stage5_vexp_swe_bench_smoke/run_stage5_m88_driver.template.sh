#!/usr/bin/env bash
# M88 (TEMPLATE) — sequential live driver for the COMBINED V4 tool-loop guard + C7_D cost
# guard INJECT slice, HARDENED with the M86 Stage 5 environment-isolation guard.
#
# This is the M85 driver template with the three env-guard flags added to `run_treatment`
# (see the `# >>> M86 env guard` block). It is provided as a READY future-validation template:
# do NOT run it without explicit approval (it spawns REAL agents and costs money). Per M87B,
# the host BASE prefix is now repaired (baseRepairVerified=true) and the clean
# `vexp_swebench` testbed prefix passes the prefix guard, so future live work MAY enable the
# guard via the flags below.
#
# Treatment = exact M73/M77/M80/M82/M85 structured-bounded + pivot-confidence flags PLUS
#   --tool-loop-guard-mode inject --tool-loop-guard-calibration v4
#   --cost-guard-mode inject --cost-guard-calibration c7d
#   --stage5-env-guard --stage5-env-drift-check
#   --expected-testbed-prefix /home/calvin/miniforge3/envs/vexp_swebench
# With --stage5-env-guard set, runCondition() probes the testbed interpreter and THROWS before
# spawning the agent unless sys.prefix / pip -V / interpreter all provably equal the expected
# prefix (never base/dev). Default-off elsewhere ⇒ unchanged behavior.
#
# Runs are SEQUENTIAL (the first pass writes a SHARED results/_agent_stream.jsonl; concurrent
# live runs clobber it). Resumable: a treatment run is skipped if its swebench-*.jsonl exists.
#
#   run_stage5_m88_driver.template.sh treat    [instance_id]   # phase 1: sequential live runs
#   run_stage5_m88_driver.template.sh evaluate [instance_id]   # phase 2: sequential docker evals
set -uo pipefail

ROOT="/home/calvin/code/vtrace"
VEXP="/home/calvin/code/vexp-swe-bench"
OUT="$ROOT/benchmarks/stage5_vexp_swe_bench_smoke/results"
RUNNER="$ROOT/benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_vexp_swe_bench_smoke.ts"
SPLIT="$OUT/stage5_m85_v4_c7d_live_split.json"     # reuse the M85 split unless a new one is built
LEDGER="$OUT/_m88_driver_ledger.jsonl"             # untracked operational ledger
LOGDIR="$OUT/_m88_logs"
DATASET="$VEXP/data/swe-bench-100.jsonl"
EXPECTED_TESTBED_PREFIX="/home/calvin/miniforge3/envs/vexp_swebench"   # M87B-verified clean prefix
MAX_RETRIES=4
ABORT_RE='rate.?limit|overloaded|quota|insufficient|429|529|Could not authenticate|authentication|ECONNRESET|fetch failed|socket hang up|terminated|ETIMEDOUT|503 |502 '

mkdir -p "$LOGDIR"
cd "$ROOT" || exit 2
mode="${1:-treat}"
ONLY="${2:-}"

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
    --tool-loop-guard-calibration v4 \
    --cost-guard-mode inject \
    --cost-guard-calibration c7d \
    `# >>> M86 env guard (M87B-verified): fail closed before agent spawn on a wrong prefix` \
    --stage5-env-guard \
    --stage5-env-drift-check \
    --expected-testbed-prefix "$EXPECTED_TESTBED_PREFIX" \
    `# <<< M86 env guard` \
    --out "$OUT" \
    > "$LOGDIR/${label}.stdout.log" 2> "$LOGDIR/${label}.stderr.log"
  return $?
}

if [[ "$mode" == "treat" ]]; then
  n=0; total=${#LINES[@]}; retries_used=0
  for line in "${LINES[@]}"; do
    inst="${line%%$'\t'*}"; grp="${line##*$'\t'}"
    n=$((n+1))
    [[ -n "$ONLY" && "$inst" != "$ONLY" ]] && continue
    base="m88_v4_c7d_envguard_$(safe "$inst")"
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
      aborted="no"
      if ! ran_meta "$label" && grep -qiE "$ABORT_RE" "$LOGDIR/${label}.stderr.log" 2>/dev/null; then aborted="yes"; fi
      if [[ "$aborted" == "yes" && $retries_used -lt $MAX_RETRIES ]]; then
        retries_used=$((retries_used+1)); attempt=$((attempt+1))
        label="${base}_retry${attempt}"
        echo "[$n/$total] ABORT (provider/infra) rc=$rc -> operational retry ${attempt} (global ${retries_used}/${MAX_RETRIES}): $inst"
        echo "{\"ts\":\"$(stamp)\",\"phase\":\"treat\",\"i\":$n,\"instance\":\"$inst\",\"group\":\"$grp\",\"label\":\"$label\",\"attempt\":$attempt,\"status\":\"operational_abort_retry\",\"rc\":$rc,\"global_retries_used\":$retries_used}" >> "$LEDGER"
        continue
      fi
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
    [[ -n "$ONLY" && "$inst" != "$ONLY" ]] && continue
    for label in "m88_v4_c7d_envguard_$(safe "$inst")" "m88_v4_c7d_envguard_$(safe "$inst")"_retry{1,2,3,4}; do
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
  echo "usage: $0 treat|evaluate [instance_id]" >&2; exit 2
fi
