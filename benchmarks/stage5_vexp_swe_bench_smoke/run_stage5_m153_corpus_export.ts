// Export the behavioural cross-repository corpus as frozen JSON artifacts.
//
// The TypeScript module is the single source of truth; these JSON files are a
// serialisation of it, so a hand-edit to the JSON cannot silently diverge from
// what the evaluators actually read. Regenerating is idempotent — if the corpus
// has not changed, neither has the output.
//
//   bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m153_corpus_export.ts --out <dir>
//
// No agent, Docker, VEXP, network or paid API.

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  BEHAVIORAL_CASES,
  CALIBRATION_REPOSITORIES,
  CORPUS_REPOSITORIES,
  GROUND_TRUTH_FILE_DIGESTS,
  HOLDOUT_REPOSITORIES,
  splitOf,
} from "./behavioralCrossRepoCorpus";

function argument(flag: string, fallback: string): string {
  const index = process.argv.indexOf(flag);
  return index === -1 ? fallback : (process.argv[index + 1] ?? fallback);
}

function tally<T>(items: readonly T[], key: (item: T) => string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const item of items) out[key(item)] = (out[key(item)] ?? 0) + 1;
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)));
}

const outDir = argument("--out", "benchmarks/stage5_vexp_swe_bench_smoke/results");
await mkdir(outDir, { recursive: true });

const corpus = {
  name: "behavioral_cross_repo",
  version: 1,
  purpose:
    "Measure whether behavioural retrieval and repository nomination generalise to repositories that supplied no development pressure. ARC is deliberately absent.",
  repositories: CORPUS_REPOSITORIES,
  groundTruthFileDigests: GROUND_TRUTH_FILE_DIGESTS,
  cases: BEHAVIORAL_CASES.map((entry) => ({ ...entry, split: splitOf(entry) })),
  summary: {
    cases: BEHAVIORAL_CASES.length,
    repositories: CORPUS_REPOSITORIES.length,
    byRepository: tally(BEHAVIORAL_CASES, (c) => c.expectedRepository ?? "(ambiguous)"),
    bySplit: tally(BEHAVIORAL_CASES, (c) => splitOf(c)),
    byCategory: tally(BEHAVIORAL_CASES, (c) => c.category),
    byQueryKind: tally(BEHAVIORAL_CASES, (c) => c.queryKind),
    falsePremise: BEHAVIORAL_CASES.filter((c) => c.falsePremise).length,
    expectAbsence: BEHAVIORAL_CASES.filter((c) => c.expectAbsence === true).length,
    ambiguous: BEHAVIORAL_CASES.filter((c) => c.ambiguous === true).length,
    distractorsRecorded: BEHAVIORAL_CASES.reduce((sum, c) => sum + c.distractors.length, 0),
    expectedEvidenceItems: BEHAVIORAL_CASES.reduce((sum, c) => sum + c.expected.length, 0),
    multiPartCases: BEHAVIORAL_CASES.filter((c) => c.expected.length > 1).length,
  },
};

// §72/§73: the split is frozen BEFORE any algorithm work and is by repository,
// not by query, so a holdout case cannot share a repository with a calibration
// case that was tuned against.
const split = {
  policy: "by_repository",
  frozenBefore: "any M153 routing implementation",
  rationale:
    "Holding out whole repositories is stronger than holding out random queries: a held-out query from a tuned repository still benefits from that repository's vocabulary and structure having been examined.",
  calibration: {
    repositories: CALIBRATION_REPOSITORIES,
    cases: BEHAVIORAL_CASES.filter((c) => splitOf(c) === "calibration").map((c) => c.id),
  },
  holdout: {
    repositories: HOLDOUT_REPOSITORIES,
    cases: BEHAVIORAL_CASES.filter((c) => splitOf(c) === "holdout").map((c) => c.id),
  },
  ambiguous: {
    note: "Span repositories by construction; scored separately and counted in neither aggregate.",
    cases: BEHAVIORAL_CASES.filter((c) => splitOf(c) === "ambiguous").map((c) => c.id),
  },
  externalHoldouts: {
    arc: "Run ONLY after the M153 functional candidate is frozen. Never calibration data.",
    tckdb: "Final holdout; no tuning after inspection.",
  },
};

// The per-case ground-truth record, generated rather than hand-written so it
// cannot drift from the module the evaluators actually read (§31).
const groundTruth: string[] = [
  "# M153-A — behavioural cross-repository corpus: ground truth",
  "",
  "Generated from `behavioralCrossRepoCorpus.ts` by `run_stage5_m153_corpus_export.ts`.",
  "Do not hand-edit. Every span below was read from the pinned checkout and is",
  "mechanically verified to match the symbol's actual line range.",
  "",
];
for (const repo of CORPUS_REPOSITORIES) {
  const cases = BEHAVIORAL_CASES.filter((entry) => entry.expectedRepository === repo.key);
  groundTruth.push(
    `## ${repo.key} — ${repo.domain} (${repo.split.toUpperCase()})`,
    "",
    `Instance \`${repo.instanceId}\` @ \`${repo.baseCommit}\` — ${cases.length} cases.`,
    "",
  );
  for (const entry of cases) {
    groundTruth.push(`### \`${entry.id}\` — ${entry.category}`, "");
    groundTruth.push(`> ${entry.query}`, "");
    const flags = [
      `phrasing: ${entry.queryKind}`,
      `falsePremise: ${entry.falsePremise}`,
      ...(entry.expectAbsence === true ? ["**expects a bounded absence**"] : []),
      ...(entry.pairedControl !== undefined ? [`paired with \`${entry.pairedControl}\``] : []),
    ];
    groundTruth.push(flags.join(" · "), "");
    groundTruth.push(entry.groundTruth, "");
    if (entry.expected.length > 0) {
      groundTruth.push("| Role | Symbol | Span | Why |", "| --- | --- | --- | --- |");
      for (const item of entry.expected) {
        groundTruth.push(
          `| ${item.role} | \`${item.fqName}\` | \`${item.sourceSpan}\` | ${item.why} |`,
        );
      }
      groundTruth.push("");
    }
    if (entry.acceptableAlternates !== undefined && entry.acceptableAlternates.length > 0) {
      groundTruth.push(
        `Acceptable alternates: ${entry.acceptableAlternates.map((a) => `\`${a}\``).join(", ")}`,
        "",
      );
    }
    if (entry.distractors.length > 0) {
      groundTruth.push("| Distractor | Kind | Why it attracts |", "| --- | --- | --- |");
      for (const item of entry.distractors) {
        groundTruth.push(`| \`${item.fqName}\` | ${item.kind} | ${item.why} |`);
      }
      groundTruth.push("");
    }
  }
}
const ambiguousCases = BEHAVIORAL_CASES.filter((entry) => entry.expectedRepository === null);
groundTruth.push("## Ambiguous — no single correct repository", "");
for (const entry of ambiguousCases) {
  groundTruth.push(`### \`${entry.id}\` — ${entry.category}`, "", `> ${entry.query}`, "");
  groundTruth.push(entry.groundTruth, "");
}
groundTruth.push("## Ground-truth file digests", "", "| Repository | File | sha256[0:16] |", "| --- | --- | --- |");
for (const digest of GROUND_TRUTH_FILE_DIGESTS) {
  groundTruth.push(`| ${digest.repository} | \`${digest.path}\` | \`${digest.sha256Prefix}\` |`);
}
groundTruth.push("");

await writeFile(
  path.join(outDir, "stage5_m153_behavioral_ground_truth.md"),
  groundTruth.join("\n"),
);
await writeFile(
  path.join(outDir, "stage5_m153_behavioral_corpus.json"),
  `${JSON.stringify(corpus, null, 2)}\n`,
);
await writeFile(
  path.join(outDir, "stage5_m153_corpus_split.json"),
  `${JSON.stringify(split, null, 2)}\n`,
);

console.log(`cases=${corpus.summary.cases} repos=${corpus.summary.repositories}`);
console.log(`split=${JSON.stringify(corpus.summary.bySplit)}`);
console.log(`falsePremise=${corpus.summary.falsePremise} absence=${corpus.summary.expectAbsence}`);
console.log(`distractors=${corpus.summary.distractorsRecorded} multiPart=${corpus.summary.multiPartCases}`);
console.log(`wrote stage5_m153_behavioral_corpus.json + stage5_m153_corpus_split.json → ${outDir}`);
