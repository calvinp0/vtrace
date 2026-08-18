#!/usr/bin/env bash
# M161-C — sequential paired live driver: baseline vs VTRACE-injected context.
#
# WHAT DIFFERS FROM M155's DRIVER, AND WHY
# -----------------------------------------
# 1. --vexp-run-data. M161's corpus is drawn from the 400 SWE-bench Verified
#    instances that vexp's bundled swe-bench-100.jsonl does NOT contain, so the
#    external CLI must be pointed at the full population. Passed to BOTH arms
#    identically: the dataset decides which instances exist, never which arm sees
#    what.
#
# 2. --disable-token-discipline, on BOTH arms. The historical Stage 5 treatment
#    was "capsule evidence + STAGE5_TOKEN_DISCIPLINE search/edit policy"; M161's
#    treatment is "capsule evidence only". That block told the VTRACE arm to patch
#    first, cap searches before the first edit, and not grep once the capsule named
#    a pivot — exactly the instructions §30 forbids, and precisely the confound that
#    would make every §64/§66/§70 anchoring finding and every §113 efficiency delta
#    attributable to an instruction rather than to the evidence. The block itself is
#    NOT deleted; M161 declines to inject it and records that it is intentionally not
#    historical-treatment identical. M161's numbers are therefore not directly
#    comparable to M155's.
#
# Arm order ALTERNATES per case from the frozen schedule (§45), so neither condition
# is systematically run earlier and provider drift spreads across both arms.
#
# Runs are SEQUENTIAL: the first pass writes a SHARED results/_agent_stream.jsonl,
# and M155/M156 already learned what saturating this machine does to measurements
# (five parallel indexers turned 0 real test failures into 86 apparent ones). Never
# parallelise (§47).
#
# Resumable: an arm is skipped when its swebench-*.jsonl already exists.
#
# RERUN POLICY (frozen before any live run — results/stage5_m161_rerun_policy.md):
# retries are launched ONLY for infrastructure/provider failures matched by ABORT_RE.
# A bad agent decision, a failed patch, a poor VTRACE context, or a lost baseline is
# a RESULT and is never rerun.
#
#   run_stage5_m161_paired_driver.sh smoke <instance_id>   # 1 paired case, NOT in the frozen set
#   run_stage5_m161_paired_driver.sh treat [N|instance_id] # live paired runs over paired30
#   run_stage5_m161_paired_driver.sh evaluate              # docker grading, both arms
set -uo pipefail

ROOT="/home/calvin/code/vtrace"
VEXP="/home/calvin/code/vexp-swe-bench"
OUT="$ROOT/benchmarks/stage5_vexp_swe_bench_smoke/results"
RUNNER="$ROOT/benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_vexp_swe_bench_smoke.ts"
SCHEDULE="$OUT/stage5_m161_arm_schedule.json"
PAIRED30="$OUT/stage5_m161_paired30_manifest.json"
EXTENSION="$OUT/stage5_m161_extension_manifest.json"
LEDGER="$OUT/_m161_paired_ledger.jsonl"
LOGDIR="$OUT/_m161_paired_logs"
# The FULL SWE-bench Verified population. Both the vtrace runner (gold labels,
# FAIL_TO_PASS, docker eval) and the external vexp CLI (`run --data`) read it.
DATASET="$OUT/_m160_corpus/swe_bench_verified.jsonl"
EXPECTED_TESTBED_PREFIX="/home/calvin/miniforge3/envs/vexp_swebench"
MAX_RETRIES=4
ABORT_RE='rate.?limit|overloaded|quota|insufficient|429|529|Could not authenticate|authentication|ECONNRESET|fetch failed|socket hang up|terminated|ETIMEDOUT|503 |502 '

mkdir -p "$LOGDIR"

log() { printf '{"ts":"%s","phase":"%s","instance":"%s","arm":"%s","label":"%s","attempt":%s,"status":"%s"}\n' \
  "$(date -Iseconds)" "$1" "$2" "$3" "$4" "$5" "$6" >> "$LEDGER"; }

label_for() { printf 'm161_%s_%s' "$1" "$(echo "$2" | tr -- '-' '_')"; }

# The runner writes each condition's rows under raw/<condition>/. Checking only
# raw/vtrace/ would report every completed baseline as a failure — and re-run it,
# spending twice and breaking the frozen rerun policy (M155 learned this).
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
    # M161: the external vexp CLI's own --data, so it can resolve an instance that
    # is not in its bundled 100-task subset. Identical for both arms.
    --vexp-run-data "$DATASET"
    # M161 treatment definition: capsule evidence only, no search/edit policy.
    # Passed on BOTH arms so the parity control asserts its absence symmetrically.
    --disable-token-discipline
    # M89 MANDATORY env guard — a live run fails closed before agent spawn without these.
    --stage5-env-guard
    --stage5-env-drift-check
    --expected-testbed-prefix "$EXPECTED_TESTBED_PREFIX"
    # M90A MANDATORY agent shell guard / host-pip firewall.
    --stage5-agent-shell-guard
    --stage5-host-pip-firewall
    --out "$OUT"
  )
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
    # Only infrastructure/provider failures are eligible for a retry.
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

# Both arms of one case, in the frozen schedule's order.
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
    # The smoke pair validates the harness and must never touch the frozen sample:
    # a case consumed here could not later be a clean member of paired30 or of the
    # extension set, and its outcome must never reach a utility denominator (§81).
    if bun -e "
      const p = await Bun.file('$PAIRED30').json();
      const e = await Bun.file('$EXTENSION').json();
      const frozen = new Set([
        ...p.cases.map(c => c.instanceId),
        ...e.extension.cases.map(c => c.instanceId),
        ...e.reserve.cases.map(c => c.instanceId),
      ]);
      if (frozen.has('$inst')) {
        console.error('refusing: $inst is inside the frozen M161 sample (paired30 / extension / reserve)');
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
      const s = await Bun.file('$SCHEDULE').json();
      for (const c of s.paired30.schedule) console.log(\`\${c.order}\t\${c.instanceId}\t\${c.armOrder[0]}\`);")
    for row in "${rows[@]}"; do
      IFS=$'\t' read -r order inst first <<< "$row"
      if [[ -n "$sel" && "$sel" != "$inst" && "$sel" != "$order" ]]; then continue; fi
      run_pair "$inst" "$first"
    done
    ;;
  evaluate)
    sel="${2:-}"
    mapfile -t rows < <(bun -e "
      const s = await Bun.file('$SCHEDULE').json();
      for (const c of s.paired30.schedule) console.log(c.instanceId);")
    [[ -n "$sel" ]] && rows=("$sel")
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
    echo "usage: $0 smoke <instance_id> | treat [N|instance_id] | evaluate [instance_id]"
    exit 2
    ;;
esac
