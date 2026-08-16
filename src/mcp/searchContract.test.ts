// M154-D. The search contract as an executable claim.
//
// These assertions are about product BEHAVIOUR, not documentation. A tool
// description and a response schema are the two things a model reads before it
// decides whether to keep looking, so wording that promises exhaustive search is a
// functional defect in exactly the way a wrong return value is: it changes what the
// caller does next. The failure being guarded against is one step long —
//
//     vtrace returned a bounded selection
//       → the agent read it as everything relevant
//       → the agent stopped searching
//       → the agent wrote a second copy of code that already existed
//
// — and every rule below cuts one of those steps.

import assert from "node:assert/strict";
import { test } from "bun:test";

import { VTRACE_AGENT_GUIDANCE_BLOCK } from "../runtime/agentGuidance";
import {
  SELECTIVE_TASK_RETRIEVAL_COVERAGE,
  type ProductContextResponse,
} from "../productContext/types";
import { createMcpToolRegistry } from "./registry";
import { RESERVED_MCP_TOOL_DEFINITIONS } from "./tools";
import { McpToolId } from "./types";

function metadataFor(toolId: McpToolId) {
  const registry = createMcpToolRegistry({ tools: [...RESERVED_MCP_TOOL_DEFINITIONS] });
  const tool = registry.getByToolId(toolId);
  assert.ok(tool !== undefined, `${toolId} must be registered`);
  return tool.metadata;
}

/** Every surface a model reads before deciding whether to keep searching. */
function agentFacingProse(): string {
  const registry = createMcpToolRegistry({ tools: [...RESERVED_MCP_TOOL_DEFINITIONS] });
  return [
    ...registry.listMetadata().map((metadata) => metadata.description),
    VTRACE_AGENT_GUIDANCE_BLOCK,
  ].join("\n");
}

test("get_code_context states that it is selective rather than exhaustive", () => {
  const description = metadataFor(McpToolId.GetCodeContext).description;
  assert.match(description, /selective/i);
  assert.match(description, /unsearched rather than absent|not.*absent/i);
});

// §42: the description must not recommend vtrace as a replacement for exhaustive
// identifier search, because it cannot perform one.
test("no agent-facing surface promises exhaustive repository search", () => {
  const prose = agentFacingProse();
  const overclaims = [
    /exhaustive (?:repository |repo )?search/i,
    /instead of grep/i,
    /\breplaces? grep\b/i,
    /every (?:symbol|match|occurrence) in the repo/i,
    /all (?:symbols|occurrences|matches) in the repository/i,
  ];
  for (const pattern of overclaims) {
    assert.ok(!pattern.test(prose), `agent-facing prose overclaims coverage: ${pattern}`);
  }
});

// §51 with a hard target of zero. The pre-M154 guidance block said "Use
// get_code_context before manual grep", and inspect-first closed every response
// with a constant instruction to avoid broad grep/find.
test("no agent-facing surface discourages further searching", () => {
  const prose = agentFacingProse();
  const antiSearch = [
    /before manual grep/i,
    /(?:avoid|do not|don't|no need to)[^.\n]{0,40}\b(?:grep|search|rg|ripgrep)\b/i,
    /\b(?:grep|search)[^.\n]{0,30}\b(?:unnecessary|not needed|redundant)\b/i,
  ];
  for (const pattern of antiSearch) {
    assert.ok(!pattern.test(prose), `unsupported anti-search advice present: ${pattern}`);
  }
});

test("the guidance block tells the reader a miss is inconclusive", () => {
  assert.match(VTRACE_AGENT_GUIDANCE_BLOCK, /unsearched, not absent/i);
  // The reuse-before-write workflow is named, because that is where a selective
  // miss turns into duplicated code rather than merely a slower search.
  assert.match(VTRACE_AGENT_GUIDANCE_BLOCK, /before writing a new helper/i);
});

// §43: one worktree, one source state. The index cannot answer about a revision
// it never indexed, and must say so rather than answering from the one it has.
test("the cross-revision boundary is stated on the tool and in the guidance", () => {
  assert.match(metadataFor(McpToolId.GetCodeContext).description, /never about another branch or revision|use Git for cross-revision/i);
  assert.match(VTRACE_AGENT_GUIDANCE_BLOCK, /Git question, not a Vtrace one/i);
});

// §15: the structural tool keeps its own job. Merging it into get_code_context
// would remove the one lane that answers a blast-radius question exactly.
test("get_impact_graph remains a distinct known-symbol structural tool", () => {
  const description = metadataFor(McpToolId.GetImpactGraph).description;
  assert.match(description, /impact/i);
  assert.match(description, /symbol/i);
  assert.ok(!/selective_task_retrieval/i.test(description));
});

test("the product response carries a coverage claim that cannot settle absence", () => {
  assert.equal(SELECTIVE_TASK_RETRIEVAL_COVERAGE.mode, "selective_task_retrieval");
  // The weakest rung of the shared workspace vocabulary, reused rather than
  // reinvented: a ranked miss says nothing about the world.
  assert.equal(SELECTIVE_TASK_RETRIEVAL_COVERAGE.absenceClaim, "not_observed");
  assert.equal(SELECTIVE_TASK_RETRIEVAL_COVERAGE.enumerationComplete, false);
});

// §39 and §88, as a type-level and value-level statement: `resolved: false` is a
// delivery fact. It is not, and must never be serialized as, an absence proof.
test("an unresolved response still claims nothing about absence", () => {
  const unresolved: Pick<ProductContextResponse, "resolved" | "resultState" | "coverage"> = {
    resolved: false,
    resultState: "no_result",
    coverage: SELECTIVE_TASK_RETRIEVAL_COVERAGE,
  };
  assert.equal(unresolved.coverage.absenceClaim, "not_observed");
  assert.equal(unresolved.coverage.enumerationComplete, false);
});

// §78: two different axes that a shared word invites collapsing. Workspace
// coverage answers "which repositories were accounted for"; retrieval coverage
// answers "what evidence came back". A complete member scan says nothing about
// whether the returned code evidence is complete.
test("workspace member coverage and retrieval coverage stay separate axes", async () => {
  const { CAPABILITY_SETTLES_MEMBER_ABSENCE, EvidenceCapability } = await import("../workspace/evidenceClaims");
  assert.equal(CAPABILITY_SETTLES_MEMBER_ABSENCE[EvidenceCapability.RankedRetrieval], false);
  // The exact lanes keep the stronger reading M147/M149 proved for them.
  assert.equal(CAPABILITY_SETTLES_MEMBER_ABSENCE[EvidenceCapability.SymbolExactLookup], true);
  assert.equal(CAPABILITY_SETTLES_MEMBER_ABSENCE[EvidenceCapability.PathMembership], true);
});
