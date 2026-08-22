/**
 * M171-B — emit the frozen contract artifacts.
 *
 *   bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m171_contract.ts
 *
 * The disclosure matrix is emitted FROM the table the projector actually
 * consults, and is accompanied by the coverage check that gives §10 its teeth:
 * any path in a real response that no rule classifies is reported here, and a
 * non-empty list fails B.
 *
 * The population manifests are frozen here, before any holdout number exists,
 * and name the development/holdout overlap rather than hiding it (§32).
 */

import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { DISCLOSURE_MATRIX, unclassifiedPaths } from "./m171Disclosure";
import { FROZEN_PHRASES, NEIGHBOR_RELATION_PHRASES, ORIENTATION_BOUNDARY, ORIENTATION_SCHEMA_VERSION, RUNGS } from "./m171Projection";

const ROOT = path.resolve(".");
const BENCH = path.join(ROOT, "benchmarks/stage5_vexp_swe_bench_smoke");
const RESULTS = path.join(BENCH, "results");
const CAPTURE = path.join(RESULTS, "_m171_capture", "dev");

const DEVELOPMENT_CASES: readonly string[] = Object.freeze([
  "astropy__astropy-14369", "django__django-13658", "matplotlib__matplotlib-22719",
  "mwaskom__seaborn-3187", "pallets__flask-5014", "psf__requests-1724",
  "pydata__xarray-6599", "pylint-dev__pylint-4551", "pytest-dev__pytest-7432",
  "scikit-learn__scikit-learn-10844", "sphinx-doc__sphinx-7462", "sympy__sympy-13480",
]);

const write = (name: string, body: unknown): void => {
  writeFileSync(path.join(RESULTS, name), `${JSON.stringify(body, null, 1)}\n`);
  process.stdout.write(`wrote ${name}\n`);
};

// ---- disclosure matrix + coverage check ---------------------------

const unclassified = new Set<string>();
let inspected = 0;
for (const file of readdirSync(CAPTURE).filter((name) => name.endsWith(".json"))) {
  const captured = JSON.parse(readFileSync(path.join(CAPTURE, file), "utf-8")) as Record<string, any>;
  for (const mode of ["default", "debug"] as const) {
    const output = captured[mode]?.structuredContent?.result?.output;
    if (output === undefined || output === null) continue;
    inspected += 1;
    for (const unmatched of unclassifiedPaths(output as Record<string, unknown>)) unclassified.add(unmatched);
  }
}

const byClass: Record<string, number> = {};
for (const entry of DISCLOSURE_MATRIX) byClass[entry.disclosure] = (byClass[entry.disclosure] ?? 0) + 1;

write("stage5_m171_disclosure_matrix.json", {
  schemaVersion: "stage5.m171.disclosure-matrix.v1",
  milestone: "M171",
  workstream: "M171-B",
  title: "Every field of the current default response, classified with a reason",
  classes: {
    ALWAYS_MODEL_VISIBLE: "in every default packet",
    VISIBLE_WHEN_NONDEFAULT: "only when its value is not the quiet case",
    VISIBLE_WHEN_INTERPRETATION_CRITICAL: "only when omitting it would let a reader misread a claim the packet DOES make",
    DEBUG_ONLY: "retained, reachable at detail=debug",
    INTERNAL_ONLY: "never serialized in any mode",
  },
  rulesPerClass: byClass,
  coverageCheck: {
    responsesInspected: inspected,
    unclassifiedPaths: [...unclassified].sort(),
    passes: unclassified.size === 0,
    meaning: "§10 — no field disappears by intuition. A path no rule covers is a failure, not a silent omission.",
  },
  internalOnly: {
    note: "Nothing currently in the response is INTERNAL_ONLY: every field is at least reachable at detail=debug (§78). The class exists for state the pipeline computes and has never serialized.",
    examples: [
      "the full retrieval candidate population and its scores",
      "ranking intermediates inside the hybrid retriever",
      "pivotNeighborhood[].excerpts[].text, already stripped before any response is emitted",
    ],
  },
  matrix: DISCLOSURE_MATRIX,
});

// ---- populations ---------------------------------------------------

const fixtureIds = (file: string): string[] =>
  (JSON.parse(readFileSync(path.join(BENCH, file), "utf-8")) as { instance_id: string }[]).map((row) => row.instance_id);

const broadA = fixtureIds("retrieval_eval.m155_broad_100.json");
const broadB = fixtureIds("retrieval_eval.m160_broad_b.json");
const developmentInA = DEVELOPMENT_CASES.filter((id) => broadA.includes(id));
const developmentInB = DEVELOPMENT_CASES.filter((id) => broadB.includes(id));

write("stage5_m171_development_manifest.json", {
  schemaVersion: "stage5.m171.development-manifest.v1",
  milestone: "M171",
  workstream: "M171-B",
  title: "The design population, frozen before the projector was tuned",
  rationale: "§30 — historical material already repeatedly inspected. These twelve carry M168 live transcripts, M169 per-case cost attribution and fresh indexes, and are contaminated for benchmark-quality inference anyway.",
  cases: DEVELOPMENT_CASES,
  liveTranscripts: "results/runs/m168_vtrace_clean_*/raw/vtrace/_agent_stream.first_pass.jsonl",
  costAttribution: "stage5_m169_economic_classes.json rows[]",
  freshIndexRoot: "results/workspaces/m169_broad_a/<instance_id>",
});

write("stage5_m171_holdout_manifest.json", {
  schemaVersion: "stage5.m171.holdout-manifest.v1",
  milestone: "M171",
  workstream: "M171-B",
  title: "The holdout populations and the contamination between them, named",
  broad100a: {
    cases: broadA.length,
    identity: "the exact public VEXP 100-task manifest (M168)",
    freshIndexRoot: "results/workspaces/m169_broad_a/<instance_id>",
    developmentMembers: developmentInA,
    remainder: broadA.length - developmentInA.length,
    inferenceRule: "§32 — primary A inference uses the non-development remainder. Full A is reported alongside and never substituted for it.",
  },
  broad100b: {
    cases: broadB.length,
    identity: "independent, disjoint from A",
    freshIndexRoot: "per-fixture workspace field",
    developmentMembers: developmentInB,
    remainder: broadB.length - developmentInB.length,
    inferenceRule: "§71 — B is never tuned against. If B fails, the milestone closes MIXED rather than adjusting the contract.",
  },
  disjoint: broadA.filter((id) => broadB.includes(id)).length === 0,
});

// ---- the contract itself, machine-readable -------------------------

write("stage5_m171_orientation_contract.json", {
  schemaVersion: "stage5.m171.orientation-contract.v1",
  milestone: "M171",
  workstream: "M171-B",
  packetSchemaVersion: ORIENTATION_SCHEMA_VERSION,
  shape: {
    schemaVersion: "contract identity",
    state: "resolved | no_evidence | not_ready | failed",
    focus: "{ at, file, lines, form, why, code, codeTruncated } — the primary target, or null when not resolved",
    related: "[{ at, file, lines, how }] — named locations with a verbatim or frozen relationship label; never excerpts",
    boundary: "the single global claim boundary, on every packet",
    notes: "interpretation-critical only; absent when there is nothing to say",
    problem: "present only on a non-resolved state; never compressed (§11, §79)",
  },
  priorityClasses: {
    P0: "state, focus identity, boundary — always",
    P1: "focus source excerpt, head-bounded, labelled with its form",
    P2: "related locations with relationship labels, in authoritative order",
    P3: "interpretation-critical notes",
    "P4+": "nothing. Additional support, impact detail, memory, flow and provenance are not in a default orientation at any rung.",
  },
  authoredText: {
    rule: "§49 — every string is either a verbatim authoritative string or one of the frozen phrases below. A claim is never re-worded.",
    frozenPhrases: FROZEN_PHRASES,
    boundary: ORIENTATION_BOUNDARY,
    neighborRelationPhrases: NEIGHBOR_RELATION_PHRASES,
    failsClosed: "a pivot-neighborhood reason absent from the phrase table carries no claim and the neighbour is dropped",
  },
  rungs: RUNGS,
  ceilingNotTarget: "§17/§46 — the rung bounds the packet and is never filled. The projector has no notion of remaining space, so a packet complete at 400 tokens under a 2,000 ceiling stays at 400.",
  sourceOfCode: "productContext.modelVisibleContext, the only place a serialized response carries source text. The packet can therefore never show source the current default does not already disclose (§38).",
  orderingRule: "§37 — authoritative order only: productContext.items as the pipeline delivered them, then pivotNeighborhood excerpts. relatedCap takes a PREFIX, which is what makes the rungs nested.",
});

if (unclassified.size > 0) {
  process.stdout.write(`\nCOVERAGE FAILURE: ${unclassified.size} unclassified paths\n`);
  process.exitCode = 1;
}
