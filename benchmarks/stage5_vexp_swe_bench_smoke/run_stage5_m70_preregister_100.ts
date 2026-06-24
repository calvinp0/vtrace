/**
 * M70 — deterministic 100-task preregistration fixture builder (report-only).
 *
 * NO live agents, NO Docker, NO API spend, NO retrieval/scoring/ranking touch. This script
 * only reads the canonical SWE-bench source pool (swe-bench-100.jsonl) and the frozen M62
 * 24-task preregistration fixture, then emits the M70 frozen 100-task fixture JSON.
 *
 * Source pool: the ONLY dataset on disk is `$VEXP/data/swe-bench-100.jsonl` (100 instances,
 * SWE-bench Verified-derived, carries the Verified `difficulty` annotation). Because the
 * target sample size (100) EQUALS the available pool size (100), the M70 sample is a FULL
 * CENSUS of the pool: every instance is included, no sub-selection. This is the strongest
 * anti-cherry-picking stance — there is zero selection discretion, so no task can be added
 * because the treatment did well on it or dropped because it did poorly.
 *
 * `--selection-seed 42` therefore governs ONLY the deterministic run-queue ordering (a
 * seeded, repo-stratified shuffle used to schedule the future live runs), never membership.
 *
 * Determinism: selection is identity (the whole pool); the only randomness is a mulberry32
 * PRNG seeded at 42 for run-queue ordering. `SELECTION_DATE` is a baked-in constant (not
 * Date.now) so the fixture is byte-reproducible.
 *
 * Usage:
 *   bun run_stage5_m70_preregister_100.ts \
 *     [--dataset path] [--m62 path] [--out dir] [--seed 42]
 * Writes <out>/stage5_m70_100_task_preregistration.json and prints a RESULT_JSON: line.
 */
import path from "node:path";

const ROOT = "/home/calvin/code/vtrace";
const RESULTS = path.join(ROOT, "benchmarks/stage5_vexp_swe_bench_smoke/results");

function flag(name: string, fb: string): string {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1]! : fb;
}

const DATASET = flag("--dataset", "/home/calvin/code/vexp-swe-bench/data/swe-bench-100.jsonl");
const M62_FIXTURE = flag(
  "--m62",
  path.join(RESULTS, "stage5_m62_structured_bounded_24_preregistration.json"),
);
const OUT = flag("--out", RESULTS);
const SELECTION_SEED = Number(flag("--seed", "42"));

// Baked-in (NOT Date.now) so the fixture is reproducible. Today's planning date.
const SELECTION_DATE = "2026-06-24";
const SOURCE_POOL = "swe-bench-100.jsonl (SWE-bench Verified-derived; the only dataset on disk)";
const SELECTION_METHOD =
  "full-census of the available source pool (sample_size == source_pool_size == 100; zero sub-selection)";

// The future treatment condition (vtrace structured-bounded + pivot-confidence gate).
const TREATMENT_FLAGS = [
  "--protocol vtrace-indexed",
  "--context-policy force-inject",
  "--capsule-engine v2",
  "--capsule-intent debug",
  "--capsule-budget 8000",
  "--inject-capsule-digest",
  "--digest-decision-contract",
  "--bounded-digest-decisions",
  "--compact-digest-injection",
  "--pivot-confidence-gate",
];

// vexp-swe-bench default model; the runner does NOT override it. All reused M62/M69 baselines
// recorded this model, so reuse model-match is preserved. Confirm per-case at run time.
const FUTURE_MODEL = "claude-opus-4-5-20251101 (vexp-swe-bench default; runner does not override)";
const FUTURE_TURN_LIMIT = "vexp-swe-bench harness default (runner does not override)";
const FUTURE_COST_LIMIT =
  "no hard per-run cost cap; vexp default. Reporting guardrail: flag any run > $5 as a cost outlier (M69 max was astropy-14598 at $3.01).";

// SWE-bench Verified difficulty buckets are 4 ORDINAL bands (not 5 numeric quintiles). We
// record an ordinal complexity_score (1..4) and a complexity_band label; complexity_quintile
// is recorded as the closest reproducible alternative `band_<n>_of_4`.
const DIFFICULTY_ORDER: Record<string, number> = {
  "<15 min fix": 1,
  "15 min - 1 hour": 2,
  "1-4 hours": 3,
  ">4 hours": 4,
};

// mulberry32 — deterministic PRNG (seeded run-queue ordering only; never membership).
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function safeId(instanceId: string): string {
  // e.g. "django__django-11820" -> "django_11820"
  const tail = instanceId.split("__").pop() ?? instanceId;
  return tail.replace(/[^a-zA-Z0-9]+/g, "_");
}

type Rec = { instance_id: string; repo: string; difficulty: string };

const ds = (await Bun.file(DATASET).text())
  .split("\n")
  .map((l) => l.trim())
  .filter(Boolean)
  .map((l) => JSON.parse(l) as Rec);

if (ds.length !== 100) {
  // Not a hard failure of the census model, but the preregistration assumes a 100-pool.
  console.error(`WARNING: source pool has ${ds.length} instances (expected 100).`);
}

const m62 = JSON.parse(await Bun.file(M62_FIXTURE).text()) as {
  instances: Array<{
    instance_id: string;
    category: string;
    baseline_label_hint: string;
    locked_sentinel?: boolean;
  }>;
  locked_sentinels: string[];
};
const m62ById = new Map(m62.instances.map((i) => [i.instance_id, i]));
const lockedSentinels = new Set(m62.locked_sentinels);

// Historically over-budget (FAIL_CLOSED_OMITTED at 12k in the pre-M63 M62 replay). All three
// became VALID in the post-M63 M69 live pre-flight, but we keep an over-budget watch flag.
const OVER_BUDGET_WATCH = new Set([
  "pylint-dev__pylint-8898",
  "sympy__sympy-12419",
  "matplotlib__matplotlib-22719",
]);

const repoCounts: Record<string, number> = {};
const complexityCounts: Record<string, number> = {};
for (const r of ds) {
  repoCounts[r.repo] = (repoCounts[r.repo] ?? 0) + 1;
  complexityCounts[r.difficulty] = (complexityCounts[r.difficulty] ?? 0) + 1;
}

// Deterministic run-queue ordering: seeded shuffle, then stable-grouped by repo so the queue
// interleaves repos (a repo-stratified schedule) without biasing membership. We assign each
// instance a seeded sort key, sort by (repo, key), then round-robin across repos.
const rng = mulberry32(SELECTION_SEED);
const keyed = ds
  .slice()
  .sort((a, b) => a.instance_id.localeCompare(b.instance_id)) // stable base order
  .map((r) => ({ r, k: rng() }));
const byRepo = new Map<string, Array<{ r: Rec; k: number }>>();
for (const e of keyed) {
  if (!byRepo.has(e.r.repo)) byRepo.set(e.r.repo, []);
  byRepo.get(e.r.repo)!.push(e);
}
for (const list of byRepo.values()) list.sort((a, b) => a.k - b.k);
// Round-robin across repos ordered by descending stratum size (largest stratum first slot).
const reposBySize = [...byRepo.keys()].sort(
  (a, b) => (repoCounts[b]! - repoCounts[a]!) || a.localeCompare(b),
);
const runQueue: string[] = [];
let remaining = true;
const cursors: Record<string, number> = {};
while (remaining) {
  remaining = false;
  for (const repo of reposBySize) {
    const list = byRepo.get(repo)!;
    const c = cursors[repo] ?? 0;
    if (c < list.length) {
      runQueue.push(list[c]!.r.instance_id);
      cursors[repo] = c + 1;
      remaining = true;
    }
  }
}
const queuePos = new Map(runQueue.map((id, i) => [id, i + 1]));

let plannedReused = 0;
let plannedFresh = 0;

const instances = ds
  .slice()
  .sort((a, b) => a.instance_id.localeCompare(b.instance_id))
  .map((r) => {
    const inM62 = m62ById.has(r.instance_id);
    const m62rec = m62ById.get(r.instance_id);
    const safe = safeId(r.instance_id);
    const score = DIFFICULTY_ORDER[r.difficulty] ?? 0;

    // Conservative reuse gate: only the 24 M62/M69 baselines are pre-approved for reuse
    // (verified same-instance, model-matched opus-4-5, Docker-evaluated, in committed M69
    // detail artifacts). Every other instance defaults to a fresh baseline; it may be
    // upgraded to reuse at run time ONLY if it passes the same reuse gate.
    const plannedBaselineSource = inM62 ? "reused" : "fresh";
    const plannedFreshNeeded = !inM62;
    if (inM62) plannedReused += 1;
    else plannedFresh += 1;

    const expectedPreflight = inM62 ? "VALID (M69 post-M63 live pre-flight)" : "unknown (run live pre-flight)";

    const notes: string[] = [];
    if (lockedSentinels.has(r.instance_id)) notes.push("locked sentinel");
    if (OVER_BUDGET_WATCH.has(r.instance_id))
      notes.push("over-budget watch (FAIL_CLOSED at 12k pre-M63; VALID in M69 post-M63)");
    if (inM62) notes.push("in frozen M62/M69 24-task locked diagnostic subset");

    return {
      instance_id: r.instance_id,
      repo: r.repo,
      source_pool: SOURCE_POOL,
      selection_method: SELECTION_METHOD,
      selection_seed: SELECTION_SEED,
      repo_stratum: r.repo,
      repo_stratum_size: repoCounts[r.repo],
      difficulty: r.difficulty,
      complexity_score: score, // 1..4 ordinal (SWE-bench Verified band)
      complexity_band: r.difficulty,
      complexity_quintile: score ? `band_${score}_of_4` : "unknown",
      category_label: m62rec?.category ?? null, // A–E only labeled for the M62 24
      in_M62_24: inM62,
      locked_sentinel: lockedSentinels.has(r.instance_id),
      over_budget_watch: OVER_BUDGET_WATCH.has(r.instance_id),
      known_prior_baseline_available: inM62, // verified-reusable only for the M62 set
      known_prior_vtrace_available: inM62, // M69 treatment artifacts exist for the M62 set
      baseline_label_hint: m62rec?.baseline_label_hint ?? null,
      planned_treatment_run_label: `m70_structured_bounded_${safe}`,
      planned_baseline_source: plannedBaselineSource,
      planned_fresh_baseline_needed: plannedFreshNeeded,
      expected_preflight_status: expectedPreflight,
      run_queue_position: queuePos.get(r.instance_id) ?? null,
      notes: notes.join("; "),
    };
  });

const plannedTreatment = instances.length; // census => 100 treatment runs

const fixture = {
  milestone: "M70",
  kind: "preregistration (planning only — no live agents, no Docker, no API spend, no 100-task run)",
  title: "100-task structured-bounded + pivot-confidence-gate benchmark",
  sample_size: instances.length,
  source_pool: SOURCE_POOL,
  source_pool_size: ds.length,
  selection_method: SELECTION_METHOD,
  selection_seed: SELECTION_SEED,
  selection_seed_role:
    "deterministic run-queue ordering ONLY (repo-stratified seeded shuffle); never membership (membership is the full census)",
  selection_date: SELECTION_DATE,
  treatment_flags: TREATMENT_FLAGS,
  baseline_protocol: "baseline (vexp-swe-bench default scaffold; no vtrace context injection)",
  future_model: FUTURE_MODEL,
  future_turn_limit: FUTURE_TURN_LIMIT,
  future_cost_limit: FUTURE_COST_LIMIT,
  repo_count: Object.keys(repoCounts).length,
  repo_counts: repoCounts,
  complexity_counts: complexityCounts,
  complexity_note:
    "SWE-bench Verified difficulty = 4 ordinal bands, not 5 numeric quintiles. complexity_score is the band ordinal (1..4); complexity_quintile records the closest reproducible alternative band_<n>_of_4. A census cannot rebalance complexity — the distribution IS the pool's own.",
  locked_cases: [...lockedSentinels],
  locked_diagnostic_subset:
    "the frozen M62/M69 24-task set (in_M62_24=true) is retained as a locked diagnostic subset for continuity with M55Y→M62→M69",
  excluded_cases: [] as string[],
  exclusion_reasons: {
    note: "Zero exclusions. The full available pool is included. The 3 historically over-budget cases (pylint-8898, sympy-12419, matplotlib-22719) are RETAINED with an over-budget watch flag and skipped at run time only if their live pre-flight is not VALID — not excluded here.",
  },
  planned_treatment_runs: plannedTreatment,
  planned_reused_baselines: plannedReused,
  planned_fresh_baselines: plannedFresh,
  baseline_reuse_note:
    "Conservative: only the 24 M62/M69 baselines are pre-approved for reuse (verified same-instance, model-matched opus-4-5, Docker-evaluated, committed). ~23 distinct baseline run dirs exist on disk (some non-M62), which MAY upgrade specific cases to reuse if they pass the run-time reuse gate — not assumed in this frozen plan, so the fresh-baseline count is an upper bound.",
  expected_total_live_runs: {
    option_1_treatment_only: plannedTreatment,
    option_2_treatment_plus_fresh_baselines: plannedTreatment + plannedFresh,
    option_3_staged_50_50: `${plannedTreatment} treatment + ${plannedFresh} fresh, executed as two 50-instance halves of the SAME frozen fixture`,
  },
  future_live_run_cap: {
    option_1: plannedTreatment,
    option_2: plannedTreatment + plannedFresh,
    note: "No execution authorized in M70. Cap is per chosen option at authorization time.",
  },
  run_label_scheme: {
    treatment: "m70_structured_bounded_<SAFE>",
    fresh_baseline_if_needed: "m70_baseline_<SAFE>",
  },
  preflight_gate: [
    "digest START/END exactly once",
    "decision contract START/END exactly once",
    "real non-warning → impact section",
    "bounded structured grammar OR explicit <VTRACE_NO_HIGH_CONFIDENCE_REQUIRED_TARGET> marker",
    "compact mode applied (no duplicate '## VTRACE inspect-first')",
    "pivot-confidence gate enabled",
    "no partial sentinel block",
    "no required IMPACT targets",
    "optional/FYI impact context present when impact reps exist",
    "O-prefixed optional IDs do not collide with T-required IDs",
  ],
  stop_conditions: [
    "pre-flight produces any partial sentinel",
    "fewer than 90 selected cases are valid",
    "required IMPACT targets appear",
    "confidence gate is missing",
    "artifact extraction cannot verify treatment validity",
  ],
  non_claims: [
    "Does not claim VTRACE beats VEXP.",
    "Does not claim a general SWE-bench pass@1 improvement.",
    "Does not make a statistical superiority claim until executed and analyzed.",
    "A 100-task census supports a stronger engineering claim than the 24-task set but still does not prove general SWE-bench superiority unless sampling and comparator are fully aligned.",
  ],
  instances,
};

await Bun.write(
  path.join(OUT, "stage5_m70_100_task_preregistration.json"),
  JSON.stringify(fixture, null, 2) + "\n",
);

const summary = {
  sample_size: fixture.sample_size,
  source_pool_size: fixture.source_pool_size,
  repo_count: fixture.repo_count,
  repo_counts: fixture.repo_counts,
  complexity_counts: fixture.complexity_counts,
  in_M62_24: instances.filter((i) => i.in_M62_24).length,
  planned_treatment_runs: fixture.planned_treatment_runs,
  planned_reused_baselines: fixture.planned_reused_baselines,
  planned_fresh_baselines: fixture.planned_fresh_baselines,
  expected_total_live_runs_option2: fixture.expected_total_live_runs.option_2_treatment_plus_fresh_baselines,
  out: path.join(OUT, "stage5_m70_100_task_preregistration.json"),
};
console.log("RESULT_JSON: " + JSON.stringify(summary));
