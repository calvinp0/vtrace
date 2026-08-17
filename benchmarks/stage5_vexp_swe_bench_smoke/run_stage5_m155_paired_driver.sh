#!/usr/bin/env bash
# M155-D — sequential paired live driver: baseline vs VTRACE-injected context.
#
# The VTRACE arm reproduces the M105/M108 frozen treatment flag set EXACTLY. The
# baseline arm is the same runner, same model, same tools, same guards, with no
# VTRACE context injected — the only intended treatment difference (M155 §36/§37).
#
# Arm order ALTERNATES per case from the frozen manifest (§49), so neither
# condition is systematically run earlier and API/environment drift over the run
# window spreads across both arms instead of loading onto one.
#
# Runs are SEQUENTIAL: the first pass writes a SHARED results/_agent_stream.jsonl,
# and M155 already learned what concurrency does to this machine (five parallel
# indexers turned 0 real test failures into 86 apparent ones). Never parallelise.
#
# Resumable: an arm is skipped when its swebench-*.jsonl already exists.
#
# RERUN POLICY (frozen before any live run, §46): retries are launched ONLY for
# infrastructure/provider failures matched by ABORT_RE. A bad agent decision, a
# failed patch, a poor VTRACE context, or a lost baseline is a RESULT and is never
# rerun.
#
#   run_stage5_m155_paired_driver.sh smoke <instance_id>   # 1 paired case, not in the 30
#   run_stage5_m155_paired_driver.sh treat [N|instance_id] # live paired runs
#   run_stage5_m155_paired_driver.sh evaluate              # docker grading, both arms
set -uo pipefail

ROOT="/home/calvin/code/vtrace"
VEXP="/home/calvin/code/vexp-swe-bench"
OUT="$ROOT/benchmarks/stage5_vexp_swe_bench_smoke/results"
RUNNER="$ROOT/benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_vexp_swe_bench_smoke.ts"
MANIFEST="$OUT/stage5_m155_paired30_manifest.json"
LEDGER="$OUT/_m155_paired_ledger.jsonl"
LOGDIR="$OUT/_m155_paired_logs"
DATASET="$VEXP/data/swe-bench-100.jsonl"
EXPECTED_TESTBED_PREFIX="/home/calvin/miniforge3/envs/vexp_swebench"
MAX_RETRIES=4
ABORT_RE='rate.?limit|overloaded|quota|insufficient|429|529|Could not authenticate|authentication|ECONNRESET|fetch failed|socket hang up|terminated|ETIMEDOUT|503 |502 '

mkdir -p "$LOGDIR"

log() { printf '{"ts":"%s","phase":"%s","instance":"%s","arm":"%s","label":"%s","attempt":%s,"status":"%s"}\n' \
  "$(date -Iseconds)" "$1" "$2" "$3" "$4" "$5" "$6" >> "$LEDGER"; }

label_for() { printf 'm155_%s_%s' "$1" "$(echo "$2" | tr -- '-' '_')"; }

# The runner writes each condition's rows under raw/<condition>/, so the baseline
# arm lands in raw/baseline/ and the treatment arm in raw/vtrace/. Checking only
# raw/vtrace/ reported every completed baseline as a failure — and would have
# re-run it, spending twice and breaking the frozen rerun policy.
raw_dir_for() {
  case "$1" in
    baseline) printf '%s/runs/%s/raw/baseline' "$OUT" "$2" ;;
    *)        printf '%s/runs/%s/raw/vtrace'   "$OUT" "$2" ;;
  esac
}

already_done() {
  local arm="$1" label="$2"
  compgen -G "$(raw_dir_for "$arm" "$label")/swebench-*.jsonl" > /dev/null 2>&1
}

# One arm of one case. $1 = baseline|vtrace, $2 = instance_id
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
    # M89 MANDATORY env guard — a live run fails closed before agent spawn without these.
    --stage5-env-guard
    --stage5-env-drift-check
    --expected-testbed-prefix "$EXPECTED_TESTBED_PREFIX"
    # M90A MANDATORY agent shell guard / host-pip firewall.
    --stage5-agent-shell-guard
    --stage5-host-pip-firewall
    --out "$OUT"
  )
  # The VTRACE arm's treatment: the M105/M108 frozen default path, unchanged.
  local treatment=()
  if [[ "$arm" == "vtrace" ]]; then
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
  else
    treatment=(--protocol baseline)
  fi

  local attempt=1
  while (( attempt <= MAX_RETRIES )); do
    echo "  [run ] $arm $inst (attempt $attempt)"
    log treat "$inst" "$arm" "$label" "$attempt" start
    bun "$RUNNER" "${common[@]}" "${treatment[@]}" \
      > "$LOGDIR/${label}.stdout.log" 2> "$LOGDIR/${label}.stderr.log"
    local code=$?
    if already_done "$arm" "$label"; then
      log treat "$inst" "$arm" "$label" "$attempt" done
      echo "  [ok  ] $arm $inst"
      return 0
    fi
    # Only infrastructure/provider failures are eligible for a retry (§46).
    if grep -qiE "$ABORT_RE" "$LOGDIR/${label}.stderr.log" 2>/dev/null; then
      log treat "$inst" "$arm" "$label" "$attempt" infra_retry
      echo "  [infra] $arm $inst — provider/infra failure, retrying"
      attempt=$((attempt + 1))
      sleep 30
      continue
    fi
    log treat "$inst" "$arm" "$label" "$attempt" "failed_exit_${code}"
    echo "  [fail] $arm $inst (exit $code, not an infra pattern — NOT retried)"
    return 1
  done
  log treat "$inst" "$arm" "$label" "$attempt" retries_exhausted
  echo "  [fail] $arm $inst — infra retries exhausted"
  return 1
}

# Both arms of one case, in the manifest's frozen order.
run_pair() {
  local inst="$1" first="$2"
  local second
  [[ "$first" == "baseline" ]] && second="vtrace" || second="baseline"
  echo "== $inst (first arm: $first)"
  run_arm "$first" "$inst"
  run_arm "$second" "$inst"
}

cmd="${1:-}"
case "$cmd" in
  smoke)
    inst="${2:?smoke needs an instance_id}"
    if bun -e "
      const m = await Bun.file('$MANIFEST').json();
      if (m.cases.some(c => c.instance_id === '$inst')) {
        console.error('refusing: $inst is IN the frozen paired-30; smoke on a case outside it');
        process.exit(1);
      }" ; then
      run_pair "$inst" baseline
    else
      exit 1
    fi
    ;;
  treat)
    sel="${2:-}"
    mapfile -t rows < <(bun -e "
      const m = await Bun.file('$MANIFEST').json();
      for (const c of m.cases) console.log(\`\${c.order}\t\${c.instance_id}\t\${c.armOrder[0]}\`);")
    for row in "${rows[@]}"; do
      IFS=$'\t' read -r order inst first <<< "$row"
      if [[ -n "$sel" && "$sel" != "$inst" && "$sel" != "$order" ]]; then continue; fi
      run_pair "$inst" "$first"
    done
    ;;
  evaluate)
    mapfile -t rows < <(bun -e "
      const m = await Bun.file('$MANIFEST').json();
      for (const c of m.cases) console.log(c.instance_id);")
    for inst in "${rows[@]}"; do
      for arm in baseline vtrace; do
        label="$(label_for "$arm" "$inst")"
        if ! already_done "$arm" "$label"; then echo "  [skip] $label (no run)"; continue; fi
        if [[ -f "$(raw_dir_for "$arm" "$label")/_eval.meta.json" ]]; then
          echo "  [skip] $label (already graded)"; continue
        fi
        echo "  [eval] $label"
        log evaluate "$inst" "$arm" "$label" 1 start
        bun "$RUNNER" --mode evaluate --eval-mode docker \
          --vexp-swe-bench-dir "$VEXP" --run-label "$label" \
          --eval-dataset "$DATASET" --out "$OUT" \
          > "$LOGDIR/${label}.eval.stdout.log" 2> "$LOGDIR/${label}.eval.stderr.log"
        log evaluate "$inst" "$arm" "$label" 1 "exit_$?"
      done
    done
    ;;
  *)
    echo "usage: $0 smoke <instance_id> | treat [N|instance_id] | evaluate"
    exit 2
    ;;
esac
