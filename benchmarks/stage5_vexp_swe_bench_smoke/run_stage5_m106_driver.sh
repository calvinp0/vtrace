#!/usr/bin/env bash
# M106 — sequential live driver for the 24-case live-confirmation EXTENSION
# (10 pre-registered cases from stage5_m106_case_selection.json; see
# results/stage5_m106_24_case_live_confirmation_plan.md for the protocol).
# The 14 committed M105 cases are NEVER rerun by this driver — it only knows
# the 10 extension ids.
#
# Treatment = the M105/M92 clean-core flag set EXACTLY (mandatory env/shell
# safety; NO V4/C7_D, NO revision/corrective/oracle, NO vexp, NO baseline).
#
# Per-case gate: the case must have preflight_pass=true in the M106 no-agent
# preflight detail (task parity + leakage + fallback + guards) or it is SKIPPED
# as invalid — never spawned.
#
# Runs are SEQUENTIAL (the first pass writes a SHARED results/_agent_stream.jsonl).
# Resumable: a case is skipped if its swebench-*.jsonl exists.
#
#   run_stage5_m106_driver.sh treat    [instance_id]   # live runs (phase A then B)
#   run_stage5_m106_driver.sh evaluate [instance_id]   # docker evals
set -uo pipefail

ROOT="/home/calvin/code/vtrace"
VEXP="/home/calvin/code/vexp-swe-bench"
OUT="$ROOT/benchmarks/stage5_vexp_swe_bench_smoke/results"
RUNNER="$ROOT/benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_vexp_swe_bench_smoke.ts"
PREFLIGHT="$OUT/stage5_m106_live_preflight.detail.json"
LEDGER="$OUT/_m106_driver_ledger.jsonl"                    # untracked operational ledger
LOGDIR="$OUT/_m106_logs"
DATASET="$VEXP/data/swe-bench-100.jsonl"
EXPECTED_TESTBED_PREFIX="/home/calvin/miniforge3/envs/vexp_swebench"   # M87B-verified clean prefix
MAX_RETRIES=4    # M106 pre-registered: max 4 operational retry launches (provider/infra only)
ABORT_RE='rate.?limit|overloaded|quota|insufficient|429|529|Could not authenticate|authentication|ECONNRESET|fetch failed|socket hang up|terminated|ETIMEDOUT|503 |502 '

# Pre-registered selection order (Phase A = first 3, then Phase B; no replacements).
CASES=(
  astropy__astropy-7166
  django__django-11815
  astropy__astropy-14365
  django__django-15695
  matplotlib__matplotlib-24870
  pydata__xarray-6992
  matplotlib__matplotlib-24970
  pylint-dev__pylint-4551
  pydata__xarray-6938
  sphinx-doc__sphinx-7748
)

mkdir -p "$LOGDIR"
cd "$ROOT" || exit 2
mode="${1:-treat}"
ONLY="${2:-}"

stamp() { date -u +%Y-%m-%dT%H:%M:%SZ; }
safe() { echo "$1" | tr -c 'a-zA-Z0-9' '_'; }
result_file() { ls "$OUT/runs/$1/raw/vtrace/"swebench-*.jsonl 2>/dev/null | head -1; }
ran_meta() { [[ -f "$OUT/runs/$1/raw/vtrace/_run.meta.json" ]]; }
preflight_pass() { # instance -> rc 0 iff preflight_pass true and the global gate passed
  python3 - "$1" "$PREFLIGHT" << 'EOF'
import json, sys
inst, preflight = sys.argv[1], sys.argv[2]
d = json.load(open(preflight))
rows = [c for c in d["cases"] if c["instance_id"] == inst]
ok = bool(rows) and rows[0]["preflight_pass"] is True and d["summary"]["gate_pass"] is True
sys.exit(0 if ok else 1)
EOF
}

run_treatment() { # instance, label -> rc
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
    `# >>> M89 MANDATORY env guard: a live run fails closed before agent spawn without these` \
    --stage5-env-guard \
    --stage5-env-drift-check \
    --expected-testbed-prefix "$EXPECTED_TESTBED_PREFIX" \
    `# <<< M89 env guard` \
    `# >>> M90A MANDATORY agent shell guard / host-pip firewall (default ON; explicit for clarity)` \
    --stage5-agent-shell-guard \
    --stage5-host-pip-firewall \
    `# <<< M90A agent shell guard` \
    `# NOTE: M106 = M105/M92 core treatment. NO V4/C7_D, NO revision/corrective, NO vexp/baseline.` \
    --out "$OUT" \
    > "$LOGDIR/${label}.stdout.log" 2> "$LOGDIR/${label}.stderr.log"
  return $?
}

if [[ "$mode" == "treat" ]]; then
  n=0; total=${#CASES[@]}; retries_used=0
  for inst in "${CASES[@]}"; do
    n=$((n+1))
    [[ -n "$ONLY" && "$inst" != "$ONLY" ]] && continue
    base="m106_live_ext_$(safe "$inst")"
    if [[ -n "$(result_file "$base")" ]]; then
      echo "[$n/$total] SKIP (already has result): $inst"
      continue
    fi
    if ! preflight_pass "$inst"; then
      echo "[$n/$total] PREFLIGHT-FAIL (never spawned): $inst"
      echo "{\"ts\":\"$(stamp)\",\"phase\":\"treat\",\"i\":$n,\"instance\":\"$inst\",\"label\":\"$base\",\"status\":\"preflight_fail_skip\"}" >> "$LEDGER"
      continue
    fi
    label="$base"; attempt=0
    while : ; do
      echo "[$n/$total] RUN ($label) attempt=$attempt: $inst  ($(stamp))"
      echo "{\"ts\":\"$(stamp)\",\"phase\":\"treat\",\"i\":$n,\"instance\":\"$inst\",\"label\":\"$label\",\"attempt\":$attempt,\"status\":\"start\"}" >> "$LEDGER"
      run_treatment "$inst" "$label"; rc=$?
      rf="$(result_file "$label")"
      if [[ -n "$rf" ]]; then
        echo "[$n/$total] DONE rc=$rc result_present=yes label=$label: $inst"
        echo "{\"ts\":\"$(stamp)\",\"phase\":\"treat\",\"i\":$n,\"instance\":\"$inst\",\"label\":\"$label\",\"attempt\":$attempt,\"status\":\"done\",\"rc\":$rc,\"result_present\":\"yes\"}" >> "$LEDGER"
        break
      fi
      aborted="no"
      if ! ran_meta "$label" && grep -qiE "$ABORT_RE" "$LOGDIR/${label}.stderr.log" 2>/dev/null; then aborted="yes"; fi
      if [[ "$aborted" == "yes" && $retries_used -lt $MAX_RETRIES ]]; then
        retries_used=$((retries_used+1)); attempt=$((attempt+1))
        label="${base}_retry${attempt}"
        echo "[$n/$total] ABORT (provider/infra) rc=$rc -> operational retry ${attempt} (global ${retries_used}/${MAX_RETRIES}): $inst"
        echo "{\"ts\":\"$(stamp)\",\"phase\":\"treat\",\"i\":$n,\"instance\":\"$inst\",\"label\":\"$label\",\"attempt\":$attempt,\"status\":\"operational_abort_retry\",\"rc\":$rc,\"global_retries_used\":$retries_used}" >> "$LEDGER"
        continue
      fi
      echo "[$n/$total] DONE rc=$rc result_present=no aborted=$aborted label=$label: $inst"
      echo "{\"ts\":\"$(stamp)\",\"phase\":\"treat\",\"i\":$n,\"instance\":\"$inst\",\"label\":\"$label\",\"attempt\":$attempt,\"status\":\"done\",\"rc\":$rc,\"result_present\":\"no\",\"aborted\":\"$aborted\"}" >> "$LEDGER"
      break
    done
  done
  echo "TREATMENT PHASE COMPLETE ($(stamp)); operational_retries_used=$retries_used"

elif [[ "$mode" == "evaluate" ]]; then
  n=0; total=${#CASES[@]}
  for inst in "${CASES[@]}"; do
    n=$((n+1))
    [[ -n "$ONLY" && "$inst" != "$ONLY" ]] && continue
    for label in "m106_live_ext_$(safe "$inst")" "m106_live_ext_$(safe "$inst")"_retry{1,2,3,4}; do
      rf="$(result_file "$label")"; [[ -z "$rf" ]] && continue
      if [[ -f "$OUT/runs/$label/raw/vtrace/_eval.meta.json" ]]; then
        echo "[$n/$total] EVAL SKIP (already evaluated): $label"; continue
      fi
      echo "[$n/$total] EVAL ($label): $inst  ($(stamp))"
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
