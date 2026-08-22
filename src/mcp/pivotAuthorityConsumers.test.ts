/**
 * M157-D §48/§49/§60 — every delivery consumer must agree about pivot authority.
 *
 * M156 taught the shape of this failure: the primitive was fixed and a consumer
 * still refused the result, so the repository stayed effectively unavailable.
 * M157 changes which candidate holds a pivot slot, so the same question has to
 * be asked of the surfaces rather than of `buildCapsuleV2` alone —
 * `get_code_context`, `get_context_capsule` and `run_pipeline` must report the
 * same delivery state for the same repository, query and budget.
 *
 * The fixture is the generic shape that produced an empty capsule in the M157-A
 * audit: doc-tree candidates outrank real source, take the pivot slots, and are
 * then disqualified by the non-source rule.
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
  "quickstart prompt does not exit when a conf.py already exists; "
  + "the quickstart prompt loop should detect the existing conf.py and exit";

/** Nothing in the repository is about this. */
const NONSENSE_QUERY = "zzqq nonexistent xyzzy gibberish wibble frobnicate";

async function withDocOutranksSourceRepo(run: (repoRoot: string) => Promise<void>): Promise<void> {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), "vtrace-m157-consumers-"));
  try {
    await mkdir(path.join(repoRoot, "doc"), { recursive: true });
    await mkdir(path.join(repoRoot, "src"), { recursive: true });
    // Doc-tree definitions that match the query strongly enough to lead.
    await writeFile(
      path.join(repoRoot, "doc", "conf.py"),
      [
        "def quickstart_prompt_exit(conf):",
        "    # quickstart prompt exit conf.py existing",
        "    return conf",
        "",
        "def quickstart_prompt_conf(conf):",
        "    # quickstart prompt conf.py exists detect",
        "    return conf",
        "",
      ].join("\n"),
    );
    // The real edit sites.
    await writeFile(
      path.join(repoRoot, "src", "quickstart.py"),
      [
        "def quickstart_prompt_loop(conf):",
        "    # quickstart prompt loop exit existing conf",
        "    return conf",
        "",
        "def quickstart_detect_conf(conf):",
        "    # quickstart detect conf exists prompt",
        "    return conf",
        "",
      ].join("\n"),
    );
    await run(repoRoot);
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
}

interface DeliveryState {
  ok: boolean;
  resolved: boolean;
  leadPivotPath: string | null;
  absenceClaim: string | undefined;
}

async function deliveryStates(repoRoot: string, query: string): Promise<Record<string, DeliveryState>> {
  const server = createMcpServer({ context: { repoRoot } });
  const tools: Array<[string, McpToolId]> = [
    ["get_code_context", McpToolId.GetCodeContext],
    ["get_context_capsule", McpToolId.GetContextCapsule],
    ["run_pipeline", McpToolId.RunPipeline],
  ];

  const states: Record<string, DeliveryState> = {};
  for (const [name, toolId] of tools) {
    const response = await server.handleRequest({
      schema: MCP_SERVER_SCHEMA,
      requestId: `m157-${name}`,
      toolId,
      // detail=debug asks for the AUTHORITATIVE result. run_pipeline and
      // get_code_context project a compact orientation by default, and this
      // test is about what the pipeline resolved, not about what it discloses.
      input: { query, detail: "debug" },
    });
    const output = response.result.output as Record<string, unknown>;
    const product = (output.productContext ?? output) as Record<string, unknown>;
    // `leadPivot` is an item IDENTITY string (`<path>::<fqName>`), not an object.
    const lead = product.leadPivot;
    states[name] = {
      ok: response.result.ok,
      resolved: product.resolved === true,
      leadPivotPath: typeof lead === "string" && lead.length > 0 ? lead : null,
      absenceClaim: product.absenceClaim as string | undefined,
    };
  }
  return states;
}

test("M157: every delivery consumer agrees on the recovered pivot state", async () => {
  await withDocOutranksSourceRepo(async (repoRoot) => {
    const initialized = await initRepo({ repoPath: repoRoot });
    const states = await deliveryStates(initialized.repoRoot, QUERY);

    const [first, ...rest] = Object.values(states);
    assert.ok(first !== undefined);
    // Guard against a vacuous pass: the fixture must actually deliver a pivot,
    // which it only does because a released slot was reclaimed.
    assert.ok(first.leadPivotPath !== null, "fixture delivered no pivot at all");
    for (const state of rest) {
      assert.equal(state.ok, first.ok);
      assert.equal(state.resolved, first.resolved, `consumers disagree on resolved: ${JSON.stringify(states)}`);
      assert.equal(
        state.leadPivotPath,
        first.leadPivotPath,
        `consumers disagree on the lead pivot: ${JSON.stringify(states)}`,
      );
    }

    // No consumer may be served a doc-tree file as the edit target.
    for (const [name, state] of Object.entries(states)) {
      assert.ok(
        state.leadPivotPath === null || !state.leadPivotPath.includes("doc/"),
        `${name} led with a non-source file: ${state.leadPivotPath}`,
      );
    }
  });
});

test("M157: a genuinely irrelevant query stays empty on every consumer", async () => {
  await withDocOutranksSourceRepo(async (repoRoot) => {
    const initialized = await initRepo({ repoPath: repoRoot });
    const states = await deliveryStates(initialized.repoRoot, NONSENSE_QUERY);

    for (const [name, state] of Object.entries(states)) {
      // Abstention is preserved: releasing a pivot slot must not manufacture one
      // where no candidate ever qualified.
      assert.equal(state.leadPivotPath, null, `${name} invented a pivot for an irrelevant query`);
      assert.equal(state.resolved, false, `${name} reported an irrelevant query as resolved`);
    }
  });
});

test("M157: an empty delivery is never serialized as authoritative absence", async () => {
  await withDocOutranksSourceRepo(async (repoRoot) => {
    const initialized = await initRepo({ repoPath: repoRoot });
    const states = await deliveryStates(initialized.repoRoot, NONSENSE_QUERY);

    for (const [name, state] of Object.entries(states)) {
      // §38/§66: not finding an edit target is not proof that none exists. The
      // claim must stay on the weakest rung of the evidence scale.
      assert.notEqual(
        state.absenceClaim,
        "authoritative_absence",
        `${name} overclaimed absence for a no-pivot result`,
      );
    }
  });
});
