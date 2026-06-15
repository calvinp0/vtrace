// M7 conservative-localization context policy — gate + metadata unit tests.
//
// These are PURE: they exercise `decideCapsuleV2ContextPolicy` directly with
// constructed task-shape signals + capsule diagnostics (no DB, no agents). They
// lock in the M7 behaviour:
//   - an inject-bound decision is DOWNGRADED to no_context only when the issue
//     TRACEBACK-localizes the lead pivot with no vtrace advantage;
//   - file-/symbol-named localization is deliberately NOT downgraded (the offline
//     M6 audit showed it cannot separate inject-without-benefit cases from genuine
//     wins — e.g. django-11728 — on localization signal alone, so a conservative
//     gate keeps them inject);
//   - actionability / hidden-pivot / line-anchor advantages block the downgrade;
//   - existing no_context / override behaviour is unchanged.

import assert from "node:assert/strict";
import { test } from "bun:test";

import { RecommendedCapsuleMode, TargetConfidence } from "../../src/capsule/recommendMode";
import type { LocalizationSignals } from "../../src/capsuleV2/localizationSignals";
import {
  applyContextPolicyOverride,
  decideCapsuleV2ContextPolicy,
  indexedContextMetaFields,
  type CapsuleV2PolicyDiagnostics,
  type ContextPolicySignals,
  type IndexedContextResult,
} from "./run_stage5_vexp_swe_bench_smoke";

// A "moderate inject" task shape: not micro (so not cheap/local), not navigation-
// heavy (so no strong-capsule-evidence inject) — it reaches the step-4 standard
// inject, exactly where the conservative downgrade can act.
function moderateSignals(overrides: Partial<ContextPolicySignals> = {}): ContextPolicySignals {
  return {
    failingTestCount: 1,
    problemStatementLength: 2000,
    crossModule: false,
    touchesComplexInternals: false,
    likelyFileCount: 1,
    likelySymbolCount: 2,
    hasExplicitTargets: true,
    recommendedMode: RecommendedCapsuleMode.Standard,
    targetConfidence: TargetConfidence.Medium,
    ...overrides,
  };
}

const PIVOT = "pkg/sub/target.py";

function diag(overrides: Partial<CapsuleV2PolicyDiagnostics> = {}): CapsuleV2PolicyDiagnostics {
  return {
    capsuleAction: "inject",
    hasContext: true,
    actualMode: "standard",
    pivotCount: 1,
    supportCount: 1,
    topPivotHasSource: true,
    topPivotSourceChars: 1200,
    editRiskDirectiveCount: 0,
    lineAnchorResolutionUsed: false,
    sqlRenderingBackfillUsed: false,
    actionabilityHintCount: 0,
    topPivotPath: PIVOT,
    localization: undefined,
    ...overrides,
  };
}

function loc(
  kind: LocalizationSignals["kind"],
  overrides: Partial<LocalizationSignals> = {},
): LocalizationSignals {
  return {
    tracebackPaths: [],
    tracebackSymbols: [],
    explicitFileMentions: [],
    explicitSymbolMentions: [],
    resolvedFiles: [PIVOT],
    resolvedSymbols: [],
    confidence: "strong",
    kind,
    reasons: [],
    ...overrides,
  };
}

// 7. Auto SKIPS a traceback-localized task with no advantage.
test("auto skips a traceback-localized task with no advantage", () => {
  const decision = decideCapsuleV2ContextPolicy(moderateSignals(), diag({ localization: loc("traceback") }));
  assert.equal(decision.action, "no_context");
  assert.ok(decision.decisionSignals.includes("skip_traceback_localized"));
});

// 8. Auto does NOT skip an explicit file-named task (conservative; see header).
test("auto keeps a file-named-localized task as inject (conservative)", () => {
  const decision = decideCapsuleV2ContextPolicy(moderateSignals(), diag({ localization: loc("file_named") }));
  assert.equal(decision.action, "inject");
  assert.ok(!decision.decisionSignals.includes("skip_traceback_localized"));
});

// 9. Auto does NOT skip an explicit symbol-named task (conservative; see header).
test("auto keeps a symbol-named-localized task as inject (conservative)", () => {
  const decision = decideCapsuleV2ContextPolicy(moderateSignals(), diag({ localization: loc("symbol_named") }));
  assert.equal(decision.action, "inject");
  assert.ok(!decision.decisionSignals.includes("skip_traceback_localized"));
});

// 10. Auto INJECTS when actionability hints exist, even for a traceback-localized task.
test("actionability hints block the localization downgrade", () => {
  const decision = decideCapsuleV2ContextPolicy(
    moderateSignals(),
    diag({ localization: loc("traceback"), actionabilityHintCount: 2 }),
  );
  assert.equal(decision.action, "inject");
  assert.ok(decision.decisionSignals.includes("actionability_hint_present"));
  assert.ok(!decision.decisionSignals.includes("skip_traceback_localized"));
});

// 11a. A hidden pivot (lead pivot the issue does NOT name) blocks the downgrade.
test("a hidden pivot blocks the localization downgrade", () => {
  const decision = decideCapsuleV2ContextPolicy(
    moderateSignals(),
    diag({ localization: loc("traceback", { resolvedFiles: ["other/named.py"] }), topPivotPath: PIVOT }),
  );
  assert.equal(decision.action, "inject");
  assert.ok(decision.decisionSignals.includes("hidden_pivot_advantage"));
  assert.ok(!decision.decisionSignals.includes("skip_traceback_localized"));
});

// 11b. Edit-changing evidence (a resolved line anchor) blocks the downgrade.
test("a resolved line anchor blocks the localization downgrade", () => {
  const decision = decideCapsuleV2ContextPolicy(
    moderateSignals(),
    diag({ localization: loc("traceback"), lineAnchorResolutionUsed: true }),
  );
  assert.equal(decision.action, "inject");
  assert.ok(!decision.decisionSignals.includes("skip_traceback_localized"));
});

// 12. force-inject still injects (over a localization skip).
test("force-inject overrides the localization skip", () => {
  const skip = decideCapsuleV2ContextPolicy(moderateSignals(), diag({ localization: loc("traceback") }));
  assert.equal(skip.action, "no_context");
  const forced = applyContextPolicyOverride(skip, "force-inject", true);
  assert.equal(forced.action, "inject");
});

// 13. explicit force-no-context still skips (over an inject).
test("force-no-context overrides an inject", () => {
  const inject = decideCapsuleV2ContextPolicy(moderateSignals(), diag({ localization: loc("file_named") }));
  assert.equal(inject.action, "inject");
  const forced = applyContextPolicyOverride(inject, "force-no-context", true);
  assert.equal(forced.action, "no_context");
});

// 14. The no_context decision carries the skip reason AND the localization signals.
test("localization skip decision carries skip reason + localization signals", () => {
  const decision = decideCapsuleV2ContextPolicy(moderateSignals(), diag({ localization: loc("traceback") }));
  assert.equal(decision.action, "no_context");
  assert.ok(decision.decisionSignals.includes("skip_traceback_localized"));
  assert.equal(decision.localizationSignals?.kind, "traceback");
  assert.deepEqual(decision.vtraceAdvantageSignals, []);
});

// 15. The Stage 5 harness records the new policy reason + decision signals in the
//     run metadata (the offline-readable provenance of a skip).
test("harness run metadata records the new policy reason + decision signals", () => {
  const decision = decideCapsuleV2ContextPolicy(moderateSignals(), diag({ localization: loc("traceback") }));
  const meta = indexedContextMetaFields({
    policyReason: decision.reason,
    contextPolicyDecisionSignals: decision.decisionSignals,
    policyAction: "skip",
    contextPolicyAction: "no_context",
  } as unknown as IndexedContextResult);
  assert.equal(meta.vtracePolicyReason, decision.reason);
  assert.ok((meta.vtraceContextPolicyDecisionSignals ?? []).includes("skip_traceback_localized"));
});

// 16. Existing no_context behaviour is unchanged: a capsule that recovered nothing
//     still skips, regardless of localization; a cheap/local micro task still skips.
test("existing no_context behaviour is preserved", () => {
  const capsuleEmpty = decideCapsuleV2ContextPolicy(
    moderateSignals(),
    diag({ capsuleAction: "skip", hasContext: false, actualMode: "no_context", localization: loc("file_named") }),
  );
  assert.equal(capsuleEmpty.action, "no_context");
  assert.ok(capsuleEmpty.decisionSignals.includes("capsule_no_context"));

  const cheapLocal = decideCapsuleV2ContextPolicy(
    moderateSignals({
      failingTestCount: 1,
      problemStatementLength: 200,
      recommendedMode: RecommendedCapsuleMode.Micro,
      likelyFileCount: 1,
    }),
    diag({ actualMode: "micro", topPivotHasSource: false, topPivotSourceChars: null }),
  );
  assert.equal(cheapLocal.action, "no_context");
  assert.ok(cheapLocal.decisionSignals.includes("micro_capsule"));
});
