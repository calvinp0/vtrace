/**
 * M175-C — the admissible disclosure policies, priced and compared.
 *
 *   bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m175_candidates.ts
 *
 * §68 requires the candidate to be frozen BEFORE Broad100-B is evaluated and NOT
 * on holdout outcomes. So nothing here looks at delivery: the decision is made on
 * what each policy costs the envelope and what it costs the consumers, both of
 * which are knowable without running the product. M175-E then qualifies the frozen
 * choice and is not permitted to revise it.
 *
 * THE CANDIDATE SET IS NOT A CURVE. §26 admits only policies the M175-A authority
 * audit supports. That audit found zero product consumers of the shipped `request`
 * block and `request.task` identical to `request.query` in 199 of 199 captures, so
 * all five below preserve every consumer that exists — they differ in how much
 * prose they leave behind and in what they do to the published schema.
 *
 * Offline. No agent, no Docker, no paid API, no index access.
 */

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { applyPolicy, DisclosurePolicy, envelopeTokens, REQUEST_PROSE_OMITTED } from "./m175Echo";
import { loadProblemStatements } from "./m175Capture";

const ROOT = path.resolve(".");
const RESULTS = path.join(ROOT, "benchmarks/stage5_vexp_swe_bench_smoke/results");
const DATASET = path.join(RESULTS, "_m160_corpus/swe_bench_verified.jsonl");

const CORPORA = ["broad100a", "broad100b"] as const;

const statements = loadProblemStatements(DATASET);

const median = (values: readonly number[]): number => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[middle]!;
};
const percentile = (values: readonly number[], p: number): number => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))]!;
};

/** The non-prose remainder of a real request block, from the M174 capture. */
const REQUEST_SCAFFOLD = Object.freeze({
  maxResults: 6,
  maxBudgetCharacters: 2_000,
  intentRequested: "auto",
  sessionId: null,
  includeTests: true,
  includeFileContent: true,
  presetRequested: "auto",
});

const buildRequestBlock = (task: string): Record<string, unknown> =>
  ({ query: task, task, ...REQUEST_SCAFFOLD });

interface PolicyProfile {
  readonly policy: DisclosurePolicy;
  readonly whatTheModelSees: string;
  /** §56: does the published output schema change shape? */
  readonly schemaChange: "none" | "field_value_only" | "field_removed" | "block_removed";
  readonly consumersBroken: readonly string[];
  readonly debugPreserved: boolean;
  readonly leavesVerbatimProse: boolean;
  readonly falseAbsenceRisk: string;
}

const PROFILES: readonly PolicyProfile[] = Object.freeze([
  {
    policy: DisclosurePolicy.Current,
    whatTheModelSees: "the caller's own question, twice, verbatim",
    schemaChange: "none",
    consumersBroken: [],
    debugPreserved: true,
    leavesVerbatimProse: true,
    falseAbsenceRisk: "none — nothing is omitted",
  },
  {
    policy: DisclosurePolicy.TaskOnly,
    whatTheModelSees: "the question once, verbatim; `query` becomes '@request.task'",
    schemaChange: "field_value_only",
    consumersBroken: [],
    debugPreserved: true,
    leavesVerbatimProse: true,
    falseAbsenceRisk: "none — the reference names where the value went",
  },
  {
    policy: DisclosurePolicy.QueryOnly,
    whatTheModelSees: "the question once, verbatim; `task` becomes '@request.query'",
    schemaChange: "field_value_only",
    consumersBroken: [],
    debugPreserved: true,
    leavesVerbatimProse: true,
    falseAbsenceRisk:
      "none, but it inverts the codebase's own convention: `productContext.task` and the "
      + "envelope's existing dedup tier both already point AT `@request.task` as canonical.",
  },
  {
    policy: DisclosurePolicy.IdentityOnly,
    whatTheModelSees: `'${REQUEST_PROSE_OMITTED}' and '@request.task'`,
    schemaChange: "field_value_only",
    consumersBroken: [],
    debugPreserved: true,
    leavesVerbatimProse: false,
    falseAbsenceRisk:
      "handled — the marker states that the caller supplied the text and that debug returns it, "
      + "so the omission carries no claim.",
  },
  {
    policy: DisclosurePolicy.NoDisclosure,
    whatTheModelSees: "nothing; the `request` block is absent",
    schemaChange: "block_removed",
    consumersBroken: [
      "any consumer branching on the presence of `request` — none proven, and §11 forbids "
      + "claiming an unknown consumer is safe",
    ],
    debugPreserved: true,
    leavesVerbatimProse: false,
    falseAbsenceRisk:
      "UNHANDLED — a silently absent block is indistinguishable from a response that never had "
      + "one, which is exactly the false-absence failure the projector's boundary rule forbids.",
  },
]);

interface CorpusRow {
  readonly corpus: string;
  readonly cases: number;
  readonly taskCharacters: { median: number; p90: number; max: number };
  readonly byPolicy: Record<string, {
    medianTokens: number; p90Tokens: number; maxTokens: number;
    medianSavedTokens: number; p90SavedTokens: number; maxSavedTokens: number;
  }>;
}

const corpusRows: CorpusRow[] = [];
for (const corpus of CORPORA) {
  const manifest = JSON.parse(
    readFileSync(path.join(RESULTS, "_m171_capture", `${corpus}.manifest.json`), "utf8"),
  ) as { cases: readonly { instanceId: string }[] };
  const tasks = manifest.cases
    .map((entry) => statements.get(entry.instanceId))
    .filter((task): task is string => typeof task === "string");

  const byPolicy: CorpusRow["byPolicy"] = {};
  const baseline = tasks.map((task) => envelopeTokens(buildRequestBlock(task)));
  for (const profile of PROFILES) {
    const tokens = tasks.map((task) =>
      envelopeTokens(applyPolicy({ request: buildRequestBlock(task) }, profile.policy).request));
    const saved = tokens.map((value, index) => baseline[index]! - value);
    byPolicy[profile.policy] = {
      medianTokens: median(tokens), p90Tokens: percentile(tokens, 90), maxTokens: Math.max(...tokens),
      medianSavedTokens: median(saved), p90SavedTokens: percentile(saved, 90),
      maxSavedTokens: Math.max(...saved),
    };
  }
  const lengths = tasks.map((task) => task.length);
  corpusRows.push({
    corpus, cases: tasks.length,
    taskCharacters: { median: median(lengths), p90: percentile(lengths, 90), max: Math.max(...lengths) },
    byPolicy,
  });
}

/**
 * THE FREEZE.
 *
 * TASK_ONLY and QUERY_ONLY halve the echo and leave the other half in place, so a
 * long enough question still outbids the evidence — they fix the case that was
 * measured and not the defect that produced it. QUERY_ONLY additionally inverts
 * the convention the codebase already uses.
 *
 * NO_REQUEST_DISCLOSURE removes the block, which is a schema change §56 asks to
 * avoid where a shortening will do, and it makes the omission silent.
 *
 * IDENTITY_ONLY removes ALL verbatim prose while keeping the block, its resolved
 * parameters and its shape. It changes two field VALUES and nothing else, it
 * states what it omitted and where to retrieve it, and `detail=debug` still
 * returns the request whole. It is the smallest representation that preserves
 * every semantic the authority audit found to exist — which is §28's rule, not
 * the largest saving.
 */
const FROZEN = DisclosurePolicy.IdentityOnly;

writeFileSync(path.join(RESULTS, "stage5_m175_candidate_comparison.json"), `${JSON.stringify({
  schemaVersion: "stage5.m175.candidate-comparison.v1",
  milestone: "M175",
  workstream: "M175-C",
  decisionBasis: "envelope cost and consumer compatibility only — no delivery outcome was consulted",
  frozenPolicy: FROZEN,
  frozenBefore: "any Broad100-A or Broad100-B evaluation of the repair (§68, §42)",
  profiles: PROFILES,
  economics: corpusRows,
  rationale: {
    rejected: {
      [DisclosurePolicy.TaskOnly]:
        "Halves the echo and leaves the other half unreducible. A sufficiently long question still "
        + "evicts evidence, so it fixes the measured case rather than the defect.",
      [DisclosurePolicy.QueryOnly]:
        "Same objection, and it inverts the codebase's own canonical direction: the envelope's "
        + "existing dedup tier and productContext.task both already reference '@request.task'.",
      [DisclosurePolicy.NoDisclosure]:
        "Removes a published block where a shortening suffices (§56), and makes the omission "
        + "silent, which is the false-absence failure the projection rules forbid.",
    },
    selected:
      "IDENTITY_ONLY removes every verbatim copy while preserving the block, its shape, its "
      + "resolved parameters, all debug fidelity, and every consumer M175-A could find.",
  },
}, null, 2)}\n`);

// Per-policy artifacts, as §65 asks, for the policies actually admissible.
for (const profile of PROFILES) {
  const slug = profile.policy.toLowerCase();
  writeFileSync(path.join(RESULTS, `stage5_m175_candidate_${slug}.json`), `${JSON.stringify({
    schemaVersion: "stage5.m175.candidate.v1",
    policy: profile.policy,
    profile,
    economics: corpusRows.map((row) => ({ corpus: row.corpus, ...row.byPolicy[profile.policy]! })),
    frozen: profile.policy === FROZEN,
  }, null, 2)}\n`);
}

for (const row of corpusRows) {
  console.log(`\n${row.corpus}  n=${row.cases}  task chars median=${row.taskCharacters.median} `
    + `p90=${row.taskCharacters.p90} max=${row.taskCharacters.max}`);
  console.log("  policy                    median   p90     max    median saved");
  for (const profile of PROFILES) {
    const stats = row.byPolicy[profile.policy]!;
    console.log(
      `  ${profile.policy.padEnd(24)} ${String(stats.medianTokens).padStart(6)}`
      + ` ${String(stats.p90Tokens).padStart(6)} ${String(stats.maxTokens).padStart(6)}`
      + ` ${String(stats.medianSavedTokens).padStart(13)}`,
    );
  }
}
console.log("");
console.log("wrote results/stage5_m175_candidate_comparison.json + per-policy artifacts");
console.log(`FROZEN POLICY  ${FROZEN}`);
