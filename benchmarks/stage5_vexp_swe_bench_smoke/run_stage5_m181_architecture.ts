/**
 * M181-A — selection-reason architecture and authority audit.
 *
 *   bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m181_architecture.ts
 *
 * Every structural claim this milestone rests on is a claim about source code,
 * so every one of them is CHECKED against the source rather than asserted from a
 * reading. `verify()` re-reads the recorded file, takes the recorded line, and
 * requires the recorded expression to still be on it. A claim whose evidence has
 * moved fails the runner instead of silently becoming folklore — which is the
 * failure mode that let `compactReasons` and the orientation projector disagree
 * about position 0 for two milestones without anyone noticing.
 *
 * Offline, pure, deterministic. Live spend $0.00.
 */

import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import {
  COMPACT_PREFERRED_PATTERN, COMPACT_REASON_CHARACTERS, REASON_FAMILY,
  asArray, hashOf, isRecord, reasonFamily, reasonWitnesses,
} from "./m181Reasons";

const REPO = path.resolve(".");
const RESULTS = path.join(REPO, "benchmarks/stage5_vexp_swe_bench_smoke/results");
const CORPUS_ROOT = path.join(RESULTS, "_m179_authoritative");

interface SourceClaim {
  readonly id: string;
  readonly file: string;
  readonly line: number;
  /** A substring that must appear on that line for the claim to still hold. */
  readonly expression: string;
  readonly claim: string;
}

interface VerifiedClaim extends SourceClaim {
  readonly verified: boolean;
  readonly actualLine: string;
}

const sourceCache = new Map<string, string[]>();
function lines(file: string): string[] {
  const cached = sourceCache.get(file);
  if (cached !== undefined) return cached;
  const value = readFileSync(path.join(REPO, file), "utf8").split("\n");
  sourceCache.set(file, value);
  return value;
}

function verify(claim: SourceClaim): VerifiedClaim {
  const actual = lines(claim.file)[claim.line - 1] ?? "";
  return { ...claim, verified: actual.includes(claim.expression), actualLine: actual.trim().slice(0, 200) };
}

/**
 * §9 — every place that creates or appends `selectionReasons`.
 *
 * `evidenceCondition` is what makes the producer fire; `orderIntentional` records
 * whether the order the producer emits is a declared contract or a by-product.
 */
const PRODUCERS: ReadonlyArray<SourceClaim & {
  readonly reasonKind: string;
  readonly orderIntentional: boolean;
  readonly multipleReasons: boolean;
  readonly duplicatesPossible: boolean;
  readonly domain: string;
}> = [
  {
    id: "P1_source_draft",
    file: "src/productContext/assembleProductContext.ts",
    line: 408,
    expression: "unique([item.roleReason, ...item.evidence]",
    claim: "Pivot/support items: the decisive role reason FIRST, then ordered retrieval evidence.",
    reasonKind: "roleReason ++ evidence[]",
    orderIntentional: true,
    multipleReasons: true,
    duplicatesPossible: false,
    domain: "mixed: position 0 is semantic role, the tail is provenance",
  },
  {
    id: "P1_role_reason_contract",
    file: "src/capsuleV2/productAdapter.ts",
    line: 48,
    expression: "The decisive reason this item landed in its role",
    claim: "THE GOVERNING SENTENCE. `roleReason` is DECLARED decisive at its definition.",
    reasonKind: "roleReason (declaration)",
    orderIntentional: true,
    multipleReasons: false,
    duplicatesPossible: false,
    domain: "semantic role",
  },
  {
    id: "P1_evidence_contract",
    file: "src/capsuleV2/productAdapter.ts",
    line: 56,
    expression: "Ordered evidence: why this item was selected",
    claim: "`evidence` is declared ORDERED, so its head is not arbitrary either.",
    reasonKind: "evidence[] (declaration)",
    orderIntentional: true,
    multipleReasons: true,
    duplicatesPossible: false,
    domain: "provenance",
  },
  {
    id: "P2_coedit_hint",
    file: "src/productContext/assembleProductContext.ts",
    line: 460,
    expression: "unique([hint.hint, ...hint.evidence])",
    claim: "High-confidence co-edit hints: the hint text first, then its evidence.",
    reasonKind: "hint ++ evidence[]",
    orderIntentional: true,
    multipleReasons: true,
    duplicatesPossible: false,
    domain: "relation (co-edit) + provenance",
  },
  {
    id: "P3_impact_relation",
    file: "src/productContext/assembleProductContext.ts",
    line: 510,
    expression: "selectionReasons: [`${relation} of ${pivot.fqName}`]",
    claim: "Impact neighbours carry exactly one reason: the indexed relation to a pivot.",
    reasonKind: "single relation string",
    orderIntentional: false,
    multipleReasons: false,
    duplicatesPossible: false,
    domain: "actionable relation",
  },
  {
    id: "P4_memory_signals",
    file: "src/productContext/assembleProductContext.ts",
    line: 586,
    expression: "result.signals.map((signal) => signal.kind)",
    claim: "Memory items carry signal KINDS, in scorer order.",
    reasonKind: "signal kind[]",
    orderIntentional: false,
    multipleReasons: true,
    duplicatesPossible: false,
    domain: "provenance",
  },
  {
    id: "P5_project_rule",
    file: "src/productContext/assembleProductContext.ts",
    line: 604,
    expression: "selectionReasons: [selected.reason]",
    claim: "Project rules carry exactly one reason.",
    reasonKind: "single rule reason",
    orderIntentional: false,
    multipleReasons: false,
    duplicatesPossible: false,
    domain: "provenance",
  },
  {
    id: "P6_dedupe_merge",
    file: "src/productContext/assembleProductContext.ts",
    line: 621,
    expression: "unique([...existing.selectionReasons, ...draft.selectionReasons])",
    claim: "Merging duplicates APPENDS: the surviving draft keeps position 0, so the merge cannot displace a decisive reason. Drafts are sorted by roleOrder first, so the merge order is deterministic.",
    reasonKind: "union",
    orderIntentional: true,
    multipleReasons: true,
    duplicatesPossible: false,
    domain: "mixed",
  },
];

/** §13 — every material consumer of `selectionReasons` or a reason derived from it. */
const CONSUMERS: ReadonlyArray<SourceClaim & {
  readonly reads: string;
  readonly agentVisible: boolean;
  readonly affectsSelection: boolean;
}> = [
  {
    id: "C1_orientation_related",
    file: "src/runPipeline/orientationProjection.ts",
    line: 329,
    expression: "item.reasons[0] ?? item.roles.join(\", \")",
    claim: "THE MODEL-FACING CLAIM. The projector reuses position 0 verbatim as `related[].how`, the relationship claim about the item.",
    reads: "reasons[0]",
    agentVisible: true,
    affectsSelection: false,
  },
  {
    id: "C1_orientation_contract",
    file: "src/runPipeline/orientationProjection.ts",
    line: 327,
    expression: "first selection reason IS the relationship claim",
    claim: "The projector's own declared contract for position 0.",
    reads: "reasons[0]",
    agentVisible: true,
    affectsSelection: false,
  },
  {
    id: "C2_orientation_focus",
    file: "src/runPipeline/orientationProjection.ts",
    line: 295,
    expression: "why: focusItem.reasons[0] ?? null",
    claim: "The focus item's `why` is position 0 as well.",
    reads: "reasons[0]",
    agentVisible: true,
    affectsSelection: false,
  },
  {
    id: "C3_assembly_render",
    file: "src/productContext/assembleProductContext.ts",
    line: 690,
    expression: "lines.push(`why: ${reason}`)",
    claim: "The assembly layer renders EVERY reason as a `why:` line in modelVisibleContext.",
    reads: "all reasons",
    agentVisible: true,
    affectsSelection: false,
  },
  {
    id: "C4_delivery_render",
    file: "src/productContext/budgetDelivery.ts",
    line: 401,
    expression: "lines.push(`why: ${reason}`)",
    claim: "The delivery layer re-renders the same `why:` lines after compaction — this is where a compacted reason becomes model-visible prose.",
    reads: "all surviving reasons",
    agentVisible: true,
    affectsSelection: false,
  },
  {
    id: "C5_answer_bearing",
    file: "src/productContext/budgetDelivery.ts",
    line: 344,
    expression: "directEvidence.includes(\"symbol-name match\")",
    claim: "SELECTION-AFFECTING, AND IT READS THE WHOLE SET. `answerBearing` joins ALL reasons (line 342) and tests for the same four substrings `compactReasons` prefers. It is computed in `mutableItem`, BEFORE `compactReasons` runs, so which reason is displayed cannot feed back into it.",
    reads: "all reasons, joined",
    agentVisible: false,
    affectsSelection: true,
  },
  {
    id: "C6_compact_reasons",
    file: "src/productContext/budgetDelivery.ts",
    line: 428,
    expression: "const preferred = reasons.find((reason) =>",
    claim: "THE TRANSFORM UNDER TEST. Reduces the array to one reason, preferring a substring match over position 0.",
    reads: "all reasons",
    agentVisible: true,
    affectsSelection: false,
  },
  {
    id: "C7_compact_call_site",
    file: "src/productContext/budgetDelivery.ts",
    line: 165,
    expression: "item.selectionReasons = compactReasons(item.selectionReasons)",
    claim: "Applied to every item, unconditionally, as the FIRST compaction rung — before any source body is touched.",
    reads: "all reasons",
    agentVisible: true,
    affectsSelection: false,
  },
  {
    id: "C8_envelope_slice",
    file: "src/mcp/responseEnvelope.ts",
    line: 1668,
    expression: "selectionReasons: reasons.slice(0, 1)",
    claim: "The metadata layer independently slices to position 0 — it keeps the FIRST reason, not the preferred one. The envelope and the evidence layer already disagree about which reason matters.",
    reads: "all reasons",
    agentVisible: true,
    affectsSelection: false,
  },
  {
    id: "C9_envelope_drop",
    file: "src/mcp/responseEnvelope.ts",
    line: 1914,
    expression: "delete next.selectionReasons",
    claim: "A later metadata rung drops reasons entirely, recording the count in `selectionReasonsOmitted`.",
    reads: "all reasons",
    agentVisible: true,
    affectsSelection: false,
  },
  {
    id: "C10_schema",
    file: "src/mcp/tools.ts",
    line: 8395,
    expression: "selectionReasons: arrayProperty(\"Evidence-backed selection reasons.\"",
    claim: "The published schema describes the field as evidence-backed reasons, plural — it makes no claim of exclusivity for any one of them.",
    reads: "declaration",
    agentVisible: true,
    affectsSelection: false,
  },
];

/** §12 — what `compactReasons` actually is, verified line by line. */
function compactReasonsAudit(): Record<string, unknown> {
  const body = lines("src/productContext/budgetDelivery.ts").slice(426, 431).join("\n");
  const literal = /\/(?<pattern>[^/]+)\/iu/u.exec(body);
  const productPattern = literal?.groups?.pattern ?? "";
  return {
    file: "src/productContext/budgetDelivery.ts",
    lines: "427-431",
    body: body.trim(),
    // The instrument's mirror must be the product's regex, character for
    // character, or every family statement derived from it is about the wrong
    // predicate.
    mirrorMatchesProduct: productPattern === COMPACT_PREFERRED_PATTERN.source,
    productPattern,
    mirrorPattern: COMPACT_PREFERRED_PATTERN.source,
    steps: {
      filtering: "none — no reason is discarded for being untrue",
      dedupe: "none — the array is already `unique()`d upstream",
      priorityRule: "first reason matching /preferred contrast|symbol-name match|direct evidence|exact/iu",
      sorting: "none",
      fallback: "reasons[0]",
      output: "exactly one reason, ellipsized past 160 characters",
    },
    basisOfPreference: "SUBSTRING MATCH, and the substrings are `answerBearing`'s. There is no reason-priority enum, no ordering table, no test, and no comment stating an intent. The same four substrings decide which ITEM to keep (line 342-346); reusing them to rank an EXPLANATION is the collision.",
    documented: false,
    testedDirectly: false,
    introducedBy: "f48f8c11 'Preserve context under tight token budgets' (M136, 2026-08-09)",
    predatesConsumer: "The orientation projector, the only consumer that treats position 0 as a semantic claim, shipped in M172 — AFTER this transform. compactReasons was written when reasons were only ever rendered as a list of `why:` lines, where reducing five to one had no canonical answer to violate.",
    ellipsisCharacters: COMPACT_REASON_CHARACTERS,
  };
}

/** §11 — where the ordering comes from. */
function orderingAudit(verified: readonly VerifiedClaim[]): Record<string, unknown> {
  return {
    question: "Does selectionReasons[0] have semantic authority, or is it construction order?",
    answer: "DECLARED AUTHORITY, on the producer that emits multi-reason items.",
    chain: [
      "productAdapter.ts:48 declares roleReason `The decisive reason this item landed in its role`.",
      "assembleProductContext.ts:408 builds `unique([roleReason, ...evidence].filter(Boolean))`, so the decisive reason is position 0 whenever it is non-empty.",
      "assembleProductContext.ts:621 merges duplicates by APPENDING, so a merge cannot displace it; drafts are pre-sorted by roleOrder, so the merge is deterministic.",
      "orientationProjection.ts:327-329 declares position 0 to be the relationship claim and reuses it verbatim.",
    ],
    candidateSources: {
      insertionOrder: "true but not the whole story — the insertion is itself ordered by a declared contract",
      candidateGenerationOrder: false,
      scoreOrder: false,
      explicitReasonPriority: "no enum exists",
      setOrMapIteration: "no — `unique()` preserves first-seen order over an explicitly ordered input",
      sortComparator: "none applied to reasons",
      historicalAccident: false,
    },
    caveat: "Position 0 is `roleReason` only while `roleReason` is non-empty; `.filter(Boolean)` promotes evidence[0] otherwise. Producers P3/P4/P5 emit a single reason or a scorer-ordered list, where the question does not arise.",
    verifiedClaims: verified.filter((claim) => claim.id.startsWith("P")).length,
  };
}

function loadCorpus(corpus: string): Array<{ instanceId: string; authoritative: unknown }> {
  const dir = path.join(CORPUS_ROOT, corpus);
  const cases: Array<{ instanceId: string; authoritative: unknown }> = [];
  for (const file of readdirSync(dir).sort()) {
    if (!file.endsWith(".json")) continue;
    const capture = JSON.parse(readFileSync(path.join(dir, file), "utf8")) as { instanceId: string; snapshot: unknown };
    if (capture.snapshot === null) continue;
    cases.push({ instanceId: capture.instanceId, authoritative: capture.snapshot });
  }
  return cases;
}

/** §10 — the vocabulary, from the corpus rather than from imagination. */
function vocabulary(): Record<string, unknown> {
  const byFamily = new Map<string, { count: number; distinct: Set<string>; samples: string[] }>();
  const counts: number[] = [];
  let items = 0;
  let single = 0;
  let disagreements = 0;
  const witnessSets: Record<string, unknown>[] = [];

  for (const corpus of ["broad100a", "broad100b"]) {
    for (const entry of loadCorpus(corpus)) {
      const witnesses = reasonWitnesses(entry.authoritative);
      let caseDisagreements = 0;
      for (const witness of witnesses.values()) {
        items += 1;
        counts.push(witness.ordered.length);
        if (witness.ordered.length <= 1) single += 1;
        if (witness.compactPreferred !== null) { disagreements += 1; caseDisagreements += 1; }
        witness.ordered.forEach((reason, index) => {
          const family = reasonFamily(reason, index === 0);
          const bucket = byFamily.get(family) ?? { count: 0, distinct: new Set<string>(), samples: [] };
          bucket.count += 1;
          bucket.distinct.add(reason);
          if (bucket.samples.length < 4 && !bucket.samples.includes(reason)) bucket.samples.push(reason.slice(0, 130));
          byFamily.set(family, bucket);
        });
      }
      witnessSets.push({
        corpus,
        instanceId: entry.instanceId,
        items: witnesses.size,
        reasonSetsHash: hashOf([...witnesses.values()].map((witness) => [witness.fqName, witness.setHash, witness.orderHash])),
        compactWouldDisagree: caseDisagreements,
      });
    }
  }

  counts.sort((a, b) => a - b);
  return {
    corpusItems: items,
    itemsWithOneReason: single,
    itemsWithMultipleReasons: items - single,
    medianReasonsPerItem: counts[Math.floor(counts.length / 2)] ?? 0,
    maxReasonsPerItem: counts[counts.length - 1] ?? 0,
    itemsWhereCompactWouldDisagreeWithPositionZero: disagreements,
    families: Object.fromEntries([...byFamily].sort((a, b) => b[1].count - a[1].count).map(([family, bucket]) => [
      family,
      { occurrences: bucket.count, distinctStrings: bucket.distinct.size, samples: bucket.samples },
    ])),
    familyDomains: {
      [REASON_FAMILY.RoleDecisive]: "ACTIONABLE SEMANTICS — states the item's role and what to do with it ('the edit site is the helper it calls', 'support, not an edit target')",
      [REASON_FAMILY.DirectEvidenceAnchor]: "STRONG PROVENANCE — the task text itself names this file or module",
      [REASON_FAMILY.ScoringDiagnostic]: "SCORER INTERNALS — matched terms and a numeric score delta",
      [REASON_FAMILY.LexicalSignal]: "PROVENANCE — how the string matched",
      [REASON_FAMILY.FileLocality]: "PROVENANCE — declared in a file the task points at",
      [REASON_FAMILY.BehavioralMatch]: "ACTIONABLE SEMANTICS — implements the behaviour the task asks for",
      [REASON_FAMILY.GraphDependency]: "STRUCTURAL FACT — indexed fan-in count",
      [REASON_FAMILY.ImpactRelation]: "ACTIONABLE RELATION — indexed edge to a named pivot",
      [REASON_FAMILY.CoeditHint]: "ACTIONABLE RELATION — co-edit coupling",
      [REASON_FAMILY.MemorySignal]: "PROVENANCE — memory scorer signal kind",
      [REASON_FAMILY.ProjectRule]: "PROVENANCE — rule selection",
      [REASON_FAMILY.RolesFallback]: "NOT A REASON — the projector's fallback when the array is empty",
      [REASON_FAMILY.Other]: "unclassified",
    },
    perCase: witnessSets,
  };
}

/** §15 — the authority matrix. */
const AUTHORITY_MATRIX = [
  { surface: "authoritative item (assembly output)", fullReasonSet: "present, ordered", primaryReason: "position 0 = roleReason", orderingAuthoritative: "YES (declared)", agentVisible: "via modelVisibleContext `why:` lines", usedInSelection: "no" },
  { surface: "evidence-layer render (uncompacted)", fullReasonSet: "all rendered as `why:` lines", primaryReason: "position 0", orderingAuthoritative: "YES (inherited)", agentVisible: "YES", usedInSelection: "no" },
  { surface: "evidence-layer render (compacted)", fullReasonSet: "REDUCED TO ONE by compactReasons", primaryReason: "substring-preferred, else position 0", orderingAuthoritative: "NO — substring match overrides order", agentVisible: "YES", usedInSelection: "no" },
  { surface: "compact orientation (`related[].how`, `focus.why`)", fullReasonSet: "not shown", primaryReason: "position 0 of whatever survived", orderingAuthoritative: "YES (declared consumer contract)", agentVisible: "YES — this is the packet", usedInSelection: "no" },
  { surface: "response metadata `productContext.items[]`", fullReasonSet: "sliced to 3, then 1, then dropped", primaryReason: "position 0", orderingAuthoritative: "YES (slice keeps the head)", agentVisible: "YES", usedInSelection: "no" },
  { surface: "`answerBearing` / keep priority", fullReasonSet: "ALL reasons, joined and substring-tested", primaryReason: "not used", orderingAuthoritative: "no — order-insensitive", agentVisible: "no", usedInSelection: "YES" },
  { surface: "benchmark telemetry (M180 identity)", fullReasonSet: "not used", primaryReason: "position 0 (`semanticItemIdentity`)", orderingAuthoritative: "YES", agentVisible: "no", usedInSelection: "no" },
];

function main(): void {
  const verified = [...PRODUCERS, ...CONSUMERS].map(verify);
  const failed = verified.filter((claim) => !claim.verified);
  const audit = compactReasonsAudit();
  const vocab = vocabulary();

  writeFileSync(path.join(RESULTS, "stage5_m181_reason_producers.json"), `${JSON.stringify({
    milestone: "M181-A",
    generatedFrom: "run_stage5_m181_architecture.ts",
    method: "declared source claims, each re-verified against the file and line it cites",
    producers: PRODUCERS.map((producer) => ({ ...producer, ...verify(producer) })),
    allVerified: PRODUCERS.every((producer) => verify(producer).verified),
  }, null, 2)}\n`);

  writeFileSync(path.join(RESULTS, "stage5_m181_reason_consumers.json"), `${JSON.stringify({
    milestone: "M181-A",
    generatedFrom: "run_stage5_m181_architecture.ts",
    consumers: CONSUMERS.map((consumer) => ({ ...consumer, ...verify(consumer) })),
    allVerified: CONSUMERS.every((consumer) => verify(consumer).verified),
    selectionVersusExplanation: {
      question: "Can the choice of displayed reason change what is selected, ranked or delivered?",
      answer: "NO on the reason-choice axis. The single selection-affecting consumer is `answerBearing`, which reads the WHOLE joined set and is computed in `mutableItem` before `compactReasons` runs. Reason identity is therefore an explanation-level concept, and M181 stays a rendering-contract milestone.",
      residualCoupling: "compactReasons changes the rendered STRING LENGTH, which changes `fits()`, which can change which compaction rung is reached. That is a token-budget coupling, not a semantic one, and it is measured as an item-set gate rather than assumed away.",
    },
  }, null, 2)}\n`);

  writeFileSync(path.join(RESULTS, "stage5_m181_reason_vocabulary.json"), `${JSON.stringify({
    milestone: "M181-A", generatedFrom: "run_stage5_m181_architecture.ts",
    corpus: "_m179_authoritative (broad100a + broad100b), frozen authoritative objects",
    ...vocab,
  }, null, 2)}\n`);

  writeFileSync(path.join(RESULTS, "stage5_m181_reason_ordering.json"), `${JSON.stringify({
    milestone: "M181-A", generatedFrom: "run_stage5_m181_architecture.ts",
    ...orderingAudit(verified),
  }, null, 2)}\n`);

  writeFileSync(path.join(RESULTS, "stage5_m181_compact_reasons_audit.json"), `${JSON.stringify({
    milestone: "M181-A", generatedFrom: "run_stage5_m181_architecture.ts", ...audit,
  }, null, 2)}\n`);

  writeFileSync(path.join(RESULTS, "stage5_m181_reason_authority_matrix.json"), `${JSON.stringify({
    milestone: "M181-A", generatedFrom: "run_stage5_m181_architecture.ts",
    matrix: AUTHORITY_MATRIX,
    finding: "Six surfaces treat position 0 as the head of an ordered, authoritative array. One — `compactReasons` — overrides it on a substring match. That one is also the only surface with no declared contract, no test and no comment stating an intent.",
  }, null, 2)}\n`);

  const gate = failed.length === 0 && audit.mirrorMatchesProduct === true;
  console.log(JSON.stringify({
    milestone: "M181-A",
    sourceClaims: verified.length,
    verified: verified.length - failed.length,
    failed: failed.map((claim) => ({ id: claim.id, file: claim.file, line: claim.line, expected: claim.expression, actual: claim.actualLine })),
    mirrorMatchesProduct: audit.mirrorMatchesProduct,
    corpusItems: vocab.corpusItems,
    itemsWhereCompactWouldDisagreeWithPositionZero: vocab.itemsWhereCompactWouldDisagreeWithPositionZero,
    gate: gate ? "PASS" : "FAIL",
  }, null, 2));
  if (!gate) process.exitCode = 1;
}

main();
