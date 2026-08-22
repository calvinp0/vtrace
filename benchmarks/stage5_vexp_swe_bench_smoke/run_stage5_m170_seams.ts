/**
 * M170-B — what VTRACE already produces, and where a mediation could attach.
 *
 *   bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m170_seams.ts
 *
 * Two questions, kept apart:
 *
 *   PRODUCERS  can VTRACE answer "which lines of this file matter" without an
 *              MCP round trip, out of implementation that already exists?
 *   SEAMS      is there a supported place to put that answer where it costs no
 *              model tokens and the agent makes no extra decision?
 *
 * Every producer row is verified by importing the module and checking the
 * export exists — a documentation-derived map is how M165 found "approximately
 * 14 tools" was both true and incomplete. Every seam row is verified against
 * the shipped Claude Code binary's own strings, not against its documentation.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { writeFileSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(".");
const RESULTS = path.join(ROOT, "benchmarks/stage5_vexp_swe_bench_smoke/results");

// ── seam evidence, read from the harness itself ─────────────────────

const CLAUDE_VERSIONS = "/home/calvin/.local/share/claude/versions";
const HARNESS_VERSION = "2.1.240";
const harnessPath = path.join(CLAUDE_VERSIONS, HARNESS_VERSION);

interface SeamProbe {
  readonly needle: string;
  readonly meaning: string;
}

const SEAM_PROBES: readonly SeamProbe[] = Object.freeze([
  { needle: "updatedInput", meaning: "PreToolUse may REWRITE the tool input before the native tool runs" },
  { needle: "permission handler updatedInput failed schema", meaning: "the rewritten input is validated against the tool's own schema" },
  { needle: "updatedInput is missing or empty, falling back to original tool input", meaning: "an absent rewrite fails open to the agent's own input" },
  { needle: "permissionDecision", meaning: "PreToolUse may allow / deny / ask" },
  { needle: "additionalContext", meaning: "PostToolUse may APPEND text the model then reads" },
  { needle: "[Truncated: PARTIAL view", meaning: "Read's own partial-view disclosure exists as a string" },
  { needle: "Showing results with pagination =", meaning: "Grep declares its own bound in its own result" },
  { needle: "USE_BUILTIN_RIPGREP", meaning: "the search backend binary is selectable by environment" },
]);

let harnessBytes: Buffer | null = null;
try { harnessBytes = existsSync(harnessPath) ? readFileSync(harnessPath) : null; } catch { harnessBytes = null; }

const seamEvidence = SEAM_PROBES.map((probe) => ({
  ...probe,
  present: harnessBytes === null ? null : harnessBytes.includes(probe.needle),
}));

const SEAMS = Object.freeze([
  Object.freeze({
    seam: "S1_PRETOOLUSE_UPDATED_INPUT",
    what: "rewrite the parameters of the operation the agent already chose, then let the native tool run",
    modelVisibleTokensWhenFiring: 0,
    modelVisibleTokensWhenDeclining: 0,
    extraModelDecision: false,
    schemaTax: 0,
    failOpen: "built in — an omitted or empty updatedInput falls back to the agent's own input",
    truthfulness: "inherits whatever the native tool declares about its own bounds, which differs per tool",
    verdict: "SUPPORTED_AND_ELIGIBLE",
  }),
  Object.freeze({
    seam: "S2_PRETOOLUSE_DENY",
    what: "refuse the operation and hand the model a reason instead of a result",
    modelVisibleTokensWhenFiring: "the refusal text",
    modelVisibleTokensWhenDeclining: 0,
    extraModelDecision: true,
    schemaTax: 0,
    failOpen: "n/a",
    truthfulness: "honest, but the agent is told to do something else",
    verdict: "FORBIDDEN_BY_M170_17 — M168-E measured this exact policy losing 2 tasks and winning none",
  }),
  Object.freeze({
    seam: "S3_POSTTOOLUSE_ADDITIONAL_CONTEXT",
    what: "append material after the native result",
    modelVisibleTokensWhenFiring: "the appended text, in full",
    modelVisibleTokensWhenDeclining: 0,
    extraModelDecision: false,
    schemaTax: 0,
    failOpen: "trivial — emit nothing",
    truthfulness: "additive; cannot remove anything",
    verdict: "ELIGIBLE_ONLY_AS_DISCLOSURE — as a delivery mechanism it adds by construction (§13)",
  }),
  Object.freeze({
    seam: "S4_MCP_TOOL",
    what: "offer VTRACE as a tool the model may call",
    modelVisibleTokensWhenFiring: "response payload, measured by M166 at 8.9k tokens per call",
    modelVisibleTokensWhenDeclining: "the schema, always — M165 measured 5,521 tokens for the default surface",
    extraModelDecision: true,
    schemaTax: 5521,
    failOpen: "n/a",
    truthfulness: "the product's own contract",
    verdict: "FORBIDDEN_BY_M170_12 — requires an extra model-visible call and taxes every task that never uses it",
  }),
  Object.freeze({
    seam: "S5_SEARCH_BACKEND_SUBSTITUTION",
    what: "place a VTRACE-authored `rg` earlier on PATH and let USE_BUILTIN_RIPGREP resolve to it",
    modelVisibleTokensWhenFiring: 0,
    modelVisibleTokensWhenDeclining: 0,
    extraModelDecision: false,
    schemaTax: 0,
    failOpen: "delegate to the real ripgrep",
    truthfulness: "the Grep tool would report VTRACE's output as ripgrep's, and the substitution would also "
      + "capture every unrelated `rg` the agent runs in Bash",
    verdict: "REJECTED_BY_M170_16 — a client-version-coupled interception of a shared binary, unmeasurable "
      + "per-consumer and indistinguishable from the tool it impersonates",
  }),
]);

// ── producer evidence, read from the modules themselves ─────────────

interface ProducerSpec {
  readonly producer: string;
  readonly module: string;
  readonly exportName: string;
  readonly classification: "REUSABLE_INTERNAL_PRODUCER" | "MCP_ONLY_WRAPPER_AROUND_REUSABLE_PRODUCER" | "NOT_RELEVANT" | "WOULD_REQUIRE_NEW_CAPABILITY";
  readonly answersWhichLinesMatter: boolean;
  readonly note: string;
}

const PRODUCERS: readonly ProducerSpec[] = Object.freeze([
  {
    producer: "retrieval candidate generation",
    module: "src/retrieval/hybridRetrieval.ts", exportName: "hybridRetrieve",
    classification: "REUSABLE_INTERNAL_PRODUCER", answersWhichLinesMatter: true,
    note: "ranks symbols repo-wide against task prose; filtered to one file it yields ranked in-file spans. "
      + "This is what M170-C used. It is a pure function of (db, input) — no MCP, no server, no session.",
  },
  {
    producer: "symbol span lookup",
    module: "src/db/repositories/symbolsRepository.ts", exportName: "listSymbolsForFile",
    classification: "REUSABLE_INTERNAL_PRODUCER", answersWhichLinesMatter: true,
    note: "start/end line and parent for every symbol in a file. Sub-millisecond. This is the whole of what "
      + "a window needs once a symbol is chosen.",
  },
  {
    producer: "symbol name search (plain SQL / FTS)",
    module: "src/retrieval/searchSymbols.ts", exportName: "searchSymbols",
    classification: "REUSABLE_INTERNAL_PRODUCER", answersWhichLinesMatter: false,
    note: "a NAME lookup. Handed 2,597 characters of issue prose it returned zero results on astropy-14369 "
      + "and matplotlib-22719 — it is not a prose ranker and must not be used as one.",
  },
  {
    producer: "query shaping / intent derivation",
    module: "src/capsule/sweQueryShaping.ts", exportName: "shapeSweQuery",
    classification: "REUSABLE_INTERNAL_PRODUCER", answersWhichLinesMatter: false,
    note: "turns issue prose into the shaped query hybridRetrieve expects. Required to use retrieval at all.",
  },
  {
    producer: "impact graph",
    module: "src/impact/getImpactGraph.ts", exportName: "getImpactGraph",
    classification: "REUSABLE_INTERNAL_PRODUCER", answersWhichLinesMatter: false,
    note: "callers/callees of a symbol. Relevant to a search-to-graph design, which §13 disqualifies as "
      + "additive, not to read narrowing.",
  },
  {
    producer: "structural skeleton",
    module: "src/skeleton/getSkeleton.ts", exportName: "getIndexedSkeletonFileResult",
    classification: "REUSABLE_INTERNAL_PRODUCER", answersWhichLinesMatter: true,
    note: "a whole-file structural view. An alternative to a line window, but it is a DIFFERENT artifact than "
      + "the file the agent asked to read, so substituting it is replacement, not narrowing.",
  },
  {
    producer: "pivot neighborhood excerpts",
    module: "src/runPipeline/pivotNeighborhood.ts", exportName: "buildPivotNeighborhoods",
    classification: "REUSABLE_INTERNAL_PRODUCER", answersWhichLinesMatter: true,
    note: "already produces bounded symbol-window excerpts with honest reasons. Its windows are chosen from "
      + "pivots, so it presupposes the pipeline has run — the thing M169 closed.",
  },
  {
    producer: "logic flow",
    module: "src/logicFlow/searchLogicFlow.ts", exportName: "searchLogicFlow",
    classification: "NOT_RELEVANT", answersWhichLinesMatter: false,
    note: "needs two resolved endpoints; an ordinary Read supplies one path and no endpoints.",
  },
  {
    producer: "workspace routing",
    module: "src/workspace/productRoute.ts", exportName: "resolveProductRoute",
    classification: "REUSABLE_INTERNAL_PRODUCER", answersWhichLinesMatter: false,
    note: "maps a path to the repository whose index owns it. A mediation running under an agent with a cwd "
      + "needs exactly this, and M132 established repo_root is the contract.",
  },
  {
    producer: "index readiness",
    module: "src/workspace/readiness.ts", exportName: "evaluateRepoReadiness",
    classification: "REUSABLE_INTERNAL_PRODUCER", answersWhichLinesMatter: false,
    note: "the fail-open gate: no ready index, no mediation. M164 repaired this and M141 unified it.",
  },
  {
    producer: "productContext assembly",
    module: "src/productContext/assembleProductContext.ts", exportName: "assembleProductContext",
    classification: "MCP_ONLY_WRAPPER_AROUND_REUSABLE_PRODUCER", answersWhichLinesMatter: false,
    note: "assembles the response M166 measured as 81% non-evidence. A mediation wants the producers beneath "
      + "it, never the assembled response.",
  },
  {
    producer: "document indexing",
    module: "src/documents/documentRetrieval.ts", exportName: "retrieveIndexedDocuments",
    classification: "NOT_RELEVANT", answersWhichLinesMatter: false,
    note: "prose documents, not source line ranges.",
  },
]);

const producerRows = await Promise.all(PRODUCERS.map(async (spec) => {
  const absolute = path.join(ROOT, spec.module);
  let exportPresent: boolean | null = null;
  let moduleExists = false;
  try {
    moduleExists = existsSync(absolute) && statSync(absolute).isFile();
    if (moduleExists) {
      const imported = (await import(absolute)) as Record<string, unknown>;
      exportPresent = typeof imported[spec.exportName] === "function";
    }
  } catch {
    exportPresent = false;
  }
  return { ...spec, moduleExists, exportPresent };
}));

const report = {
  schemaVersion: "stage5.m170.seams-and-producers.v1",
  milestone: "M170",
  workstream: "B",
  title: "Integration seams and reusable producers for transparent mediation",
  method: {
    seamEvidence: "string presence in the shipped Claude Code executable, not documentation",
    harnessVersion: HARNESS_VERSION,
    harnessReadable: harnessBytes !== null,
    producerEvidence: "each module imported and the named export checked at runtime",
    liveSpendUsd: 0,
  },
  seamEvidence,
  seams: SEAMS,
  selectedSeam: "S1_PRETOOLUSE_UPDATED_INPUT",
  selectedSeamRationale:
    "the only seam that costs zero model-visible tokens whether it fires or not, requires no extra model "
    + "decision, adds no schema, and fails open by the harness's own rule. It is also the only one that can "
    + "REDUCE rather than add, because it acts before the native tool produces its result.",
  fixedModelVisibleOverhead: {
    whenEnabledAndNeverFiring: 0,
    whenDeclining: 0,
    whenFiring: "the disclosure line only — measured per operation in M170-C, not a fixed cost",
    comparedToM169Pipeline: "the mandatory pipeline's fixed cost was $0.0985 per task before any operation "
      + "was improved; this seam's is $0.00",
  },
  producers: producerRows,
  newCapabilitiesRequired: producerRows.filter((r) => r.classification === "WOULD_REQUIRE_NEW_CAPABILITY").map((r) => r.producer),
  producerVerdict:
    "no new capability is required. Read narrowing needs exactly two producers that already exist and are "
    + "already pure functions over the index database: hybridRetrieve to rank, listSymbolsForFile to resolve "
    + "spans. No fifteenth analysis tool is implied by any of this.",
};

const out = path.join(RESULTS, "stage5_m170_seams_and_producers.json");
writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);

console.log(`harness readable: ${harnessBytes !== null} (${HARNESS_VERSION})`);
for (const probe of seamEvidence) console.log(`  ${probe.present === true ? "PRESENT" : probe.present === false ? "ABSENT " : "UNKNOWN"}  ${probe.needle}`);
console.log("producers:");
for (const row of producerRows) {
  console.log(`  ${row.exportPresent === true ? "OK  " : "MISS"} ${row.classification.padEnd(46)} ${row.module}::${row.exportName}`);
}
console.log(`→ ${out}`);
