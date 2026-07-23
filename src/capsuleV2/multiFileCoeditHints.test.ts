// Tests for multi-file co-edit actionability hints.
//
// Three layers: pure-detector unit tests (which selection shapes emit a co-edit
// obligation, which do not — Path A cross-module pivots, Path B sibling pivots +
// coupled callers, plus the conservative gates), human/injected-context render tests
// (compact section before pivot bodies, co-edit checklist, inspect-or-rule-out
// obligation, survival of the Stage 5 truncation cutoff), and product/schema tests
// (relatedFiles preserved through the product projection + run_pipeline clone, and
// the MCP get_context_capsule schema documents the new shape).
//
// Nothing here pins instance ids, repo names, or gold-patch data: every fixture is a
// synthetic selection shaped like a real capsule would carry it.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "bun:test";

import {
  detectMultiFileCoeditHints,
  type CoeditCandidateItem,
} from "./multiFileCoeditHints";
import { buildCapsuleV2 } from "./buildCapsuleV2";
import { renderCapsuleV2Human } from "./renderHuman";
import { toCapsuleV2ProductResponse } from "./productAdapter";
import {
  CapsuleIntent,
  CapsuleV2ContentMode,
  type ActionabilityHint,
  type CapsuleV2Result,
} from "./types";
import { INLINES_TASK, seedCapsuleV2Fixture } from "./__fixtures__/capsuleV2Fixture";
import { RESERVED_MCP_TOOL_DEFINITIONS } from "../mcp/tools";
import { McpToolId } from "../mcp/types";

function pivot(filePath: string, symbol: string, kind = "function"): CoeditCandidateItem {
  return { role: "pivot", path: filePath, symbol, kind };
}
function support(filePath: string, symbol: string, kind = "function", isNonSourceExample = false): CoeditCandidateItem {
  return { role: "support", path: filePath, symbol, kind, isNonSourceExample };
}

function coeditHints(input: {
  pivots: CoeditCandidateItem[];
  support?: CoeditCandidateItem[];
  task?: string;
  generatedArtifactFiles?: string[];
}): ActionabilityHint[] {
  return detectMultiFileCoeditHints({
    pivots: input.pivots,
    support: input.support ?? [],
    task: input.task,
    generatedArtifactFiles: input.generatedArtifactFiles,
  });
}

// --- (1) cross-module pivots (Path A) emit multi_file_coedit --------------------

test("two pivots in different modules emit a multi_file_coedit hint", () => {
  // Shape of sphinx-7462: a traceback-named pivot + a hidden pivot in another module.
  const hints = coeditHints({
    pivots: [
      pivot("pkg/domains/python.py", "_parse_annotation"),
      pivot("pkg/pycode/ast.py", "unparse"),
    ],
  });
  assert.equal(hints.length, 1);
  const hint = hints[0]!;
  assert.equal(hint.kind, "multi_file_coedit");
  assert.equal(hint.confidence, "high");
  assert.equal(hint.sourceFile, "pkg/domains/python.py");
  assert.deepEqual(hint.relatedFiles, ["pkg/pycode/ast.py"]);
  // Back-compat single field mirrors the first related file.
  assert.equal(hint.relatedFile, "pkg/pycode/ast.py");
  assert.equal(hint.patchObligation?.kind, "consider_coedit_files_in_final_diff");
});

test("two pivots in the SAME directory do not emit a cross-module hint", () => {
  // Shape of sympy-16766 / requests-5414: both pivots in one module (a base/dispatch
  // or public-api entrypoint alongside the real edit site) — single-file fixes.
  const hints = coeditHints({
    pivots: [
      pivot("pkg/printing/pycode.py", "PythonCodePrinter", "class"),
      pivot("pkg/printing/printer.py", "_print", "method"),
    ],
  });
  assert.equal(hints.length, 0);
});

// --- (2) sibling pivots + coupled support (Path B) emit multi_file_coedit -------

test("sibling pivots in one file plus a domain-coupled caller emit a hint", () => {
  // Shape of django-13195: two sibling methods in one file (a multi-symbol edit) and
  // caller/handler support that shares a domain noun (cookie/response).
  const hints = coeditHints({
    pivots: [
      pivot("app/http/response.py", "set_cookie", "method"),
      pivot("app/http/response.py", "delete_cookie", "method"),
    ],
    support: [
      support("app/sessions/middleware.py", "process_response", "method"),
      support("app/storage/cookie.py", "_update_cookie", "method"),
      // Shares only the verb "set" (excluded) — must NOT couple.
      support("app/security/csrf.py", "_set_token", "method"),
    ],
  });
  assert.equal(hints.length, 1);
  const hint = hints[0]!;
  assert.equal(hint.kind, "multi_file_coedit");
  assert.equal(hint.confidence, "medium");
  assert.equal(hint.sourceFile, "app/http/response.py");
  assert.deepEqual(hint.relatedFiles, [
    "app/sessions/middleware.py",
    "app/storage/cookie.py",
  ]);
  // The verb-only support (csrf) is excluded from the co-edit set.
  assert.ok(!(hint.relatedFiles ?? []).some((f) => f.includes("csrf")));
});

// --- (3) three coupled files emit ONE obligation listing all related ------------

test("a multi-symbol edit with two coupled callers lists all related files in one hint", () => {
  const hints = coeditHints({
    pivots: [
      pivot("app/http/response.py", "set_cookie", "method"),
      pivot("app/http/response.py", "delete_cookie", "method"),
    ],
    support: [
      support("app/sessions/middleware.py", "process_response", "method"),
      support("app/storage/cookie.py", "_update_cookie", "method"),
    ],
  });
  assert.equal(hints.length, 1, "exactly one co-edit obligation, not one per file");
  assert.equal((hints[0]!.relatedFiles ?? []).length, 2);
});

// --- (4) single-file capsule emits no hint --------------------------------------

test("a single pivot with no other edit-capable file emits no co-edit hint", () => {
  const hints = coeditHints({
    pivots: [pivot("pkg/models.py", "prepare_url", "method")],
    support: [support("pkg/exceptions.py", "InvalidError", "class")],
  });
  assert.equal(hints.length, 0);
});

// --- (5) weak/lone-pivot lexical support emits no hint --------------------------

test("a lone pivot plus same-noun support does not fire (no multi-symbol edit shape)", () => {
  // A single pivot whose support shares a noun ("url") is NOT enough: Path B requires
  // >=2 sibling pivots before pointing the agent at coupled callers. This is exactly
  // the guard that keeps requests-5414 (prepare_url + InvalidURL) from firing.
  const hints = coeditHints({
    pivots: [pivot("pkg/models.py", "prepare_url", "method")],
    support: [support("pkg/exceptions.py", "InvalidURL", "class")],
  });
  assert.equal(hints.length, 0);
});

// --- (6) docs/examples/tests-only candidates are never co-edit targets ----------

test("docs/example/test candidates are excluded from co-edit hints", () => {
  // Cross-module: the only "other" pivot-shaped file is a test file → not edit-capable.
  const crossModule = coeditHints({
    pivots: [
      pivot("pkg/core/scales.py", "_setup", "method"),
      pivot("tests/test_scales.py", "test_setup", "function"),
    ],
  });
  assert.equal(crossModule.length, 0, "a test file is not a cross-module co-edit target");

  // Sibling pivots whose only coupled support is a docs/example fixture → no hint.
  const fixtureOnly = coeditHints({
    pivots: [
      pivot("pkg/http/response.py", "set_cookie", "method"),
      pivot("pkg/http/response.py", "delete_cookie", "method"),
    ],
    support: [
      support("examples/cookie_demo.py", "cookie_example", "module_variable", true),
      support("docs/cookie.py", "cookie_response", "function"),
    ],
  });
  assert.equal(fixtureOnly.length, 0, "docs/example support is not a co-edit target");
});

// --- (7) generated-artifact files are excluded (not replaced) -------------------

test("a file already covered by a generated-artifact hint is excluded from co-edit", () => {
  // The generated-artifact obligation is more specific; the co-edit detector must not
  // duplicate or override it. With the lead pivot suppressed, no cross-module pair
  // remains, so no co-edit hint is emitted for it.
  const hints = coeditHints({
    pivots: [
      pivot("pkg/format/cds.py", "to_string", "method"),
      pivot("pkg/other/vounit.py", "VOUnit", "class"),
    ],
    generatedArtifactFiles: ["pkg/format/cds.py", "pkg/format/cds_parsetab.py"],
  });
  // cds.py is suppressed; the lead becomes vounit.py with no cross-module partner.
  assert.ok(!hints.some((h) => h.sourceFile === "pkg/format/cds.py"));
  assert.equal(hints.length, 0);
});

// (The generated_artifact-hint-is-not-replaced case is asserted end-to-end through
// buildCapsuleV2 in actionabilityHints.test.ts, where the PLY grammar fixture lives.)

// --- (8) detector logic is generic (no instance ids / repo names) ---------------

test("the detector source contains no instance-id or repo-name specific logic", () => {
  const source = readFileSync(path.join(import.meta.dir, "multiFileCoeditHints.ts"), "utf8");
  for (const banned of ["sphinx", "seaborn", "django", "astropy", "sympy", "requests", "pylint", "xarray"]) {
    assert.ok(!source.toLowerCase().includes(banned), `detector must not reference "${banned}"`);
  }
  // No bare 4-5 digit instance numbers either.
  assert.doesNotMatch(source, /\b\d{4,5}\b/);
});

// --- render / product helpers ---------------------------------------------------

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

function resultWithCoeditHint(overridePivotSource?: string): CapsuleV2Result {
  const { db, repoRoot } = seedCapsuleV2Fixture();
  try {
    const base = buildCapsuleV2({
      db,
      repoRoot,
      task: INLINES_TASK,
      intent: CapsuleIntent.Debug,
      maxTokens: 8_000,
    });
    const pivots = overridePivotSource
      ? base.pivots.map((p, i) =>
          i === 0 ? { ...p, content_mode: CapsuleV2ContentMode.Full, source: overridePivotSource } : p)
      : base.pivots;
    return { ...base, pivots, actionability_hints: [COEDIT_HINT] };
  } finally {
    db.close();
  }
}

// --- (9) actionability section renders before pivot bodies ----------------------

test("the multi-file co-edit section renders before the first pivot body", () => {
  const text = renderCapsuleV2Human(resultWithCoeditHint());
  const sectionIdx = text.indexOf("## Actionability hints");
  const firstPivotIdx = text.indexOf("● pivot");
  assert.ok(sectionIdx >= 0, "co-edit section missing");
  assert.ok(text.includes("multi-file co-edit likely"), "co-edit headline missing");
  if (firstPivotIdx >= 0) {
    assert.ok(sectionIdx < firstPivotIdx, `section (${sectionIdx}) must precede first pivot (${firstPivotIdx})`);
  }
});

// --- (10) the co-edit checklist is present --------------------------------------

test("the rendered co-edit hint includes the inspect/rule-out checklist", () => {
  const text = renderCapsuleV2Human(resultWithCoeditHint());
  assert.ok(text.includes("Co-edit checklist:"), "checklist heading missing");
  assert.ok(text.includes("[ ] inspect lead pivot"), "checklist item 1 missing");
  assert.ok(text.includes("[ ] inspect related candidate(s)"), "checklist item 2 missing");
  assert.ok(text.includes("[ ] decide edit vs rule-out for each"), "checklist item 3 missing");
  assert.ok(text.includes("[ ] ensure all required co-edits are in the final diff"), "checklist item 4 missing");
  // Lead pivot + related candidate are both named.
  assert.ok(text.includes("Lead pivot: pkg/domains/python.py"));
  assert.ok(text.includes("Related edit candidate(s): pkg/pycode/ast.py"));
});

// --- (11) obligation includes final-diff / inspect-or-rule-out language ---------

test("the rendered obligation uses inspect / rule-out / final-diff language", () => {
  const text = renderCapsuleV2Human(resultWithCoeditHint());
  assert.match(text, /Obligation:/);
  assert.match(text, /inspect/i);
  assert.match(text, /rule it out/i);
  assert.match(text, /final diff/i);
});

// --- (12) the hint survives the Stage 5 12000-char truncation cutoff ------------

test("a long pivot body does not push the co-edit hint past the Stage 5 cutoff", () => {
  const HUGE = "        # padding line to inflate the pivot body\n".repeat(600); // ~30k chars
  const text = renderCapsuleV2Human(resultWithCoeditHint(HUGE));
  const STAGE5_TRUNC = 12_000;
  assert.ok(text.length > STAGE5_TRUNC, "test invalid unless the inflated render exceeds the cutoff");
  const sectionIdx = text.indexOf("## Actionability hints");
  assert.ok(sectionIdx >= 0 && sectionIdx < STAGE5_TRUNC, `co-edit hint at ${sectionIdx} must be < ${STAGE5_TRUNC}`);
  const injected = text.slice(0, STAGE5_TRUNC);
  assert.ok(injected.includes("multi-file co-edit likely"), "co-edit headline dropped by truncation");
  assert.ok(injected.includes("Co-edit checklist:"), "checklist dropped by truncation");
});

// --- (13) product response + run_pipeline clone preserve relatedFiles -----------

test("the product response preserves the multi_file_coedit hint and relatedFiles", () => {
  const product = toCapsuleV2ProductResponse(resultWithCoeditHint());
  const hint = product.actionabilityHints.find((h) => h.kind === "multi_file_coedit");
  assert.ok(hint, "multi_file_coedit hint lost in product projection");
  assert.deepEqual(hint!.relatedFiles, ["pkg/pycode/ast.py"]);
  assert.equal(hint!.patchObligation?.kind, "consider_coedit_files_in_final_diff");
  // run_pipeline emits the product response verbatim inside `capsuleV2` (structuredClone).
  const runPipelineOutput = { capsuleV2: structuredClone(product) };
  assert.deepEqual(runPipelineOutput.capsuleV2.actionabilityHints, product.actionabilityHints);
});

// --- (14) the Stage 5 injected snapshot (rendered context) carries the hint -----

test("the injected context snapshot includes the multi-file co-edit obligation", () => {
  // Stage 5 injects renderCapsuleV2Human(result) (the _capsule_v2_context.md body).
  const injected = renderCapsuleV2Human(resultWithCoeditHint());
  assert.ok(injected.includes("multi-file co-edit likely"));
  assert.ok(injected.includes("Obligation:"));
  // Guidance must not leak any evaluation-only label into agent-facing context.
  for (const leak of ["gold", "expected_file", "FAIL_TO_PASS", "decoy"]) {
    assert.ok(!injected.toLowerCase().includes(leak.toLowerCase()), `must not contain "${leak}"`);
  }
});

// --- (15) the MCP get_context_capsule schema documents the new shape ------------

test("get_context_capsule schema documents multi_file_coedit / relatedFiles", () => {
  const tool = RESERVED_MCP_TOOL_DEFINITIONS.find(
    (t) => t.metadata.toolId === McpToolId.GetContextCapsule,
  );
  assert.ok(tool, "get_context_capsule tool definition not found");
  const schema = tool!.metadata.outputSchema as {
    properties?: { capsuleResult?: { properties?: Record<string, unknown>; required?: string[] } };
  };
  const capsule = schema.properties?.capsuleResult;
  const hintsSchema = capsule?.properties?.actionabilityHints as
    | { items?: { properties?: Record<string, { properties?: Record<string, unknown>; description?: string }> } }
    | undefined;
  const itemProps = hintsSchema?.items?.properties;
  assert.ok(itemProps, "actionabilityHints item schema missing");
  // relatedFiles is documented...
  assert.ok(itemProps!.relatedFiles, "schema missing relatedFiles");
  // ...but NOT required (optional — only present for multi_file_coedit).
  const required = (hintsSchema!.items as { required?: string[] }).required ?? [];
  assert.ok(!required.includes("relatedFiles"), "relatedFiles must stay optional");
  // The kind and obligation descriptions mention the new variants.
  assert.match(itemProps!.kind!.description ?? "", /multi_file_coedit/);
  assert.match(
    itemProps!.patchObligation!.description ?? "",
    /multi-file|co-edit/i,
  );
});
