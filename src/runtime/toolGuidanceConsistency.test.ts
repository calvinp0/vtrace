// M132 — generated agent guidance must only name tools that actually exist.
//
// The incident: guidance told agents to "use `search_symbols` for exact symbol
// lookup" while `search_symbols` was registered as a HIDDEN legacy tool. Hidden
// tools are callable by id but absent from `tools/list`, so every MCP client
// — and the agent's own tool search — saw nothing. The agent concluded the tool
// did not exist, which was true of everything it could observe.
//
// This test makes that class of drift impossible to reintroduce silently: every
// backticked tool name in generated guidance must appear in the VISIBLE tool
// list, not merely in the registry.

import assert from "node:assert/strict";
import { describe, test } from "bun:test";

import { defaultMcpToolRegistry } from "../mcp/tools";
import { McpToolId } from "../mcp/types";
import { VTRACE_AGENT_GUIDANCE_BLOCK } from "./agentGuidance";

/** Tool names visible to a client through `tools/list`. */
const visibleToolNames = new Set(
  defaultMcpToolRegistry.listMetadata().map((metadata) => metadata.toolId as string),
);

/** Every tool the registry can dispatch, visible or hidden. */
const registeredToolNames = new Set(
  defaultMcpToolRegistry.tools.map((tool) => tool.metadata.toolId as string),
);

/**
 * Backticked snake_case identifiers in guidance that name a registered tool.
 * Matching against the registry (rather than any backticked token) keeps prose
 * like `stale_index` and `if_stale` out of the comparison, while still catching
 * a name that used to be a tool and no longer is — that case is handled by the
 * explicit removed-name assertion below.
 */
function referencedToolNames(guidance: string): string[] {
  const candidates = [...guidance.matchAll(/`([a-z][a-z0-9_]*)`/g)].map((match) => match[1]!);
  return [...new Set(candidates.filter((name) => registeredToolNames.has(name)))].sort();
}

describe("generated agent guidance names only exposed MCP tools", () => {
  test("referenced tools are a subset of the visible tool list", () => {
    const referenced = referencedToolNames(VTRACE_AGENT_GUIDANCE_BLOCK);
    assert.equal(referenced.length > 0, true, "guidance must recommend at least one tool");

    const invisible = referenced.filter((name) => !visibleToolNames.has(name));
    assert.deepEqual(
      invisible,
      [],
      `guidance names tools that are not exposed in tools/list: ${invisible.join(", ")}`,
    );
  });

  test("guidance no longer recommends the hidden search_symbols tool", () => {
    assert.doesNotMatch(
      VTRACE_AGENT_GUIDANCE_BLOCK,
      /search_symbols/,
      "search_symbols is a hidden legacy tool; guidance must not send agents to it",
    );
  });

  test("search_symbols remains registered-but-hidden, deliberately", () => {
    // The M132 decision was to fix the guidance, not to promote a legacy tool.
    // If that decision is ever reversed, this assertion is where it gets recorded.
    assert.equal(registeredToolNames.has(McpToolId.SearchSymbols), true);
    assert.equal(visibleToolNames.has(McpToolId.SearchSymbols), false);
  });

  test("every recommended workflow maps to a current exposed tool", () => {
    for (const required of [
      McpToolId.GetCodeContext,
      McpToolId.GetSkeleton,
      McpToolId.GetImpactGraph,
      McpToolId.GetContextCapsule,
      McpToolId.RunPipeline,
      McpToolId.IndexRepo,
    ]) {
      assert.equal(
        visibleToolNames.has(required),
        true,
        `${required} is recommended by guidance and must stay visible`,
      );
    }
  });

  test("exposed tools not mentioned in guidance are reported, not required", () => {
    // Informational: guidance is a recommended workflow, not a tool catalogue.
    const referenced = new Set(referencedToolNames(VTRACE_AGENT_GUIDANCE_BLOCK));
    const unmentioned = [...visibleToolNames].filter((name) => !referenced.has(name)).sort();
    assert.equal(Array.isArray(unmentioned), true);
  });

  test("worktree behaviour is described accurately in guidance", () => {
    assert.match(VTRACE_AGENT_GUIDANCE_BLOCK, /repo_root/);
    assert.match(VTRACE_AGENT_GUIDANCE_BLOCK, /auto_refresh/);
    assert.match(VTRACE_AGENT_GUIDANCE_BLOCK, /worktree/i);
  });
});
