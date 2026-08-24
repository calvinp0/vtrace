/**
 * M181-C — reason semantics, the equivalence relation, and the primary-reason
 * contract.
 *
 *   bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m181_semantics.ts
 *
 * NO PRODUCT CODE HAS CHANGED WHEN THIS RUNS, and that is a §67 condition. The
 * contract has to be derivable from the source and the measurement alone,
 * because a contract derived after a repair exists is a description of the
 * repair.
 *
 * The question is not "are both reasons true" — every reason in the set is true,
 * which is exactly why truth cannot settle it. The question is whether an agent
 * reading one instead of the other would navigate or edit differently.
 *
 * Offline, pure, deterministic. Live spend $0.00.
 */

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { REASON_FAMILY } from "./m181Reasons";

const RESULTS = path.resolve("benchmarks/stage5_vexp_swe_bench_smoke/results");

/**
 * §26 — per-family semantics.
 *
 * `agentQuestion` is what the family answers for a coding agent. `class` is the
 * §26 taxonomy. `actionable` records whether the family tells the agent anything
 * about what to DO, as opposed to how VTRACE found the item.
 */
const FAMILY_SEMANTICS: ReadonlyArray<Record<string, unknown>> = [
  {
    family: REASON_FAMILY.RoleDecisive,
    agentQuestion: "What part does this symbol play in the task, and is it an edit target?",
    class: "SEMANTIC_ROLE",
    actionable: true,
    evidence: "`productAdapter.ts:48` declares it 'The decisive reason this item landed in its role'. Its strings carry imperatives: 'the edit site is the helper it calls', 'support, not an edit target', 'likely edit site', 'explicit edit site'.",
  },
  {
    family: REASON_FAMILY.ImpactRelation,
    agentQuestion: "What indexed edge connects this symbol to the pivot?",
    class: "SEMANTIC_ROLE",
    actionable: true,
    evidence: "`assembleProductContext.ts:510` — `<relation> of <pivot fqName>`. Names a concrete structural relationship to a named symbol.",
  },
  {
    family: REASON_FAMILY.CoeditHint,
    agentQuestion: "Must this file change together with the pivot?",
    class: "SEMANTIC_ROLE",
    actionable: true,
    evidence: "`assembleProductContext.ts:460`. 'coordinated edits across multiple surfaced files' is an instruction about scope of the edit.",
  },
  {
    family: REASON_FAMILY.BehavioralMatch,
    agentQuestion: "Does this symbol implement the behaviour the task asks about?",
    class: "SEMANTIC_ROLE",
    actionable: true,
    evidence: "`hybridRetrieval.ts:1329` — '(answer role)'.",
  },
  {
    family: REASON_FAMILY.DirectEvidenceAnchor,
    agentQuestion: "Did the task text itself name this file or symbol?",
    class: "RELEVANCE_EXPLANATION",
    actionable: "partly — it justifies attention without saying what role the symbol plays",
    evidence: "`directEvidenceAnchoring.ts:724`, `buildCapsuleV2.ts:505`. A strong relevance claim, but it is a statement about the QUERY, not about the code.",
  },
  {
    family: REASON_FAMILY.GraphDependency,
    agentQuestion: "How many indexed symbols depend on this one?",
    class: "SCORING_EXPLANATION",
    actionable: "weakly — blast radius, not role",
    evidence: "A fan-in count. True, structural, and silent about the task.",
  },
  {
    family: REASON_FAMILY.LexicalSignal,
    agentQuestion: "How did the string match?",
    class: "PROVENANCE_ONLY",
    actionable: false,
    evidence: "`hybridRetrieval.ts:587`. 'symbol name matches \"fit\"' explains the retriever, not the repository.",
  },
  {
    family: REASON_FAMILY.FileLocality,
    agentQuestion: "Is this declared in a file the task points at?",
    class: "PROVENANCE_ONLY",
    actionable: false,
    evidence: "`hybridRetrieval.ts:601`.",
  },
  {
    family: REASON_FAMILY.ScoringDiagnostic,
    agentQuestion: "What did the scorer weigh, and by how much?",
    class: "DEBUG_ONLY",
    actionable: false,
    evidence: "`hybridRetrieval.ts:1230`, `1201`, `buildCapsuleV2.ts:582`. 'preferred contrast side matched: management, command, py (+0.18)' is a bag of matched tokens and a float. It is the only family that names an internal tuning quantity, and it is not a claim about the repository at all.",
  },
  {
    family: REASON_FAMILY.MemorySignal,
    agentQuestion: "Which memory signal fired?",
    class: "PROVENANCE_ONLY",
    actionable: false,
    evidence: "`assembleProductContext.ts:586`. Never reaches orientation: memory items carry no fqName and the projector filters on fqName.",
  },
  {
    family: REASON_FAMILY.ProjectRule,
    agentQuestion: "Which rule selected this?",
    class: "PROVENANCE_ONLY",
    actionable: false,
    evidence: "`assembleProductContext.ts:604`. Also fqName-less, so also never in orientation.",
  },
  {
    family: REASON_FAMILY.RolesFallback,
    agentQuestion: "(none — it is the roles string, not a reason)",
    class: "UNKNOWN",
    actionable: false,
    evidence: "`orientationProjection.ts:329`'s `?? item.roles.join(\", \")`. M180 already classifies movement out of this as a benign upgrade.",
  },
];

/**
 * §61 — the agent-relevance test, for every family pair the corpus actually
 * produced. Counts come from the measured cross-tab; the judgement is argued from
 * the family definitions above.
 */
const PAIR_JUDGEMENTS: Readonly<Record<string, { equivalent: boolean; wouldChangeAgentBehaviour: string; argument: string }>> = {
  "SCORING_DIAGNOSTIC -> ROLE_DECISIVE": {
    equivalent: false,
    wouldChangeAgentBehaviour: "YES",
    argument: "One tells the agent the symbol is the edit site, or that it is support and not an edit target. The other tells it which query tokens matched and by how much. An agent choosing where to edit can act on the first and cannot act on the second. This is a DEBUG_ONLY claim displacing a SEMANTIC_ROLE claim, and it is 214 of the 289 measured substitutions.",
  },
  "SCORING_DIAGNOSTIC -> DIRECT_EVIDENCE_ANCHOR": {
    equivalent: false,
    wouldChangeAgentBehaviour: "YES",
    argument: "'the task names this file' is a relevance fact an agent can weigh; a contrast-score delta is not.",
  },
  "DIRECT_EVIDENCE_ANCHOR -> ROLE_DECISIVE": {
    equivalent: false,
    wouldChangeAgentBehaviour: "YES, though less sharply",
    argument: "Both are informative. But 'task names file `compiler.py` (direct evidence, strong)' answers WHY LOOK, while 'actionable class — in a likely edit file' answers WHAT IT IS. An agent deciding whether to edit or merely read needs the second. Displacing role by relevance is a downgrade in kind even when both are useful.",
  },
  "LEXICAL_SIGNAL -> ROLE_DECISIVE": {
    equivalent: false,
    wouldChangeAgentBehaviour: "YES",
    argument: "PROVENANCE_ONLY displacing SEMANTIC_ROLE. Same argument as the scoring case, weaker only because the lexical string is at least about the symbol's name.",
  },
  "ROLE_DECISIVE -> ROLE_DECISIVE": {
    equivalent: true,
    wouldChangeAgentBehaviour: "NO",
    argument: "Same family, and every measured instance is the 160-character ellipsis cutting the same sentence. `reasonEquivalent` already classifies these as REPRESENTATION_ONLY, and they are the 12 the detector excuses.",
  },
};

function main(): void {
  const crosstab = JSON.parse(
    readFileSync(path.join(RESULTS, "stage5_m181_reason_family_crosstab.json"), "utf8"),
  ) as { rows: Array<{ transition: string; count: number; equivalentUnderM181Relation: number; example: Record<string, string> }> };

  const rows = crosstab.rows.map((row) => {
    const judgement = PAIR_JUDGEMENTS[row.transition];
    return {
      transition: row.transition,
      count: row.count,
      equivalentUnderM181Relation: row.equivalentUnderM181Relation,
      semanticallyEquivalent: judgement?.equivalent ?? null,
      wouldChangeAgentBehaviour: judgement?.wouldChangeAgentBehaviour ?? "UNJUDGED",
      argument: judgement?.argument ?? "no judgement recorded — transition not anticipated",
      example: row.example,
    };
  });
  const unjudged = rows.filter((row) => row.semanticallyEquivalent === null);
  // PRECEDENCE. The string relation outranks the family judgement. Family is
  // assigned by pattern, and a reason cut at 159 characters can lose the words
  // that identify its family — two `LEXICAL_SIGNAL -> ROLE_DECISIVE` rows are in
  // fact one ROLE_DECISIVE sentence and its own truncated head. Comparing the
  // claims is evidence; labelling a truncated prefix is a heuristic, so where
  // they disagree the claim wins.
  const ellipsisOnly = rows.reduce((sum, row) => sum + row.equivalentUnderM181Relation, 0);
  const nonEquivalent = rows
    .filter((row) => row.semanticallyEquivalent === false)
    .reduce((sum, row) => sum + row.count - row.equivalentUnderM181Relation, 0);
  const equivalent = rows.reduce((sum, row) => sum + row.count, 0) - nonEquivalent;

  writeFileSync(path.join(RESULTS, "stage5_m181_reason_semantics.json"), `${JSON.stringify({
    milestone: "M181-C", generatedFrom: "run_stage5_m181_semantics.ts",
    productCodeChangedBeforeThisRan: false,
    families: FAMILY_SEMANTICS,
    provenanceVersusActionability: {
      question: "§62 — are selection reasons provenance, or do they encode actionable role?",
      answer: "BOTH, and they are not mixed randomly: the ASSEMBLY LAYER SEPARATES THEM BY POSITION. Position 0 is `roleReason`, the actionable role claim. Positions 1..n are `evidence`, which is provenance and scoring explanation. The array is not a bag; it is a role claim followed by its supporting provenance.",
      consequence: "A selector that ignores position therefore cannot help but sometimes replace an actionable claim with provenance. That is what the measurement shows, in one direction, 277 times out of 277.",
    },
  }, null, 2)}\n`);

  writeFileSync(path.join(RESULTS, "stage5_m181_reason_equivalence.json"), `${JSON.stringify({
    milestone: "M181-C", generatedFrom: "run_stage5_m181_semantics.ts",
    relation: {
      definition: "reasonEquivalent(a, b) iff a === b, or one is the other under compactReasons' 160-character ellipsis.",
      deliberatelyNarrow: "Truth is not equivalence. Every reason in an authoritative set is true; if truth licensed substitution, the budget-monotonicity invariant would be unfalsifiable by construction. Equivalence is therefore SAME CLAIM, not BOTH TRUE.",
      rejected: "An equivalence that grouped whole families (e.g. 'all retrieval evidence is interchangeable') was considered and rejected: the measured substitutions cross from DEBUG_ONLY to SEMANTIC_ROLE, which no defensible grouping makes equivalent.",
    },
    familyPairs: rows,
    totals: {
      substitutionsObserved: rows.reduce((sum, row) => sum + row.count, 0),
      semanticallyNonEquivalent: nonEquivalent,
      representationOnlyEllipsis: ellipsisOnly,
      semanticallyEquivalent: equivalent,
      unjudged: unjudged.length,
    },
    precedence: "Where the family judgement and the string relation disagree, the string relation governs: it compares the claims, while family is a pattern label that a 159-character cut can strip.",
  }, null, 2)}\n`);

  console.log(JSON.stringify({
    milestone: "M181-C",
    familyPairsObserved: rows.length,
    unjudgedTransitions: unjudged.map((row) => row.transition),
    semanticallyNonEquivalentSubstitutions: nonEquivalent,
    representationOnlyEllipsis: ellipsisOnly,
    semanticallyEquivalentSubstitutions: equivalent,
    gate: unjudged.length === 0 ? "PASS" : "FAIL — an observed transition has no recorded judgement",
  }, null, 2));
  if (unjudged.length > 0) process.exitCode = 1;
}

main();
