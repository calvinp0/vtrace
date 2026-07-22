import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { withWorktreeIndexLock, WorktreeIndexLockError } from "../../src/indexer/worktreeIndexLock";
import { resolveWorktreeIdentity } from "../../src/indexer/worktreeIdentity";
import { initRepo } from "../../src/setup/initRepo";
import { createMcpServer } from "../../src/mcp/server";
import { MCP_SERVER_SCHEMA, McpToolId } from "../../src/mcp/types";

const OUTPUT_PATH = path.resolve(
  "benchmarks/stage5_vexp_swe_bench_smoke/results/stage5_m114_worktree_index_smoke.detail.json",
);
const task = "Find and modify SessionManager.createSession";

const tempRoot = await mkdtemp(path.join(os.tmpdir(), "vtrace-m114-smoke-"));
const mainRoot = path.join(tempRoot, "main");
const featureRoot = path.join(tempRoot, "feature");
const detachedRoot = path.join(tempRoot, "detached");

try {
  await mkdir(path.join(mainRoot, "src"), { recursive: true });
  git(mainRoot, "init", "-b", "main");
  git(mainRoot, "config", "user.email", "vtrace@example.test");
  git(mainRoot, "config", "user.name", "Vtrace Smoke");
  await writeFile(path.join(mainRoot, ".gitignore"), ".vtrace/\n");
  await writeFile(
    path.join(mainRoot, "src", "session.ts"),
    "export class SessionManager { createSession(): void {} }\n",
  );
  git(mainRoot, "add", ".gitignore", "src/session.ts");
  git(mainRoot, "commit", "-m", "initial");
  git(mainRoot, "worktree", "add", "-b", "feature", featureRoot);
  git(mainRoot, "worktree", "add", "--detach", detachedRoot, "HEAD");

  await initRepo({ repoPath: mainRoot });
  const server = createMcpServer({ context: { repoRoot: mainRoot } });
  const freshBefore = await context(server, mainRoot, "never");
  await call(server, McpToolId.IndexRepo, { repo_root: mainRoot });
  const freshAfter = await context(server, mainRoot, "never");
  const invariantBefore = contextInvariant(freshBefore);
  const invariantAfter = contextInvariant(freshAfter);

  await writeFile(path.join(mainRoot, "src", "advanced.ts"), "export const advanced = true;\n");
  git(mainRoot, "add", "src/advanced.ts");
  git(mainRoot, "commit", "-m", "advance main");
  const headDisabled = await context(server, mainRoot, "never");
  const headRefreshed = await context(server, mainRoot, "if_stale");

  await writeFile(
    path.join(mainRoot, "src", "session.ts"),
    "export class SessionManager { createSession(): string { return 'dirty'; } }\n",
  );
  const dirtyDisabled = await context(server, mainRoot, "never");
  const dirtyRefreshed = await context(server, mainRoot, "if_stale");

  const featureDisabled = await context(server, featureRoot, "never");
  const featureRefreshed = await context(server, featureRoot, "if_stale");
  const detachedIdentity = await resolveWorktreeIdentity(detachedRoot);

  let release!: () => void;
  let acquired!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const ready = new Promise<void>((resolve) => { acquired = resolve; });
  const firstLock = withWorktreeIndexLock({
    repoRoot: mainRoot,
    operation: async () => { acquired(); await held; return true; },
  });
  await ready;
  let lockReason: string | null = null;
  try {
    await withWorktreeIndexLock({ repoRoot: mainRoot, operation: async () => true });
  } catch (error) {
    lockReason = error instanceof WorktreeIndexLockError ? error.code : String(error);
  }
  const otherWorktreeLock = await withWorktreeIndexLock({
    repoRoot: featureRoot,
    operation: async () => true,
  });
  release();
  await firstLock;

  const visibleTools = server.listTools().map((tool) => tool.toolId);
  const detail = {
    schema: "vtrace.stage5.m114.worktree_index_smoke.v1",
    generatedAt: new Date().toISOString(),
    noAgent: true,
    scenarios: {
      sameRootHeadMismatch: summarize(headDisabled),
      sameRootDirtyChange: summarize(dirtyDisabled),
      sameRootDirtyAutoRefresh: summarize(dirtyRefreshed),
      newLinkedWorktree: summarize(featureDisabled),
      detachedWorktree: {
        branch: detachedIdentity.snapshot.branch,
        detached: detachedIdentity.snapshot.detached,
        headCommit: detachedIdentity.snapshot.headCommit,
        worktreeId: detachedIdentity.worktree.worktreeId,
      },
      autoRefreshSuccess: summarize(headRefreshed),
      autoRefreshDisabled: summarize(headDisabled),
      featureAutoRefresh: summarize(featureRefreshed),
      lockBehavior: {
        sameWorktreeSecondOperation: lockReason,
        differentWorktreeConcurrent: otherWorktreeLock.value,
      },
      toolExposure: {
        getCodeContext: visibleTools.includes(McpToolId.GetCodeContext),
        indexRepo: visibleTools.includes(McpToolId.IndexRepo),
        checkCapsuleStaleness: visibleTools.includes(McpToolId.CheckCapsuleStaleness),
      },
    },
    freshIndexInvariants: {
      before: invariantBefore,
      after: invariantAfter,
      equal: JSON.stringify(invariantBefore) === JSON.stringify(invariantAfter),
    },
    verdict: "PASS",
  };

  assert.equal(detail.scenarios.sameRootHeadMismatch.reason, "head_mismatch");
  assert.equal(detail.scenarios.sameRootDirtyChange.reason, "working_tree_changed");
  assert.equal(detail.scenarios.newLinkedWorktree.reason, "missing_index");
  assert.equal(detail.scenarios.autoRefreshSuccess.afterReason, "fresh");
  assert.equal(detail.scenarios.lockBehavior.sameWorktreeSecondOperation, "index_in_progress");
  assert.equal(detail.freshIndexInvariants.equal, true);
  assert.equal(Object.values(detail.scenarios.toolExposure).every(Boolean), true);

  await writeFile(OUTPUT_PATH, `${JSON.stringify(detail, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(detail, null, 2)}\n`);
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}

async function context(
  server: ReturnType<typeof createMcpServer>,
  repoRoot: string,
  autoRefresh: "never" | "if_stale",
) {
  const response = await call(server, McpToolId.GetCodeContext, {
    task,
    preset: "modify",
    include_tests: true,
    max_tokens: 6_000,
    capsule_engine: "v2",
    repo_root: repoRoot,
    auto_refresh: autoRefresh,
  });
  assert.equal(response.result.ok, true);
  return response.result.output as Record<string, any>;
}

async function call(server: ReturnType<typeof createMcpServer>, toolId: string, input: Record<string, unknown>) {
  return server.handleRequest({
    schema: MCP_SERVER_SCHEMA,
    requestId: `m114-${toolId}-${createHash("sha256").update(JSON.stringify(input)).digest("hex").slice(0, 8)}`,
    toolId,
    input,
  });
}

function summarize(output: Record<string, any>) {
  const diagnostic = output.diagnostics?.indexFreshness ?? {};
  return {
    resolved: output.resolved ?? true,
    reason: output.reason ?? diagnostic.before?.reason ?? diagnostic.reason ?? null,
    refreshAttempted: diagnostic.refreshAttempted ?? false,
    refreshMode: diagnostic.refreshMode ?? null,
    afterReason: diagnostic.after?.reason ?? diagnostic.reason ?? null,
    worktreeRoot: diagnostic.worktreeRoot ?? null,
  };
}

function contextInvariant(output: Record<string, any>) {
  const capsule = output.capsuleV2 ?? {};
  const pivots = Array.isArray(capsule.pivots) ? capsule.pivots : [];
  const support = Array.isArray(capsule.support) ? capsule.support : [];
  return {
    taskHash: createHash("sha256").update(task).digest("hex"),
    selectedFiles: [...pivots, ...support].map((item) => item.path),
    leadPivot: pivots[0]?.path ?? null,
    requiredFiles: pivots.map((item) => item.path),
    optionalFiles: support.map((item) => item.path),
    capsuleMode: capsule.actualMode ?? null,
  };
}

function git(cwd: string, ...args: string[]): void {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
}
