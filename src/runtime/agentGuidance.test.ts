import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";

import {
  VTRACE_AGENT_GUIDANCE_BLOCK,
  VtraceGuidanceTarget,
  writeVtraceAgentGuidanceBlock,
} from "./agentGuidance";

test("writeVtraceAgentGuidanceBlock creates AGENTS.md when missing", async () => {
  await withTempRepo(async (repoRoot) => {
    const result = await writeVtraceAgentGuidanceBlock(repoRoot);
    const agents = await readFile(path.join(repoRoot, "AGENTS.md"), "utf8");

    assert.equal(result.action, "created");
    assert.equal(result.target, VtraceGuidanceTarget.AgentsMd);
    assert.equal(result.path, path.join(repoRoot, "AGENTS.md"));
    assert.equal(agents, VTRACE_AGENT_GUIDANCE_BLOCK);
    assert.match(agents, /get_code_context/);
    assert.match(agents, /broad repo-understanding, debugging, refactor, and code-context tasks/);
    // M154-D replaced "use get_code_context before manual grep" with the
    // coverage truth. Advising against a search vtrace cannot itself perform is
    // how a bounded miss becomes a duplicate implementation.
    assert.match(agents, /unsearched, not absent/);
    assert.ok(!/before manual grep/.test(agents));
    assert.match(agents, /If `get_code_context` reports `stale_index`, `missing_index`, or `repo_not_ready`, call `index_repo` and then retry `get_code_context`\./);
    // M132: `search_symbols` is a hidden legacy tool and must not be recommended.
    assert.doesNotMatch(agents, /search_symbols/);
    assert.match(agents, /get_skeleton/);
    assert.match(agents, /get_impact_graph/);
    assert.match(agents, /get_context_capsule/);
    assert.match(agents, /run_pipeline/);
  });
});

test("writeVtraceAgentGuidanceBlock creates CLAUDE.md when targeted", async () => {
  await withTempRepo(async (repoRoot) => {
    const result = await writeVtraceAgentGuidanceBlock(
      repoRoot,
      VtraceGuidanceTarget.ClaudeMd,
    );
    const claude = await readFile(path.join(repoRoot, "CLAUDE.md"), "utf8");

    assert.equal(result.action, "created");
    assert.equal(result.target, VtraceGuidanceTarget.ClaudeMd);
    assert.equal(result.path, path.join(repoRoot, "CLAUDE.md"));
    assert.equal(claude, VTRACE_AGENT_GUIDANCE_BLOCK);
    assert.match(claude, /get_code_context/);
    await assert.rejects(
      readFile(path.join(repoRoot, "AGENTS.md"), "utf8"),
      { code: "ENOENT" },
    );
  });
});

test("writeVtraceAgentGuidanceBlock does not mention GitNexus", async () => {
  await withTempRepo(async (repoRoot) => {
    await writeVtraceAgentGuidanceBlock(repoRoot);
    const agents = await readFile(path.join(repoRoot, "AGENTS.md"), "utf8");

    assert.equal(/gitnexus/i.test(agents), false);
  });
});

test("writeVtraceAgentGuidanceBlock updates an existing Vtrace block idempotently in AGENTS.md", async () => {
  await withTempRepo(async (repoRoot) => {
    const agentsPath = path.join(repoRoot, "AGENTS.md");
    await writeFile(
      agentsPath,
      [
        "# Repo Agents",
        "",
        "<!-- vtrace:start -->",
        "old vtrace guidance",
        "<!-- vtrace:end -->",
        "",
        "Keep this footer.",
        "",
      ].join("\n"),
    );

    const updated = await writeVtraceAgentGuidanceBlock(repoRoot);
    const afterUpdate = await readFile(agentsPath, "utf8");
    const unchanged = await writeVtraceAgentGuidanceBlock(repoRoot);
    const afterUnchanged = await readFile(agentsPath, "utf8");

    assert.equal(updated.action, "updated");
    assert.equal(unchanged.action, "unchanged");
    assert.equal(afterUnchanged, afterUpdate);
    assert.equal(countOccurrences(afterUpdate, "<!-- vtrace:start -->"), 1);
    assert.equal(countOccurrences(afterUpdate, "<!-- vtrace:end -->"), 1);
    assert.equal(afterUpdate.includes("old vtrace guidance"), false);
    assert.equal(afterUpdate.includes(VTRACE_AGENT_GUIDANCE_BLOCK), true);
    assert.match(afterUpdate, /Keep this footer\./);
  });
});

test("writeVtraceAgentGuidanceBlock updates an existing Vtrace block idempotently in CLAUDE.md", async () => {
  await withTempRepo(async (repoRoot) => {
    const claudePath = path.join(repoRoot, "CLAUDE.md");
    await writeFile(
      claudePath,
      [
        "# Repo Instructions for Claude",
        "",
        "Project-specific rules go here.",
        "",
        "<!-- vtrace:start -->",
        "stale vtrace content",
        "<!-- vtrace:end -->",
        "",
      ].join("\n"),
    );

    const updated = await writeVtraceAgentGuidanceBlock(
      repoRoot,
      VtraceGuidanceTarget.ClaudeMd,
    );
    const afterUpdate = await readFile(claudePath, "utf8");
    const unchanged = await writeVtraceAgentGuidanceBlock(
      repoRoot,
      VtraceGuidanceTarget.ClaudeMd,
    );
    const afterUnchanged = await readFile(claudePath, "utf8");

    assert.equal(updated.action, "updated");
    assert.equal(unchanged.action, "unchanged");
    assert.equal(afterUnchanged, afterUpdate);
    assert.equal(countOccurrences(afterUpdate, "<!-- vtrace:start -->"), 1);
    assert.equal(countOccurrences(afterUpdate, "<!-- vtrace:end -->"), 1);
    assert.equal(afterUpdate.includes("stale vtrace content"), false);
    assert.equal(afterUpdate.includes(VTRACE_AGENT_GUIDANCE_BLOCK), true);
    assert.match(afterUpdate, /Project-specific rules go here\./);
  });
});

test("writeVtraceAgentGuidanceBlock preserves an unrelated existing block unchanged", async () => {
  await withTempRepo(async (repoRoot) => {
    const claudePath = path.join(repoRoot, "CLAUDE.md");
    const unrelatedBlock = [
      "<!-- other-tool:start -->",
      "Some other tool's guidance lives here.",
      "<!-- other-tool:end -->",
    ].join("\n");
    await writeFile(
      claudePath,
      [
        "# Repo Instructions for Claude",
        "",
        unrelatedBlock,
        "",
      ].join("\n"),
    );

    const result = await writeVtraceAgentGuidanceBlock(
      repoRoot,
      VtraceGuidanceTarget.ClaudeMd,
    );
    const claude = await readFile(claudePath, "utf8");

    assert.equal(result.action, "updated");
    assert.equal(claude.includes(unrelatedBlock), true);
    assert.match(claude, /<!-- vtrace:start -->/);
    assert.match(claude, /<!-- vtrace:end -->/);
  });
});

async function withTempRepo(
  run: (repoRoot: string) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "vtrace-agent-guidance-"));
  const repoRoot = path.join(root, "repo");

  try {
    await mkdir(repoRoot, { recursive: true });
    await run(repoRoot);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function countOccurrences(
  value: string,
  needle: string,
): number {
  return value.split(needle).length - 1;
}
