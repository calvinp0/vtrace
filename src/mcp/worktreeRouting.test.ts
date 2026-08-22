// M132 — MCP request -> worktree routing.
//
// The central acceptance: a long-lived server bound to the MAIN checkout must
// answer a request for a linked worktree with THAT worktree's content, and must
// never fall back to another checkout when it cannot.

import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, test } from "bun:test";

import { initRepo } from "../setup/initRepo";
import { resolveRepoLocalPaths } from "../setup/repoState";
import { readIndexMeta } from "../indexer/indexMeta";
import { defaultMcpToolRegistry } from "./tools";
import { McpToolId } from "./types";
import type { McpServerContext } from "./types";
import {
  WorktreeRoutingReason,
  WorktreeRoutingSource,
  detectIndexWorktreeMismatch,
  resolveWorktreeRouting,
  routingSourceFor,
} from "./worktreeRouting";

const execFile = promisify(execFileCallback);

async function git(cwd: string, ...args: string[]): Promise<void> {
  await execFile("git", args, { cwd, encoding: "utf8" });
}

let scratch: string;

beforeEach(async () => {
  scratch = await mkdtemp(path.join(os.tmpdir(), "vtrace-m132-route-"));
});

afterEach(async () => {
  await rm(scratch, { recursive: true, force: true });
});

/** A repo whose single function returns `marker`, committed on `main`. */
async function createRepo(name: string, marker: string): Promise<string> {
  const root = path.join(scratch, name);
  await mkdir(path.join(root, "src"), { recursive: true });
  await writeFile(path.join(root, "src", "foo.py"), `def foo():\n    return "${marker}"\n`);
  await git(root, "init", "--initial-branch=main");
  await git(root, "config", "user.email", "m132@example.com");
  await git(root, "config", "user.name", "M132");
  await git(root, "add", ".");
  await git(root, "commit", "-m", "initial");
  return root;
}

/** A linked worktree of `root` whose `src/foo.py` returns `marker` instead. */
async function createLinkedWorktree(
  root: string,
  location: string,
  branch: string,
  marker: string,
): Promise<string> {
  await git(root, "worktree", "add", "-b", branch, location);
  await writeFile(path.join(location, "src", "foo.py"), `def foo():\n    return "${marker}"\n`);
  await git(location, "add", ".");
  await git(location, "commit", "-m", `${branch} change`);
  return location;
}

function contextBoundTo(repoRoot: string | null): McpServerContext {
  const paths = repoRoot === null ? null : resolveRepoLocalPaths(repoRoot);
  return {
    serverId: "vtrace",
    repoRoot,
    dbPath: paths?.dbPath ?? null,
    configPath: paths?.configPath ?? null,
    statePath: paths?.statePath ?? null,
    initialized: repoRoot !== null,
    config: null,
    state: null,
  } as McpServerContext;
}

const registry = defaultMcpToolRegistry;

async function callTool(
  context: McpServerContext,
  toolId: McpToolId,
  input: Record<string, unknown>,
): Promise<{ ok: boolean; output?: any; error?: any }> {
  const definition = registry.getByToolId(toolId);
  assert.notEqual(definition, undefined, `tool ${toolId} must be registered`);
  // run_pipeline and get_code_context project a compact orientation by default;
  // this suite asserts on the authoritative result, so it asks for that result
  // explicitly rather than for the disclosure.
  const authoritativeInput = toolId === McpToolId.RunPipeline || toolId === McpToolId.GetCodeContext
    ? { ...input, detail: "debug" }
    : input;
  return await definition!.handler({
    context,
    request: { schema: registry.schema, requestId: "m132", toolId, input: authoritativeInput },
  }) as any;
}

/** The source text `get_code_context` put in front of the model. */
function modelVisible(output: any): string {
  return output?.productContext?.modelVisibleContext ?? "";
}

describe("M132 worktree routing", () => {
  test("routing precedence is explicit_root > client_context > process_default", () => {
    assert.equal(
      routingSourceFor({ requestedRoot: "/a", clientContextRoot: "/b", boundRoot: "/c" }),
      WorktreeRoutingSource.ExplicitRoot,
    );
    assert.equal(
      routingSourceFor({ clientContextRoot: "/b", boundRoot: "/c" }),
      WorktreeRoutingSource.ClientContext,
    );
    assert.equal(routingSourceFor({ boundRoot: "/c" }), WorktreeRoutingSource.ProcessDefault);
  });

  test("no root anywhere yields worktree_context_required, never a guess", async () => {
    const routing = await resolveWorktreeRouting({ boundRoot: null });
    assert.equal(routing.ok, false);
    if (routing.ok) return;
    assert.equal(routing.reason, WorktreeRoutingReason.ContextRequired);
    assert.equal(routing.action.type, "retry_with_worktree_root");
  });

  test("a removed worktree yields worktree_missing and names the active index", async () => {
    const main = await createRepo("main", "MAIN");
    const routing = await resolveWorktreeRouting({
      requestedRoot: path.join(scratch, "deleted-worktree"),
      boundRoot: main,
    });
    assert.equal(routing.ok, false);
    if (routing.ok) return;
    assert.equal(routing.reason, WorktreeRoutingReason.WorktreeMissing);
    assert.equal(routing.activeIndex?.root, main);
    assert.equal(routing.activeIndex?.branch, "main");
  });

  test("an index built for another worktree is refused, not served", () => {
    const mismatch = detectIndexWorktreeMismatch({
      routedRoot: "/tmp/worktree-B",
      indexedWorktreeRoot: "/home/calvin/code/ARC",
    });
    assert.notEqual(mismatch, undefined);
    assert.equal(mismatch!.reason, WorktreeRoutingReason.WorktreeMismatch);
    assert.equal(mismatch!.action.type, "choose_worktree");

    // Same worktree: served.
    assert.equal(
      detectIndexWorktreeMismatch({ routedRoot: "/tmp/w", indexedWorktreeRoot: "/tmp/w" }),
      undefined,
    );
    // No recorded claim (pre-identity index): not a mismatch.
    assert.equal(
      detectIndexWorktreeMismatch({ routedRoot: "/tmp/w", indexedWorktreeRoot: undefined }),
      undefined,
    );
  });

  test("server cwd A + explicit repo_root B answers from B (the PR-worktree case)", async () => {
    const main = await createRepo("main", "MAIN_IMPLEMENTATION");
    const pr = await createLinkedWorktree(
      main,
      path.join(scratch, "pr-worktree"),
      "pr944",
      "PR_IMPLEMENTATION",
    );
    await initRepo({ repoPath: main });
    await initRepo({ repoPath: pr });

    // The server is bound to main, exactly as a long-lived MCP server would be.
    const context = contextBoundTo(main);

    const fromPr = await callTool(context, McpToolId.GetCodeContext, {
      task: "what does foo return",
      repo_root: pr,
    });
    assert.equal(fromPr.ok, true);
    assert.match(modelVisible(fromPr.output), /PR_IMPLEMENTATION/);
    assert.doesNotMatch(modelVisible(fromPr.output), /MAIN_IMPLEMENTATION/);
    assert.equal(fromPr.output.productContext.repository.root, pr);
    assert.equal(fromPr.output.productContext.repository.routingSource, "explicit_root");

    // And main still answers as main.
    const fromMain = await callTool(context, McpToolId.GetCodeContext, {
      task: "what does foo return",
      repo_root: main,
    });
    assert.equal(fromMain.ok, true);
    assert.match(modelVisible(fromMain.output), /MAIN_IMPLEMENTATION/);
    assert.doesNotMatch(modelVisible(fromMain.output), /PR_IMPLEMENTATION/);
    assert.equal(fromMain.output.productContext.repository.root, main);
  });

  test("the server's process cwd cannot override an explicit requested root", async () => {
    const main = await createRepo("main", "MAIN_ONLY");
    const other = await createLinkedWorktree(
      main,
      path.join(scratch, "other"),
      "other",
      "OTHER_ONLY",
    );
    await initRepo({ repoPath: main });
    await initRepo({ repoPath: other });

    const originalCwd = process.cwd();
    try {
      process.chdir(main);
      const result = await callTool(contextBoundTo(main), McpToolId.GetCodeContext, {
        task: "what does foo return",
        repo_root: other,
      });
      assert.equal(result.ok, true);
      assert.match(modelVisible(result.output), /OTHER_ONLY/);
      assert.doesNotMatch(modelVisible(result.output), /MAIN_ONLY/);
    } finally {
      process.chdir(originalCwd);
    }
  });

  test("three worktrees of one repository each return their own src/foo.py", async () => {
    const a = await createRepo("repo-a", "VERSION_A");
    const b = await createLinkedWorktree(a, path.join(scratch, "wt-b"), "branch-b", "VERSION_B");
    const c = await createLinkedWorktree(a, path.join(scratch, "wt-c"), "branch-c", "VERSION_C");
    for (const root of [a, b, c]) await initRepo({ repoPath: root });

    const context = contextBoundTo(a);
    const expectations: Array<[string, string, string[]]> = [
      [a, "VERSION_A", ["VERSION_B", "VERSION_C"]],
      [b, "VERSION_B", ["VERSION_A", "VERSION_C"]],
      [c, "VERSION_C", ["VERSION_A", "VERSION_B"]],
      // Repeat in a different order: no cache or index leakage between roots.
      [c, "VERSION_C", ["VERSION_A", "VERSION_B"]],
      [a, "VERSION_A", ["VERSION_B", "VERSION_C"]],
      [b, "VERSION_B", ["VERSION_A", "VERSION_C"]],
    ];

    for (const [root, expected, forbidden] of expectations) {
      const result = await callTool(context, McpToolId.GetCodeContext, {
        task: "what does foo return",
        repo_root: root,
      });
      assert.equal(result.ok, true, `${root} must answer`);
      const visible = modelVisible(result.output);
      assert.match(visible, new RegExp(expected), `${root} must show ${expected}`);
      for (const other of forbidden) {
        assert.doesNotMatch(visible, new RegExp(other), `${root} must not show ${other}`);
      }
    }
  });

  test("a worktree with no index never falls back to the bound worktree's index", async () => {
    const main = await createRepo("main", "MAIN_ONLY");
    const unindexed = await createLinkedWorktree(
      main,
      path.join(scratch, "unindexed"),
      "unindexed",
      "UNINDEXED_ONLY",
    );
    await initRepo({ repoPath: main });

    const result = await callTool(contextBoundTo(main), McpToolId.GetCodeContext, {
      task: "what does foo return",
      repo_root: unindexed,
    });
    // Fail-closed: an actionable diagnostic, never main's source.
    assert.doesNotMatch(JSON.stringify(result), /MAIN_ONLY/);
    const reason = result.output?.reason ?? result.error?.details?.reason;
    assert.equal(["missing_index", "repo_not_ready"].includes(reason), true, `unexpected reason ${reason}`);
  });

  test("auto_refresh=if_stale refreshes only the requested worktree", async () => {
    const a = await createRepo("wt-a", "A_ORIGINAL");
    const b = await createLinkedWorktree(a, path.join(scratch, "wt-b"), "branch-b", "B_ORIGINAL");
    for (const root of [a, b]) await initRepo({ repoPath: root });

    const fingerprintOf = async (root: string): Promise<string> => {
      const meta = await readIndexMeta(root);
      return JSON.stringify({
        head: meta?.manifest.snapshot.headCommit,
        dirty: meta?.manifest.snapshot.dirtyFingerprint,
        indexedAt: meta?.manifest.index.indexedAt,
        runId: meta?.manifest.index.runId,
      });
    };

    const aBefore = await fingerprintOf(a);

    // Make B stale, A untouched.
    await writeFile(path.join(b, "src", "foo.py"), 'def foo():\n    return "B_REFRESHED"\n');
    await git(b, "add", ".");
    await git(b, "commit", "-m", "b moves");

    const context = contextBoundTo(a);
    const refreshed = await callTool(context, McpToolId.GetCodeContext, {
      task: "what does foo return",
      repo_root: b,
      auto_refresh: "if_stale",
    });

    assert.equal(refreshed.ok, true);
    assert.match(modelVisible(refreshed.output), /B_REFRESHED/);
    assert.equal(
      await fingerprintOf(a),
      aBefore,
      "worktree A's index fingerprint must be untouched by a refresh of B",
    );

    // The converse: refreshing A must not touch B.
    const bAfterRefresh = await fingerprintOf(b);
    await writeFile(path.join(a, "src", "foo.py"), 'def foo():\n    return "A_REFRESHED"\n');
    await git(a, "add", ".");
    await git(a, "commit", "-m", "a moves");
    const refreshedA = await callTool(context, McpToolId.GetCodeContext, {
      task: "what does foo return",
      repo_root: a,
      auto_refresh: "if_stale",
    });
    assert.equal(refreshedA.ok, true);
    assert.match(modelVisible(refreshedA.output), /A_REFRESHED/);
    assert.equal(await fingerprintOf(b), bAfterRefresh, "refreshing A must not refresh B");
  });

  test("a dirty worktree's state does not leak into a sibling worktree", async () => {
    const a = await createRepo("clean", "A_CLEAN");
    const b = await createLinkedWorktree(a, path.join(scratch, "dirty"), "dirty", "B_COMMITTED");
    for (const root of [a, b]) await initRepo({ repoPath: root });

    const aMetaBefore = await readIndexMeta(a);
    // Uncommitted edit in B only.
    await writeFile(path.join(b, "src", "foo.py"), 'def foo():\n    return "B_DIRTY"\n');

    const context = contextBoundTo(a);
    const fromA = await callTool(context, McpToolId.GetCodeContext, {
      task: "what does foo return",
      repo_root: a,
    });
    assert.equal(fromA.ok, true, "a clean worktree stays answerable while its sibling is dirty");
    assert.match(modelVisible(fromA.output), /A_CLEAN/);

    const aMetaAfter = await readIndexMeta(a);
    assert.equal(
      aMetaAfter?.manifest.snapshot.dirtyFingerprint,
      aMetaBefore?.manifest.snapshot.dirtyFingerprint,
      "B's dirt must not appear in A's fingerprint",
    );
  });

  test("get_skeleton, get_impact_graph and search_logic_flow all accept repo_root", async () => {
    for (const toolId of [McpToolId.GetSkeleton, McpToolId.GetImpactGraph, McpToolId.SearchLogicFlow, McpToolId.GetContextCapsule, McpToolId.RunPipeline]) {
      const definition = registry.getByToolId(toolId);
      assert.notEqual(definition, undefined, `${toolId} must be registered`);
      assert.notEqual(
        definition!.metadata.inputSchema.properties?.repo_root,
        undefined,
        `${toolId} must accept repo_root`,
      );
    }
  });

  test("get_skeleton routed to a linked worktree reads that worktree's file", async () => {
    const main = await createRepo("main", "MAIN_SKELETON");
    const pr = await createLinkedWorktree(main, path.join(scratch, "pr"), "pr", "PR_SKELETON");
    for (const root of [main, pr]) await initRepo({ repoPath: root });

    const result = await callTool(contextBoundTo(main), McpToolId.GetSkeleton, {
      files: ["src/foo.py"],
      repo_root: pr,
    });
    assert.equal(result.ok, true);
    assert.match(JSON.stringify(result.output), /foo/);
  });
});
