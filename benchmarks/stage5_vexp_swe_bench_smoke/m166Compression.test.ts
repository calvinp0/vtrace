import assert from "node:assert/strict";
import { test } from "bun:test";

import {
  CompressionVariant,
  buildVariant,
  epistemicSafety,
  extractFacts,
  semanticPreservation,
} from "./m166Compression";

// A payload small enough to reason about, carrying one of everything the safety
// checks are meant to protect: a bounded absence, a not-applicable component, a
// readiness state, an authority limitation and an omission disclosure.
const PAYLOAD = {
  productContext: {
    modelVisibleContext: "# VTRACE product context\n## [P1] pkg/mod.py::Widget.render\nroles: pivot\nlines: 10-20\n\ndef render(self):\nCONTAINS pkg/mod.py::Widget at pkg/mod.py:8 [exact]\n",
    leadPivot: "pkg/mod.py::Widget.render",
    resultState: "resolved",
    items: [{ path: "pkg/mod.py", symbol: "render", fqName: "pkg/mod.py::Widget.render", roles: ["pivot"], contentMode: "skeleton", lineSpan: { start: 10, end: 20 }, stableId: "aaaabbbbccccdddd" }],
    coverage: { absenceClaim: "bounded", enumerationComplete: false, mode: "bounded" },
    diagnostics: { staticEvidenceOnly: true, limitations: ["Impact is bounded static structural graph evidence, not dynamic execution flow."] },
    repository: { headCommit: "0123456789abcdef0123", repositoryId: "repo-1", worktreeId: "wt-1" },
    freshness: { status: "fresh", reason: "source_fresh", action: "none" },
    timing: { totalMs: 1234, renderMs: 12 },
    accounting: { claimBoundary: "bounded static evidence only", naiveTokensEstimate: 9999 },
  },
  diagnostics: {
    retrieval: { search: { laneCandidateFiles: { lexical: ["a/b/c1.py", "a/b/c2.py", "a/b/c3.py", "a/b/c4.py"] }, candidateFilesConsidered: 4 } },
    indexFreshness: { status: "fresh", reason: "source_fresh", readiness: { ready: true, sourceFresh: true } },
  },
  impact: { included: false, skipReason: "not_requested_by_intent", candidatesConsidered: 0 },
  flow: { included: false, skipReason: "no_relevant_endpoints" },
  memory: { durable: { included: false, skipReason: "no_relevant_observations" }, session: { included: false, skipReason: "no_session_requested" }, capsuleSurfaced: { included: false, skipReason: "no_relevant_observations" } },
  rules: { included: false, activeCount: 0 },
  context: { included: true, skipReason: null },
  capsuleResult: { warnings: ["Support items are evidence of relevance, not of ownership."] },
  responseBudget: { compacted_fields: ["pivotNeighborhood[].excerpts[].text"], omitted_detail_counts: { pivotNeighborhoodExcerptCharacters: 1037 }, estimated_metadata_tokens: 5595 },
  deferred: { items: [{ kind: "context_capsule", id: "vexp:capsule:53939b98" }] },
  runtime: { commit: "fedcba9876543210fedc", retrievalRankingVersion: "rank/7" },
  request: { query: "pkg/mod.py::Widget.render" },
  pivotNeighborhood: [{ pivot: { path: "pkg/mod.py" }, excerpts: [{ filePath: "pkg/mod.py", startLine: 8, endLine: 9, symbol: "Widget" }] }],
};

test("extractFacts reads the distinctions the safety checks depend on", () => {
  const facts = extractFacts(PAYLOAD);
  assert.equal(facts.componentStatuses.impact, "NOT_APPLICABLE");
  assert.equal(facts.componentStatuses.flow, "NO_RELEVANT_EVIDENCE");
  assert.equal(facts.componentStatuses.memorySession, "NOT_APPLICABLE");
  assert.equal(facts.componentStatuses.memoryDurable, "NO_RELEVANT_EVIDENCE");
  assert.equal(facts.freshnessStatus, "fresh");
  assert.equal(facts.readinessReady, true);
  assert.ok(facts.absenceClaims.includes("coverage.absenceClaim=bounded"));
  assert.ok(facts.authorityLimitations.some((l) => l.includes("not dynamic execution flow")));
  assert.ok(facts.omissionDisclosures.includes("pivotNeighborhood[].excerpts[].text"));
});

test("every variant is smaller than the one before it, and EVIDENCE_ONLY is the floor", () => {
  const order = [
    CompressionVariant.FullCurrent,
    CompressionVariant.NoDuplicates,
    CompressionVariant.NoMachineDiagnostics,
    CompressionVariant.CompactProvenance,
  ];
  const sizes = order.map((v) => buildVariant(PAYLOAD, v).modelFacingCharacters);
  for (let i = 1; i < sizes.length; i += 1) assert.ok(sizes[i]! <= sizes[i - 1]!, `${order[i]} (${sizes[i]}) should not exceed ${order[i - 1]} (${sizes[i - 1]})`);
  assert.ok(buildVariant(PAYLOAD, CompressionVariant.EvidenceOnly).modelFacingCharacters < sizes[sizes.length - 1]!);
});

test("EVIDENCE_ONLY fails the safety checks it was built to fail", () => {
  // §36. The floor exists to prove the checks can fail; a safety suite that never
  // fails is not evidence that the other variants are safe.
  const full = extractFacts(PAYLOAD);
  const floor = buildVariant(PAYLOAD, CompressionVariant.EvidenceOnly);
  const findings = epistemicSafety(full, floor.retained);
  const failed = findings.filter((f) => !f.passed).map((f) => f.check);
  assert.ok(failed.length >= 4, `expected the floor to fail several checks, failed: ${failed.join(" | ")}`);
  assert.ok(failed.some((c) => c.includes("readiness")));
  assert.ok(failed.some((c) => c.includes("absence")));
});

test("AGENT_MINIMAL_SAFE keeps the evidence and the epistemic distinctions", () => {
  const full = extractFacts(PAYLOAD);
  const variant = buildVariant(PAYLOAD, CompressionVariant.AgentMinimalSafe);
  const findings = epistemicSafety(full, variant.retained);
  assert.deepEqual(findings.filter((f) => !f.passed).map((f) => f.check), []);
  const preservation = semanticPreservation(full, variant.retained, variant.modelFacingText);
  assert.deepEqual(preservation.filter((p) => !p.preserved).map((p) => p.dimension), []);
  assert.ok(variant.modelFacingCharacters < JSON.stringify(PAYLOAD).length);
});

test("NO_DUPLICATES keeps every fact and only drops restatements", () => {
  const full = extractFacts(PAYLOAD);
  const variant = buildVariant(PAYLOAD, CompressionVariant.NoDuplicates);
  assert.deepEqual(epistemicSafety(full, variant.retained).filter((f) => !f.passed), []);
  // The structured restatement of the lead pivot goes; the fact stays in the
  // rendering, which is what the model reads.
  const preservation = semanticPreservation(full, variant.retained, variant.modelFacingText);
  assert.deepEqual(preservation.filter((p) => !p.preserved).map((p) => p.dimension), []);
});

test("dropping machine diagnostics does not disturb readiness or absence", () => {
  const full = extractFacts(PAYLOAD);
  const variant = buildVariant(PAYLOAD, CompressionVariant.NoMachineDiagnostics);
  const findings = epistemicSafety(full, variant.retained);
  assert.deepEqual(findings.filter((f) => !f.passed).map((f) => f.check), []);
  // and the scorer internals really are gone
  assert.ok(!JSON.stringify(variant).includes("laneCandidateFiles"));
});
