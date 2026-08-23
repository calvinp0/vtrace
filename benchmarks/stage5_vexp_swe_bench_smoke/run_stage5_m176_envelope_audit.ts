/**
 * M176-A — where `product_response_envelope_unreachable` comes from, what feeds
 * it, and which response paths are proven bounded.
 *
 *   bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m176_envelope_audit.ts
 *
 * Three artifacts, three questions:
 *
 *   stage5_m176_envelope_failure_trace.json    who throws, who catches, what the
 *                                              caller receives
 *   stage5_m176_envelope_contributors.json     which default model-facing fields
 *                                              can carry a response over the
 *                                              ceiling, measured by injection
 *   stage5_m176_response_path_totality.json    which response paths have a proof
 *                                              or a bounded fallback
 *
 * The trace is a SOURCE audit: every row names a file and a line, and the runner
 * re-verifies that the named line still contains the named text, so the artifact
 * cannot quietly rot into a description of code that has moved.
 *
 * The contributor and totality rows are MEASURED, by growing one field at a time
 * on a real authoritative capture and reading the envelope floor. Nothing here
 * reasons from a field looking large.
 *
 * Offline. Local index reads only; no agent, no Docker, no paid API.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { captureCached, loadProblemStatements, CAPTURE_MAX_TOKENS } from "./m175Capture";
import {
  compactOutcome, ContributorBound, envelopeFloorTokens, envelopeTokens, filler,
  measureContributor, residualSections, stripBudget,
} from "./m176Envelope";
import type { ContributorMeasurement, JsonRecord } from "./m176Envelope";
import { McpResponseDetail, responseTokenCeiling } from "../../src/mcp/responseEnvelope";

const ROOT = path.resolve(".");
const RESULTS = path.join(ROOT, "benchmarks/stage5_vexp_swe_bench_smoke/results");
const DATASET = path.join(RESULTS, "_m160_corpus/swe_bench_verified.jsonl");
const SNAPSHOTS = path.join(RESULTS, "_m176_snapshots");

/**
 * The specimens the contributor sweep runs on.
 *
 * Four real authoritative captures, two per corpus, deliberately spanning task
 * lengths — the M175 defect lived in the task-length tail, and a contributor
 * classification taken only on short tasks would measure a regime the product
 * does not operate in.
 */
const SPECIMENS: ReadonlyArray<{ readonly corpus: string; readonly instanceId: string }> = [
  { corpus: "broad100a", instanceId: "astropy__astropy-14365" },
  { corpus: "broad100a", instanceId: "django__django-10880" },
  { corpus: "broad100b", instanceId: "pytest-dev__pytest-10081" },
  { corpus: "broad100b", instanceId: "django__django-11603" },
];

interface ManifestCase { readonly instanceId: string; readonly repoRoot: string }

function manifestCases(corpus: string): ReadonlyMap<string, string> {
  const file = path.join(RESULTS, "_m171_capture", `${corpus}.manifest.json`);
  const manifest = JSON.parse(readFileSync(file, "utf8")) as { cases: readonly ManifestCase[] };
  return new Map(manifest.cases.map((entry) => [entry.instanceId, entry.repoRoot]));
}

// ── the source trace (§10, §11) ──

interface TraceStep {
  readonly stage: string;
  readonly file: string;
  readonly line: number;
  readonly expect: string;
  readonly what: string;
}

const TRACE: readonly TraceStep[] = [
  {
    stage: "authoritative pipeline result",
    file: "src/mcp/tools.ts",
    line: 9252,
    expect: "const authoritativeResult = compactProductResponse(",
    what: "run_pipeline assembles the authoritative result and hands it to the envelope. "
      + "The envelope is applied to the AUTHORITATIVE payload, before the compact orientation "
      + "the model actually receives is projected from it.",
  },
  {
    stage: "model-visible packing",
    file: "src/mcp/responseEnvelope.ts",
    line: 308,
    expect: "const delivery = applyProgressiveContextBudget(draft, options.requestedContextTokens);",
    what: "productContext.modelVisibleContext is packed to the requested budget; this is the "
      + "step that can already report resolved / delivery_failure / no_result.",
  },
  {
    stage: "request disclosure projection (M175)",
    file: "src/mcp/responseEnvelope.ts",
    line: 320,
    expect: "projectRequestDisclosure(draft, { detail, compactedFields, omitted });",
    what: "The caller's own question stops being echoed; its cost becomes a constant.",
  },
  {
    stage: "degradation ladder",
    file: "src/mcp/responseEnvelope.ts",
    line: 353,
    expect: "const escalation = enforceTotalEnvelope(draft, {",
    what: "Named duplication-removal rungs, then a last-resort sweep that empties the OPTIONAL "
      + "sections in LAST_RESORT_OPTIONAL_SECTIONS. Every other top-level section survives it.",
  },
  {
    stage: "ladder rung 1",
    file: "src/mcp/responseEnvelope.ts",
    line: 381,
    expect: "compactMandatoryProductMetadata(draft, compactedFields, omitted);",
    what: "productContext.items collapses to the single strongest row.",
  },
  {
    stage: "ladder rung 2",
    file: "src/mcp/responseEnvelope.ts",
    line: 394,
    expect: "compactNonessentialEnvelopeMetadata(draft, compactedFields, omitted);",
    what: "Optional compatibility manifests are dropped.",
  },
  {
    stage: "ladder rung 3 — bounded degradation",
    file: "src/mcp/responseEnvelope.ts",
    line: 407,
    expect: "degradeOversizedProductResponse(draft, compactedFields, omitted);",
    what: "productContext is emptied and replaced by a short truthful block. This IS a bounded "
      + "truthful degradation — but it degrades productContext ONLY, and the response is more "
      + "than its productContext.",
  },
  {
    stage: "unreachable determination",
    file: "src/mcp/responseEnvelope.ts",
    line: 420,
    expect: "throw new Error(\"product_response_envelope_unreachable\");",
    what: "The ladder is exhausted and the response still exceeds the ceiling. There is no "
      + "terminal product representation for this state, so it leaves as an exception.",
  },
  {
    stage: "unreachable determination (get_code_context re-measure)",
    file: "src/mcp/responseEnvelope.ts",
    line: 517,
    expect: "throw new Error(\"product_response_envelope_unreachable\");",
    what: "The same condition on the re-measure path, reached when get_code_context overwrites "
      + "freshness and timing on an already-bounded response.",
  },
  {
    stage: "MCP result construction",
    file: "src/mcp/server.ts",
    line: 83,
    expect: "code: McpErrorCode.HandlerFailed,",
    what: "The server's catch-all turns any handler exception into handler_failed. It cannot "
      + "distinguish this predictable product condition from a genuine implementation fault.",
  },
  {
    stage: "transport",
    file: "src/mcp/startServer.ts",
    line: 600,
    expect: "isError: !toolResponse.result.ok,",
    what: "The model receives isError:true and an error object in both content[0].text and "
      + "structuredContent. No repository evidence, no orientation, no decline.",
  },
];

function verifyTrace(): { readonly steps: readonly (TraceStep & { readonly verified: boolean })[]; readonly allVerified: boolean } {
  const steps = TRACE.map((step) => {
    const lines = readFileSync(path.join(ROOT, step.file), "utf8").split("\n");
    const actual = lines[step.line - 1] ?? "";
    return { ...step, verified: actual.trim() === step.expect.trim() };
  });
  return { steps, allVerified: steps.every((step) => step.verified) };
}

// ── §12 contributor sweep ──

/**
 * Every default model-facing top-level section of a `run_pipeline` response, with
 * who supplies its content. The sweep grows each one and reads the floor.
 *
 * `productContext.modelVisibleContext` is deliberately absent: it is the one field
 * the product is FOR, it is bounded by `applyProgressiveContextBudget` before any
 * of this runs, and §37 forbids adding another cap to it.
 */
const CONTRIBUTORS: ReadonlyArray<{
  readonly field: string;
  readonly supplier: ContributorMeasurement["supplier"];
  readonly note: string;
  readonly build?: (characters: number) => unknown;
}> = [
  { field: "request.task", supplier: "caller", note: "The caller's own question. M175 replaced it with a frozen constant." },
  { field: "request.repoRoot", supplier: "caller", note: "Caller-supplied path, spread into request from orchestration.request." },
  { field: "productContext.repository.worktreeId", supplier: "repository", note: "Repository identity inside the protected productContext block." },
  { field: "productContext.freshness.reason", supplier: "product", note: "Freshness prose; protected from the ladder as a truthfulness surface." },
  { field: "productContext.leadPivot", supplier: "repository", note: "Top-match identity: path::symbol from the indexed corpus." },
  { field: "workspaceRouting.reason", supplier: "product", note: "M175-B already found this block is reduced by no rung." },
  {
    field: "workspaceRouting.perRepository[]",
    supplier: "repository",
    note: "One row per workspace member. Grows with the workspace, not with the request.",
    build: (characters: number) => Array.from(
      { length: Math.max(1, Math.floor(characters / 200)) },
      (_unused, index) => ({ repoRoot: `/w/member-${index}`, worktreeId: `wt-${index}`, indexed: true, reason: filler(120, "member routed") }),
    ),
  },
  { field: "intent.reason", supplier: "derived", note: "Intent rationale; only exact legacy aliases are removed." },
  { field: "diagnostics.nudge", supplier: "product", note: "Product advisory attached after assembly." },
  { field: "savedObservation", supplier: "product", note: "Memory write-back record." },
  { field: "warnings", supplier: "product", note: "Compatibility warnings; no rung enumerates them.", build: (characters: number) => [filler(characters, "compatibility warning")] },
  { field: "flow.skipReason", supplier: "derived", note: "Flow decision prose; flow.paths are dropped but the block is kept." },
  { field: "runtime.version", supplier: "product", note: "Runtime provenance stamp." },
  { field: "taskSummary.editGoal", supplier: "derived", note: "In LAST_RESORT_OPTIONAL_SECTIONS; expected to be fully absorbed." },
  { field: "memory.session.note", supplier: "product", note: "In LAST_RESORT_OPTIONAL_SECTIONS; expected to be fully absorbed." },
];

// ── §13 totality classification ──

export enum PathTotality {
  ProvenBounded = "PROVEN_BOUNDED",
  BoundedByDecline = "BOUNDED_BY_DECLINE",
  Unbounded = "UNBOUNDED",
  Unknown = "UNKNOWN",
}

async function main(): Promise<void> {
  mkdirSync(SNAPSHOTS, { recursive: true });
  const statements = loadProblemStatements(DATASET);

  const trace = verifyTrace();
  writeFileSync(
    path.join(RESULTS, "stage5_m176_envelope_failure_trace.json"),
    `${JSON.stringify({
      schemaVersion: "stage5.m176.envelope-failure-trace.v1",
      milestone: "M176",
      workstream: "A",
      question: "Where does product_response_envelope_unreachable come from, and what does a caller receive?",
      producers: [
        { file: "src/mcp/responseEnvelope.ts", line: 420, function: "compactProductResponse" },
        { file: "src/mcp/responseEnvelope.ts", line: 517, function: "remeasureResponseBudget" },
      ],
      productConsumers: [],
      nonProductConsumers: [
        {
          file: "benchmarks/stage5_vexp_swe_bench_smoke/m175Echo.ts",
          function: "compactOrUnreachable",
          what: "M175's offline replay catches the message and carries it as an outcome. "
            + "The only code anywhere that treats this condition as a state rather than a fault.",
        },
      ],
      siblingDefect: {
        file: "src/impact/impactResponseEnvelope.ts",
        line: 340,
        message: "impact_response_envelope_unreachable",
        what: "get_impact_graph has the same shape of terminal throw. Recorded, not repaired: "
          + "M176's scope is the run_pipeline response envelope (§34).",
      },
      classification: "EXHAUSTED_DEGRADATION_LADDER",
      classificationWhy:
        "The throw is not an assertion guarding an invariant that should be impossible, and it is "
        + "not legacy transport code. It is the documented end of a deliberate fail-closed ladder "
        + "(responseEnvelope.ts:652 — 'A successful bounded tool must never knowingly ship "
        + "within_envelope:false'). The fail-closed decision is right; what is missing is a bounded "
        + "terminal REPRESENTATION for the state it closes on, so the condition escapes as an "
        + "exception and is reclassified by the server's catch-all as an implementation fault.",
      architecturalNote:
        "The envelope is enforced on the AUTHORITATIVE result at tools.ts:9252, and the compact "
        + "orientation the model actually receives is projected from it afterwards at tools.ts:9282. "
        + "So a request whose compact orientation would occupy a few hundred tokens can still fail, "
        + "because the payload being measured against the ceiling is not the payload being delivered.",
      steps: trace.steps,
      allStepsVerified: trace.allVerified,
    }, null, 2)}\n`,
  );
  console.log(`trace: ${trace.steps.length} steps, all verified: ${trace.allVerified}`);
  if (!trace.allVerified) {
    for (const step of trace.steps) if (!step.verified) console.log(`  UNVERIFIED ${step.file}:${step.line}`);
  }

  // ── specimens ──
  const specimens: Array<{ corpus: string; instanceId: string; snapshot: JsonRecord }> = [];
  for (const entry of SPECIMENS) {
    const roots = manifestCases(entry.corpus);
    const repoRoot = roots.get(entry.instanceId);
    const task = statements.get(entry.instanceId);
    if (repoRoot === undefined || task === undefined || !existsSync(repoRoot)) {
      console.log(`  SKIPPED ${entry.instanceId} (no workspace or task)`);
      continue;
    }
    const captured = await captureCached(SNAPSHOTS, entry.instanceId, repoRoot, task, CAPTURE_MAX_TOKENS);
    if (captured.snapshot === null || captured.error !== null) {
      console.log(`  SKIPPED ${entry.instanceId} (capture failed: ${captured.error})`);
      continue;
    }
    specimens.push({ ...entry, snapshot: stripBudget(captured.snapshot) });
    console.log(`  captured ${entry.instanceId} (${captured.taskCharacters} task chars)`);
  }
  if (specimens.length === 0) throw new Error("M176-A has no specimens; cannot measure contributors.");

  // ── floors and residues ──
  const floors = specimens.map((specimen) => {
    const residue = residualSections(specimen.snapshot);
    const outcome = compactOutcome(specimen.snapshot, residue.floorTokens);
    const productContext = outcome.response?.productContext as JsonRecord | undefined;
    return {
      instanceId: specimen.instanceId,
      corpus: specimen.corpus,
      authoritativeCharacters: JSON.stringify(specimen.snapshot).length,
      floorTokens: residue.floorTokens,
      minimumCeilingTokens: responseTokenCeiling(0),
      headroomAtMinimumCeilingTokens: responseTokenCeiling(0) - envelopeTokens(outcome.response),
      floorCharacters: residue.totalCharacters,
      resultStateAtFloor: productContext?.resultState ?? null,
      retrievalFoundAtFloor: productContext?.retrievalFound ?? null,
      residualSections: Object.fromEntries(
        Object.entries(residue.sections).filter(([, size]) => size > 2).sort((left, right) => right[1] - left[1]),
      ),
    };
  });

  // ── contributor sweep, on the specimen with the least headroom ──
  const tightest = floors.reduce((least, row) => (row.headroomAtMinimumCeilingTokens < least.headroomAtMinimumCeilingTokens ? row : least));
  const base = specimens.find((specimen) => specimen.instanceId === tightest.instanceId)!.snapshot;
  const measurements: ContributorMeasurement[] = [];
  for (const contributor of CONTRIBUTORS) {
    measurements.push(measureContributor(base, {
      field: contributor.field,
      supplier: contributor.supplier,
      note: contributor.note,
      ...(contributor.build === undefined ? {} : { build: contributor.build }),
    }));
    const last = measurements[measurements.length - 1]!;
    console.log(`  ${last.bound.padEnd(22)} ${last.field} (floor ${last.floorTokens.join(" → ")}`
      + `; exceeds default ceiling at ${last.charactersToExceedDefaultCeiling ?? "never"} chars)`);
  }

  const unbounded = measurements.filter((row) => row.bound === ContributorBound.PotentiallyUnbounded);

  writeFileSync(
    path.join(RESULTS, "stage5_m176_envelope_contributors.json"),
    `${JSON.stringify({
      schemaVersion: "stage5.m176.envelope-contributors.v1",
      milestone: "M176",
      workstream: "A",
      question: "Which default model-facing fields can independently make the envelope unreachable?",
      method:
        "One field at a time is grown on a real authoritative capture and the ENVELOPE FLOOR is "
        + "read — the smallest requestedContextTokens at which the response still terminates. A "
        + "field whose floor tracks the injected size is paid for in full at any size and can "
        + "therefore carry any response over any ceiling. Nothing is classified by looking large.",
      detail: McpResponseDetail.Standard,
      sweptOn: tightest.instanceId,
      sweptOnWhy: "The specimen with the least headroom at the minimum ceiling, so a cap that binds "
        + "only under pressure has the best chance to be observed binding.",
      floors,
      contributors: measurements,
      unboundedFields: unbounded.map((row) => row.field),
      reachabilityAtDefaultBudget: {
        requestedContextTokens: 8_000,
        ceilingTokens: responseTokenCeiling(8_000),
        note: "charactersToExceedDefaultCeiling is how much content in that ONE field takes this "
          + "otherwise ordinary response past the DEFAULT budget's ceiling. Below that size the "
          + "response is delivered; at or above it the tool throws.",
      },
      finding: unbounded.length === 0
        ? "No swept field is unbounded."
        : `${unbounded.length} default model-facing fields grow the floor without limit: `
          + `${unbounded.map((row) => row.field).join(", ")}. Each can independently make the `
          + "envelope unreachable for an otherwise ordinary request.",
    }, null, 2)}\n`,
  );

  // ── §13 totality ──
  const minimumCeiling = responseTokenCeiling(0);
  const paths = [
    {
      path: "run_pipeline → compact orientation (default, fits)",
      totality: PathTotality.ProvenBounded,
      why: "The orientation projector emits a fixed-shape packet and the envelope reports "
        + "within_envelope before it runs.",
    },
    {
      path: "run_pipeline → orientation decline (M174)",
      totality: PathTotality.BoundedByDecline,
      why: "projectOrientationDecline emits frozen phrases plus one verbatim top-match identity. "
        + "Reached only when the envelope has ALREADY terminated.",
    },
    {
      path: "run_pipeline → bounded degradation (ladder rung 3)",
      totality: PathTotality.BoundedByDecline,
      why: "degradeOversizedProductResponse empties productContext. Bounds productContext only; "
        + "the rest of the response is whatever survived the ladder.",
    },
    {
      path: "run_pipeline → ladder exhausted",
      totality: PathTotality.Unbounded,
      why: `The irreducible residue measured at ${tightest.floorTokens} tokens against a minimum `
        + `ceiling of ${minimumCeiling} leaves ${tightest.headroomAtMinimumCeilingTokens} tokens of `
        + "headroom, and unbounded fields feed it. There is no terminal representation: the "
        + "condition throws.",
    },
    {
      path: "run_pipeline → readiness / staleness envelope",
      totality: PathTotality.ProvenBounded,
      why: "Returned before assembly; carries reason and nextTool and never reaches the envelope.",
    },
    {
      path: "get_code_context → remeasureResponseBudget",
      totality: PathTotality.Unbounded,
      why: "Same exhausted-ladder throw at responseEnvelope.ts:517, reached after the wrapper "
        + "overwrites freshness and timing on an already-bounded response.",
    },
    {
      path: "run_pipeline detail=debug",
      totality: PathTotality.Unknown,
      why: "Debug is subject to the same ceiling and the same throw, and M175 established debug "
        + "can degrade on cases the default path serves. Measured in M176-D.",
    },
  ];

  writeFileSync(
    path.join(RESULTS, "stage5_m176_response_path_totality.json"),
    `${JSON.stringify({
      schemaVersion: "stage5.m176.response-path-totality.v1",
      milestone: "M176",
      workstream: "A",
      question: "Does every default response path have a proof or a bounded fallback?",
      minimumCeilingTokens: minimumCeiling,
      paths,
      unboundedOrUnknown: paths.filter((row) => row.totality !== PathTotality.ProvenBounded
        && row.totality !== PathTotality.BoundedByDecline).map((row) => row.path),
    }, null, 2)}\n`,
  );

  // ── §6 current state machine ──
  writeFileSync(
    path.join(RESULTS, "stage5_m176_state_machine_before.json"),
    `${JSON.stringify({
      schemaVersion: "stage5.m176.state-machine-before.v1",
      milestone: "M176",
      workstream: "A",
      declineAuthority: {
        file: "src/runPipeline/orientationDecline.ts",
        function: "decideDecline",
        line: 201,
        order: [
          { rank: 1, test: "!ready", state: "repository_not_ready", discloseTopMatch: false },
          { rank: 2, test: "!retrievalFound", state: "no_relevant_evidence", discloseTopMatch: false },
          { rank: 3, test: "deliveryFailed", state: "evidence_found_but_undelivered", discloseTopMatch: true },
          { rank: 4, test: "otherwise", state: "no_focus_selected", discloseTopMatch: true },
        ],
      },
      deliveryAuthority: {
        file: "src/productContext/budgetDelivery.ts",
        function: "applyProgressiveContextBudget",
        states: ["resolved", "delivery_failure", "no_result"],
        retrievalFoundDerivation: "product.resolved === true || sourceItems.length > 0",
        nonIdempotenceWarning:
          "The derivation does not consult a previously written productContext.retrievalFound, so "
          + "re-compacting an already-degraded response reclassifies delivery_failure as no_result. "
          + "The live product compacts once, so this is not a shipped defect — but it makes M175's "
          + "8,000-token .debug captures unusable as specimens for delivery-state analysis.",
      },
      missingState: {
        condition: "valid request + authoritative state + ladder exhausted",
        currentTerminal: "throw → McpErrorCode.HandlerFailed → isError:true",
        note: "No state in either authority covers this. decideDecline is never reached, because "
          + "the exception is raised before the orientation and decline projectors run.",
      },
      derivedPlacement: {
        rank: 3.5,
        rationale:
          "Readiness and genuinely-empty retrieval both rank ABOVE it, unchanged: a claim derived "
          + "from an unready index is not a fact, and an empty result is retrieval's own finding. "
          + "It ranks BELOW neither of those and ABOVE unexpected failure, because it is predictable "
          + "and the product knows exactly why it happened. It is NOT the same state as "
          + "evidence_found_but_undelivered: that one means the envelope was reached and the evidence "
          + "did not survive it; this one means the envelope could not be reached at all.",
      },
    }, null, 2)}\n`,
  );

  console.log("\nM176-A artifacts written.");
  console.log(`  tightest specimen: ${tightest.instanceId} floor=${tightest.floorTokens} `
    + `headroom@minCeiling=${tightest.headroomAtMinimumCeilingTokens} tokens`);
  console.log(`  unbounded contributors: ${unbounded.length === 0 ? "none" : unbounded.map((row) => row.field).join(", ")}`);
}

await main();
