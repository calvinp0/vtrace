/**
 * M185-B/D/E — the case records, the addressability matrix, and the aggregates.
 *
 * The per-case labels below are the AUDITOR'S judgements. They are data, not
 * computation, and they are written out verbatim so a reader can disagree with a
 * specific one without re-deriving the whole audit. Everything downstream of
 * them — stage counts, addressability counts, counterfactual support, the
 * continuation verdict — is computed by `m185Audit.ts` from these records, so a
 * changed label changes the verdict mechanically rather than editorially.
 *
 * Every `onScreen` count is recomputed here from M183's preserved tool outputs
 * at run time. A claim that a run never saw a fact is the one thing in this file
 * that is never taken on the auditor's word.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  classifyStage, counterfactualSupport, continuationVerdict, evidenceClassIsVtraceAddressable,
  isRepeatedMechanism,
  type Addressability, type CounterfactualSupport, type EvidenceClass, type ExposureRow,
  type FailureStage, type StageEvidence, type WitnessQuality,
} from "./m185Audit";

const REPO_ROOT = path.resolve(import.meta.dir, "../..");
const RESULTS = path.join(REPO_ROOT, "benchmarks/stage5_vexp_swe_bench_smoke/results");

interface Arm { readonly rawDir: string; readonly resolved: boolean; }
interface Pair { readonly instanceId: string; readonly repo: string; readonly baseline: Arm; readonly treatment: Arm; }
const pairs = new Map<string, Pair>(readFileSync(path.join(RESULTS, "stage5_m183_pair_records.jsonl"), "utf8")
  .split("\n").filter((l) => l.trim()).map((l) => { const p = JSON.parse(l) as Pair; return [p.instanceId, p]; }));

const onScreen = (rawDir: string, term: string): number => {
  const p = path.join(REPO_ROOT, rawDir, "_tool_calls_with_outputs.json");
  if (!existsSync(p)) return -1;
  const tc = JSON.parse(readFileSync(p, "utf8")) as { output: string | null }[];
  return tc.reduce((a, t) => a + ((t.output ?? "").split(term).length - 1), 0);
};

// ── the six mandatory correct-focus failure records (§29) ───────────

interface CaseRecord {
  readonly instanceId: string;
  readonly repo: string;
  readonly focus: string;
  readonly focusIsGoldFile: boolean;
  readonly agentEditedFocus: boolean;
  readonly graderOutcome: string;
  readonly firstDownstreamDivergence: string;
  readonly stageEvidence: StageEvidence;
  readonly subMechanism: string | null;
  readonly evidenceClass: EvidenceClass;
  readonly candidateFact: string;
  readonly repositoryWitness: string | null;
  /** the probe recomputed at run time: term, and where it must / must not appear */
  readonly onScreenProbe: { readonly term: string; readonly expectFailedRunCount: "zero" | "nonzero" };
  readonly failedRunAcquired: boolean;
  readonly comparator: string;
  readonly witness: WitnessQuality;
  readonly witnessNote: string;
  readonly addressability: Addressability;
  readonly exposure: ExposureRow;
  readonly exposureEvidence: string;
  readonly precedesDivergence: boolean;
  readonly confidence: "HIGH" | "MEDIUM" | "LOW";
  readonly confidenceReason: string;
}

const CASES: CaseRecord[] = [
  {
    instanceId: "psf__requests-5414", repo: "psf/requests",
    focus: "requests/models.py::PreparedRequest.prepare_url",
    focusIsGoldFile: true, agentEditedFocus: true,
    graderOutcome: "FAIL_TO_PASS 1/1 pass, PASS_TO_PASS 122/130 — the target test passed and eight existing ones broke",
    firstDownstreamDivergence:
      "call 6: the run replaces the `if not unicode_is_ascii(host)` guard with an unconditional `host = self._get_idna_encoded_host(host)`, converting a VALIDATION into a MUTATION of every ASCII host.",
    stageEvidence: {
      contactedCorrectImplementation: true, environmentBlocked: false,
      behaviouralAssumptionContradictedByRepo: false, missedCrossFileContract: true,
      repairMechanismWrong: false, implementationDefect: false,
      decisiveTestNotSelected: true, validationOutputMisread: false, failedToReviseAfterSignal: false,
    },
    subMechanism: "MISSING_TEST_CONTRACT",
    evidenceClass: "EVIDENCE_NOT_ACQUIRED",
    candidateFact:
      "prepare_url must not change the value of an ASCII host. The strict third-party `idna` library behind `_get_idna_encoded_host` rejects inputs that are legal HTTP hosts — IPv6 literals, already-punycoded labels, percent-encoded http+unix socket paths.",
    repositoryWitness: "tests/test_requests.py::TestPreparingURLs.test_preparing_url — present at base commit 39d0fdd9, parametrised with xn--n3h.net, [1200:0000:...]:12345 and http+unix://%2Fvar%2Frun%2Fsocket",
    onScreenProbe: { term: "TestPreparingURLs", expectFailedRunCount: "zero" },
    failedRunAcquired: false,
    comparator: "the baseline arm, which solved this task",
    witness: "COMPATIBLE_ONLY",
    witnessNote:
      "the winning baseline never opened the test file either (TestPreparingURLs on screen 0 times). Its transcript shows it CONSIDERING the losing patch — 'the simplest fix is to ALWAYS try IDNA encoding' — and rejecting it for PERFORMANCE, not for any repository evidence. Its patch validates without assigning, and survives by structure rather than by knowledge.",
    addressability: "NOT_CURRENTLY_DERIVABLE",
    exposure: { authorityAvailable: true, onDemandToolExposes: false, defaultProjectionExposes: false },
    exposureEvidence:
      "offline replay at base commit: the test is reverse-reachable from prepare_url at hop 4, by which point the frontier is 92 symbols. `vtrace impact-graph --depth 3` does not reach it; three non-gold capsule queries ('what tests exercise prepare_url', 'prepare_url tests expected url output', 'PreparedRequest url preparation tests') all miss it. The authority holds the path; nothing shipped selects it.",
    precedesDivergence: true,
    confidence: "HIGH",
    confidenceReason: "the divergent edit, the rejected alternative, and the eight broken tests are all explicit in the preserved record",
  },
  {
    instanceId: "django__django-11820", repo: "django/django",
    focus: "django/db/models/base.py::Model._check_ordering",
    focusIsGoldFile: true, agentEditedFocus: true,
    graderOutcome: "FAIL_TO_PASS 1/2 — the pk-alias test passes, test_ordering_pointing_multiple_times_to_model_fields fails; PASS_TO_PASS 61/61",
    firstDownstreamDivergence:
      "the run scopes the defect to the one symptom the issue reports (`option__pk` raising E015) and never asks what the loop does after a part resolves to a NON-relational field, where `_cls` is left pointing at the previous model and a further lookup silently resolves.",
    stageEvidence: {
      contactedCorrectImplementation: true, environmentBlocked: false,
      behaviouralAssumptionContradictedByRepo: false, missedCrossFileContract: true,
      repairMechanismWrong: false, implementationDefect: false,
      decisiveTestNotSelected: false, validationOutputMisread: false, failedToReviseAfterSignal: false,
    },
    subMechanism: "MISSING_MIRROR_IMPLEMENTATION_RULE",
    evidenceClass: "EVIDENCE_NOT_ACQUIRED",
    candidateFact:
      "a lookup path may not continue past a non-relational field; the ordering check is supposed to mirror what the query compiler accepts.",
    repositoryWitness: "django/db/models/sql/query.py::Query.names_to_path — raises FieldError('Join on field %r not permitted') for exactly this traversal",
    onScreenProbe: { term: "names_to_path", expectFailedRunCount: "zero" },
    failedRunAcquired: false,
    comparator: "none — both arms failed with the identical grader result",
    witness: "NONE",
    witnessNote: "no successful comparator exists for this task, and no other task in the corpus shows a run consulting the query compiler to calibrate a checks-framework rule",
    addressability: "REQUIRES_NEW_SEMANTIC_ANALYSIS",
    exposure: { authorityAvailable: false, onDemandToolExposes: false, defaultProjectionExposes: false },
    exposureEvidence:
      "the relation needed is 'these two functions independently implement the same rule and must agree'. VTRACE indexes contains/imports/calls/references; a mirror-implementation relation is not among them and cannot be composed from them.",
    precedesDivergence: true,
    confidence: "MEDIUM",
    confidenceReason: "the omission is certain and the witness is real, but nothing in the transcript shows the run considering and rejecting the traversal question, so the counterfactual is inferred",
  },
  {
    instanceId: "django__django-13195", repo: "django/django",
    focus: "django/http/response.py::HttpResponseBase.delete_cookie",
    focusIsGoldFile: true, agentEditedFocus: true,
    graderOutcome: "FAIL_TO_PASS 4/5, PASS_TO_PASS 381/382 — two of three gold hunks byte-identical to the reference patch",
    firstDownstreamDivergence:
      "the run gives the new parameter the default `samesite='Lax'` and leaves `secure = key.startswith(('__Secure-','__Host-'))` unchanged. Both decisions are made in a single edit, against a `set_cookie` signature already on screen whose own default is `samesite=None`.",
    stageEvidence: {
      contactedCorrectImplementation: true, environmentBlocked: false,
      behaviouralAssumptionContradictedByRepo: false, missedCrossFileContract: false,
      repairMechanismWrong: false, implementationDefect: true,
      decisiveTestNotSelected: false, validationOutputMisread: false, failedToReviseAfterSignal: false,
    },
    subMechanism: null,
    evidenceClass: "EVIDENCE_ACQUIRED_AND_UNDERSTOOD_BUT_BAD_REPAIR",
    candidateFact:
      "the wrapper's default must match the delegate's — set_cookie declares samesite=None — and samesite='none' requires the secure flag, which the issue's own Firefox warning states.",
    repositoryWitness: "django/http/response.py::HttpResponseBase.set_cookie — the same file, twenty lines above the edit",
    onScreenProbe: { term: "samesite=None", expectFailedRunCount: "nonzero" },
    failedRunAcquired: true,
    comparator: "none — both arms produced the identical patch and the identical grader result",
    witness: "NONE",
    witnessNote: "there is nothing to supply: the decisive text was already in the run's context when it chose otherwise",
    addressability: "NOT_A_REPOSITORY_FACT",
    exposure: { authorityAvailable: true, onDemandToolExposes: true, defaultProjectionExposes: true },
    exposureEvidence: "already delivered — the fact is in the file the run read and edited",
    precedesDivergence: false,
    confidence: "HIGH",
    confidenceReason: "the delegate signature is verifiably on screen and the two wrong decisions are a single explicit edit",
  },
  {
    instanceId: "mwaskom__seaborn-3187", repo: "mwaskom/seaborn",
    focus: "seaborn/utils.py::move_legend",
    focusIsGoldFile: true, agentEditedFocus: false,
    graderOutcome: "FAIL_TO_PASS 0/2, PASS_TO_PASS 248/248 — the objects-API test and the classic-API test both fail",
    firstDownstreamDivergence:
      "call 2 onward: every search is scoped to seaborn/_core/. The run concludes the objects-API legend path is the whole surface and never asks whether the classic API formats legend entries somewhere else.",
    stageEvidence: {
      contactedCorrectImplementation: true, environmentBlocked: false,
      behaviouralAssumptionContradictedByRepo: false, missedCrossFileContract: true,
      repairMechanismWrong: false, implementationDefect: false,
      decisiveTestNotSelected: false, validationOutputMisread: false, failedToReviseAfterSignal: false,
    },
    subMechanism: "MISSING_PARALLEL_IMPLEMENTATION_SITE",
    evidenceClass: "EVIDENCE_NOT_ACQUIRED",
    candidateFact:
      "the classic (non-objects) API builds its legend labels in a second place, seaborn/utils.py::locator_to_legend_entries, which constructs its own mpl.ticker.ScalarFormatter.",
    repositoryWitness: "seaborn/utils.py::locator_to_legend_entries (line 687 at base 22cdfb0c), called by seaborn/relational.py::_RelationalPlotter.add_legend_data and by tests/test_utils.py::test_locator_to_legend_entries",
    onScreenProbe: { term: "locator_to_legend_entries", expectFailedRunCount: "zero" },
    failedRunAcquired: false,
    comparator: "none — both arms failed with the identical grader result",
    witness: "NONE",
    witnessNote: "the baseline scoped its searches the same way and missed the same site",
    addressability: "CURRENTLY_DERIVABLE",
    exposure: { authorityAvailable: true, onDemandToolExposes: true, defaultProjectionExposes: false },
    exposureEvidence:
      "offline replay at base commit: the symbol is indexed with both an incoming call edge and a test caller. Three non-gold capsule queries derivable from the issue text ('where are legend tick labels formatted', 'legend entries formatter offset', 'brief numeric legend levels') return it as a PIVOT. The delivered default packet instead spent its same-file slot on seaborn/utils.py::__all__, annotated 'no indexed relationship to it'.",
    precedesDivergence: true,
    confidence: "HIGH",
    confidenceReason: "the missing site, its edges, and the on-demand queries that surface it are all verifiable offline against the base commit",
  },
  {
    instanceId: "sphinx-doc__sphinx-7462", repo: "sphinx-doc/sphinx",
    focus: "sphinx/domains/python.py::_parse_annotation",
    focusIsGoldFile: true, agentEditedFocus: true,
    graderOutcome: "FAIL_TO_PASS 0/2, PASS_TO_PASS 49/49 — test_parse_annotation and test_unparse[()-()] both fail",
    firstDownstreamDivergence:
      "call 4: the run patches the nested unparse's ast.Tuple branch to return [] for an empty tuple. That fixes the crash, renders nothing where '()' belongs, and treats the one unparse it can see as the only one.",
    stageEvidence: {
      contactedCorrectImplementation: true, environmentBlocked: false,
      behaviouralAssumptionContradictedByRepo: false, missedCrossFileContract: true,
      repairMechanismWrong: false, implementationDefect: false,
      decisiveTestNotSelected: false, validationOutputMisread: false, failedToReviseAfterSignal: false,
    },
    subMechanism: "MISSING_PARALLEL_IMPLEMENTATION_SITE",
    evidenceClass: "EVIDENCE_NOT_ACQUIRED",
    candidateFact:
      "a second function also named unparse, in sphinx/pycode/ast.py, carries the identical ast.Tuple branch and the identical empty-tuple defect, and has its own test file.",
    repositoryWitness: "sphinx/pycode/ast.py::unparse (line 61 at base b3e26a6c); tests/test_pycode_ast.py",
    onScreenProbe: { term: "pycode/ast.py", expectFailedRunCount: "zero" },
    failedRunAcquired: false,
    comparator: "none — both arms failed with the identical grader result",
    witness: "NONE",
    witnessNote: "the baseline also patched only sphinx/domains/python.py",
    addressability: "DERIVABLE_WITH_EXISTING_PRIMITIVE_COMPOSITION",
    exposure: { authorityAvailable: true, onDemandToolExposes: true, defaultProjectionExposes: false },
    exposureEvidence:
      "offline replay at base commit: sphinx/pycode/ast.py::unparse is in the symbol index and the capsule query 'unparse ast Tuple' returns it as pivot #1. But the query needs the name, and the name comes from the focus BODY — the nested unparse inside _parse_annotation is not itself an indexed symbol, so the composition is read-focus-then-look-up-the-name, not an index relation. Queries phrased from the issue text alone ('IndexError: pop from empty list for empty tuple type annotation', 'where are type annotations unparsed', 'empty tuple annotation rendering') all miss it.",
    precedesDivergence: true,
    confidence: "HIGH",
    confidenceReason: "the sibling symbol, its indexed presence, and the query that finds it are verifiable offline; the second F2P test names the missed module directly",
  },
  {
    instanceId: "sympy__sympy-13974", repo: "sympy/sympy",
    focus: "sympy/physics/quantum/tensorproduct.py::tensor_product_simp",
    focusIsGoldFile: true, agentEditedFocus: true,
    graderOutcome: "FAIL_TO_PASS 0/1, PASS_TO_PASS 4/4",
    firstDownstreamDivergence:
      "call 7: the run guards its new Pow branch with `exp.is_Integer and exp > 0`, which excludes the symbolic exponent the test requires, and it leaves tensor_product_simp_Mul untouched although that function's own TODO — on screen at call 0 — names Pow as the composite it cannot handle.",
    stageEvidence: {
      contactedCorrectImplementation: true, environmentBlocked: false,
      behaviouralAssumptionContradictedByRepo: false, missedCrossFileContract: false,
      repairMechanismWrong: true, implementationDefect: false,
      decisiveTestNotSelected: false, validationOutputMisread: false, failedToReviseAfterSignal: false,
    },
    subMechanism: null,
    evidenceClass: "EVIDENCE_ACQUIRED_BUT_MISUNDERSTOOD",
    candidateFact: "tensor_product_simp_Mul cannot handle a Pow of a TensorProduct, and says so in its own TODO comment.",
    repositoryWitness: "sympy/physics/quantum/tensorproduct.py::tensor_product_simp_Mul — the same file, seventy lines above the edit",
    onScreenProbe: { term: "tensor_product_simp_Mul", expectFailedRunCount: "nonzero" },
    failedRunAcquired: true,
    comparator: "none — both arms failed with the identical grader result",
    witness: "NONE",
    witnessNote:
      "an inverted comparison is available and is worth recording: the BASELINE never had the TODO on screen and wrote the STRICTLY BETTER Pow branch, omitting the is_Integer guard that the treatment added. More evidence, worse repair.",
    addressability: "NOT_A_REPOSITORY_FACT",
    exposure: { authorityAvailable: true, onDemandToolExposes: true, defaultProjectionExposes: true },
    exposureEvidence: "already delivered — the TODO is in the file the run read and edited",
    precedesDivergence: false,
    confidence: "HIGH",
    confidenceReason: "the TODO is verifiably on screen for the treatment and verifiably absent for the baseline, and the two patches differ exactly where that matters",
  },
];

// ── derive everything downstream of the labels ──────────────────────

const derived = CASES.map((c) => {
  const pair = pairs.get(c.instanceId)!;
  const probeTreatment = onScreen(pair.treatment.rawDir, c.onScreenProbe.term);
  const probeBaseline = onScreen(pair.baseline.rawDir, c.onScreenProbe.term);
  const probeHolds = c.onScreenProbe.expectFailedRunCount === "zero" ? probeTreatment === 0 : probeTreatment > 0;
  const stage: FailureStage = classifyStage(c.stageEvidence);
  const support: CounterfactualSupport = counterfactualSupport({
    failedRunLackedFact: !c.failedRunAcquired,
    witness: c.witness,
    repositoryWitnessNamed: c.repositoryWitness !== null,
    addressability: c.addressability,
    precedesDivergence: c.precedesDivergence,
  });
  return {
    ...c, failureStage: stage,
    vtraceAddressableByEvidenceClass: evidenceClassIsVtraceAddressable(c.evidenceClass),
    counterfactualSupport: support,
    onScreenProbeResult: { treatment: probeTreatment, baseline: probeBaseline, holds: probeHolds },
  };
});

const probeFailures = derived.filter((d) => !d.onScreenProbeResult.holds);
if (probeFailures.length > 0) {
  console.error("ON-SCREEN PROBE DISAGREES WITH A LABEL:", probeFailures.map((d) => d.instanceId));
  process.exitCode = 1;
}

// ── aggregates (§41/§42/§95/§96) ────────────────────────────────────

const tally = <T extends string>(xs: readonly T[]): Record<string, number> =>
  xs.reduce<Record<string, number>>((a, x) => ({ ...a, [x]: (a[x] ?? 0) + 1 }), {});

const stageCounts = Object.entries(tally(derived.map((d) => d.failureStage))).map(([stage, count]) => ({
  stage, count,
  repositories: [...new Set(derived.filter((d) => d.failureStage === stage).map((d) => d.repo))].sort(),
  tasks: derived.filter((d) => d.failureStage === stage).map((d) => d.instanceId),
  repositoryAddressable: derived.filter((d) => d.failureStage === stage)
    .every((d) => d.addressability === "CURRENTLY_DERIVABLE" || d.addressability === "DERIVABLE_WITH_EXISTING_PRIMITIVE_COMPOSITION")
    ? "YES" : derived.filter((d) => d.failureStage === stage)
      .some((d) => d.addressability === "CURRENTLY_DERIVABLE" || d.addressability === "DERIVABLE_WITH_EXISTING_PRIMITIVE_COMPOSITION") ? "PARTIAL" : "NO",
}));

const addressabilityCounts = tally(derived.map((d) => d.addressability));
const supportCounts = tally(derived.map((d) => d.counterfactualSupport));
const evidenceCounts = tally(derived.map((d) => d.evidenceClass));

// ── candidate mechanisms and their breadth (§43/§44/§78) ────────────

const mechanisms = [...new Set(derived.map((d) => d.subMechanism).filter((m): m is string => m !== null))]
  .map((m) => {
    const members = derived.filter((d) => d.subMechanism === m);
    const breadth = { tasks: members.length, repositories: new Set(members.map((d) => d.repo)).size };
    return {
      mechanism: m, breadth,
      tasks: members.map((d) => d.instanceId),
      repositories: [...new Set(members.map((d) => d.repo))].sort(),
      repeatedByThreshold: isRepeatedMechanism(breadth),
      threshold: "at least 3 tasks across at least 2 repositories (§43 — two near-identical tasks in one repository are weak)",
      coverageOfCorrectFocusFailures: `${members.length} / ${derived.length}`,
      bestCounterfactualSupport: members.map((d) => d.counterfactualSupport)
        .sort()[0] ?? "NO_COUNTERFACTUAL_SUPPORT",
      currentlyDerivable: members.filter((d) => d.addressability === "CURRENTLY_DERIVABLE"
        || d.addressability === "DERIVABLE_WITH_EXISTING_PRIMITIVE_COMPOSITION").map((d) => d.instanceId),
      successWitnessed: members.some((d) => d.witness === "OBSERVED_USE"),
    };
  });

const bestMechanism = mechanisms.find((m) => m.mechanism === "MISSING_PARALLEL_IMPLEMENTATION_SITE") ?? mechanisms[0];
const gates = {
  repeated: bestMechanism ? bestMechanism.repeatedByThreshold : false,
  downstreamOfCorrectLocalization: true,
  repositoryDerived: true,
  currentlyVtraceDerivable: bestMechanism ? bestMechanism.currentlyDerivable.length === bestMechanism.breadth.tasks : false,
  successWitnessed: derived.some((d) => d.witness === "OBSERVED_USE"),
  causallyPlausible: true,
  narrowlyIntervenable: true,
};
const verdict = continuationVerdict(gates);

writeFileSync(path.join(RESULTS, "stage5_m185_correct_focus_failures.json"), `${JSON.stringify({
  schemaVersion: "stage5.m185.correct-focus-failures.v1", milestone: "M185", workstream: "M185-B/C/D",
  goldDiscipline: "reference patches were read to understand each task and are never the reason a step is labelled wrong (§10/§20). Every candidate fact names a witness that exists at the base commit independent of the reference patch.",
  cases: derived,
}, null, 2)}\n`);

writeFileSync(path.join(RESULTS, "stage5_m185_failure_stage_counts.json"), `${JSON.stringify({
  schemaVersion: "stage5.m185.failure-stage-counts.v1", milestone: "M185", workstream: "M185-B",
  population: "the six correct-focus VTRACE failures (cohort A)",
  stageCounts, evidenceCounts,
  firstDecisiveDivergenceRule: "the earliest stage whose predicate holds wins; S3 is ordered before S2 so a concrete second-file obligation is never absorbed into a generic bad-repair bucket",
}, null, 2)}\n`);

writeFileSync(path.join(RESULTS, "stage5_m185_vtrace_addressability.json"), `${JSON.stringify({
  schemaVersion: "stage5.m185.vtrace-addressability.v1", milestone: "M185", workstream: "M185-D",
  separationOfConcerns: "§47 — AUTHORITY_AVAILABLE, ON_DEMAND_TOOL_EXPOSES and DEFAULT_PROJECTION_EXPOSES are three different questions and are answered separately for every case.",
  derivationReplay: {
    method: "each repository materialised at its SWE-bench base commit with `git archive` into a scratch tree (no bench repo mutated, no worktree created), then `vtrace init` + `vtrace index` at product HEAD, then non-gold-shaped queries (§71/§72)",
    repositoriesReplayed: ["psf__requests-5414", "mwaskom__seaborn-3187", "sphinx-doc__sphinx-7462"],
    indexSizes: { "psf__requests-5414": { files: 38, symbols: 771, edges: 1407 }, "mwaskom__seaborn-3187": { files: 157, symbols: 3316, edges: 7108 }, "sphinx-doc__sphinx-7462": { files: 465, symbols: 7999, edges: 13916 } },
    defaultProjectionReproduced: "run_pipeline against the seaborn replay with M183's exact derived task text returns the same pivot (seaborn/utils.py::move_legend) and the same support (seaborn/_core/plot.py::Plotter._make_legend) as the delivered M183 packet",
  },
  addressabilityCounts,
  matrix: derived.map((d) => ({
    instanceId: d.instanceId, candidateFact: d.candidateFact, repositoryWitness: d.repositoryWitness,
    authorityAvailable: d.exposure.authorityAvailable,
    onDemandToolExposes: d.exposure.onDemandToolExposes,
    defaultProjectionExposes: d.exposure.defaultProjectionExposes,
    addressability: d.addressability, evidence: d.exposureEvidence,
  })),
}, null, 2)}\n`);

writeFileSync(path.join(RESULTS, "stage5_m185_counterfactual_candidates.json"), `${JSON.stringify({
  schemaVersion: "stage5.m185.counterfactual-candidates.v1", milestone: "M185", workstream: "M185-E",
  supportCounts, mechanisms,
  witnessRule: "§18/§19 — STRONG requires a successful comparator whose transcript shows it RECOVERING and USING the fact. A patch that merely happens to respect an invariant is COMPATIBLE_ONLY and does not support an intervention.",
  observedUseWitnesses: derived.filter((d) => d.witness === "OBSERVED_USE").map((d) => d.instanceId),
  gates, verdict,
  gateNote: "§83 — all seven or downgrade. successWitnessed is false for every case in the cohort, which is decisive on its own.",
}, null, 2)}\n`);

console.log("stage counts:", JSON.stringify(tally(derived.map((d) => d.failureStage))));
console.log("evidence   :", JSON.stringify(evidenceCounts));
console.log("addressab. :", JSON.stringify(addressabilityCounts));
console.log("support    :", JSON.stringify(supportCounts));
console.log("mechanisms :", JSON.stringify(mechanisms.map((m) => ({ m: m.mechanism, tasks: m.breadth.tasks, repos: m.breadth.repositories, repeated: m.repeatedByThreshold }))));
console.log("gates      :", JSON.stringify(gates));
console.log("verdict    :", verdict);
console.log("probes     :", derived.map((d) => `${d.instanceId.split("__")[1]}=${d.onScreenProbeResult.treatment}${d.onScreenProbeResult.holds ? "ok" : "MISMATCH"}`).join(" "));
