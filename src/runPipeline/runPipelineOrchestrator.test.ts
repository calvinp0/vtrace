import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";

import { openIndexerDatabase } from "../db/sqlite";
import { indexProject } from "../indexer/indexProject";
import { persistObservation } from "../db/repositories/observationsRepository";
import { ObservationKind, ObservationSource } from "../observations/types";
import {
  deriveImpactDigestSeam,
  deriveMemoryDigestSeam,
  deriveRulesDigestSeam,
  runPipelineOrchestrator,
  type OrchestrationImpactSection,
  type OrchestrationMemorySection,
  type OrchestrationRulesSection,
  type RunPipelineOrchestratorInput,
} from "./runPipelineOrchestrator";
import { formatRunPipelineOrchestrationOutput } from "./formatRunPipelineOutput";
import { createDeferredVexpStore, type DeferredVexpStore } from "./deferredVexpStore";
import { CapsuleIntent } from "../capsuleV2/types";

// The orchestrator wires real leaf engines (routing, capsule assembly, impact,
// logic flow, memory) together. These tests pin the orchestration-only
// behaviors that distinguish run_pipeline from the bare context capsule.

type RunInput = (
  input: { repoRoot: string; db: ReturnType<typeof openIndexerDatabase> },
) => Promise<void> | void;

async function withFixture(run: RunInput): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "vtrace-run-pipeline-"));
  const repoRoot = path.join(root, "repo");
  const db = openIndexerDatabase();
  try {
    await mkdir(path.join(repoRoot, "src"), { recursive: true });
    await writeFixtureRepo(repoRoot);
    await indexProject({ repoRoot, db });
    await run({ repoRoot, db });
  } finally {
    db.close();
    await rm(root, { recursive: true, force: true });
  }
}

// beta -> alpha -> base via imports; orphan is unreachable. This gives a real
// directed structural path (beta reaches base) and real reverse dependents
// (base is depended on by alpha and beta).
async function writeFixtureRepo(repoRoot: string): Promise<void> {
  await writeFile(
    path.join(repoRoot, "src", "base.ts"),
    ["export function base(): string {", "  return \"base\";", "}", ""].join("\n"),
  );
  await writeFile(
    path.join(repoRoot, "src", "alpha.ts"),
    [
      "import { base } from \"./base\";",
      "",
      "export function alpha(): string {",
      "  return base();",
      "}",
      "",
    ].join("\n"),
  );
  await writeFile(
    path.join(repoRoot, "src", "beta.ts"),
    [
      "import { alpha } from \"./alpha\";",
      "",
      "export function beta(): string {",
      "  return alpha();",
      "}",
      "",
    ].join("\n"),
  );
  await writeFile(
    path.join(repoRoot, "src", "orphan.ts"),
    ["export function orphan(): string {", "  return \"orphan\";", "}", ""].join("\n"),
  );
}

function runFormatted(
  db: ReturnType<typeof openIndexerDatabase>,
  repoRoot: string,
  input: RunPipelineOrchestratorInput,
  deferredStore?: DeferredVexpStore,
) {
  return formatRunPipelineOrchestrationOutput(
    runPipelineOrchestrator(db, repoRoot, input, deferredStore ? { deferredStore } : {}),
  );
}

test("auto intent resolves to exactly one concrete preset", async () => {
  await withFixture(({ db, repoRoot }) => {
    const out = runFormatted(db, repoRoot, { query: "explore the base module" });
    assert.equal(out.intent.requested, "auto");
    assert.ok(
      ["explore", "debug", "modify", "refactor"].includes(out.intent.selected),
      `unexpected selected preset: ${out.intent.selected}`,
    );
    assert.ok(out.intent.source.startsWith("auto_") || out.intent.source === "explicit");
  });
});

test("explicit presets materially change orchestration behavior", async () => {
  await withFixture(({ db, repoRoot }) => {
    const debug = runFormatted(db, repoRoot, { query: "why does base fail", intent: "debug" });
    const explore = runFormatted(db, repoRoot, { query: "why does base fail", intent: "explore" });
    const modify = runFormatted(db, repoRoot, { query: "change base behavior", intent: "modify" });
    const refactor = runFormatted(db, repoRoot, { query: "rename base everywhere", intent: "refactor" });

    assert.equal(debug.intent.selected, "debug");
    assert.equal(explore.intent.selected, "explore");
    assert.equal(modify.intent.selected, "modify");
    assert.equal(refactor.intent.selected, "refactor");

    // Debug defaults to including tests; other presets do not.
    assert.equal(debug.request.includeTests, true);
    assert.equal(explore.request.includeTests, false);

    // Explore de-emphasizes durable memory unless explicitly opted in.
    assert.equal(explore.memory.durable.included, false);
    assert.equal(explore.memory.durable.skipReason, "intent_deemphasized");
  });
});

test("impact is included for a refactor task naming one symbol with dependents", async () => {
  await withFixture(({ db, repoRoot }) => {
    const out = runFormatted(db, repoRoot, { query: "refactor base function", intent: "refactor" });
    assert.equal(out.impact.included, true);
    assert.equal(out.impact.skipReason, null);
    assert.equal(out.impact.focalSymbol?.localName, "base");
    assert.ok((out.impact.summary?.dependentSymbolCount ?? 0) > 0);
    assert.match(out.impact.impactRef ?? "", /^vexp:impact:/);
  });
});

test("impact is skipped with an explicit reason for an explore task", async () => {
  await withFixture(({ db, repoRoot }) => {
    const out = runFormatted(db, repoRoot, { query: "explore base module", intent: "explore" });
    assert.equal(out.impact.included, false);
    assert.equal(out.impact.skipReason, "not_requested_by_intent");
    assert.equal(out.impact.focalSymbol, null);
  });
});

test("explicit capsule impact intent ungates impact for a non-refactor query", async () => {
  await withFixture(({ db, repoRoot }) => {
    // The preset auto-resolves away from refactor, but an explicit impact intent
    // drives the run_pipeline impact section the same way it drives Capsule v2 —
    // no phrase hack required.
    const out = runFormatted(db, repoRoot, {
      query: "inspect base function",
      intent: "debug",
      capsuleIntent: CapsuleIntent.Impact,
    });
    assert.equal(out.intent.resolvedIntent, "impact");
    assert.equal(out.intent.impactEligible, true);
    assert.equal(out.impact.included, true);
    assert.equal(out.impact.skipReason, null);
    assert.equal(out.impact.triggerReason, "impact_intent");
    assert.equal(out.impact.focalSymbol?.localName, "base");
  });
});

test("explicit impact phrasing ungates impact without the refactor preset", async () => {
  await withFixture(({ db, repoRoot }) => {
    const out = runFormatted(db, repoRoot, { query: "what is the impact of base" });
    assert.equal(out.intent.resolvedIntent, "impact");
    assert.equal(out.intent.intentSource, "phrase");
    assert.equal(out.impact.included, true);
    assert.equal(out.impact.triggerReason, "impact_phrase");
    assert.equal(out.impact.focalSymbol?.localName, "base");
  });
});

test("debug intent stays clear of impact and reports the intent-level skip reason", async () => {
  await withFixture(({ db, repoRoot }) => {
    const out = runFormatted(db, repoRoot, { query: "fix base function", intent: "debug" });
    assert.equal(out.intent.resolvedIntent, "debug");
    assert.equal(out.intent.impactEligible, false);
    assert.equal(out.impact.included, false);
    assert.equal(out.impact.skipReason, "not_requested_by_intent");
  });
});

test("impact intent with no resolvable focal symbol reports no_focal_symbol, not a non-intent skip", async () => {
  await withFixture(({ db, repoRoot }) => {
    const out = runFormatted(db, repoRoot, {
      query: "what is the impact of nonexistent_symbol_zzz",
    });
    assert.equal(out.intent.resolvedIntent, "impact");
    assert.equal(out.intent.impactEligible, true);
    assert.equal(out.impact.included, false);
    // Intent DID request impact; the skip is about resolving a focal symbol.
    assert.equal(out.impact.skipReason, "no_focal_symbol");
  });
});

test("impact intent mentioning multiple symbols reports multiple_focal_symbols", async () => {
  await withFixture(({ db, repoRoot }) => {
    const out = runFormatted(db, repoRoot, {
      query: "trace the impact across alpha and base",
      capsuleIntent: CapsuleIntent.Impact,
    });
    assert.equal(out.intent.resolvedIntent, "impact");
    assert.equal(out.impact.included, false);
    assert.equal(out.impact.skipReason, "multiple_focal_symbols");
    assert.ok(out.impact.matchedCandidates >= 2);
  });
});

test("flow is included with a directional cue resolving start and end", async () => {
  await withFixture(({ db, repoRoot }) => {
    const out = runFormatted(db, repoRoot, { query: "trace the flow from beta to base", intent: "explore" });
    assert.equal(out.flow.included, true);
    assert.equal(out.flow.skipReason, null);
    assert.equal(out.flow.endpointStrategy, "directional_cue");
    assert.equal(out.flow.start?.localName, "beta");
    assert.equal(out.flow.end?.localName, "base");
    assert.equal(out.flow.summary?.reachable, true);
    assert.ok((out.flow.paths?.length ?? 0) >= 1);
    assert.equal(out.flow.paths?.[0]?.nodeFqNames[0], "src/beta.ts::beta");
    assert.match(out.flow.flowRef ?? "", /^vexp:flow:/);
  });
});

test("flow paths render compact bounded source excerpts", async () => {
  await withFixture(({ db, repoRoot }) => {
    const out = runFormatted(db, repoRoot, { query: "trace the flow from beta to base", intent: "explore" });
    const excerpts = out.flow.paths?.[0]?.sourceExcerpts ?? [];
    assert.ok(excerpts.length >= 1, "expected at least one inline flow excerpt");

    for (const excerpt of excerpts) {
      assert.ok(typeof excerpt.filePath === "string" && excerpt.filePath.length > 0);
      assert.ok(excerpt.startLine >= 1);
      assert.ok(excerpt.endLine >= excerpt.startLine);
      assert.ok(
        excerpt.text.split("\n").length <= 12,
        "rendered excerpt must stay within the line ceiling",
      );
    }
  });
});

test("impact dependents render bounded source excerpts", async () => {
  await withFixture(({ db, repoRoot }) => {
    const out = runFormatted(db, repoRoot, { query: "refactor base function", intent: "refactor" });
    const dependents = (out.impact.topDependents ?? []).filter((node) => node.distance > 0);
    assert.ok(dependents.length >= 1, "expected at least one dependent");

    const enriched = dependents.find((node) => node.sourceExcerpt != null);
    assert.ok(enriched, "expected at least one dependent to carry an inline excerpt");
    assert.ok(
      enriched.sourceExcerpt!.text.split("\n").length <= 12,
      "rendered excerpt must stay within the line ceiling",
    );
  });
});

test("flow falls back to bidirectional probing when no directional cue is present", async () => {
  await withFixture(({ db, repoRoot }) => {
    const out = runFormatted(db, repoRoot, { query: "show the link between beta and base", intent: "explore" });
    assert.equal(out.flow.included, true);
    assert.equal(out.flow.endpointStrategy, "bidirectional_probe");
    // beta -> base is reachable, base -> beta is not, so probing picks beta -> base.
    assert.equal(out.flow.start?.localName, "beta");
    assert.equal(out.flow.end?.localName, "base");
    assert.equal(out.flow.bothDirectionsReachable, false);
  });
});

test("flow is skipped with a reason when fewer than two endpoints are inferred", async () => {
  await withFixture(({ db, repoRoot }) => {
    const out = runFormatted(db, repoRoot, { query: "why does base fail", intent: "explore" });
    assert.equal(out.flow.included, false);
    assert.equal(out.flow.skipReason, "not_enough_endpoints");
    assert.equal(out.flow.matchedCandidates, 1);
    assert.equal(out.flow.start, null);
    assert.equal(out.flow.end, null);
  });
});

test("flow is skipped as ambiguous when more than two endpoints are inferred", async () => {
  await withFixture(({ db, repoRoot }) => {
    const out = runFormatted(db, repoRoot, { query: "compare alpha beta base orphan", intent: "explore" });
    assert.equal(out.flow.included, false);
    assert.equal(out.flow.skipReason, "ambiguous_endpoints");
    assert.ok(out.flow.matchedCandidates > 2);
  });
});

test("memory session evidence is included when a populated session is provided", async () => {
  await withFixture(({ db, repoRoot }) => {
    persistObservation(db, {
      repoRoot,
      sessionId: "sess-1",
      kind: ObservationKind.Decision,
      source: ObservationSource.Manual,
      summary: "Investigated base failure",
      body: "base returned an unexpected value during the session.",
      queryText: "base failure",
      createdAtMs: 100,
      linkedFilePaths: ["src/base.ts"],
    });

    const out = runFormatted(db, repoRoot, {
      query: "base failure",
      intent: "debug",
      sessionId: "sess-1",
      includeMemory: true,
    });

    assert.equal(out.memory.session.included, true);
    assert.equal(out.memory.session.sessionId, "sess-1");
    assert.ok(out.memory.session.observationCount >= 1);
    assert.equal(out.diagnostics.memory.sessionIncluded, true);
  });
});

test("memory is skipped with explicit reasons when no session and explore intent", async () => {
  await withFixture(({ db, repoRoot }) => {
    const out = runFormatted(db, repoRoot, { query: "explore base", intent: "explore" });
    assert.equal(out.memory.session.included, false);
    assert.equal(out.memory.session.skipReason, "no_session_requested");
    assert.equal(out.memory.durable.included, false);
    assert.equal(out.memory.durable.skipReason, "intent_deemphasized");
  });
});

test("deferred references are emitted with stable 12-hex hashes", async () => {
  await withFixture(({ db, repoRoot }) => {
    const store = createDeferredVexpStore({ now: () => 0 });
    const out = runFormatted(
      db,
      repoRoot,
      { query: "trace the flow from beta to base", intent: "explore" },
      store,
    );

    assert.ok(out.deferred.items.length > 0);
    assert.equal(out.deferred.expandable, true);
    for (const item of out.deferred.items) {
      assert.match(item.hash, /^[0-9a-f]{12}$/);
      assert.equal(item.expandable, true);
      assert.equal(item.expansionTool, "expand_vexp_ref");
    }
    const kinds = out.deferred.items.map((item) => item.kind);
    assert.ok(kinds.includes("context_capsule"));
    assert.ok(kinds.includes("logic_flow"));
  });
});

test("run_pipeline output differs materially from the context capsule it wraps", async () => {
  await withFixture(({ db, repoRoot }) => {
    const orchestration = runPipelineOrchestrator(db, repoRoot, {
      query: "refactor base function",
      intent: "refactor",
    });
    const out = formatRunPipelineOrchestrationOutput(orchestration);
    const capsuleKeys = Object.keys(orchestration.context.capsule);

    // Orchestration-only sections exist on the pipeline output but not on the capsule.
    for (const section of ["flow", "impact", "memory", "diagnostics", "deferred"]) {
      assert.ok(section in out, `expected pipeline output to expose ${section}`);
      assert.ok(!capsuleKeys.includes(section), `capsule must not expose ${section}`);
    }

    // The raw capsule's surface (pivots/supportingItems) is not the pipeline's top-level shape.
    assert.ok("pivots" in orchestration.context.capsule);
    assert.equal((out as Record<string, unknown>).pivots, undefined);
    assert.equal((out as Record<string, unknown>).supportingItems, undefined);
  });
});

test("repeated runs produce identical formatted output", async () => {
  await withFixture(({ db, repoRoot }) => {
    const input: RunPipelineOrchestratorInput = {
      query: "trace the flow from beta to base",
      intent: "refactor",
      sessionId: "sess-determinism",
    };
    const first = runFormatted(db, repoRoot, input, createDeferredVexpStore({ now: () => 0 }));
    const second = runFormatted(db, repoRoot, input, createDeferredVexpStore({ now: () => 0 }));
    assert.deepEqual(second, first);
  });
});

test.skip("default orchestration omits the Capsule v2 section entirely", async () => {
  await withFixture(({ db, repoRoot }) => {
    const out = runFormatted(db, repoRoot, { query: "modify base function", intent: "modify" });
    // No opt-in => no v2 discriminator and no v2 product block (v1 byte-compatible).
    assert.equal((out as Record<string, unknown>).contextEngine, undefined);
    assert.equal((out as Record<string, unknown>).capsuleV2, undefined);
    assert.equal((out as Record<string, unknown>).capsuleV2ManifestId, undefined);
    // The pivot-neighborhood enrichment is v2-only; the v1 path omits it entirely.
    assert.equal((out as Record<string, unknown>).pivotNeighborhood, undefined);
  });
});

test("capsuleEngine=v2 adds bounded pivot-neighborhood excerpts", async () => {
  await withFixture(({ db, repoRoot }) => {
    const out = runFormatted(db, repoRoot, {
      query: "base in src/base.ts#L1-L3 returns wrong value",
      intent: "debug",
      capsuleEngine: "v2",
    });

    const neighborhood = (out as Record<string, unknown>).pivotNeighborhood as Array<{
      pivot: { fqName: string | null };
      excerpts: Array<{ filePath: string; text: string; reason: string; startLine: number; endLine: number; truncated: boolean }>;
    }>;

    assert.notEqual(neighborhood, undefined);
    assert.ok(Array.isArray(neighborhood));
    // At most the top-2 pivots are seeded.
    assert.ok(neighborhood.length <= 2);

    const enriched = neighborhood.find((n) => n.excerpts.length > 0);
    assert.ok(enriched, "expected at least one pivot to carry neighbor excerpts");

    for (const ctx of neighborhood) {
      assert.ok(ctx.excerpts.length <= 4, "per-pivot excerpt budget enforced");
      for (const e of ctx.excerpts) {
        assert.ok(e.text.split("\n").length <= 12, "12-line ceiling enforced");
        assert.ok(e.startLine >= 1 && e.endLine >= e.startLine);
        assert.ok(
          ["caller", "callee", "importer", "imported", "reference", "support", "sibling", "fallback_symbol_window"]
            .includes(e.reason),
        );
      }
    }
  });
});

test("pivot-neighborhood enrichment leaves flow and impact sections unchanged", async () => {
  await withFixture(({ db, repoRoot }) => {
    const withV2 = runFormatted(db, repoRoot, {
      query: "trace the flow from beta to base",
      intent: "explore",
      capsuleEngine: "v2",
    });
    const withoutV2 = runFormatted(db, repoRoot, {
      query: "trace the flow from beta to base",
      intent: "explore",
    });

    // The flow/impact sections are identical with and without the v2 opt-in;
    // pivot-neighborhood is purely additive.
    assert.deepEqual(withV2.flow, withoutV2.flow);
    assert.deepEqual(withV2.impact, withoutV2.impact);
  });
});

test("pivot-neighborhood is deterministic across repeated v2 runs", async () => {
  await withFixture(({ db, repoRoot }) => {
    const input: RunPipelineOrchestratorInput = {
      query: "base in src/base.ts#L1-L3 returns wrong value",
      intent: "debug",
      capsuleEngine: "v2",
    };
    const first = runFormatted(db, repoRoot, input, createDeferredVexpStore({ now: () => 0 }));
    const second = runFormatted(db, repoRoot, input, createDeferredVexpStore({ now: () => 0 }));
    assert.deepEqual(
      (second as Record<string, unknown>).pivotNeighborhood,
      (first as Record<string, unknown>).pivotNeighborhood,
    );
  });
});

test.skip("capsuleEngine=v2 adds the v2 section while preserving the v1 sections", async () => {
  await withFixture(({ db, repoRoot }) => {
    const out = runFormatted(db, repoRoot, {
      query: "modify base function to accept a label",
      intent: "modify",
      capsuleEngine: "v2",
    });

    // v2 discriminator + product block are present and self-describing.
    assert.equal((out as Record<string, unknown>).contextEngine, "v2");
    const capsuleV2 = (out as Record<string, unknown>).capsuleV2 as { engine: string; experimental: boolean };
    assert.notEqual(capsuleV2, undefined);
    assert.equal(capsuleV2.engine, "v2");
    assert.equal(capsuleV2.experimental, true);

    // The v1 sections survive the v2 opt-in.
    assert.notEqual(out.context, undefined);
    assert.notEqual(out.impact, undefined);
    assert.notEqual(out.flow, undefined);
    assert.notEqual(out.memory, undefined);
    assert.notEqual(out.rules, undefined);
    assert.notEqual(out.deferred, undefined);
  });
});

test("capsuleEngine=v2 orchestration is deterministic across repeated runs", async () => {
  await withFixture(({ db, repoRoot }) => {
    const input: RunPipelineOrchestratorInput = {
      query: "modify base function to accept a label",
      intent: "modify",
      capsuleEngine: "v2",
    };
    const first = runFormatted(db, repoRoot, input, createDeferredVexpStore({ now: () => 0 }));
    const second = runFormatted(db, repoRoot, input, createDeferredVexpStore({ now: () => 0 }));
    assert.deepEqual(
      (second as Record<string, unknown>).capsuleV2,
      (first as Record<string, unknown>).capsuleV2,
    );
  });
});

test("unversioned capsule and deprecated aliases share one authoritative result", async () => {
  await withFixture(({ db, repoRoot }) => {
    const base = { query: "modify base function to accept a label", intent: "modify" } as const;
    const current = runFormatted(db, repoRoot, base);
    const deprecatedDefault = runFormatted(db, repoRoot, { ...base, capsuleEngine: "default" });
    const deprecatedV2 = runFormatted(db, repoRoot, { ...base, capsuleEngine: "v2" });

    assert.deepEqual(deprecatedDefault.capsuleResult, current.capsuleResult);
    assert.deepEqual(deprecatedV2.capsuleResult, current.capsuleResult);
    assert.deepEqual(deprecatedDefault.context, current.context);
    assert.deepEqual(deprecatedV2.context, current.context);
    assert.equal(current.capsule.implementation, "hybrid");
    assert.equal(current.capsule.retrievalVersion, "product-retrieval-v2");
    assert.deepEqual(current.capsule.compatibilityWarnings, []);
    assert.match(deprecatedDefault.capsule.compatibilityWarnings[0]!, /deprecated and ignored/);
    assert.match(deprecatedV2.capsule.compatibilityWarnings[0]!, /deprecated and ignored/);
    assert.equal(current.capsuleEngine, undefined);
    assert.equal(current.contextEngine, undefined);
  });
});

test("explicit legacy capsule requests fail before classification or retrieval", async () => {
  await withFixture(({ db, repoRoot }) => {
    let classifications = 0;
    const classifier = {
      classify() {
        classifications += 1;
        throw new Error("classification must not run");
      },
    };
    for (const capsuleEngine of ["v1", "legacy"]) {
      assert.throws(
        () => runPipelineOrchestrator(
          db,
          repoRoot,
          { query: "modify base", capsuleEngine },
          { classifier },
        ),
        (error: unknown) =>
          error instanceof Error
          && error.name === "CapsuleEngineCompatibilityError"
          && error.message.includes("Remove capsule_engine=v1"),
      );
    }
    assert.equal(classifications, 0);
  });
});

test("runtime provenance identifies the source-backed executable and current implementations", async () => {
  await withFixture(({ db, repoRoot }) => {
    const output = runFormatted(db, repoRoot, { query: "modify base", intent: "modify" });
    assert.match(output.runtime.executablePath, /\/bin\/vtrace$/);
    assert.equal(output.runtime.capsuleImplementation, "hybrid");
    assert.equal(output.runtime.retrievalImplementation, "product-retrieval-v2");
    assert.equal(output.runtime.indexSchemaVersion, 4);
    assert.ok(output.runtime.commit === null || /^[0-9a-f]{40}$/.test(output.runtime.commit));
  });
});

// --- Unified capsule-engine selection (requested / effective / fallback) ---

test.skip("default path records requested=default, effective=v1 with no fallback", async () => {
  await withFixture(({ db, repoRoot }) => {
    const out = runFormatted(db, repoRoot, { query: "modify base function", intent: "modify" });
    assert.deepEqual((out as Record<string, unknown>).capsuleEngine, {
      requested: "default",
      effective: "v1",
      fallbackReason: null,
      compactInspectFirst: false,
    });
    // No v2 discriminator and no inspect-first on the default path.
    assert.equal((out as Record<string, unknown>).contextEngine, undefined);
    assert.equal((out as Record<string, unknown>).inspectFirst, undefined);
  });
});

test.skip("explicit v1 and legacy stay on v1 but are recorded distinctly", async () => {
  await withFixture(({ db, repoRoot }) => {
    for (const requested of ["v1", "legacy"] as const) {
      const out = runFormatted(db, repoRoot, {
        query: "modify base function",
        intent: "modify",
        capsuleEngine: requested,
      });
      const engine = (out as Record<string, unknown>).capsuleEngine as {
        requested: string;
        effective: string;
        fallbackReason: string | null;
        compactInspectFirst: boolean;
      };
      assert.equal(engine.requested, requested);
      assert.equal(engine.effective, "v1");
      assert.equal(engine.fallbackReason, null);
      assert.equal(engine.compactInspectFirst, false);
      // Explicit v1/legacy never builds the v2 section.
      assert.equal((out as Record<string, unknown>).contextEngine, undefined);
      assert.equal((out as Record<string, unknown>).capsuleV2, undefined);
    }
  });
});

test.skip("capsuleEngine=v2 records effective=v2 and emits compact inspect-first guidance", async () => {
  await withFixture(({ db, repoRoot }) => {
    const out = runFormatted(db, repoRoot, {
      query: "base in src/base.ts#L1-L3 returns wrong value",
      intent: "debug",
      capsuleEngine: "v2",
    });
    const engine = (out as Record<string, unknown>).capsuleEngine as {
      requested: string;
      effective: string;
      fallbackReason: string | null;
      compactInspectFirst: boolean;
    };
    assert.equal(engine.requested, "v2");
    assert.equal(engine.effective, "v2");
    assert.equal(engine.fallbackReason, null);

    // When v2 found an actionable pivot, the compact inspect-first block is
    // emitted and compactInspectFirst tracks it.
    const inspectFirst = (out as Record<string, unknown>).inspectFirst as {
      confidence: string;
      likelyFirst: { path: string };
    } | null;
    if (inspectFirst !== null) {
      assert.equal(engine.compactInspectFirst, true);
      assert.ok(["high", "medium", "low"].includes(inspectFirst.confidence));
      assert.ok(typeof inspectFirst.likelyFirst.path === "string");
    } else {
      assert.equal(engine.compactInspectFirst, false);
    }
  });
});

test.skip("a genuine v2 build failure falls back to v1 with a fallback reason, preserving v1 sections", async () => {
  await withFixture(({ db, repoRoot }) => {
    const orchestration = runPipelineOrchestrator(
      db,
      repoRoot,
      { query: "modify base function to accept a label", intent: "modify", capsuleEngine: "v2" },
      {
        capsuleV2Builder: () => {
          throw new Error("synthetic v2 render failure");
        },
      },
    );

    // Fell back to v1, recorded the reason, and emitted no v2 section.
    assert.equal(orchestration.capsuleEngine.requested, "v2");
    assert.equal(orchestration.capsuleEngine.effective, "v1");
    assert.equal(orchestration.capsuleEngine.compactInspectFirst, false);
    assert.ok(orchestration.capsuleEngine.fallbackReason?.startsWith("v2_build_failed: "));
    assert.equal(orchestration.capsuleV2, null);
    assert.equal(orchestration.inspectFirst, null);

    // The v1 sections still assembled — the fallback did not drop context.
    assert.ok(orchestration.context.included || orchestration.context.skipReason !== null);

    const out = formatRunPipelineOrchestrationOutput(orchestration);
    assert.equal((out as Record<string, unknown>).contextEngine, undefined);
    assert.equal((out as Record<string, unknown>).capsuleEngine.effective, "v1");
    assert.ok((out as Record<string, unknown>).capsuleEngine.fallbackReason.startsWith("v2_build_failed: "));
  });
});

// M56: the impact / memory / rules sections are folded into the Capsule v2 product
// digest, so the agent-facing render answers "what depends on this" / "what prior
// knowledge / rules apply" in the same block — not just pivots/support.
test("M56: capsule v2 digest folds the impact section for an impact-intent query", async () => {
  await withFixture(({ db, repoRoot }) => {
    const orchestration = runPipelineOrchestrator(db, repoRoot, {
      query: "what is the impact of base",
      capsuleEngine: "v2",
    });
    // The impact section resolved real reverse dependents (alpha + beta depend on base).
    assert.equal(orchestration.impact.included, true);
    assert.ok((orchestration.impact.graph?.summary.dependentSymbolCount ?? 0) > 0);
    const digest = orchestration.capsuleV2?.digest ?? "";
    // The digest carries a `→ impact` line with the real dependent + cross-file counts.
    assert.match(digest, /→ impact \d+ dependents, \d+ cross-file/);
    // The impact graph attaches signature-window source excerpts (repoRoot supplied),
    // so the digest folds REAL per-caller rows (path::symbol + line range), not just
    // counts — and the snippets are genuine, so no snippets-unavailable warning.
    assert.match(digest, /dependent src\/(alpha|beta)\.ts::(alpha|beta) L\d+-L\d+:/);
    assert.equal(orchestration.capsuleV2?.warnings.includes("impact_snippets_unavailable"), false);
    // summary.impactCount mirrors the dependent count (never fabricated).
    assert.equal(
      orchestration.capsuleV2?.summary.impactCount,
      orchestration.impact.graph?.summary.dependentSymbolCount,
    );
  });
});

test("M56: capsule v2 digest carries no impact line when the query does not request impact", async () => {
  await withFixture(({ db, repoRoot }) => {
    const orchestration = runPipelineOrchestrator(db, repoRoot, {
      query: "why does base fail",
      intent: "debug",
      capsuleEngine: "v2",
    });
    assert.equal(orchestration.impact.included, false);
    const digest = orchestration.capsuleV2?.digest ?? "";
    // No impact section for this intent → no `→ impact` line and no impactCount.
    assert.equal(digest.includes("→ impact"), false);
    assert.equal("impactCount" in (orchestration.capsuleV2?.summary ?? {}), false);
  });
});

test("M56: capsule v2 digest folds active project rules when rules are surfaced", async () => {
  await withFixture(({ db, repoRoot }) => {
    const orchestration = runPipelineOrchestrator(db, repoRoot, {
      query: "modify base function",
      intent: "modify",
      capsuleEngine: "v2",
    });
    // Rules availability depends on the fixture; assert the wiring is honest either way.
    const digest = orchestration.capsuleV2?.digest ?? "";
    if (orchestration.rules.included && orchestration.rules.activeCount > 0) {
      assert.match(digest, /◇ rule \d+ active/);
      assert.equal(orchestration.capsuleV2?.summary.ruleCount, orchestration.rules.activeCount);
    } else {
      assert.equal(digest.includes("◇ rule"), false);
    }
  });
});

test("M56: deriveImpactDigestSeam returns null when impact was not included", () => {
  const section = {
    included: false,
    skipReason: "not_requested_by_intent",
    triggerReason: null,
    selectionSource: null,
    focalSymbol: null,
    graph: null,
    candidatesConsidered: 0,
    matchedCandidates: 0,
  } as unknown as OrchestrationImpactSection;
  assert.equal(deriveImpactDigestSeam(section), null);
});

test("M56: deriveMemoryDigestSeam returns null when nothing relevant surfaced", () => {
  const section = {
    session: { included: false, skipReason: "query_unsupported", sessionId: null, observationCount: 0, recentObservations: [] },
    durable: { included: false, skipReason: "no_matches", matchedCount: 0, topObservations: [] },
  } as unknown as OrchestrationMemorySection;
  assert.equal(deriveMemoryDigestSeam(section), null);
});

test("M56: deriveRulesDigestSeam returns null when no active rules", () => {
  const section = {
    included: false,
    active: [],
    candidates: [],
    activeCount: 0,
    candidateCount: 0,
    staleCount: 0,
    disabledCount: 0,
    dismissedCount: 0,
  } as unknown as OrchestrationRulesSection;
  assert.equal(deriveRulesDigestSeam(section), null);
});
