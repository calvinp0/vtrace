/**
 * M158-D §71/§72/§74 — every delivery consumer must serve the SAME bounded
 * support set, in the authoritative packed order.
 *
 * M158 changes which candidates occupy the scarce support slots, so the
 * question M157 asked of pivot authority has to be asked again of support:
 * `get_code_context`, `get_context_capsule` and `run_pipeline` must report the
 * same support items for the same repository, query and budget. A rule that
 * deduped in the producer while a consumer re-sorted or re-truncated behind it
 * would be worse than no rule at all — the surfaces would disagree about what
 * the model was shown.
 *
 * The fixture is the generic shape the broad100 audit measured ten times over:
 * one method overridden in several classes of one file, which renders
 * signature-only as support and therefore delivers byte-identical text.
 */

import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";

import { initRepo } from "../setup/initRepo";
import { createMcpServer } from "./server";
import { MCP_SERVER_SCHEMA, McpToolId } from "./types";

const QUERY =
  "value_from_datadict widget returns the wrong value for the datadict name; "
  + "the widget value_from_datadict lookup should read the datadict name";

const OVERRIDE = "    def value_from_datadict(self, data, files, name):";

async function withRepeatedOverrideRepo(run: (repoRoot: string) => Promise<void>): Promise<void> {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), "vtrace-m158-consumers-"));
  try {
    await mkdir(path.join(repoRoot, "pkg"), { recursive: true });
    const classes = ["A", "B", "C", "D", "E", "F"];
    const lines: string[] = [];
    for (const name of classes) {
      lines.push(
        `class Widget${name}:`,
        OVERRIDE,
        "        # widget value datadict name lookup",
        "        return data.get(name)",
        "",
      );
    }
    // Weakly related helpers in the same file, so a slot freed by the rule has
    // somewhere real to refill from.
    lines.push(
      "def widget_registry_reset(registry):",
      "    # widget registry reset",
      "    return registry",
      "",
      "def widget_cache_clear(cache):",
      "    # widget cache clear",
      "    return cache",
      "",
    );
    await writeFile(path.join(repoRoot, "pkg", "widgets.py"), lines.join("\n"));
    await run(repoRoot);
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
}

interface SupportItem {
  path: string;
  fqName: string;
  contentMode: string;
  estimatedTokens: number;
}

interface SupportState {
  ok: boolean;
  support: SupportItem[];
  estimatedTokens: number | undefined;
  maxTokens: number | undefined;
}

async function supportStates(repoRoot: string): Promise<Record<string, SupportState>> {
  const server = createMcpServer({ context: { repoRoot } });
  const tools: Array<[string, McpToolId]> = [
    ["get_code_context", McpToolId.GetCodeContext],
    ["get_context_capsule", McpToolId.GetContextCapsule],
    ["run_pipeline", McpToolId.RunPipeline],
  ];

  const states: Record<string, SupportState> = {};
  for (const [name, toolId] of tools) {
    const response = await server.handleRequest({
      schema: MCP_SERVER_SCHEMA,
      requestId: `m158-${name}`,
      toolId,
      // The tier is derived from the budget, and the default micro tier has a
      // single support slot — which would make the bounded-set assertions
      // vacuous. Standard tier is the one the broad corpus measures.
      // detail=debug asks for the AUTHORITATIVE result: run_pipeline and
      // get_code_context project a compact orientation by default, and this
      // suite is about the support set the pipeline SELECTED, not about how
      // much of it the default disclosure carries.
      input: { query: QUERY, capsule_budget_tokens: 8_000, detail: "debug" },
    });
    const output = response.result.output as Record<string, unknown>;
    // `capsuleResult` is the authoritative capsule as each surface serializes
    // it. The bounded product response deliberately ships support text through
    // `modelVisibleContext` rather than inline, so identity here is the packed
    // item and its cost — which is exactly what parity is about.
    const capsule = (output.capsuleResult ?? {}) as Record<string, unknown>;
    const raw = Array.isArray(capsule.support) ? (capsule.support as Array<Record<string, unknown>>) : [];
    const budget = capsule.budget as Record<string, unknown> | undefined;
    states[name] = {
      ok: response.result.ok,
      support: raw.map((item) => ({
        path: String(item.path),
        fqName: String(item.fqName),
        contentMode: String(item.contentMode),
        estimatedTokens: Number(item.estimatedTokens),
      })),
      estimatedTokens: budget?.estimatedTokens as number | undefined,
      maxTokens: budget?.maxTokens as number | undefined,
    };
  }
  return states;
}

test("M158: every consumer serves the same bounded support set in the same order", async () => {
  await withRepeatedOverrideRepo(async (repoRoot) => {
    const initialized = await initRepo({ repoPath: repoRoot });
    const states = await supportStates(initialized.repoRoot);

    const [first, ...rest] = Object.values(states);
    assert.ok(first !== undefined);
    // Guard against a vacuous pass: the fixture must actually deliver support.
    assert.ok(first.support.length > 0, "fixture delivered no support at all");
    assert.ok(first.support.length > 1, "fixture must exercise a multi-slot bound");
    const identity = (state: SupportState) =>
      state.support.map((item) => `${item.path}::${item.fqName}::${item.contentMode}::${item.estimatedTokens}`);
    for (const state of rest) {
      assert.equal(state.ok, first.ok);
      assert.deepEqual(
        identity(state),
        identity(first),
        `consumers disagree on the packed support set: ${JSON.stringify(states, null, 2)}`,
      );
    }
  });
});

test("M158: no consumer delivers the same support item twice", async () => {
  await withRepeatedOverrideRepo(async (repoRoot) => {
    const initialized = await initRepo({ repoPath: repoRoot });
    const states = await supportStates(initialized.repoRoot);

    for (const [name, state] of Object.entries(states)) {
      // The producer deduped on delivered evidence; a consumer that re-sorted or
      // re-truncated behind it could still surface the same item twice.
      const identities = state.support.map((item) => `${item.path}::${item.fqName}`);
      assert.equal(
        new Set(identities).size,
        identities.length,
        `${name} served the same support item twice:\n${identities.join("\n")}`,
      );
    }
  });
});

test("M158: one global token envelope still holds on every consumer", async () => {
  // §74/§98: refilling a freed slot must not let any surface exceed the budget,
  // and no surface gets a support bonus of its own.
  await withRepeatedOverrideRepo(async (repoRoot) => {
    const initialized = await initRepo({ repoPath: repoRoot });
    const states = await supportStates(initialized.repoRoot);

    for (const [name, state] of Object.entries(states)) {
      if (state.estimatedTokens === undefined || state.maxTokens === undefined) continue;
      assert.ok(
        state.estimatedTokens <= state.maxTokens,
        `${name} exceeded the global envelope: ${state.estimatedTokens} > ${state.maxTokens}`,
      );
    }
  });
});
