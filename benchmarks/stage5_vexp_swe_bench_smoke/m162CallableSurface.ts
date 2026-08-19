/**
 * M162-A — callable VTRACE agent-surface audit (pure).
 *
 * Reads the ACTUAL product registry (`defaultMcpToolRegistry`) rather than
 * inferring a surface from filenames, and classifies every model-visible tool
 * for the M162 callable-architecture experiment.
 *
 * Two things this module deliberately measures rather than assumes:
 *
 *  - **Schema token cost.** A callable arm does NOT start at zero VTRACE
 *    tokens (§48): every exposed tool's name/description/inputSchema sits in
 *    the agent's prompt prefix on every turn, exactly like M161's injected
 *    capsule. Selecting a minimal set is therefore a token decision, not only
 *    an ergonomics one.
 *
 *  - **Hidden behavioural policy.** §8 forbids usage-priority or
 *    investigation-suppressing instructions in tool descriptions, because
 *    M162 tests repository-intelligence interaction, not prompt coercion.
 *    The scanner below looks for that class of phrasing.
 */

import {
  defaultMcpToolRegistry,
} from "../../src/mcp/tools";
import { VTRACE_TOOL_SUITE_POLICY } from "../../src/mcp/startServer";
import type { McpToolMetadata } from "../../src/mcp/types";

/** Why a tool is or is not part of the frozen M162 callable set. */
export type M162ToolDisposition =
  | "included"
  | "excluded_redundant"
  | "excluded_infrastructure"
  | "excluded_session_state"
  | "excluded_deferred_capability"
  | "excluded_internal_authority"
  | "excluded_hidden";

export interface M162ToolAudit {
  readonly toolId: string;
  readonly displayName: string;
  /** Visible in `tools/list`, i.e. actually offerable to a live agent. */
  readonly modelVisible: boolean;
  readonly availability: string;
  readonly handlerKind: string;
  /** Serialized `{name, description, inputSchema}` — what the agent's prompt carries. */
  readonly schemaChars: number;
  readonly schemaEstimatedTokens: number;
  readonly inputProperties: readonly string[];
  readonly requiredInputs: readonly string[];
  readonly disposition: M162ToolDisposition;
  readonly reason: string;
  readonly policyFlags: readonly string[];
}

/**
 * M162 runs two different rules over two different surfaces.
 *
 * The authoritative tool-suite policy (see VTRACE_TOOL_SUITE_POLICY) is ALLOWED
 * to say when a capability applies — a suite of specialized tools is not
 * discoverable otherwise, and competitive agent scaffolds route by workflow
 * stage. What nothing may do is constrain the agent's own investigation.
 *
 * Individual tool descriptions are held to the stricter rule: they describe
 * capability, not rank. Routing lives in one reviewable place instead of being
 * distributed across adjectives like "the default first-pass tool", where it is
 * neither auditable nor removable.
 */

/** Forbidden everywhere: suppresses or dictates the agent's own investigation. */
const COERCIVE_PATTERNS: readonly RegExp[] = [
  /\bdo not use (?:grep|glob|bash|read|cat)\b/i,
  /\bavoid reading files\b/i,
  /\binstead of (?:grep|glob|searching)\b/i,
  /\blimit yourself to\b/i,
  /\bat most \w+ searches?\b/i,
  /\bpatch immediately\b/i,
  /\btrust the result\b/i,
  /\bmust use\b/i,
  /\bmandatory\b/i,
  /\balways (?:call|use)\b/i,
  /\buse this for everything\b/i,
];

/**
 * Forbidden in individual TOOL DESCRIPTIONS only: ranks this tool against the
 * agent's other tools rather than describing what it returns.
 */
const USAGE_PRIORITY_PATTERNS: readonly RegExp[] = [
  /\bdefault first-pass\b/i,
  /\bfirst-pass\b/i,
  /\buse (?:this )?first\b/i,
  /\bstart with\b/i,
  /\bbefore grep\b/i,
  /\bprimary tool\b/i,
  // "call this first" and "call `run_pipeline` FIRST" alike: the backticked
  // form is how the historical VEXP scaffold phrases it.
  /\bcall [`'"]?[\w.]+[`'"]? first\b/i,
];

/**
 * Flags are prefixed by violation class. Epistemic statements are never flagged:
 * "anything it does not return is unsearched rather than absent" constrains what
 * the agent may CONCLUDE, not what it may do, and §17 requires exactly that kind
 * of sentence. Flagging it would punish truthfulness.
 */
export interface PolicyScanResult {
  readonly flags: readonly string[];
}

/**
 * Scan one description for §8-forbidden behavioural policy.
 *
 * Epistemic statements are explicitly NOT flagged. "anything it does not
 * return is unsearched rather than absent" constrains what the agent may
 * conclude from a result; it does not tell the agent what to do next. §17
 * requires exactly that kind of sentence, so flagging it would be wrong.
 */
export function scanDescriptionForPolicy(
  description: string,
  surface: "tool_description" | "suite_policy" = "tool_description",
): PolicyScanResult {
  const flags: string[] = [];

  for (const pattern of COERCIVE_PATTERNS) {
    const match = description.match(pattern);
    if (match !== null) flags.push(`coercive:${match[0].toLowerCase()}`);
  }

  if (surface === "tool_description") {
    for (const pattern of USAGE_PRIORITY_PATTERNS) {
      const match = description.match(pattern);
      if (match !== null) flags.push(`usage_priority:${match[0].toLowerCase()}`);
    }
  }

  return { flags: Object.freeze(flags) };
}

/**
 * Serialize a tool exactly as `tools/list` delivers it, so the measured cost
 * is the cost the agent actually pays rather than an internal metadata size.
 */
export function serializeListedTool(metadata: McpToolMetadata): string {
  return JSON.stringify({
    name: metadata.toolId,
    description: metadata.description,
    inputSchema: metadata.inputSchema,
  });
}

/** chars/4, the same estimator the product's own budget accounting uses. */
export function estimateTokens(chars: number): number {
  return Math.ceil(chars / 4);
}

interface DispositionRule {
  readonly disposition: M162ToolDisposition;
  readonly reason: string;
}

/**
 * The frozen M162 dispositions (§23). Each is a claim about capability, not a
 * preference — see stage5_m162_tool_selection.md for the evidence behind each.
 */
const DISPOSITIONS: Readonly<Record<string, DispositionRule>> = Object.freeze({
  get_code_context: {
    disposition: "included",
    reason:
      "The authoritative task->ranked-evidence primitive. Product-routed, wired, "
      + "bounded, and verified VALID_NONEMPTY on a known positive. No ordinary agent "
      + "tool ranks repository evidence against a task description.",
  },
  get_impact_graph: {
    disposition: "included",
    reason:
      "Distinct capability with no grep/read equivalent: resolved structural "
      + "callers/dependants for one exact indexed symbol, bounded by max_edges/max_tokens. "
      + "This is the on-demand question a static capsule cannot anticipate.",
  },
  run_pipeline: {
    disposition: "excluded_redundant",
    reason:
      "Byte-equivalent capability to get_code_context by the product's own description "
      + "('get_code_context is the agent-friendly alias for this tool'). Exposing both "
      + "costs ~850 schema tokens and forces the agent to choose between identical doors.",
  },
  get_context_capsule: {
    disposition: "excluded_redundant",
    reason:
      "A third entry point onto the same routing+capsule pipeline, with a narrower "
      + "input surface than get_code_context. Adds no capability.",
  },
  search_logic_flow: {
    disposition: "excluded_deferred_capability",
    reason:
      "Genuinely distinct and verified working, but requires TWO exact indexed FQNs, so "
      + "it is only invocable once the agent already knows both endpoints. Recorded as a "
      + "candidate for a later milestone rather than spent on ~536 schema tokens now.",
  },
  get_skeleton: {
    disposition: "excluded_deferred_capability",
    reason:
      "Substitutable by the agent's ordinary Read tool. Belongs to the compact/skeleton "
      + "context architecture direction (§94), which must not be combined with the "
      + "dynamic-timing change M162 is isolating.",
  },
  index_repo: {
    disposition: "excluded_infrastructure",
    reason:
      "Index maintenance, not repository intelligence. The harness guarantees a ready "
      + "index before each run, so exposing refresh would only let the agent spend turns "
      + "on upkeep and would confound the navigation-work metrics.",
  },
  index_status: {
    disposition: "excluded_infrastructure",
    reason: "Readiness introspection; same confound as index_repo, no task-solving capability.",
  },
  workspace_setup: {
    disposition: "excluded_infrastructure",
    reason: "Setup shell. Mutates repo-local state and has no bearing on solving a task.",
  },
  get_session_context: {
    disposition: "excluded_session_state",
    reason:
      "Returns session observation memory, not repository evidence. Cross-task exposure "
      + "would put §32 session isolation at risk for zero capability gain.",
  },
  search_memory: {
    disposition: "excluded_session_state",
    reason: "Observation memory rather than repository intelligence; same isolation risk.",
  },
  save_observation: {
    disposition: "excluded_session_state",
    reason:
      "A WRITE surface. §33 requires the evidence index stay read-only during tool use, "
      + "and a benchmark arm must not accumulate state across tasks.",
  },
  expand_vexp_ref: {
    disposition: "excluded_redundant",
    reason:
      "Expands deferred V-REF hashes emitted by run_pipeline, which is not in the set. "
      + "Without its producer it is unreachable.",
  },
  check_capsule_staleness: {
    disposition: "excluded_internal_authority",
    reason: "Internal comparison/provenance authority used by evaluators, not an agent capability.",
  },
});

export interface CallableSurfaceAudit {
  readonly visibleToolCount: number;
  readonly hiddenToolIds: readonly string[];
  readonly tools: readonly M162ToolAudit[];
  readonly includedToolIds: readonly string[];
  /** Schema cost if every visible tool were exposed — the surface M162 declines. */
  readonly fullSurfaceSchemaTokens: number;
  /** Schema cost of the frozen set — the static tax CALLABLE actually pays. */
  readonly selectedSchemaTokens: number;
  readonly policyFlaggedToolIds: readonly string[];
  /**
   * The authoritative routing policy served on `initialize`, audited as its own
   * surface and costed separately: it is real agent-facing context, so pretending
   * CALLABLE's static overhead is schema-only would understate the tax.
   */
  readonly suitePolicy: {
    readonly text: string;
    readonly chars: number;
    readonly estimatedTokens: number;
    readonly flags: readonly string[];
  };
  /** Schema tokens plus routing-policy tokens: CALLABLE's true turn-0 VTRACE cost. */
  readonly selectedStaticTokens: number;
}

/** Audit the live product registry. */
export function auditCallableSurface(): CallableSurfaceAudit {
  const visible = defaultMcpToolRegistry.listMetadata();
  const visibleIds = new Set(visible.map((tool) => tool.toolId));
  const hiddenToolIds = defaultMcpToolRegistry.tools
    .map((tool) => tool.metadata.toolId)
    .filter((toolId) => !visibleIds.has(toolId));

  const tools: M162ToolAudit[] = [];
  let fullSurfaceSchemaTokens = 0;
  let selectedSchemaTokens = 0;
  const includedToolIds: string[] = [];
  const policyFlaggedToolIds: string[] = [];

  for (const metadata of visible) {
    const schemaChars = serializeListedTool(metadata).length;
    const schemaEstimatedTokens = estimateTokens(schemaChars);
    const rule = DISPOSITIONS[metadata.toolId] ?? {
      disposition: "excluded_internal_authority" as const,
      reason: "Not classified by the M162 audit; excluded by default rather than exposed unreviewed.",
    };
    const policy = scanDescriptionForPolicy(metadata.description);

    fullSurfaceSchemaTokens += schemaEstimatedTokens;
    if (rule.disposition === "included") {
      includedToolIds.push(metadata.toolId);
      selectedSchemaTokens += schemaEstimatedTokens;
    }
    if (policy.flags.length > 0) {
      policyFlaggedToolIds.push(metadata.toolId);
    }

    tools.push({
      toolId: metadata.toolId,
      displayName: metadata.displayName,
      modelVisible: true,
      availability: metadata.registration.availability,
      handlerKind: metadata.registration.handlerKind,
      schemaChars,
      schemaEstimatedTokens,
      inputProperties: Object.freeze(Object.keys(metadata.inputSchema.properties)),
      requiredInputs: Object.freeze([...metadata.inputSchema.required]),
      disposition: rule.disposition,
      reason: rule.reason,
      policyFlags: policy.flags,
    });
  }

  const suiteFlags = scanDescriptionForPolicy(VTRACE_TOOL_SUITE_POLICY, "suite_policy").flags;
  const suitePolicyTokens = estimateTokens(VTRACE_TOOL_SUITE_POLICY.length);

  return {
    suitePolicy: {
      text: VTRACE_TOOL_SUITE_POLICY,
      chars: VTRACE_TOOL_SUITE_POLICY.length,
      estimatedTokens: suitePolicyTokens,
      flags: Object.freeze(suiteFlags),
    },
    selectedStaticTokens: selectedSchemaTokens + suitePolicyTokens,
    visibleToolCount: visible.length,
    hiddenToolIds: Object.freeze(hiddenToolIds),
    tools: Object.freeze(tools),
    includedToolIds: Object.freeze(includedToolIds),
    fullSurfaceSchemaTokens,
    selectedSchemaTokens,
    policyFlaggedToolIds: Object.freeze(policyFlaggedToolIds),
  };
}
