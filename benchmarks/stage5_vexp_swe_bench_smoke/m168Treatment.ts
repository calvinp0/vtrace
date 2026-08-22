/**
 * M168-E treatment definitions — three arms, one manipulated variable.
 *
 * This is NOT a reproduction of the historical VEXP 73%. That result's own
 * committed telemetry does not evidence that its treatment was active
 * (`stage5_m168_vexp_result_provenance.json`), and no paired no-VEXP baseline
 * exists inside it. What is reproduced here is the POLICY MECHANISM the public
 * VEXP benchmark code implements, driven by VTRACE as the intelligence engine.
 *
 *   A  BASELINE        no VTRACE at all
 *   B  VTRACE_STRICT   mandate + VEXP-shaped prohibition + Grep|Glob denial hook
 *   C  VTRACE_CLEAN    mandate only
 *
 * B and C share the frozen VTRACE commit, the tool inventory, the schemas, the
 * server policy and the run_pipeline output. Their only difference is the
 * coercive investigation policy. A shares the model, budgets, workspace
 * preparation and normal tool whitelist, and nothing else.
 */

import { createHash } from "node:crypto";

export const M168_ARMS = Object.freeze(["baseline", "vtrace_strict", "vtrace_clean"] as const);
export type M168Arm = (typeof M168_ARMS)[number];

export const sha256 = (text: string): string =>
  createHash("sha256").update(text, "utf8").digest("hex");

/**
 * The agent-visible tool name, verified against a live `tools/list` before
 * being written into any policy text. The MCP config key is `vtrace`, so
 * Claude Code namespaces the tool as below.
 */
export const M168_PIPELINE_TOOL_NAME = "mcp__vtrace__run_pipeline";

/**
 * Frozen identically for B and C.
 *
 * `run_pipeline` rather than `get_code_context`: M165 established they return
 * byte-identical model-visible context on 12/12 workspaces, and run_pipeline is
 * a median 613 tokens cheaper because it carries no freshness envelope. Keeping
 * `get_impact_graph` alongside it holds the surface at M164's qualified shape,
 * so the only thing that moves between M164 and this experiment is the policy.
 */
export const M168_VISIBLE_TOOL_IDS = Object.freeze([
  "run_pipeline",
  "get_impact_graph",
] as const);

/**
 * The mandate. Shared verbatim by B and C — this is the part that is NOT the
 * manipulated variable, and it is byte-identical in both arms by construction.
 */
export const M168_MANDATE_TEXT = `## Repository context

### MANDATORY: use the vtrace pipeline
For every task — bug fixes, features, refactors, debugging:
**call \`${M168_PIPELINE_TOOL_NAME}\` FIRST**. It executes context search + impact
analysis + memory recall in a single call, returning compressed results.

### Workflow
1. \`${M168_PIPELINE_TOOL_NAME}("your task")\` — ALWAYS FIRST
2. Make targeted changes based on the context returned
3. Only call \`${M168_PIPELINE_TOOL_NAME}\` again if you need more context during
   implementation
`;

/**
 * The manipulated variable: VEXP's prohibition, semantically reproduced.
 *
 * VEXP's published bytes name five things — grep, glob, Bash, Read, cat — while
 * its hook enforces two. Both halves of that are preserved deliberately. The
 * over-broad prose IS the published treatment, and narrowing it here to match
 * the hook would be testing a policy VEXP never shipped. The gap between stated
 * and enforced is recorded in `M168_POLICY_ENFORCEMENT`, not edited away.
 */
export const M168_PROHIBITION_TEXT = `
Do NOT use grep, glob, Bash, Read, or cat to search/explore the codebase.
vtrace returns pre-indexed, graph-ranked context that is more relevant and
uses fewer tokens than manual searching.
`;

export function claudeMdForArm(arm: M168Arm): string | null {
  if (arm === "baseline") return null;
  if (arm === "vtrace_clean") return M168_MANDATE_TEXT;
  // vtrace_strict: mandate with the prohibition spliced in where VEXP puts it —
  // after the mandate paragraph, before the workflow.
  const [head, tail] = M168_MANDATE_TEXT.split("\n### Workflow");
  return `${head}${M168_PROHIBITION_TEXT}\n### Workflow${tail}`;
}

/**
 * The guard, reproducing the published script's structure and its condition.
 *
 * VEXP denies only while its engine is provably live — `.vexp/daemon.sock` AND
 * `.vexp/healthy` — and exits 0 otherwise, so an engine that failed to start
 * silently converts the strict arm into an unguarded one.
 *
 * VTRACE has no daemon: its MCP server is stdio-spawned per run by the agent
 * itself, so "the server process is up" is guaranteed by the MCP config and is
 * not a condition anything could observe from a hook. What remains observable,
 * and what `.vexp/healthy` actually stands for, is that this workspace has an
 * index for the engine to answer from: `.vtrace/index.sqlite`.
 *
 * The failure mode is preserved on purpose. No index, no denial — exactly as
 * VEXP's guard does not fire when its own engine artifacts are missing. A
 * strict arm that silently degrades into an unguarded one is a real property of
 * the published policy, and the telemetry records which happened per run rather
 * than assuming the guard was live.
 *
 * The denial reason goes to STDOUT and the process exits 2, which is what the
 * published script does. Whether a Claude Code PreToolUse hook surfaces stdout
 * to the model on exit 2 is recorded as UNKNOWN and measured in the smoke; it
 * is not "fixed" here, because that would be a different policy.
 */
export function guardScript(repoPath: string, eventLogPath: string): string {
  return `#!/usr/bin/env bash
# M168 arm B — VEXP-shaped Grep/Glob denial. Conditional on engine readiness.
INDEX="${repoPath}/.vtrace/index.sqlite"
EVENTS="${eventLogPath}"
mkdir -p "$(dirname "$EVENTS")" 2>/dev/null
if [ -f "$INDEX" ]; then
  printf '{"ts":"%s","decision":"deny","indexPresent":true}\\n' "$(date -Iseconds)" >> "$EVENTS"
  echo "DENY: Use ${M168_PIPELINE_TOOL_NAME} instead of Grep/Glob. vtrace index is ready."
  exit 2
fi
printf '{"ts":"%s","decision":"allow","indexPresent":false}\\n' "$(date -Iseconds)" >> "$EVENTS"
exit 0
`;
}

export function settingsJsonForArm(
  arm: M168Arm,
  hookPath: string,
): { hooks: { PreToolUse: unknown[] } } | null {
  if (arm !== "vtrace_strict") return null;
  return {
    hooks: {
      PreToolUse: [
        {
          matcher: "Grep|Glob",
          hooks: [{ type: "command", command: hookPath }],
        },
      ],
    },
  };
}

export function mcpConfigForArm(
  arm: M168Arm,
  repoPath: string,
  vtraceCliEntry: string,
): { mcpServers: Record<string, unknown> } {
  if (arm === "baseline") return { mcpServers: {} };
  return {
    mcpServers: {
      vtrace: {
        command: "bun",
        args: [
          vtraceCliEntry,
          "mcp-serve",
          "--repo",
          repoPath,
          "--tools",
          M168_VISIBLE_TOOL_IDS.join(","),
        ],
      },
    },
  };
}

/** Normal tools, identical in all three arms. Matches the public harness's list. */
export const M168_ALLOWED_TOOLS = Object.freeze([
  "Edit", "Write", "Bash", "Read", "Glob", "Grep", "TodoWrite",
] as const);

export function allowedToolsForArm(arm: M168Arm): readonly string[] {
  if (arm === "baseline") return M168_ALLOWED_TOOLS;
  return [
    ...M168_ALLOWED_TOOLS,
    ...M168_VISIBLE_TOOL_IDS.map((id) => `mcp__vtrace__${id}`),
  ];
}

/**
 * Stated policy and mechanically enforced policy, held apart on purpose.
 * Nothing in the experiment may read one as evidence of the other.
 */
export const M168_POLICY_ENFORCEMENT = Object.freeze({
  baseline: {
    statedBlocked: [] as readonly string[],
    hookBlocks: [] as readonly string[],
    hookMatcher: null,
    conditional: null,
  },
  vtrace_clean: {
    statedBlocked: [] as readonly string[],
    hookBlocks: [] as readonly string[],
    hookMatcher: null,
    conditional: null,
  },
  vtrace_strict: {
    statedBlocked: ["grep", "glob", "Bash", "Read", "cat"] as readonly string[],
    hookBlocks: ["Grep", "Glob"] as readonly string[],
    hookMatcher: "Grep|Glob",
    conditional: "index-ready marker present",
    unenforcedStatedBlocks: ["Bash", "Read", "cat"] as readonly string[],
    denialReasonStream: "stdout",
    denialReasonReachesModel: "UNKNOWN — measured in the smoke, not assumed",
  },
} as const);

export interface ArmDefinition {
  readonly arm: M168Arm;
  readonly label: string;
  readonly vtracePresent: boolean;
  readonly mandatesPipelineFirst: boolean;
  readonly prohibitionText: boolean;
  readonly searchGuard: boolean;
  readonly claudeMdSha256: string | null;
  readonly visibleToolIds: readonly string[];
}

export function armDefinition(arm: M168Arm): ArmDefinition {
  const claudeMd = claudeMdForArm(arm);
  return {
    arm,
    label: arm.toUpperCase(),
    vtracePresent: arm !== "baseline",
    mandatesPipelineFirst: arm !== "baseline",
    prohibitionText: arm === "vtrace_strict",
    searchGuard: arm === "vtrace_strict",
    claudeMdSha256: claudeMd === null ? null : sha256(claudeMd),
    visibleToolIds: arm === "baseline" ? [] : M168_VISIBLE_TOOL_IDS,
  };
}

/**
 * Alternate arm order by task position so no arm systematically owns the first
 * attempt at a freshly cloned workspace or the earlier half of the window.
 */
export function buildSchedule(instanceIds: readonly string[]): {
  order: number;
  instanceId: string;
  armOrder: readonly M168Arm[];
}[] {
  const rotations: readonly (readonly M168Arm[])[] = [
    ["baseline", "vtrace_strict", "vtrace_clean"],
    ["vtrace_clean", "baseline", "vtrace_strict"],
    ["vtrace_strict", "vtrace_clean", "baseline"],
  ];
  return instanceIds.map((instanceId, index) => ({
    order: index + 1,
    instanceId,
    armOrder: rotations[index % rotations.length]!,
  }));
}
