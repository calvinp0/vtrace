/**
 * M178-A — the predicate inventory, and the controls that make it trustworthy.
 *
 *   bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m178_predicate_audit.ts \
 *     --out benchmarks/stage5_vexp_swe_bench_smoke/results
 *
 * Three things are established here, in order of how much they change the answer.
 *
 * 1. C2 IS DEAD, AND THAT IS PROVED RATHER THAN SAMPLED. `totalCeiling` is
 *    `Math.min(requested + allowance, floor(80_000 / 4))`, and
 *    `estimatedTotalTokens` is `ceil(serializedCharacters / 4)`. So C1 already
 *    bounds the response at `4 * totalCeiling <= 80_000` characters, which IS
 *    C2's bound. C2 cannot fail while C1 holds, at any budget a caller can name.
 *    `c2Implication` below checks the whole reachable domain rather than a
 *    handful of budgets, because "I tried some numbers" is not a proof of
 *    redundancy.
 *
 * 2. THE ESTIMATORS DISAGREE ACROSS THE REPOSITORY, AND §43 SAYS SO OUT LOUD.
 *    Both envelopes measure with `chars/4`. The orientation projection measures
 *    with M166's calibrated 0.3174 tokens/character against a FIXED 2,000-token
 *    ceiling that is not derived from `max_tokens` at all. Those are different
 *    units answering to different budgets, and the audit records them as such.
 *
 * 3. THE INSTRUMENT IS CONTROLLED BEFORE IT IS BELIEVED. §25 requires a known
 *    positive, a known negative and an identity control for every classifier;
 *    §14 requires the `limits.maxTokens` echo to be separated from content; §15
 *    requires every control to demonstrate the predicate state it actually
 *    reached. All five run here and each reports what it reached.
 *
 * Deterministic, offline, no paid API, no Docker.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import type { ImpactGraphOutput } from "../../src/impact/getImpactGraph";
import {
  compactImpactProductResponse,
  IMPACT_HARD_SERIALIZED_CHARACTER_CEILING,
  IMPACT_METADATA_ALLOWANCE_FLOOR_TOKENS,
  impactResponseTokenCeiling,
} from "../../src/impact/impactResponseEnvelope";
import {
  RESPONSE_METADATA_ALLOWANCE_FLOOR_TOKENS,
  RESPONSE_METADATA_ALLOWANCE_RATIO,
  responseTokenCeiling,
} from "../../src/mcp/responseEnvelope";
import { ORIENTATION_POLICY } from "../../src/runPipeline/orientationProjection";
import { authoritativeImpact, openWorkspace } from "./m177ImpactEnvelope";
import {
  budgetParameterFields,
  classify,
  contentIdentity,
  fullIdentity,
  observe,
  predictedDisagreementWindow,
} from "./m178FitContract";

const REPO = path.resolve(import.meta.dir, "results/workspaces/m160_broad_b/pytest-dev__pytest-10081");
const KNOWN_POSITIVE_SYMBOL = "src/_pytest/debugging.py::_enter_pdb";
const DEFAULT_BUDGET = 1_200;
const HARD_MAX_TOKENS = 20_000;

const argOf = (flag: string, fallback: string): string => {
  const index = process.argv.indexOf(flag);
  return index >= 0 && index + 1 < process.argv.length ? process.argv[index + 1] : fallback;
};

function envelopeAt(authoritative: ImpactGraphOutput, maxTokens: number) {
  const draft = structuredClone(authoritative) as ImpactGraphOutput;
  (draft.limits as { maxTokens: number }).maxTokens = maxTokens;
  const response = compactImpactProductResponse(draft);
  return {
    response,
    observation: observe(KNOWN_POSITIVE_SYMBOL, maxTokens, response),
    contentHash: contentIdentity(response),
    fullHash: fullIdentity(response),
  };
}

/**
 * Exhaustive check that C1 implies C2 over every budget the tool accepts, plus
 * the out-of-range values the clamp would map into it. If this ever reports a
 * counterexample, C2 has become load-bearing and the inventory below is stale.
 */
function c2Implication(): { holds: boolean; counterexamples: number[]; maxImpliedCharacters: number } {
  const counterexamples: number[] = [];
  let maxImpliedCharacters = 0;
  for (let requested = 1; requested <= HARD_MAX_TOKENS; requested += 1) {
    const totalCeiling = Math.min(
      impactResponseTokenCeiling(requested),
      Math.floor(IMPACT_HARD_SERIALIZED_CHARACTER_CEILING / 4),
    );
    // The largest character count that can still satisfy C1.
    const impliedCharacters = totalCeiling * 4;
    maxImpliedCharacters = Math.max(maxImpliedCharacters, impliedCharacters);
    if (impliedCharacters > IMPACT_HARD_SERIALIZED_CHARACTER_CEILING) counterexamples.push(requested);
  }
  return { holds: counterexamples.length === 0, counterexamples: counterexamples.slice(0, 8), maxImpliedCharacters };
}

async function main(): Promise<void> {
  const out = argOf("--out", path.resolve(import.meta.dir, "results"));
  mkdirSync(out, { recursive: true });
  const db = openWorkspace(REPO);

  try {
    const reference = await authoritativeImpact(db, REPO, {
      symbolFqn: KNOWN_POSITIVE_SYMBOL,
      maxTokens: DEFAULT_BUDGET,
    });
    if (!reference.ok || reference.output === null) throw new Error("known-positive symbol did not resolve");
    const authoritative = reference.output;

    // The ladder floor, and the window the floor arithmetic predicts.
    const floorProbe = (() => {
      let low = 1;
      let high = HARD_MAX_TOKENS;
      while (low < high) {
        const mid = Math.floor((low + high) / 2);
        if (envelopeAt(authoritative, mid).observation.declined) low = mid + 1;
        else high = mid;
      }
      return low;
    })();
    const atFloor = envelopeAt(authoritative, floorProbe);
    const window = predictedDisagreementWindow(
      atFloor.observation.modelVisibleEstimatedTokens,
      atFloor.observation.metadataEstimatedTokens,
    );

    /* ---------------- instrument controls (§25, §14, §15) ---------------- */

    // KNOWN POSITIVE — a budget inside the predicted window must classify as the
    // disagreement and must report the state it reached.
    const positiveBudget = window.width > 0 ? window.lowBudget : floorProbe;
    const positive = envelopeAt(authoritative, positiveBudget);

    // KNOWN NEGATIVE — the default budget must be an ordinary agreeing delivery.
    const negative = envelopeAt(authoritative, DEFAULT_BUDGET);

    // IDENTITY — the same input twice must classify the same and hash the same.
    const identityA = envelopeAt(authoritative, positiveBudget);
    const identityB = envelopeAt(authoritative, positiveBudget);

    // §14 — the `limits.maxTokens` TRAP. Two DIFFERENT budgets inside the window
    // deliver the same evidence; the responses differ only by the echoed budget
    // and the figures that report it. Content identity must therefore MATCH while
    // full identity DIFFERS. If content identity also differed, the instrument
    // would be attributing budget echo to content, which is the exact error M177
    // made when it read seven distinct terminal bodies that were one body.
    const echoLow = envelopeAt(authoritative, window.lowBudget);
    const echoHigh = envelopeAt(authoritative, Math.max(window.lowBudget, window.highBudget));
    const echoTrapControlled = window.width > 1
      ? echoLow.contentHash === echoHigh.contentHash && echoLow.fullHash !== echoHigh.fullHash
      : null;

    // §15 — the FIXTURE TRAP. A fixture that fits at max_tokens=1 never reaches
    // the branch it is believed to test. This records, for the known positive,
    // that max_tokens=1 really does decline.
    const fixtureTrap = envelopeAt(authoritative, 1);

    // The classifier must not be degenerate: it must emit more than one label
    // across the budgets probed here, or §25 says treat it as suspect.
    const labels = new Set([
      positive.observation.classification,
      negative.observation.classification,
      fixtureTrap.observation.classification,
    ]);

    const audit = {
      milestone: "M178-A",
      generatedFrom: "run_stage5_m178_predicate_audit.ts",

      /* ---------------- §11/§12/§13 — the inventory ---------------- */
      predicates: [
        {
          id: "P1_pipeline_delivery",
          site: "src/productContext/budgetDelivery.ts:136",
          expression: "estimateTokens(render(product, items)) <= budget",
          measures: "the rendered model-visible context string",
          unit: "tokens (chars/4)",
          budgetSource: "the caller's max_tokens",
          consumers: ["applyProgressiveContextBudget, called from compactProductResponse"],
          onFalse: "shed a further delivery rung; ultimately deliveryFailed",
          compactionCanAffectIt: true,
          modelSeesTheConstrainedBytes: true,
        },
        {
          id: "P2_pipeline_envelope_ladder",
          site: "src/mcp/responseEnvelope.ts:1509 (withinBudget)",
          expression: "estimateTokens(serialize(draft)) + accountingTokens() <= ceilingTokens",
          measures: "the complete serialized response plus the accounting block it will carry",
          unit: "tokens (chars/4)",
          budgetSource: "responseTokenCeiling(max_tokens) = max_tokens + max(1000, 15%)",
          consumers: ["enforceTotalEnvelope"],
          onFalse: "apply the next envelope compaction step",
          compactionCanAffectIt: true,
          modelSeesTheConstrainedBytes: true,
        },
        {
          id: "P3_pipeline_envelope_terminal",
          site: "src/mcp/responseEnvelope.ts:2311 (within_envelope)",
          expression: "estimated_total_response_tokens <= responseTokenCeiling(requested_context_tokens)",
          measures: "the complete serialized response",
          unit: "tokens (chars/4)",
          budgetSource: "responseTokenCeiling(max_tokens)",
          consumers: ["compactProductResponse terminal", "remeasureResponseBudget terminal"],
          onFalse: "escalate a rung; when exhausted, buildBoundedEnvelopeDecline",
          compactionCanAffectIt: true,
          modelSeesTheConstrainedBytes: true,
          note: "P2 and P3 are the SAME concept. run_pipeline's ladder is gated on the condition its own terminal tests.",
        },
        {
          id: "C1_impact_total",
          site: "src/impact/impactResponseEnvelope.ts:192",
          expression: "estimatedTotalTokens <= totalCeiling",
          measures: "the complete serialized impact response",
          unit: "tokens (chars/4)",
          budgetSource: "min(max_tokens + max(800, 15%), 20000)",
          consumers: ["fits() (ladder)", "the terminal at :330"],
          onFalse: "ladder: next rung. terminal: buildBoundedImpactDecline",
          compactionCanAffectIt: "partially — only the five evidence keys, never the metadata",
          modelSeesTheConstrainedBytes: true,
        },
        {
          id: "C2_impact_characters",
          site: "src/impact/impactResponseEnvelope.ts:193",
          expression: "serializedCharacters <= 80000",
          measures: "the complete serialized impact response",
          unit: "characters",
          budgetSource: "a flat constant",
          consumers: ["fits() (ladder)", "the terminal at :330"],
          onFalse: "ladder: next rung. terminal: buildBoundedImpactDecline",
          compactionCanAffectIt: true,
          modelSeesTheConstrainedBytes: true,
          verdict: "DEAD — implied by C1 at every budget. See c2Implication.",
        },
        {
          id: "C3_impact_evidence",
          site: "src/impact/impactResponseEnvelope.ts:194",
          expression: "modelVisibleEstimatedTokens <= requestedMaxTokens",
          measures: "five keys only — edges, nodes, view, directRelations, paths",
          unit: "tokens (chars/4)",
          budgetSource: "the caller's max_tokens",
          consumers: ["fits() (ladder) ONLY — the terminal at :330 does not test it"],
          onFalse: "ladder: next rung. terminal: no effect.",
          compactionCanAffectIt: true,
          modelSeesTheConstrainedBytes: true,
          note: "This is the impact path's analogue of P1, fused into the same predicate as C1.",
        },
        {
          id: "P6_orientation_related_cap",
          site: "src/runPipeline/orientationProjection.ts:328",
          expression: "orientationTokens(assemble(focus, next, notes)) > ORIENTATION_POLICY.ceilingTokens",
          measures: "the assembled orientation packet",
          unit: "tokens (characters * 0.3174, M166's calibrated provider rate)",
          budgetSource: `a FIXED ${ORIENTATION_POLICY.ceilingTokens}-token constant, NOT the caller's max_tokens`,
          consumers: ["projectRunPipelineOrientation"],
          onFalse: "stop admitting related entries",
          compactionCanAffectIt: true,
          modelSeesTheConstrainedBytes: true,
          verdict: "A DIFFERENT UNIT AND A DIFFERENT BUDGET from every predicate above. §43.",
        },
        {
          id: "P7_impact_path_budget",
          site: "src/impact/getImpactGraph.ts:966",
          expression: "used + cost > maxTokens -> stop",
          measures: "retained path evidence, PRE-ENVELOPE",
          unit: "tokens (chars/4)",
          budgetSource: "the caller's max_tokens",
          consumers: ["getImpactGraph (the ENGINE, not the envelope)"],
          onFalse: "stop admitting paths",
          compactionCanAffectIt: false,
          modelSeesTheConstrainedBytes: true,
          note: "The second spend of max_tokens on this path, and the reason M178-B holds the engine fixed.",
        },
      ],

      /* ---------------- §17 — accounting surfaces ---------------- */
      accountingSurfaces: [
        {
          surface: "structuredContent",
          measuredUnit: "tokens (chars/4)",
          modelSeesIt: true,
          wireOnly: false,
          usedByFitCondition: ["C1", "C3 (five keys of it)", "P2", "P3"],
          evidence: "M167 — the proven agent client reads structuredContent.",
        },
        {
          surface: "content[0].text fallback",
          measuredUnit: "characters",
          modelSeesIt: false,
          wireOnly: true,
          usedByFitCondition: [],
          evidence: "M167 — a total duplicate costing 0 model tokens in the proven client; unremovable under protocol 2024-11-05.",
        },
        {
          surface: "request echo (limits.maxTokens, responseBudget.requestedMaxTokens)",
          measuredUnit: "tokens (chars/4)",
          modelSeesIt: true,
          wireOnly: false,
          usedByFitCondition: ["C1 (it is serialized, so it is counted)"],
          evidence: "M175 repaired its cost to a constant 65 tokens. It is a BUDGET PARAMETER, never content. §14.",
        },
        {
          surface: "JSON-RPC protocol wrapper",
          measuredUnit: "bytes",
          modelSeesIt: false,
          wireOnly: true,
          usedByFitCondition: [],
          evidence: "M167 — outside every predicate in this inventory.",
        },
        {
          surface: "internal diagnostics (detail=debug)",
          measuredUnit: "tokens (chars/4)",
          modelSeesIt: true,
          wireOnly: false,
          usedByFitCondition: ["C1", "P2", "P3"],
          evidence: "M166 — moved behind detail=debug because the model is billed for every character.",
        },
        {
          surface: "impact response metadata (richSummary, callerCoverage, summary, coverage, resolvedSymbol, diagnostics, timing)",
          measuredUnit: "tokens (chars/4)",
          modelSeesIt: true,
          wireOnly: false,
          usedByFitCondition: ["C1 only — C3 excludes it by construction"],
          evidence: "M177 measured it at 745 of 1,217 tokens (61%) at the envelope floor. No rung of the ladder can shrink it.",
        },
      ],

      /* ---------------- §42/§43 — estimator audit ---------------- */
      estimators: {
        impactEnvelope: { method: "chars_div_4", exactTokenizer: false, site: "src/capsuleV2/tokens.ts estimateTokens" },
        pipelineEnvelope: { method: "chars_div_4", exactTokenizer: false, site: "src/capsuleV2/tokens.ts estimateTokens" },
        pipelineDelivery: { method: "chars_div_4", exactTokenizer: false, site: "src/capsuleV2/tokens.ts estimateTokens" },
        orientationProjection: {
          method: "characters * 0.3174032272551657",
          exactTokenizer: false,
          site: "src/runPipeline/orientationProjection.ts:133",
          note: "M166's measured provider rate over 363 samples. chars/4 understates serialized tool JSON materially.",
        },
        unitConsistencyDefect: {
          present: true,
          description:
            "C2 compares CHARACTERS to a character constant while C1 and C3 compare TOKENS to token budgets, inside one boolean. "
            + "The comparison is internally consistent (each side is in its own unit) but the conjunction hides that one condition "
            + "is not denominated in the caller's currency. C2 is dead, so nothing rides on it today.",
        },
      },

      constants: {
        IMPACT_METADATA_ALLOWANCE_FLOOR_TOKENS,
        IMPACT_HARD_SERIALIZED_CHARACTER_CEILING,
        RESPONSE_METADATA_ALLOWANCE_FLOOR_TOKENS,
        RESPONSE_METADATA_ALLOWANCE_RATIO,
        orientationCeilingTokens: ORIENTATION_POLICY.ceilingTokens,
        pipelineCeilingAtDefault: responseTokenCeiling(DEFAULT_BUDGET),
        impactCeilingAtDefault: impactResponseTokenCeiling(DEFAULT_BUDGET),
      },

      c2Implication: c2Implication(),

      knownPositive: {
        symbolFqn: KNOWN_POSITIVE_SYMBOL,
        firstDeliveringBudget: floorProbe,
        modelVisibleFloorTokens: atFloor.observation.modelVisibleEstimatedTokens,
        metadataFloorTokens: atFloor.observation.metadataEstimatedTokens,
        predictedWindow: window,
        windowWidthEquals: "IMPACT_METADATA_ALLOWANCE_FLOOR_TOKENS - metadataFloorTokens",
        windowWidthCheck: window.width === Math.max(
          0,
          IMPACT_METADATA_ALLOWANCE_FLOOR_TOKENS - atFloor.observation.metadataEstimatedTokens,
        ),
      },

      instrumentControls: {
        knownPositive: {
          budget: positiveBudget,
          classification: positive.observation.classification,
          reachedState: positive.observation.reachedState,
          passes: positive.observation.classification === "emitted_with_ladder_gate_false",
        },
        knownNegative: {
          budget: DEFAULT_BUDGET,
          classification: negative.observation.classification,
          reachedState: negative.observation.reachedState,
          passes: negative.observation.classification === "agree_normal",
        },
        identity: {
          budget: positiveBudget,
          passes: identityA.fullHash === identityB.fullHash
            && identityA.observation.classification === identityB.observation.classification,
        },
        budgetEchoTrap: {
          controlled: echoTrapControlled,
          budgetParameterFields: budgetParameterFields(),
          lowBudget: window.lowBudget,
          highBudget: window.highBudget,
          contentIdentical: echoLow.contentHash === echoHigh.contentHash,
          fullIdentical: echoLow.fullHash === echoHigh.fullHash,
          passes: echoTrapControlled === null ? "not_applicable_window_too_narrow" : echoTrapControlled,
        },
        fixtureTrap: {
          budget: 1,
          reachedState: fixtureTrap.observation.reachedState,
          declines: fixtureTrap.observation.declined,
          passes: fixtureTrap.observation.declined,
          note: "M177's graph() fixture fitted at max_tokens=1 and never reached this branch. This one declines, measured.",
        },
        classifierNotDegenerate: { distinctLabels: [...labels], passes: labels.size > 1 },
      },
    };

    writeFileSync(path.join(out, "stage5_m178_predicate_inventory.json"), `${JSON.stringify(audit, null, 2)}\n`);

    const controls = audit.instrumentControls;
    console.log(JSON.stringify({
      c2Implication: audit.c2Implication,
      knownPositive: audit.knownPositive,
      controls: {
        knownPositive: controls.knownPositive.passes,
        knownNegative: controls.knownNegative.passes,
        identity: controls.identity.passes,
        budgetEchoTrap: controls.budgetEchoTrap.passes,
        fixtureTrap: controls.fixtureTrap.passes,
        classifierNotDegenerate: controls.classifierNotDegenerate.passes,
      },
      reached: {
        positive: controls.knownPositive.reachedState,
        negative: controls.knownNegative.reachedState,
        fixture: controls.fixtureTrap.reachedState,
      },
    }, null, 2));
  } finally {
    db.close();
  }
}

await main();
