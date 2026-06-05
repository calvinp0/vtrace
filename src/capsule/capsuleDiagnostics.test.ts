import assert from "node:assert/strict";
import { test } from "bun:test";

import { computeCapsuleBudgetUsage, computeCapsuleItemCost, createCharacterBudget } from "./budget";
import { buildCapsuleDiagnostics, renderCompactCapsule } from "./capsuleDiagnostics";
import { CapsuleMode } from "./capsuleModes";
import { RecommendedCapsuleMode, TargetConfidence, type ModeRecommendation } from "./recommendMode";
import {
  CapsuleContentMode,
  CapsuleInclusionReasonKind,
  CapsuleItemRole,
  type Capsule,
  type PivotCapsuleItem,
  type SupportCapsuleItem,
} from "./types";
import { EdgeType, SymbolKind } from "../domain/types";
import { GraphScoreSignal, SymbolSearchMatchField } from "../retrieval/types";

const RECOMMENDATION: ModeRecommendation = {
  recommendedMode: RecommendedCapsuleMode.Full,
  targetConfidence: TargetConfidence.High,
  retrievalReason: "Navigation-heavy task: touches complex internals.",
};

test("diagnostics expose the required machine-readable shape", () => {
  const capsule = makeCapsule();
  const diagnostics = buildCapsuleDiagnostics({
    mode: CapsuleMode.Full,
    capsule,
    recommendation: RECOMMENDATION,
  });

  assert.deepEqual(Object.keys(diagnostics).sort(), [
    "action_header",
    "actual_mode",
    "context_chars",
    "context_items",
    "likely_files",
    "likely_symbols",
    "mode",
    "pivot_count",
    "recommended_mode",
    "retrieval_reason",
    "search_budget",
    "search_budget_reason",
    "support_count",
    "target_confidence",
  ]);
  // The action header + search budget are always present (Requirement 8); their
  // defaults derive from the capsule's lead pivot when no orchestrator supplies
  // richer values.
  assert.equal(diagnostics.action_header.has_target, true);
  assert.equal(diagnostics.action_header.pivot_file, "src/session/service.ts");
  assert.equal(diagnostics.action_header.pivot_symbol, "SessionManager");
  assert.ok(["low", "moderate", "high"].includes(diagnostics.search_budget));
  assert.ok(diagnostics.search_budget_reason.length > 0);
  assert.equal(diagnostics.mode, "full");
  assert.equal(diagnostics.recommended_mode, "full");
  assert.equal(diagnostics.actual_mode, "full");
  assert.equal(diagnostics.target_confidence, "high");
  assert.equal(diagnostics.context_items, 2);
  assert.equal(diagnostics.pivot_count, 1);
  assert.equal(diagnostics.support_count, 1);
  assert.ok(diagnostics.context_chars > 0);
});

test("diagnostics fall back to capsule files/symbols when shaping is absent", () => {
  const diagnostics = buildCapsuleDiagnostics({
    mode: CapsuleMode.Standard,
    capsule: makeCapsule(),
    recommendation: RECOMMENDATION,
  });
  assert.deepEqual(diagnostics.likely_files, ["src/session/service.ts"]);
  assert.deepEqual(diagnostics.likely_symbols, ["SessionManager", "createSession"]);
});

test("diagnostics prefer shaping-provided files/symbols and explicit metrics", () => {
  const diagnostics = buildCapsuleDiagnostics({
    mode: CapsuleMode.Micro,
    capsule: makeCapsule(),
    recommendation: { ...RECOMMENDATION, recommendedMode: RecommendedCapsuleMode.Micro },
    likelyFiles: ["a.py", "b.py"],
    likelySymbols: ["foo"],
    contextChars: 1234,
    contextItems: 2,
  });
  assert.deepEqual(diagnostics.likely_files, ["a.py", "b.py"]);
  assert.deepEqual(diagnostics.likely_symbols, ["foo"]);
  assert.equal(diagnostics.context_chars, 1234);
});

test("compact capsule surfaces primary target/support/snippets and omits the problem statement", () => {
  const result = renderCompactCapsule(makeCapsule(), {
    maxChars: 4_000,
    tests: ["tests.foo.TestBar.test_baz"],
    reason: "why this matters",
  });

  // The single primary edit target appears near the top, before snippets.
  const targetsIdx = result.text.indexOf("## Primary edit target");
  const snippetsIdx = result.text.indexOf("## snippets");
  assert.ok(targetsIdx !== -1 && targetsIdx < snippetsIdx);
  // Support context is explicitly labelled "do not edit first" (Requirement 3).
  assert.match(result.text, /## Support context — do not edit first/);
  assert.match(result.text, /SessionManager/);
  assert.match(result.text, /## relevant tests/);
  assert.match(result.text, /test_baz/);
  // No full problem statement / issue dump.
  assert.ok(!result.text.includes("problem statement"));
  assert.equal(result.items, 2);
});

test("compact capsule renders a decisive action header with the pivot, hint, and budget", () => {
  const result = renderCompactCapsule(makeCapsule(), {
    maxChars: 4_000,
    actionHeader: {
      has_target: true,
      pivot_file: "src/session/service.ts",
      pivot_symbol: "SessionManager",
      why: ["exercised by a failing test", "symbol-name match"],
      edit_intent_hint: "inspect session lifecycle methods.",
    },
    searchBudget: "low",
  });

  const headerIdx = result.text.indexOf("## Recommended first action");
  const targetIdx = result.text.indexOf("## Primary edit target");
  // The action header leads the block, before the primary target section.
  assert.ok(headerIdx !== -1 && headerIdx < targetIdx);
  assert.match(result.text, /Open\/edit `src\/session\/service\.ts::SessionManager` first\./);
  assert.match(result.text, /- exercised by a failing test/);
  assert.match(result.text, /Edit intent: inspect session lifecycle methods\./);
  assert.match(result.text, /Search budget: low/);
  assert.match(result.text, /Do not search broadly/);
});

test("compact capsule action header tells the agent not to inject context when no target", () => {
  const result = renderCompactCapsule(makeCapsule(), {
    maxChars: 4_000,
    actionHeader: {
      has_target: false,
      pivot_file: null,
      pivot_symbol: null,
      why: [],
      edit_intent_hint: null,
    },
  });

  assert.match(result.text, /## Recommended first action/);
  assert.match(result.text, /No high-confidence edit target recovered\. Do not inject context for this task\./);
  assert.ok(!result.text.includes("Open/edit"));
});

test("compact capsule respects the char cap with a marker", () => {
  const result = renderCompactCapsule(makeCapsule(), { maxChars: 80 });
  assert.ok(result.chars <= 80 + "\n[truncated to 80 chars]".length);
  assert.match(result.text, /\[truncated to 80 chars\]/);
});

function makeCapsule(): Capsule {
  const pivots = [makePivotItem()];
  const supportingItems = [makeSupportItem()];

  return {
    query: "session creation",
    pivots,
    supportingItems,
    budget: computeCapsuleBudgetUsage(
      { query: "session creation", pivots, supportingItems },
      createCharacterBudget(5_000),
    ),
    truncated: false,
    compressed: true,
  };
}

function makePivotItem(): PivotCapsuleItem {
  const item: PivotCapsuleItem = {
    symbolId: "sym-pivot",
    filePath: "src/session/service.ts",
    fqName: "src/session/service.ts::SessionManager",
    localName: "SessionManager",
    kind: SymbolKind.Class,
    role: CapsuleItemRole.Pivot,
    inclusionReasons: [
      {
        kind: CapsuleInclusionReasonKind.LexicalMatch,
        matchedFields: [SymbolSearchMatchField.LocalName],
      },
    ],
    content: {
      mode: CapsuleContentMode.Full,
      source: "export class SessionManager { createSession(): void {} }",
    },
    budgetCost: 0,
    compressed: false,
    lexicalScore: 100,
    graphScore: 8,
    finalScore: 108,
  };
  item.budgetCost = computeCapsuleItemCost(item);
  return item;
}

function makeSupportItem(): SupportCapsuleItem {
  const item: SupportCapsuleItem = {
    symbolId: "sym-method",
    filePath: "src/session/service.ts",
    fqName: "src/session/service.ts::SessionManager.createSession",
    localName: "createSession",
    kind: SymbolKind.Method,
    role: CapsuleItemRole.Support,
    inclusionReasons: [
      {
        kind: CapsuleInclusionReasonKind.StructuralSupport,
        edgeType: EdgeType.Contains,
        relatedSymbolIds: ["sym-pivot"],
      },
    ],
    content: {
      mode: CapsuleContentMode.Summary,
      summary: "Method that creates and persists a session.",
      signature: "createSession(): void",
    },
    budgetCost: 0,
    compressed: true,
    lexicalScore: 40,
    graphScore: 14,
    finalScore: 54,
  };
  item.budgetCost = computeCapsuleItemCost(item);
  return item;
}
