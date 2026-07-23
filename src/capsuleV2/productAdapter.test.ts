import assert from "node:assert/strict";
import { test } from "bun:test";

import {
  capsuleV2ToManifestItemFields,
  compactDigestHeader,
  MAX_DIGEST_QUERY_CHARS,
  toCapsuleV2ProductResponse,
} from "./productAdapter";
import {
  CapsuleIntent,
  CapsuleV2ContentMode,
  CapsuleV2Mode,
  NO_DEBUG_ROLE_SIGNALS,
  type CapsuleV2Discarded,
  type CapsuleV2Item,
  type CapsuleV2Result,
} from "./types";

function scorecard() {
  return {
    lexical: 0.5,
    symbol: 0,
    path: 0,
    test_to_impl: 0,
    body_literal: 0,
    graph_proximity: 0,
    centrality: 0,
    actionability: 1,
    hub_penalty: 0,
    final: 0.5,
  };
}

function pivotItem(): CapsuleV2Item {
  return {
    ...NO_DEBUG_ROLE_SIGNALS,
    role: "pivot",
    role_reason: "actionable edit target",
    path: "src/session.ts",
    fq_name: "src/session.ts::SessionManager.createSession",
    symbol: "createSession",
    kind: "method",
    content_mode: CapsuleV2ContentMode.Full,
    source: "createSession() {}",
    signature: "createSession(): Session",
    evidence: ["lexical match on local_name", "actionable edit target"],
    scorecard: scorecard(),
    estimated_tokens: 40,
  };
}

function supportItem(): CapsuleV2Item {
  return {
    ...NO_DEBUG_ROLE_SIGNALS,
    role: "support",
    role_reason: "related context",
    path: "src/controller.ts",
    fq_name: "src/controller.ts::SessionController",
    symbol: "SessionController",
    kind: "class",
    content_mode: CapsuleV2ContentMode.Signature,
    signature: "class SessionController",
    evidence: ["graph neighbour of pivot"],
    scorecard: scorecard(),
    estimated_tokens: 12,
  };
}

function discarded(reason: string): CapsuleV2Discarded {
  return {
    ...NO_DEBUG_ROLE_SIGNALS,
    path: "src/noise.ts",
    symbol: "noise",
    kind: "function",
    scorecard: scorecard(),
    evidence: ["weak lexical match"],
    discard_reason: reason,
  };
}

function result(overrides: Partial<CapsuleV2Result> = {}): CapsuleV2Result {
  return {
    intent: CapsuleIntent.Modify,
    actual_mode: CapsuleV2Mode.Standard,
    budget: { max_tokens: 8_000, estimated_tokens: 52, used_percent: 0.65 },
    pivots: [pivotItem()],
    support: [supportItem()],
    discarded: [discarded("over budget")],
    diagnostics: {
      intent_reason: ["task names an edit verb"],
      intent_confidence: "high",
      strategy: {
        candidate_generators: ["lexical"],
        role_policy: "caller_oriented",
        budget_policy: "standard",
      },
      candidate_count: 5,
      pivot_count: 1,
      support_count: 1,
      discarded_count: 1,
      tier: CapsuleV2Mode.Standard,
      weights: { lexical: 1 },
      likely_files: ["src/session.ts"],
      likely_symbols: ["createSession"],
      failing_tests: [],
    },
    ...overrides,
  } as CapsuleV2Result;
}

test("toCapsuleV2ProductResponse projects the result onto the stable unversioned product shape", () => {
  const response = toCapsuleV2ProductResponse(result());

  assert.equal("experimental" in response, false);
  assert.equal("engine" in response, false);
  assert.equal(response.intent, "modify");
  assert.equal(response.actualMode, "standard");
  assert.equal(response.reason, null);
  assert.deepEqual(response.budget, { maxTokens: 8_000, estimatedTokens: 52, usedPercent: 0.65 });

  assert.equal(response.pivots.length, 1);
  const pivot = response.pivots[0]!;
  assert.equal(pivot.role, "pivot");
  assert.equal(pivot.path, "src/session.ts");
  assert.equal(pivot.fqName, "src/session.ts::SessionManager.createSession");
  assert.equal(pivot.symbol, "createSession");
  assert.equal(pivot.contentMode, "full");
  assert.equal(pivot.source, "createSession() {}");
  assert.equal(pivot.signature, "createSession(): Session");
  assert.equal(pivot.isNonSourceExample, false);
  assert.deepEqual(pivot.evidence, ["lexical match on local_name", "actionable edit target"]);

  assert.equal(response.support.length, 1);
  assert.equal(response.support[0]!.source, null);
  assert.equal(response.support[0]!.contentMode, "signature");

  assert.equal(response.diagnostics.rolePolicy, "caller_oriented");
  assert.equal(response.diagnostics.intentConfidence, "high");
  assert.deepEqual(response.diagnostics.likelyFiles, ["src/session.ts"]);
  assert.equal(response.discardedTotal, 1);
});

test("toCapsuleV2ProductResponse is deterministic across repeated calls", () => {
  const fixture = result();
  assert.deepEqual(toCapsuleV2ProductResponse(fixture), toCapsuleV2ProductResponse(fixture));
});

test("toCapsuleV2ProductResponse threads the query and emits role/section counts", () => {
  const response = toCapsuleV2ProductResponse(result(), { query: "fix createSession" });

  assert.equal(response.query, "fix createSession");
  // One pivot (full) + one support (signature). skeleton = items not rendered full.
  assert.deepEqual(response.summary, {
    pivotCount: 1,
    supportCount: 1,
    skeletonCount: 1,
  });
  // No impact/memory/rule seam routed in → those counts are absent, never a fake 0.
  assert.equal("impactCount" in response.summary, false);
  assert.equal("memoryCount" in response.summary, false);
  assert.equal("ruleCount" in response.summary, false);
});

test("toCapsuleV2ProductResponse digest uses VEXP role glyphs with why + budget lines", () => {
  const response = toCapsuleV2ProductResponse(result(), { query: "fix createSession" });

  const lines = response.digest.split("\n");
  assert.equal(lines[0], "# fix createSession");
  // Pivot line: ● glyph, fqName target, content tag.
  assert.ok(response.digest.includes("● pivot src/session.ts::SessionManager.createSession  [full ~40t]"));
  assert.ok(response.digest.includes("    why: lexical match on local_name"));
  // Support rendered with the ○ skel glyph and signature mode.
  assert.ok(response.digest.includes("○ skel src/controller.ts::SessionController  [signature ~12t]"));
  // Closing budget line, no saved clause when no defensible estimate supplied.
  assert.ok(response.digest.includes("budget: 52/8000t (0.65%)"));
  assert.equal(response.digest.includes("saved≈"), false);
});

test("toCapsuleV2ProductResponse folds optional impact/memory/rule seams into summary, warnings, digest", () => {
  const response = toCapsuleV2ProductResponse(result(), {
    query: "who calls createSession",
    impact: { dependentCount: 3, snippetsAvailable: false },
    memory: { sessionCount: 2, durableCount: 1 },
    rules: { activeCount: 1 },
    savedTokensEstimate: 1240,
  });

  assert.equal(response.summary.impactCount, 3);
  assert.equal(response.summary.memoryCount, 3);
  assert.equal(response.summary.ruleCount, 1);
  // Impact has no per-caller snippets in this build → honest warning, not a fabrication.
  assert.ok(response.warnings.includes("impact_snippets_unavailable"));
  assert.ok(response.digest.includes("→ impact 3 dependents (summary only — snippets unavailable)"));
  assert.ok(response.digest.includes("◎ memory 2 session, 1 durable"));
  assert.ok(response.digest.includes("◇ rule 1 active"));
  // Defensible saved estimate routed in → it appears on the budget line.
  assert.ok(response.digest.includes("saved≈1240t vs full-file"));
});

test("digest folds representative impact callers with real identities + cross-file/caller counts", () => {
  const response = toCapsuleV2ProductResponse(result(), {
    query: "rename createSession",
    impact: {
      dependentCount: 5,
      crossFileDependentCount: 3,
      callerCount: 4,
      snippetsAvailable: false,
      available: true,
      representative: [
        { role: "dependent", path: "src/a.ts", symbol: "callA", snippetUnavailableReason: "edge_source_spans_not_extracted" },
        { role: "caller", path: "src/b.ts", symbol: "callB", lineStart: 10, lineEnd: 12, snippet: "createSession()" },
      ],
    },
  });

  assert.equal(response.summary.impactCount, 5);
  // Header carries the real dependent / cross-file / caller counts.
  assert.ok(response.digest.includes("→ impact 5 dependents, 3 cross-file, 4 callers"));
  // A row WITHOUT a snippet renders the bare real identity + a co-edit why, never an invented body.
  assert.ok(response.digest.includes("    dependent src/a.ts::callA"));
  assert.ok(response.digest.includes("        why: likely co-edit / blast-radius check"));
  // A row WITH a real snippet renders the line range + body.
  assert.ok(response.digest.includes("    caller src/b.ts::callB L10-L12: createSession()"));
  // Representative rows present → header drops the "summary only" suffix.
  assert.equal(response.digest.includes("summary only — snippets unavailable"), false);
});

test("digest renders summary-only impact suffix when no snippets and no representative rows", () => {
  const response = toCapsuleV2ProductResponse(result(), {
    impact: { dependentCount: 7, crossFileDependentCount: 2, snippetsAvailable: false, available: true },
  });
  assert.ok(response.digest.includes("→ impact 7 dependents, 2 cross-file (summary only — snippets unavailable)"));
  assert.ok(response.warnings.includes("impact_snippets_unavailable"));
});

test("digest folds representative memory observations with stale marker + stale count", () => {
  const response = toCapsuleV2ProductResponse(result(), {
    memory: {
      sessionCount: 2,
      durableCount: 3,
      staleCount: 1,
      available: true,
      items: [
        { source: "session", text: "tried the aggregates.py path last session" },
        { source: "durable", text: "10880 edits aggregates.py, not html.py", stale: true },
      ],
    },
  });
  assert.equal(response.summary.memoryCount, 5);
  assert.ok(response.digest.includes("◎ memory 2 session, 3 durable, 1 stale"));
  assert.ok(response.digest.includes("    session: tried the aggregates.py path last session"));
  assert.ok(response.digest.includes("    durable [stale]: 10880 edits aggregates.py, not html.py"));
});

test("digest folds representative active rules with text", () => {
  const response = toCapsuleV2ProductResponse(result(), {
    rules: {
      activeCount: 2,
      available: true,
      items: [
        { text: "regenerate the PLY parser table after editing the grammar" },
        { title: "co-edit", text: "update the matching _test.py sibling" },
      ],
    },
  });
  assert.equal(response.summary.ruleCount, 2);
  assert.ok(response.digest.includes("◇ rule 2 active"));
  assert.ok(response.digest.includes("    regenerate the PLY parser table after editing the grammar"));
  assert.ok(response.digest.includes("    co-edit: update the matching _test.py sibling"));
});

test("digest warnings stay honest when a section is genuinely unavailable", () => {
  const response = toCapsuleV2ProductResponse(result(), {
    impact: { dependentCount: 0, available: false },
    memory: { sessionCount: 0, durableCount: 0, available: false },
    rules: { activeCount: 0, available: false },
  });
  assert.ok(response.digest.includes("→ impact unavailable"));
  assert.ok(response.digest.includes("◎ memory unavailable"));
  assert.ok(response.digest.includes("◇ rules unavailable"));
  assert.ok(response.warnings.includes("impact_unavailable"));
  assert.ok(response.warnings.includes("memory_unavailable"));
  assert.ok(response.warnings.includes("rules_unavailable"));
});

test("digest warnings disappear when a section is actually threaded with available data", () => {
  const response = toCapsuleV2ProductResponse(result(), {
    impact: { dependentCount: 3, crossFileDependentCount: 1, snippetsAvailable: true, available: true,
      representative: [{ role: "caller", path: "src/x.ts", symbol: "x", lineStart: 1, lineEnd: 2, snippet: "x()" }] },
    memory: { sessionCount: 1, durableCount: 0, available: true, items: [{ source: "session", text: "note" }] },
    rules: { activeCount: 1, available: true, items: [{ text: "rule" }] },
  });
  // Threaded + available → no unavailable / snippet warnings.
  assert.equal(response.warnings.includes("impact_unavailable"), false);
  assert.equal(response.warnings.includes("impact_snippets_unavailable"), false);
  assert.equal(response.warnings.includes("memory_unavailable"), false);
  assert.equal(response.warnings.includes("rules_unavailable"), false);
});

test("enriched digest stays deterministic across repeated calls", () => {
  const enrich = {
    query: "q",
    impact: { dependentCount: 2, crossFileDependentCount: 1, available: true,
      representative: [{ role: "dependent" as const, path: "p.ts", symbol: "s" }] },
    memory: { sessionCount: 1, durableCount: 1, available: true, items: [{ source: "durable" as const, text: "m" }] },
    rules: { activeCount: 1, available: true, items: [{ text: "r" }] },
  };
  assert.deepEqual(
    toCapsuleV2ProductResponse(result(), enrich),
    toCapsuleV2ProductResponse(result(), enrich),
  );
});

test("toCapsuleV2ProductResponse marks bounded pivot source honestly", () => {
  // A pivot rendered only as a signature (budget-compressed) → bounded-source warning.
  const signatureOnlyPivot: CapsuleV2Item = {
    ...pivotItem(),
    content_mode: CapsuleV2ContentMode.Signature,
    source: undefined,
  };
  const response = toCapsuleV2ProductResponse(result({ pivots: [signatureOnlyPivot] }));

  assert.ok(response.warnings.includes("pivot_source_bounded_to_signatures"));
  assert.equal(response.summary.skeletonCount, 2);
});

test("toCapsuleV2ProductResponse merges caller warnings and dedupes", () => {
  const response = toCapsuleV2ProductResponse(
    result({ actual_mode: CapsuleV2Mode.NoContext, reason: "none", pivots: [], support: [] }),
    { warnings: ["no_pivot_recovered", "custom_marker"] },
  );

  // no_context derives no_pivot_recovered; the caller-supplied duplicate is deduped.
  assert.deepEqual(response.warnings, ["no_pivot_recovered", "custom_marker"]);
  assert.ok(response.digest.includes("(no high-confidence pivot recovered)"));
});

test("toCapsuleV2ProductResponse caps the discarded list but reports the true total", () => {
  const many = Array.from({ length: 20 }, (_unused, index) => discarded(`reason ${index}`));
  const response = toCapsuleV2ProductResponse(result({ discarded: many }));

  assert.equal(response.discarded.length, 12);
  assert.equal(response.discardedTotal, 20);
});

test("toCapsuleV2ProductResponse surfaces the no_context reason", () => {
  const response = toCapsuleV2ProductResponse(
    result({
      actual_mode: CapsuleV2Mode.NoContext,
      reason: "no high-confidence edit target recovered",
      pivots: [],
      support: [],
    }),
  );

  assert.equal(response.actualMode, "no_context");
  assert.equal(response.reason, "no high-confidence edit target recovered");
  assert.equal(response.pivots.length, 0);
});

test("capsuleV2ToManifestItemFields uses fqName as the symbol-identity surrogate", () => {
  const fields = capsuleV2ToManifestItemFields(result());

  assert.equal(fields.length, 2);
  assert.equal(fields[0]!.symbolId, "src/session.ts::SessionManager.createSession");
  assert.equal(fields[0]!.fqName, fields[0]!.symbolId);
  assert.equal(fields[0]!.role, "pivot");
  assert.equal(fields[0]!.sourceBacked, true);
  // Support is signature-mode → not source-backed.
  assert.equal(fields[1]!.role, "support");
  assert.equal(fields[1]!.sourceBacked, false);
});

// === M63: deterministic digest-header (query) compaction =========================

// A realistic oversized SWE-bench-shaped task: short metadata lead + a multi-KB
// problem statement. Mirrors the M62 fail-closed driver (header ~8k chars).
function oversizedQuery(): string {
  const head = "instance: acme__widget-4242\nrepo: acme/widget\n\n";
  const body = "combinator SQL output is wrong for values_list\n\n"
    + "When chaining union() the generated SQL drops the ORDER BY clause. "
      .repeat(220); // ~ thousands of chars, well over the 800 cap
  return head + body + "\nExpected: ordering preserved. Actual: ordering lost.";
}

test("M63: long digest query/header is compacted deterministically to a bounded block", () => {
  const q = oversizedQuery();
  assert.ok(q.length > MAX_DIGEST_QUERY_CHARS, "fixture must exceed the cap");
  const h = compactDigestHeader(q);
  assert.equal(h.truncated, true);
  // First line becomes the compact label (not the whole body).
  assert.equal(h.lines[0], "# instance: acme__widget-4242");
  assert.ok(h.lines.some((l) => l.startsWith("query_excerpt: ")));
  assert.ok(h.lines.includes("query_truncated: true"));
  // The rendered header block is bounded — never the multi-KB verbatim query.
  assert.ok(h.renderedChars < 1_000, `rendered header ${h.renderedChars} must stay bounded`);
  assert.ok(h.renderedChars < q.length, "compaction must shrink the header");
  // The verbatim issue body must NOT appear whole in the header block.
  assert.equal(h.lines.join("\n").includes(q), false);
});

test("M63: compacted header records the original query char count exactly", () => {
  const q = oversizedQuery();
  const h = compactDigestHeader(q);
  assert.equal(h.queryChars, q.trim().length);
  assert.ok(h.lines.includes(`query_original_chars: ${q.trim().length}`));
});

test("M63: compacted header carries a bounded deterministic head/tail excerpt", () => {
  const q = oversizedQuery();
  const h = compactDigestHeader(q);
  const excerpt = h.lines.find((l) => l.startsWith("query_excerpt: "))!;
  assert.ok(excerpt.includes(" … "), "excerpt must join a head and a tail with an ellipsis");
  // Head reflects the opening of the query; tail reflects its close.
  assert.ok(excerpt.includes("instance: acme__widget-4242"));
  assert.ok(excerpt.includes("Actual: ordering lost."));
  // Bounded: head(500)+sep+tail(200) ⇒ comfortably under ~750 content chars.
  assert.ok(excerpt.length < 760, `excerpt ${excerpt.length} must be bounded`);
});

test("M63: short digest query/header remains byte-identical to legacy `# <query>`", () => {
  const q = "fix createSession ordering";
  const h = compactDigestHeader(q);
  assert.equal(h.truncated, false);
  assert.deepEqual(h.lines, [`# ${q}`]);
  assert.equal(h.queryChars, q.length);
  // A query exactly at the cap is still emitted verbatim (boundary inclusive).
  const atCap = "x".repeat(MAX_DIGEST_QUERY_CHARS);
  const hc = compactDigestHeader(atCap);
  assert.equal(hc.truncated, false);
  assert.deepEqual(hc.lines, [`# ${atCap}`]);
  // One char over the cap flips to compacted.
  assert.equal(compactDigestHeader("x".repeat(MAX_DIGEST_QUERY_CHARS + 1)).truncated, true);
});

test("M63: empty/blank query yields no header line (no fabricated content)", () => {
  assert.deepEqual(compactDigestHeader("").lines, []);
  assert.deepEqual(compactDigestHeader("   \n  ").lines, []);
});

test("M63: compaction is deterministic across repeated calls", () => {
  const q = oversizedQuery();
  assert.deepEqual(compactDigestHeader(q), compactDigestHeader(q));
  assert.equal(compactDigestHeader(q).lines.join("\n"), compactDigestHeader(q).lines.join("\n"));
});

test("M63: the rendered digest uses the compacted header in its block, not the verbatim issue", () => {
  const q = oversizedQuery();
  const response = toCapsuleV2ProductResponse(result(), { query: q });
  const lines = response.digest.split("\n");
  assert.equal(lines[0], "# instance: acme__widget-4242");
  assert.ok(response.digest.includes("query_truncated: true"));
  assert.ok(response.digest.includes(`query_original_chars: ${q.trim().length}`));
  // The action map still renders its pivot/budget lines (compaction touched only the header).
  assert.ok(response.digest.includes("● pivot src/session.ts::SessionManager.createSession  [full ~40t]"));
  assert.ok(response.digest.includes("budget: 52/8000t (0.65%)"));
  // The verbatim multi-KB issue body never lands in the digest.
  assert.equal(response.digest.includes(q), false);
});
