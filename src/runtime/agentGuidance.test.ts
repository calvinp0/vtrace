import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";

import {
  VTRACE_AGENT_GUIDANCE_BLOCK,
  writeVtraceAgentGuidanceBlock,
} from "./agentGuidance";

test("writeVtraceAgentGuidanceBlock creates AGENTS.md when missing", async () => {
  await withTempRepo(async (repoRoot) => {
    const result = await writeVtraceAgentGuidanceBlock(repoRoot);
    const agents = await readFile(path.join(repoRoot, "AGENTS.md"), "utf8");

    assert.equal(result.action, "created");
    assert.equal(result.path, path.join(repoRoot, "AGENTS.md"));
    assert.equal(agents, VTRACE_AGENT_GUIDANCE_BLOCK);
    assert.match(agents, /get_code_context/);
    assert.match(agents, /broad repo-understanding, debugging, refactor, and code-context tasks/);
    assert.match(agents, /before manual grep or opening many files/);
    assert.match(agents, /may refresh a stale index automatically/);
    assert.match(agents, /call `index_repo` and retry/);
    assert.match(agents, /get_impact_graph/);
    assert.match(agents, /GitNexus impact checks before editing symbols/);
  });
});

test("writeVtraceAgentGuidanceBlock updates an existing Vtrace block idempotently", async () => {
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

test("writeVtraceAgentGuidanceBlock preserves existing GitNexus block unchanged", async () => {
  await withTempRepo(async (repoRoot) => {
    const agentsPath = path.join(repoRoot, "AGENTS.md");
    const gitNexusBlock = [
      "<!-- gitnexus:start -->",
      "Use GitNexus impact checks before editing exported symbols.",
      "<!-- gitnexus:end -->",
    ].join("\n");
    await writeFile(
      agentsPath,
      [
        "# Repo Agents",
        "",
        gitNexusBlock,
        "",
      ].join("\n"),
    );

    const result = await writeVtraceAgentGuidanceBlock(repoRoot);
    const agents = await readFile(agentsPath, "utf8");

    assert.equal(result.action, "updated");
    assert.equal(agents.includes(gitNexusBlock), true);
    assert.match(agents, /<!-- vtrace:start -->/);
    assert.match(agents, /<!-- vtrace:end -->/);
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
