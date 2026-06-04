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
  runPipelineOrchestrator,
  type RunPipelineOrchestratorInput,
} from "./runPipelineOrchestrator";
import { formatRunPipelineOrchestrationOutput } from "./formatRunPipelineOutput";
import { createDeferredVexpStore, type DeferredVexpStore } from "./deferredVexpStore";

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
    assert.equal(out.impact.skipReason, "not_refactor_like");
    assert.equal(out.impact.focalSymbol, null);
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
