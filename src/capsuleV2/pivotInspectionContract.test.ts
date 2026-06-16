// Tests for the pivot inspection contract.
//
// Two layers: pure-builder unit tests (which pivot/hint shapes produce a contract,
// which do not, and what the checklist/entries contain) and rendered-text tests
// (the contract renders before pivot bodies, uses inspect-or-rule-out language,
// carries final-diff language for co-edit obligations, and survives the Stage 5
// 12000-char truncation cutoff). A third end-to-end layer drives the contract
// through `renderCapsuleV2Human` over the real pipeline fixture, asserting that
// generated-artifact and multi_file_coedit hints still render alongside it.
//
// Nothing here pins instance ids, repo names, or gold-patch data: every fixture is a
// synthetic selection shaped like a real capsule would carry it.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "bun:test";

import {
  buildPivotInspectionContract,
  renderPivotInspectionContractText,
  type ContractPivotView,
} from "./pivotInspectionContract";
import type { ActionabilityHint } from "./actionabilityHints";
import { buildCapsuleV2 } from "./buildCapsuleV2";
import { renderCapsuleV2Human } from "./renderHuman";
import {
  CapsuleIntent,
  CapsuleV2ContentMode,
  type CapsuleV2Item,
  type CapsuleV2Result,
} from "./types";
import { INLINES_TASK, seedCapsuleV2Fixture } from "./__fixtures__/capsuleV2Fixture";

function pv(filePath: string, symbol: string, evidence?: string[]): ContractPivotView {
  return { path: filePath, symbol, evidence };
}

const COEDIT_HINT: ActionabilityHint = {
  kind: "multi_file_coedit",
  sourceFile: "pkg/domains/python.py",
  relatedFile: "pkg/pycode/ast.py",
  relatedFiles: ["pkg/pycode/ast.py"],
  confidence: "high",
  evidence: ["2 pivots were selected across separate modules (pkg/domains, pkg/pycode)"],
  hint: "This fix likely requires coordinated edits across multiple surfaced files.",
  patchObligation: {
    kind: "consider_coedit_files_in_final_diff",
    text:
      "Before finalizing, inspect each co-edit candidate and either edit it or rule it "
      + "out with a source-grounded reason. If the changed behavior spans multiple files, "
      + "include all required edits in the final diff — do not finalize after editing only "
      + "the lead pivot.",
  },
};

const GENERATED_HINT: ActionabilityHint = {
  kind: "generated_artifact",
  sourceFile: "pkg/format/cds.py",
  relatedFile: "pkg/format/cds_parsetab.py",
  confidence: "high",
  evidence: ["source defines PLY-style grammar functions (def p_*)"],
  hint: "If you change parser/grammar rules here, regenerate or update the generated parser table.",
  patchObligation: {
    kind: "ensure_related_artifact_in_final_diff",
    text: "Ensure the regenerated/updated cds_parsetab.py is included in your final submitted diff.",
  },
};

// --- (1) multi-pivot capsule builds a contract ----------------------------------

test("a multi-pivot capsule builds a pivot inspection contract", () => {
  const contract = buildPivotInspectionContract(
    [pv("pkg/a.py", "alpha"), pv("pkg/b.py", "beta")],
    [],
  );
  assert.ok(contract, "contract should be built for >=2 pivots");
  assert.equal(contract!.leadPivot, "pkg/a.py::alpha");
  assert.equal(contract!.requiredInspections.length, 1);
  assert.equal(contract!.requiredInspections[0]!.file, "pkg/b.py");
  assert.equal(contract!.requiredInspections[0]!.role, "pivot");
  assert.equal(contract!.hasCoedit, false);
});

// --- (2) single-pivot capsule does NOT build a contract -------------------------

test("a single-pivot capsule with no co-edit hint builds no contract", () => {
  const contract = buildPivotInspectionContract([pv("pkg/a.py", "alpha")], []);
  assert.equal(contract, null);
  assert.deepEqual(renderPivotInspectionContractText(contract), []);
});

test("a single-pivot capsule WITH a co-edit hint still builds a contract", () => {
  // A co-edit hint implies a coupled fix even if only one pivot is in context.
  const contract = buildPivotInspectionContract([pv("pkg/a.py", "alpha")], [COEDIT_HINT]);
  assert.ok(contract);
  assert.equal(contract!.hasCoedit, true);
  // The related co-edit candidate (not a pivot) is listed.
  assert.ok(contract!.requiredInspections.some((e) => e.role === "related_coedit"));
});

// --- (3) non-lead pivot appears with inspect-or-rule-out wording -----------------

test("each non-lead pivot renders with inspect-or-rule-out wording", () => {
  const contract = buildPivotInspectionContract(
    [pv("pkg/domains/python.py", "_parse_annotation"), pv("pkg/pycode/ast.py", "unparse")],
    [],
  );
  const text = renderPivotInspectionContractText(contract).join("\n");
  assert.match(text, /## Pivot inspection contract/);
  assert.match(text, /Inspect or rule out: pkg\/pycode\/ast\.py::unparse/);
  assert.match(text, /edit this pivot if the changed behavior crosses it/);
  assert.match(text, /rule it out with a source-grounded reason/);
});

// --- (4) multi_file_coedit hint adds related co-edit candidates to the checklist -

test("a multi_file_coedit hint adds related co-edit candidates to the checklist", () => {
  const coedit: ActionabilityHint = {
    ...COEDIT_HINT,
    sourceFile: "app/http/response.py",
    relatedFile: "app/sessions/middleware.py",
    relatedFiles: ["app/sessions/middleware.py", "app/storage/cookie.py"],
    confidence: "medium",
  };
  const contract = buildPivotInspectionContract(
    [pv("app/http/response.py", "set_cookie"), pv("app/http/response.py", "delete_cookie")],
    [coedit],
  );
  assert.ok(contract);
  assert.equal(contract!.hasCoedit, true);
  const related = contract!.requiredInspections.filter((e) => e.role === "related_coedit");
  assert.deepEqual(
    related.map((e) => e.file),
    ["app/sessions/middleware.py", "app/storage/cookie.py"],
  );
  const text = renderPivotInspectionContractText(contract).join("\n");
  assert.match(text, /Inspect or rule out related co-edit candidate: app\/sessions\/middleware\.py/);
  assert.match(text, /Inspect or rule out related co-edit candidate: app\/storage\/cookie\.py/);
  // Final-diff / co-edit obligation language present.
  assert.match(text, /include all required co-edits in the final diff/i);
  assert.match(text, /Co-edit obligation:/);
});

test("a related co-edit file that is already a pivot is not double-listed", () => {
  // The co-edit hint names ast.py, which is also a pivot — it must appear once (as a
  // pivot), not again as a related candidate.
  const contract = buildPivotInspectionContract(
    [pv("pkg/domains/python.py", "_parse_annotation"), pv("pkg/pycode/ast.py", "unparse")],
    [COEDIT_HINT],
  );
  assert.ok(contract);
  const astEntries = contract!.requiredInspections.filter((e) => e.file === "pkg/pycode/ast.py");
  assert.equal(astEntries.length, 1, "ast.py listed exactly once");
  assert.equal(astEntries[0]!.role, "pivot");
});

// --- (5) contract renders before pivot bodies (end-to-end) -----------------------

function makePivot(base: CapsuleV2Item, p: string, symbol: string): CapsuleV2Item {
  return {
    ...base,
    path: p,
    symbol,
    role_reason: "actionable function — symbol-name match; issue-domain relevance",
    evidence: [`symbol name matches "${symbol}"`],
  };
}

function multiPivotResult(overrideFirstSource?: string): CapsuleV2Result {
  const { db, repoRoot } = seedCapsuleV2Fixture();
  try {
    const base = buildCapsuleV2({
      db,
      repoRoot,
      task: INLINES_TASK,
      intent: CapsuleIntent.Debug,
      maxTokens: 8_000,
    });
    const proto = base.pivots[0]!;
    const a = makePivot(proto, "pkg/surface.py", "raise_here");
    const b = makePivot(proto, "pkg/rootcause.py", "transform_value");
    const pivots = overrideFirstSource
      ? [{ ...a, content_mode: CapsuleV2ContentMode.Full, source: overrideFirstSource }, b]
      : [a, b];
    return { ...base, pivots };
  } finally {
    db.close();
  }
}

test("the pivot inspection contract renders before the first pivot body", () => {
  const text = renderCapsuleV2Human(multiPivotResult());
  const contractIdx = text.indexOf("## Pivot inspection contract");
  const firstPivotIdx = text.indexOf("● pivot ");
  assert.ok(contractIdx >= 0, "contract section missing");
  assert.ok(firstPivotIdx >= 0, "expected a pivot body");
  assert.ok(contractIdx < firstPivotIdx, `contract (${contractIdx}) must precede first pivot body (${firstPivotIdx})`);
});

// --- (6) contract survives the Stage 5 12000-char truncation cutoff --------------

test("a long pivot body does not push the contract past the Stage 5 cutoff", () => {
  const HUGE = "        # padding line to inflate the pivot body\n".repeat(600); // ~30k chars
  const text = renderCapsuleV2Human(multiPivotResult(HUGE));
  const STAGE5_TRUNC = 12_000;
  assert.ok(text.length > STAGE5_TRUNC, "test invalid unless the inflated render exceeds the cutoff");
  const contractIdx = text.indexOf("## Pivot inspection contract");
  assert.ok(contractIdx >= 0 && contractIdx < STAGE5_TRUNC, `contract at ${contractIdx} must be < ${STAGE5_TRUNC}`);
  const injected = text.slice(0, STAGE5_TRUNC);
  assert.ok(injected.includes("Inspect or rule out: pkg/rootcause.py::transform_value"), "non-lead pivot dropped by truncation");
});

// --- (7) generated-artifact hints still render alongside the contract ------------

test("generated-artifact hints still render when the contract is present", () => {
  const result: CapsuleV2Result = { ...multiPivotResult(), actionability_hints: [GENERATED_HINT] };
  const text = renderCapsuleV2Human(result);
  assert.ok(text.includes("## Pivot inspection contract"), "contract missing");
  assert.ok(text.includes("generated/co-edit artifact: pkg/format/cds_parsetab.py"), "generated-artifact hint dropped");
  // A generated_artifact hint is NOT a multi_file_coedit hint, so no co-edit obligation.
  const contract = buildPivotInspectionContract(result.pivots, result.actionability_hints ?? []);
  assert.equal(contract!.hasCoedit, false);
});

// --- (8) multi_file_coedit hints still render alongside the contract -------------

test("multi_file_coedit hints still render their own checklist alongside the contract", () => {
  const result: CapsuleV2Result = { ...multiPivotResult(), actionability_hints: [COEDIT_HINT] };
  const text = renderCapsuleV2Human(result);
  assert.ok(text.includes("## Pivot inspection contract"), "contract missing");
  assert.ok(text.includes("multi-file co-edit likely"), "co-edit hint headline dropped");
  assert.ok(text.includes("Co-edit checklist:"), "co-edit hint checklist dropped");
});

// --- (9) the builder is generic (no instance ids / repo names) -------------------

test("the contract source contains no instance-id or repo-name specific logic", () => {
  const source = readFileSync(path.join(import.meta.dir, "pivotInspectionContract.ts"), "utf8");
  for (const banned of ["sphinx", "seaborn", "django", "astropy", "sympy", "requests", "pylint", "xarray"]) {
    assert.ok(!source.toLowerCase().includes(banned), `contract must not reference "${banned}"`);
  }
  assert.doesNotMatch(source, /\b\d{4,5}\b/);
});

// --- (10) the contract leaks no evaluation-only labels ---------------------------

test("the rendered contract leaks no evaluation-only / gold labels", () => {
  const text = renderCapsuleV2Human(multiPivotResult()).toLowerCase();
  for (const leak of ["gold", "expected_file", "fail_to_pass", "decoy"]) {
    assert.ok(!text.includes(leak), `rendered contract must not contain "${leak}"`);
  }
});

// --- (11) reason falls back from evidence to role_reason to a generic line -------

test("the why-surfaced reason uses evidence, then role_reason, then a generic fallback", () => {
  const withEvidence = buildPivotInspectionContract(
    [pv("a.py", "x"), { path: "b.py", symbol: "y", evidence: ["literal '42' matches the failing assertion"] }],
    [],
  );
  assert.match(withEvidence!.requiredInspections[0]!.reason, /literal '42'/);

  const withRoleReason = buildPivotInspectionContract(
    [pv("a.py", "x"), { path: "b.py", symbol: "y", role_reason: "graph neighbor of the lead pivot" }],
    [],
  );
  assert.match(withRoleReason!.requiredInspections[0]!.reason, /graph neighbor/);

  const bare = buildPivotInspectionContract([pv("a.py", "x"), { path: "b.py", symbol: "y" }], []);
  assert.equal(bare!.requiredInspections[0]!.reason, "surfaced as an edit-capable pivot");
});
