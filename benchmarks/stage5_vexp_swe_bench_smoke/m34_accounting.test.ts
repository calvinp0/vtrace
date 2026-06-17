// Tests for the M34 pure accounting + functional-actionability helpers.
// All offline: no agent, no Docker, no command path is exercised or importable here.

import { describe, expect, it } from "bun:test";

import { estimateTokens } from "../../src/capsuleV2/tokens";
import {
  buildProductV2Accounting,
  classifyFunctionalActionability,
  classifyInjectedHeading,
  computePostCapsuleToolUse,
  splitInjectedContextChunks,
  tokenUndercountRatio,
  type ToolCallWithOutput,
} from "./m34_accounting";

// A small but representative rendered injected block, mirroring the real
// `_vtrace_instructions.snapshot.md` section structure.
const SNAPSHOT = [
  "# vtrace indexed context",
  "",
  "## Instance",
  "instance: django__django-13195",
  "",
  "## vtrace context",
  "pivot: django/http/response.py::delete_cookie",
  "",
  "## VTRACE inspect-first (guidance, not enforcement; confidence: medium)",
  "Read the pivots before editing.",
  "",
  "## Multiple edit targets",
  "This task likely needs more than one file edited.",
  "",
  "## Pivot inspection contract",
  "Emit PIVOT_DECISION markers for each pivot.",
  "",
  "## Actionability hints",
  "Hint: delete_cookie should forward samesite.",
  "",
  "## Pivot neighborhood (nearby symbols, compact)",
  "### django/http/response.py::set_cookie",
  "def set_cookie(...): ...",
  "",
  "## STAGE5_TOKEN_DISCIPLINE",
  "Tool budget: keep reads tight.",
  "",
  "## Instruction",
  "Now implement the fix.",
].join("\n");

describe("injected-context component accounting", () => {
  it("1. injectedContextTokens covers the full rendered VTRACE block", () => {
    const acc = buildProductV2Accounting(SNAPSHOT, 50);
    expect(acc.accountingMethod).toBe("exact_rendered_block");
    expect(acc.injectedContextChars).toBe(SNAPSHOT.length);
    expect(acc.injectedContextTokens).toBe(estimateTokens(SNAPSHOT));
    // The whole-block token estimate must exceed the legacy capsule-body estimate.
    expect(acc.injectedContextTokens!).toBeGreaterThan(50);
  });

  it("2. legacy capsuleEstimatedTokens is preserved verbatim (backward-compatible)", () => {
    expect(buildProductV2Accounting(SNAPSHOT, 881).capsuleEstimatedTokens).toBe(881);
    expect(buildProductV2Accounting(SNAPSHOT, null).capsuleEstimatedTokens).toBe(null);
    // No-context run: no snapshot, legacy field still echoed.
    const none = buildProductV2Accounting(null, null);
    expect(none.accountingMethod).toBe("no_context_injected");
    expect(none.injectedContextTokens).toBe(null);
  });

  it("3. component token sum ≈ full rendered block (partition is exact in chars)", () => {
    const chunks = splitInjectedContextChunks(SNAPSHOT);
    const charSum = chunks.reduce((a, c) => a + c.text.length, 0);
    expect(charSum).toBe(SNAPSHOT.length); // exact partition
    const acc = buildProductV2Accounting(SNAPSHOT, 50);
    const componentSum =
      acc.capsuleBodyTokens! +
      acc.instructionScaffoldTokens! +
      acc.pivotContractTokens! +
      acc.actionabilityHintsTokens! +
      acc.coeditHintTokens! +
      acc.benchmarkWrapperTokens! +
      acc.unclassifiedTokens!;
    // Per-section ceil rounding lets the component sum exceed the whole-block
    // estimate by at most one token per chunk.
    expect(componentSum).toBeGreaterThanOrEqual(acc.injectedContextTokens!);
    expect(componentSum - acc.injectedContextTokens!).toBeLessThanOrEqual(chunks.length);
  });

  it("3b. headings map to the expected components", () => {
    expect(classifyInjectedHeading("Instance")).toBe("benchmarkWrapper");
    expect(classifyInjectedHeading("Instruction")).toBe("instructionScaffold");
    expect(classifyInjectedHeading("Pivot neighborhood (nearby symbols, compact)")).toBe("capsuleBody");
    expect(classifyInjectedHeading("Pivot inspection contract")).toBe("pivotContract");
    expect(classifyInjectedHeading("Actionability hints")).toBe("actionabilityHints");
    expect(classifyInjectedHeading("Multiple edit targets")).toBe("coeditHint");
    expect(classifyInjectedHeading("STAGE5_TOKEN_DISCIPLINE")).toBe("benchmarkWrapper");
    expect(classifyInjectedHeading("Some future section")).toBe("unclassified");
  });

  it("4. undercount ratio is computed when both fields exist (and >1 here)", () => {
    const acc = buildProductV2Accounting(SNAPSHOT, 50);
    const ratio = tokenUndercountRatio(acc.capsuleEstimatedTokens, acc.injectedContextTokens);
    expect(ratio).not.toBeNull();
    expect(ratio!).toBeGreaterThan(1);
    expect(tokenUndercountRatio(null, 500)).toBeNull();
    expect(tokenUndercountRatio(0, 500)).toBeNull();
    expect(tokenUndercountRatio(200, null)).toBeNull();
  });
});

describe("post-capsule tool-use accounting", () => {
  const calls: ToolCallWithOutput[] = [
    { index: 0, tool: "Grep", category: "search", path: null, output: "match a\nmatch b", truncated: false },
    { index: 1, tool: "Read", category: "read", path: "/repo/a.py", output: "x".repeat(40), truncated: false },
    { index: 2, tool: "Read", category: "read", path: "/repo/a.py", output: "y".repeat(40), truncated: true },
    { index: 3, tool: "Edit", category: "edit", path: "/repo/a.py", output: "ok", truncated: false },
    { index: 4, tool: "Bash", category: "bash", path: null, output: "ran", truncated: false },
  ];

  it("5. after-context counts come from the ordered tool-call telemetry", () => {
    const w = computePostCapsuleToolUse(calls);
    expect(w.toolCallsAfterContext).toBe(5);
    expect(w.readCallsAfterContext).toBe(2);
    expect(w.grepSearchCallsAfterContext).toBe(1);
    expect(w.bashCallsAfterContext).toBe(1);
    expect(w.uniqueFilesReadAfterContext).toBe(1); // a.py read twice
    expect(w.uniqueFilesTouchedAfterContext).toBe(1);
    expect(w.toolOutputTokensApproximate).toBe(true);
    expect(w.truncatedOutputCount).toBe(1);
    expect(w.toolOutputTokensAfterContext).toBeGreaterThan(0);
  });

  it("6. before-first-patch counts are computed when an edit is present", () => {
    const w = computePostCapsuleToolUse(calls);
    expect(w.firstPatchToolIndex).toBe(3);
    expect(w.beforeFirstPatchToolCalls).toBe(3); // grep + 2 reads precede the edit
    expect(w.beforeFirstPatchReadCalls).toBe(2);
    expect(w.beforeFirstPatchGrepSearchCalls).toBe(1);
    expect(w.beforeFirstPatchToolOutputTokens).toBeGreaterThan(0);
  });

  it("6b. no edit ⇒ before-first-patch fields are null, after-context still counted", () => {
    const noEdit = calls.filter((c) => c.category !== "edit");
    const w = computePostCapsuleToolUse(noEdit);
    expect(w.firstPatchToolIndex).toBeNull();
    expect(w.beforeFirstPatchToolCalls).toBeNull();
    expect(w.toolCallsAfterContext).toBe(4);
  });
});

describe("functional actionability labels", () => {
  it("7. functional_actionability_success: resolved + all gold edited (actioned)", () => {
    expect(
      classifyFunctionalActionability({
        resolved: true,
        contextInjected: true,
        goldSurfaced: true,
        goldEditedComplete: true,
      }),
    ).toBe("functional_actionability_success");
  });

  it("8. structural_only_success: gold edited but unresolved (not surfaced)", () => {
    expect(
      classifyFunctionalActionability({
        resolved: false,
        contextInjected: true,
        goldSurfaced: false,
        goldEditedComplete: true,
      }),
    ).toBe("structural_only_success");
    // surfaced + edited + failed is the synthesis-failure variant (django-13195)
    expect(
      classifyFunctionalActionability({
        resolved: false,
        contextInjected: true,
        goldSurfaced: true,
        goldEditedComplete: true,
      }),
    ).toBe("retrieval_success_synthesis_failure");
  });

  it("9. functional_success_gold_proxy_mismatch: resolved without editing nominal gold (xarray-3677)", () => {
    expect(
      classifyFunctionalActionability({
        resolved: true,
        contextInjected: true,
        goldSurfaced: true,
        goldEditedComplete: false,
      }),
    ).toBe("functional_success_gold_proxy_mismatch");
  });

  it("9b. retrieval_success_action_failure: surfaced, not fully edited, failed (sphinx-7462)", () => {
    expect(
      classifyFunctionalActionability({
        resolved: false,
        contextInjected: true,
        goldSurfaced: true,
        goldEditedComplete: false,
      }),
    ).toBe("retrieval_success_action_failure");
  });

  it("10. safe_no_context_success / _failure for no-context runs", () => {
    expect(
      classifyFunctionalActionability({
        resolved: true,
        contextInjected: false,
        goldSurfaced: false,
        goldEditedComplete: true,
      }),
    ).toBe("safe_no_context_success");
    expect(
      classifyFunctionalActionability({
        resolved: false,
        contextInjected: false,
        goldSurfaced: null,
        goldEditedComplete: null,
      }),
    ).toBe("safe_no_context_failure");
  });

  it("11. unknown/missing artifacts handled gracefully", () => {
    expect(
      classifyFunctionalActionability({
        resolved: null,
        contextInjected: null,
        goldSurfaced: null,
        goldEditedComplete: null,
      }),
    ).toBe("unknown");
    // resolved=false with nothing surfaced/edited ⇒ unknown, not a false failure label
    expect(
      classifyFunctionalActionability({
        resolved: false,
        contextInjected: true,
        goldSurfaced: false,
        goldEditedComplete: false,
      }),
    ).toBe("unknown");
    // empty / null telemetry never throws
    expect(computePostCapsuleToolUse(null).toolCallsAfterContext).toBe(0);
    expect(computePostCapsuleToolUse([]).firstPatchToolIndex).toBeNull();
    expect(splitInjectedContextChunks("")).toEqual([]);
  });
});

describe("no live-agent / Docker surface", () => {
  it("12. the helper module exposes only pure functions (no command runner)", async () => {
    const mod = (await import("./m34_accounting")) as Record<string, unknown>;
    for (const [name, value] of Object.entries(mod)) {
      // Only functions/types are exported; none is named like an executor.
      if (typeof value === "function") {
        expect(name).not.toMatch(/spawn|exec|docker|runProtocol|evaluate|child_process/i);
      }
    }
    // Source contains no process/Docker/child_process usage.
    const src = await Bun.file(new URL("./m34_accounting.ts", import.meta.url)).text();
    expect(src).not.toMatch(/child_process|spawnSync|execSync|docker|Bun\.spawn/);
  });
});
