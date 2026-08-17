/**
 * M156 §45: consumers must not read "index succeeded" as "every file indexed".
 *
 * Containing the failure inside the indexer is not enough. If `get_code_context`
 * or the capsule refuse a degraded index — or serve it while implying complete
 * coverage — the availability failure has only moved one layer up, and the
 * repository is still effectively unavailable to the agent.
 *
 * So these tests exercise the product tools against a repository holding a file
 * that cannot be parsed, and assert two things at once: the tools WORK, and the
 * degradation is VISIBLE.
 */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";

import { initRepo } from "../setup/initRepo";
import { createMcpServer } from "./server";
import { MCP_SERVER_SCHEMA, McpToolId } from "./types";

const BROKEN_PYTHON = "def broken(:\n    return 1\n";
const QUERY = "modify createSession in SessionManager to accept a label";

async function withDegradedRepo(run: (repoRoot: string) => Promise<void>): Promise<void> {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), "vtrace-m156-consumers-"));
  try {
    await mkdir(path.join(repoRoot, "src"), { recursive: true });
    await writeFile(
      path.join(repoRoot, "src", "session.ts"),
      [
        "export type Session = string;",
        "",
        "export class SessionManager {",
        "  createSession(accountId: string): Session {",
        "    return accountId;",
        "  }",
        "}",
        "",
      ].join("\n"),
    );
    // The offending file, in a language whose parser emits symbols, so it is a
    // genuinely relevant coverage gap rather than a document-only one.
    await writeFile(path.join(repoRoot, "src", "fixture_bad.py"), BROKEN_PYTHON);
    await run(repoRoot);
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
}

test("M156: a repository with an unparseable file initialises and reports degraded coverage", async () => {
  await withDegradedRepo(async (repoRoot) => {
    // `initRepo` is the first thing that used to fail outright — the abort that
    // made the whole repository unavailable in M155.
    const initialized = await initRepo({ repoPath: repoRoot });

    assert.equal(initialized.indexResult.coverage.complete, false);
    assert.equal(initialized.indexResult.coverage.filesFailed, 1);
    assert.equal(initialized.indexResult.coverage.failedLanguages.join(), "python");
    // The good file is indexed, which is the whole point.
    assert.equal(initialized.indexResult.coverage.filesIndexed >= 1, true);
  });
});

test("M156: index_status exposes degradation on a usable index", async () => {
  await withDegradedRepo(async (repoRoot) => {
    const initialized = await initRepo({ repoPath: repoRoot });
    const server = createMcpServer({ context: { repoRoot: initialized.repoRoot } });

    const response = await server.handleRequest({
      schema: MCP_SERVER_SCHEMA,
      requestId: "m156-status",
      toolId: McpToolId.IndexStatus,
      input: {},
    });

    assert.equal(response.result.ok, true);
    const readiness = response.result.output.indexReadiness;
    // §43: usable AND incomplete, said in one place, without reading logs.
    assert.equal(readiness.ready, true);
    assert.equal(readiness.coverageComplete, false);
    assert.equal(readiness.failedFiles, 1);
  });
});

test("M156: get_code_context serves a degraded index normally", async () => {
  await withDegradedRepo(async (repoRoot) => {
    const initialized = await initRepo({ repoPath: repoRoot });
    const server = createMcpServer({ context: { repoRoot: initialized.repoRoot } });

    const response = await server.handleRequest({
      schema: MCP_SERVER_SCHEMA,
      requestId: "m156-code-context",
      toolId: McpToolId.GetCodeContext,
      input: { query: QUERY },
    });

    // §24/§26: the failed Python fixture is irrelevant to a TypeScript question,
    // and must not stop retrieval from answering it.
    assert.equal(response.result.ok, true);
  });
});

test("M156: run_pipeline and get_context_capsule work on a degraded index", async () => {
  await withDegradedRepo(async (repoRoot) => {
    const initialized = await initRepo({ repoPath: repoRoot });
    const server = createMcpServer({ context: { repoRoot: initialized.repoRoot } });

    const pipeline = await server.handleRequest({
      schema: MCP_SERVER_SCHEMA,
      requestId: "m156-pipeline",
      toolId: McpToolId.RunPipeline,
      input: { query: QUERY },
    });
    assert.equal(pipeline.result.ok, true);

    const capsule = await server.handleRequest({
      schema: MCP_SERVER_SCHEMA,
      requestId: "m156-capsule",
      toolId: McpToolId.GetContextCapsule,
      input: { query: QUERY },
    });
    assert.equal(capsule.result.ok, true);
  });
});

test("M156: a clean repository still reports complete coverage through the same surfaces", async () => {
  // The negative control. Without it, a bug that marked EVERY index degraded
  // would pass every test above.
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), "vtrace-m156-clean-"));
  try {
    await mkdir(path.join(repoRoot, "src"), { recursive: true });
    await writeFile(path.join(repoRoot, "src", "session.ts"), "export class SessionManager {}\n");
    const initialized = await initRepo({ repoPath: repoRoot });
    const server = createMcpServer({ context: { repoRoot: initialized.repoRoot } });

    assert.equal(initialized.indexResult.coverage.complete, true);

    const response = await server.handleRequest({
      schema: MCP_SERVER_SCHEMA,
      requestId: "m156-clean-status",
      toolId: McpToolId.IndexStatus,
      input: {},
    });
    assert.equal(response.result.output.indexReadiness.coverageComplete, true);
    assert.equal(response.result.output.indexReadiness.failedFiles, 0);
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
});
