import assert from "node:assert/strict";
import { test } from "bun:test";

import {
  CANONICAL_RENDERING_PATH,
  ResponseCategory,
  baseCategory,
  decompose,
  detectorControls,
} from "./m166Taxonomy";

// §30. Every category gets a known-positive before a zero it reports is believed,
// and the accounting is checked to close: categories must sum to the payload.

test("baseCategory routes the load-bearing paths to their categories", () => {
  assert.equal(baseCategory("productContext.modelVisibleContext"), ResponseCategory.RepositoryEvidence);
  assert.equal(baseCategory("productContext.items[].path"), ResponseCategory.RepositoryEvidence);
  assert.equal(baseCategory("productContext.coverage.absenceClaim"), ResponseCategory.AgentUsefulControl);
  assert.equal(baseCategory("diagnostics.retrieval.search.laneCandidateFiles.lexical[]"), ResponseCategory.MachineDiagnostic);
  assert.equal(baseCategory("productContext.repository.headCommit"), ResponseCategory.Provenance);
  assert.equal(baseCategory("runtime.commit"), ResponseCategory.Provenance);
  assert.equal(baseCategory("productContext.timing.totalMs"), ResponseCategory.MachineDiagnostic);
  assert.equal(baseCategory("something.nobody.declared"), ResponseCategory.Other);
});

test("readiness and absence semantics are agent-useful control, not overhead", () => {
  // §21/§37/§38: these are what stop a bounded result reading as an authoritative one.
  assert.equal(baseCategory("productContext.freshness.status"), ResponseCategory.AgentUsefulControl);
  assert.equal(baseCategory("diagnostics.freshness.readiness.ready"), ResponseCategory.AgentUsefulControl);
  assert.equal(baseCategory("impact.skipReason"), ResponseCategory.AgentUsefulControl);
  assert.equal(baseCategory("memory.durable.skipReason"), ResponseCategory.AgentUsefulControl);
  assert.equal(baseCategory("productContext.diagnostics.limitations[]"), ResponseCategory.AgentUsefulControl);
});

test("decompose charges every character exactly once", () => {
  const output = {
    productContext: { modelVisibleContext: "# ctx\nsrc/alpha.py::Widget.render\n", items: [{ path: "src/alpha.py", stableId: "abcdef0123456789" }] },
    diagnostics: { retrieval: { candidateFilesConsidered: 41 } },
    runtime: { commit: "0123456789abcdef0123" },
  };
  const result = decompose(output);
  const summed = Object.values(result.byCategory).reduce((a, b) => a + b, 0);
  assert.equal(summed, result.totalCharacters);
  assert.ok(result.byCategory[ResponseCategory.TransportStructure] > 0);
});

test("a fact restated outside the canonical rendering is charged DUPLICATE", () => {
  const output = {
    productContext: {
      modelVisibleContext: "## [P1] django/contrib/auth/backends.py::ModelBackend.authenticate\nroles: pivot\n",
      items: [{ path: "django/contrib/auth/backends.py" }],
    },
    request: { query: "django/contrib/auth/backends.py::ModelBackend.authenticate" },
  };
  const result = decompose(output);
  assert.ok(result.byCategory[ResponseCategory.Duplicate] > 0);
  const duplicated = result.leaves.filter((l) => l.duplicateCharacters > 0).map((l) => l.path).sort();
  assert.deepEqual(duplicated, ["productContext.items[0].path", "request.query"]);
  // The canonical rendering itself is never charged as a duplicate of anything.
  assert.equal(result.leaves.find((l) => l.normalizedPath === CANONICAL_RENDERING_PATH)!.duplicateCharacters, 0);
});

test("an identical object elsewhere in the response is charged DUPLICATE wholesale", () => {
  const twin = {
    status: "ready",
    reason: "source_fresh",
    head: "0123456789abcdef0123456789abcdef01234567",
    worktree: "/home/calvin/code/vtrace/benchmarks/results/workspaces/trigger/checkout",
    previousHead: "fedcba9876543210fedcba9876543210fedcba98",
    recommendedAction: "no action required; the index matches the working tree",
  };
  const result = decompose({
    productContext: { modelVisibleContext: "", freshness: { refreshDiagnostics: twin } },
    diagnostics: { indexFreshness: twin },
  });
  // Every leaf of the second copy is charged out; only its JSON scaffolding stays
  // in TRANSPORT_STRUCTURE, which is measured separately.
  const later = result.leaves.filter((l) => l.path.startsWith("diagnostics.indexFreshness."));
  assert.equal(later.length, Object.keys(twin).length);
  assert.ok(later.every((l) => l.duplicateCharacters === l.characters));
  assert.equal(
    result.byCategory[ResponseCategory.Duplicate],
    later.reduce((sum, l) => sum + l.characters, 0),
  );
  // The first copy keeps its own categories rather than vanishing.
  assert.ok(result.byCategory[ResponseCategory.Provenance] > 0);
});

test("a short repeated value is not treated as a re-conveyed fact", () => {
  // "ready" appearing twice is vocabulary, not duplication (§24).
  const result = decompose({
    productContext: { modelVisibleContext: "" },
    impact: { included: false, skipReason: "ready" },
    flow: { included: false, skipReason: "ready" },
  });
  assert.equal(result.byCategory[ResponseCategory.Duplicate], 0);
});

test("detectorControls flags a category that never fired and one that never varied", () => {
  const varied = [
    { totalCharacters: 10, byCategory: { ...zero(), REPOSITORY_EVIDENCE: 5, PROVENANCE: 0, MACHINE_DIAGNOSTIC: 3 }, leaves: [], topGroups: [] },
    { totalCharacters: 10, byCategory: { ...zero(), REPOSITORY_EVIDENCE: 7, PROVENANCE: 0, MACHINE_DIAGNOSTIC: 3 }, leaves: [], topGroups: [] },
  ] as any;
  const controls = detectorControls(varied);
  const provenance = controls.find((c) => c.category === ResponseCategory.Provenance)!;
  assert.equal(provenance.tasksWhereNonZero, 0);
  assert.equal(provenance.suspicious, true);
  const diagnostic = controls.find((c) => c.category === ResponseCategory.MachineDiagnostic)!;
  assert.equal(diagnostic.uniformAcrossTasks, true);
  assert.equal(diagnostic.suspicious, true);
  const evidence = controls.find((c) => c.category === ResponseCategory.RepositoryEvidence)!;
  assert.equal(evidence.suspicious, false);
});

function zero(): Record<string, number> {
  return Object.fromEntries(Object.values(ResponseCategory).map((c) => [c, 0]));
}
