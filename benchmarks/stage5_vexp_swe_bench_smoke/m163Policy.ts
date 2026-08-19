/**
 * M163-A — the frozen policy surface for the callable-tool adoption ablation.
 *
 * Pure values and predicates, so every claim about what the three arms differ by
 * is assertable offline, before any money is spent.
 *
 * M162 measured TOOL AVAILABILITY -> ADOPTION and got 0/12 with the tools
 * connected, permitted and described. M163 holds availability fixed across all
 * three arms and varies only the policy the agent is given about those tools:
 *
 *   TOOLS_ONLY            tool schemas, nothing else
 *   TOOLS_NEUTRAL_POLICY  + the frozen VTRACE_TOOL_SUITE_POLICY (M162's exact bytes)
 *   TOOLS_TASK_TRIGGER    + one required initial orientation call
 *
 * The ordering is strictly incremental: each arm is the previous arm plus one
 * named thing. If that ever stops being true the causal reading collapses, so
 * `policyDelta` computes it rather than documenting it.
 */

import { createHash } from "node:crypto";

import { VTRACE_TOOL_SUITE_POLICY } from "../../src/mcp/startServer";
import {
  buildCallableAllowedTools,
  buildVtraceMcpConfig,
  FROZEN_CALLABLE_TOOL_IDS,
  frozenCallableMcpToolNames,
  mcpToolName,
  VTRACE_MCP_SERVER_NAME,
  type VtraceMcpConfig,
} from "./m162Callable";

export type M163Arm = "tools_only" | "tools_neutral_policy" | "tools_task_trigger";

/** Frozen arm order. Index order is the incremental-policy order, not a schedule. */
export const M163_ARMS: readonly M163Arm[] = Object.freeze([
  "tools_only",
  "tools_neutral_policy",
  "tools_task_trigger",
] as const);

/** The context tool the trigger names. Derived, never a hand-typed literal. */
export const M163_CONTEXT_TOOL_ID = FROZEN_CALLABLE_TOOL_IDS[0];
export const M163_CONTEXT_TOOL_NAME = mcpToolName(M163_CONTEXT_TOOL_ID);

/**
 * The frozen Arm C task-level trigger. AUTHORITATIVE BYTES.
 *
 * Two sentences doing two different jobs, and both are load-bearing:
 *
 *  - The first mandates ORDER ("your first action ... must be a single call").
 *    Ordering is the treatment. It is also what makes compliance decidable:
 *    "ordinary repository actions before the first VTRACE call" is a count, not
 *    a judgement, which is why this wording was chosen over the softer "before
 *    beginning ordinary repository investigation".
 *
 *  - The second returns every other decision to the agent. It grants the right
 *    to IGNORE the result, which is what keeps the treatment "forced exposure"
 *    rather than "forced compliance".
 *
 * What is deliberately absent: any clause telling the agent the result is
 * trustworthy, and any clause telling it the result is suspect. M163 has to
 * MEASURE whether agents over-trust VTRACE output (false authority) and whether
 * they read omission as absence (false absence). Priming either direction would
 * make a null result on those uninterpretable.
 */
export const M163_TASK_TRIGGER_TEXT = [
  `Your first action on this task must be a single call to the ${M163_CONTEXT_TOOL_NAME} tool, using this task's description, to orient yourself.`,
  "",
  "After that one call you may use or ignore its result entirely, and you may use all normal repository tools without restriction for the rest of the task.",
].join("\n");

/** The neutral policy is the product's own, unmodified. Re-exported for hashing. */
export const M163_NEUTRAL_POLICY_TEXT = VTRACE_TOOL_SUITE_POLICY;

export function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

// ---------------------------------------------------------------------------
// Arm profiles
// ---------------------------------------------------------------------------

export interface M163ArmProfile {
  readonly arm: M163Arm;
  /** Every arm carries the identical two-tool MCP surface. Never varies. */
  readonly callableTools: readonly string[];
  /** Whether the server serves VTRACE_TOOL_SUITE_POLICY on initialize. */
  readonly serveSuitePolicy: boolean;
  /** Whether the prompt carries the task-level orientation trigger. */
  readonly taskTrigger: boolean;
}

export function armProfile(arm: M163Arm): M163ArmProfile {
  return {
    arm,
    callableTools: frozenCallableMcpToolNames(),
    serveSuitePolicy: arm !== "tools_only",
    taskTrigger: arm === "tools_task_trigger",
  };
}

/**
 * The policy text each arm actually receives, in delivery order.
 *
 * `channel` matters as much as `text`. The neutral policy arrives on the MCP
 * server's `initialize.instructions`, which is where M162 served it; the trigger
 * arrives in the task prompt, because there is no other channel that can make an
 * instruction task-level. Recording the channel keeps the parity check honest
 * about what a "prompt diff" can and cannot see.
 */
export interface M163PolicyComponent {
  readonly id: "suite_policy" | "task_trigger";
  readonly channel: "mcp_initialize_instructions" | "task_prompt";
  readonly text: string;
  readonly chars: number;
  readonly estimatedTokens: number;
  readonly sha256: string;
}

export function policyComponents(arm: M163Arm): readonly M163PolicyComponent[] {
  const profile = armProfile(arm);
  const components: M163PolicyComponent[] = [];

  if (profile.serveSuitePolicy) {
    components.push({
      id: "suite_policy",
      channel: "mcp_initialize_instructions",
      text: M163_NEUTRAL_POLICY_TEXT,
      chars: M163_NEUTRAL_POLICY_TEXT.length,
      estimatedTokens: estimateTokens(M163_NEUTRAL_POLICY_TEXT),
      sha256: sha256(M163_NEUTRAL_POLICY_TEXT),
    });
  }
  if (profile.taskTrigger) {
    components.push({
      id: "task_trigger",
      channel: "task_prompt",
      text: M163_TASK_TRIGGER_TEXT,
      chars: M163_TASK_TRIGGER_TEXT.length,
      estimatedTokens: estimateTokens(M163_TASK_TRIGGER_TEXT),
      sha256: sha256(M163_TASK_TRIGGER_TEXT),
    });
  }
  return Object.freeze(components);
}

export interface M163PolicyDelta {
  readonly from: M163Arm;
  readonly to: M163Arm;
  readonly added: readonly string[];
  readonly removed: readonly string[];
  readonly addedTokens: number;
}

/**
 * What changes between two arms. The A->B and B->C deltas must each be exactly
 * one added component and nothing removed; anything else means the incremental
 * design broke and no policy effect could be attributed.
 */
export function policyDelta(from: M163Arm, to: M163Arm): M163PolicyDelta {
  const before = new Map(policyComponents(from).map((c) => [c.id, c] as const));
  const after = new Map(policyComponents(to).map((c) => [c.id, c] as const));
  const added = [...after.keys()].filter((id) => !before.has(id));
  const removed = [...before.keys()].filter((id) => !after.has(id));
  return {
    from,
    to,
    added: Object.freeze(added),
    removed: Object.freeze(removed),
    addedTokens: added.reduce((sum, id) => sum + (after.get(id)?.estimatedTokens ?? 0), 0),
  };
}

export interface M163ParityFinding {
  readonly ok: boolean;
  readonly issues: readonly string[];
}

/**
 * Prove the three arms form a strict policy ladder over an identical tool surface.
 *
 * Tool inventory equality is checked first and separately, because §19's failure
 * mode — arm A silently losing the tools — would reproduce M162's result exactly
 * while looking like a policy finding.
 */
export function checkArmPolicyLadder(): M163ParityFinding {
  const issues: string[] = [];

  const surfaces = M163_ARMS.map((arm) => armProfile(arm).callableTools.join(","));
  if (new Set(surfaces).size !== 1) {
    issues.push(`arms do not share one tool inventory: ${surfaces.join(" | ")}`);
  }
  for (const arm of M163_ARMS) {
    const tools = armProfile(arm).callableTools;
    if (tools.length !== FROZEN_CALLABLE_TOOL_IDS.length) {
      issues.push(`${arm} exposes ${tools.length} VTRACE tools, expected ${FROZEN_CALLABLE_TOOL_IDS.length}`);
    }
  }

  if (policyComponents("tools_only").length !== 0) {
    issues.push("TOOLS_ONLY carries a policy component; it must carry tool schemas only");
  }

  const ab = policyDelta("tools_only", "tools_neutral_policy");
  if (ab.added.join(",") !== "suite_policy" || ab.removed.length !== 0) {
    issues.push(`A->B delta is +[${ab.added.join(",")}] -[${ab.removed.join(",")}], expected +[suite_policy]`);
  }

  const bc = policyDelta("tools_neutral_policy", "tools_task_trigger");
  if (bc.added.join(",") !== "task_trigger" || bc.removed.length !== 0) {
    issues.push(`B->C delta is +[${bc.added.join(",")}] -[${bc.removed.join(",")}], expected +[task_trigger]`);
  }

  // C must be a strict superset of B, not merely "one different thing".
  const bIds = policyComponents("tools_neutral_policy").map((c) => c.id);
  const cIds = new Set(policyComponents("tools_task_trigger").map((c) => c.id));
  for (const id of bIds) {
    if (!cIds.has(id)) issues.push(`TOOLS_TASK_TRIGGER dropped ${id}, so it is not B plus the trigger`);
  }

  return { ok: issues.length === 0, issues: Object.freeze(issues) };
}

// ---------------------------------------------------------------------------
// Trigger wording controls
// ---------------------------------------------------------------------------

/**
 * Forbidden in the task trigger.
 *
 * The trigger is ALLOWED to mandate one call — that is the treatment, and it is
 * the one thing M162's neutral policy could not do. What it may not do is any of
 * the three things that would turn a forced-exposure experiment into a forced-
 * compliance one, or reintroduce STAGE5_TOKEN_DISCIPLINE by the back door:
 *
 *   1. suppress the agent's ordinary investigation (search/read/grep bans, budgets)
 *   2. dictate belief in the result (trust it, follow it, patch what it names)
 *   3. mandate VTRACE use beyond the single required call
 */
const TRIGGER_FORBIDDEN_PATTERNS: readonly { readonly id: string; readonly pattern: RegExp }[] = Object.freeze([
  { id: "suppress_search", pattern: /\b(?:do not|don'?t|never|avoid)\b[^.]{0,60}\b(?:grep|search|glob|explore|rediscover)\b/i },
  { id: "suppress_read", pattern: /\b(?:do not|don'?t|never|avoid)\b[^.]{0,60}\b(?:read|open|inspect|verify)\b/i },
  { id: "search_budget", pattern: /\bat most \w+ (?:searches?|reads?|calls?|tool)\b/i },
  { id: "limit_yourself", pattern: /\blimit yourself to\b/i },
  { id: "patch_first", pattern: /\bpatch (?:first|immediately)\b/i },
  { id: "mandate_trust", pattern: /\btrust (?:the|its|this) (?:result|output|answer|evidence)\b/i },
  { id: "mandate_follow", pattern: /\b(?:follow|use) the pivot\b/i },
  { id: "mandate_patch_named", pattern: /\bpatch the file[^.]{0,30}\bnames?\b/i },
  { id: "mandate_repeat_use", pattern: /\balways (?:call|use)\b/i },
  { id: "mandate_everything", pattern: /\b(?:use (?:it|this) for everything|for all (?:lookups|questions))\b/i },
  { id: "authoritative", pattern: /\b(?:authoritative|definitive|complete answer)\b/i },
]);

/**
 * Required in the task trigger. This is the polarity M162-B/C learned the hard
 * way to include: a detector that only forbids passes a trigger that quietly
 * dropped the sentence returning autonomy to the agent, and that trigger would
 * be measuring obedience while reporting exposure.
 */
const TRIGGER_REQUIRED_PATTERNS: readonly { readonly id: string; readonly pattern: RegExp }[] = Object.freeze([
  { id: "names_context_tool", pattern: new RegExp(M163_CONTEXT_TOOL_NAME.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")) },
  { id: "single_call", pattern: /\b(?:a single call|one call|once)\b/i },
  { id: "grants_ignore", pattern: /\bignore its result\b/i },
  { id: "grants_normal_tools", pattern: /\bnormal repository tools without restriction\b/i },
]);

export interface TriggerScanResult {
  readonly ok: boolean;
  readonly forbiddenHits: readonly string[];
  readonly missingRequired: readonly string[];
}

export function scanTaskTrigger(text: string): TriggerScanResult {
  const forbiddenHits = TRIGGER_FORBIDDEN_PATTERNS
    .filter((entry) => entry.pattern.test(text))
    .map((entry) => entry.id);
  const missingRequired = TRIGGER_REQUIRED_PATTERNS
    .filter((entry) => !entry.pattern.test(text))
    .map((entry) => entry.id);
  return {
    ok: forbiddenHits.length === 0 && missingRequired.length === 0,
    forbiddenHits: Object.freeze(forbiddenHits),
    missingRequired: Object.freeze(missingRequired),
  };
}

/**
 * The historical STAGE5 scaffold wording that must appear in NO M163 surface.
 *
 * Kept as literal historical text rather than paraphrase: §16 names these
 * behaviours specifically, and the point of the check is that the actual old
 * block would fail it.
 */
export const HISTORICAL_TOKEN_DISCIPLINE_PROBES: readonly string[] = Object.freeze([
  "patch first; do not rediscover it with grep",
  "at most 2 search/grep/read calls before first edit",
  "do not run broad recursive grep after capsule names a pivot",
]);

// ---------------------------------------------------------------------------
// Per-arm live wiring
// ---------------------------------------------------------------------------

export interface M163ArmWiring {
  readonly arm: M163Arm;
  readonly mcpConfig: VtraceMcpConfig;
  readonly allowedTools: readonly string[];
  /** Env assignments the driver must apply, beyond the shared M162 pair. */
  readonly env: Readonly<Record<string, string>>;
}

export interface M163WiringInput {
  readonly arm: M163Arm;
  readonly repoRoot: string;
  readonly cliEntry: string;
  readonly runtime: string;
  /** Absolute path of the frozen trigger file. Required for the trigger arm. */
  readonly triggerFile?: string;
}

export function buildArmWiring(input: M163WiringInput): M163ArmWiring {
  const profile = armProfile(input.arm);
  const config = buildVtraceMcpConfig({
    repoRoot: input.repoRoot,
    cliEntry: input.cliEntry,
    runtime: input.runtime,
  });

  // Arm A suppresses the suite policy at the server, which is the only place it
  // is served. Appending the flag to the frozen args keeps the tool restriction
  // and repo binding byte-identical to the other two arms.
  const server = config.mcpServers[VTRACE_MCP_SERVER_NAME];
  if (server === undefined) throw new Error(`MCP config is missing the ${VTRACE_MCP_SERVER_NAME} server`);
  const args = profile.serveSuitePolicy ? server.args : [...server.args, "--no-suite-policy"];

  const env: Record<string, string> = {
    VTRACE_MCP_ALLOWED_TOOLS: frozenCallableMcpToolNames().join(","),
  };
  if (profile.taskTrigger) {
    if (input.triggerFile === undefined) {
      throw new Error("tools_task_trigger requires a triggerFile; a trigger arm without one is arm B wearing its label");
    }
    env.VTRACE_TASK_TRIGGER_FILE = input.triggerFile;
  }

  return {
    arm: input.arm,
    mcpConfig: { mcpServers: { [VTRACE_MCP_SERVER_NAME]: { command: server.command, args } } },
    allowedTools: buildCallableAllowedTools(),
    env: Object.freeze(env),
  };
}
