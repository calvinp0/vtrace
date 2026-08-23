/**
 * M173 treatment definitions — two arms, one manipulated variable, and that
 * variable is the PRODUCT rather than the policy.
 *
 *   A  BASELINE          no VTRACE at all
 *   B  VTRACE_COMPACT    the same mandate M168's clean arm carried, against the
 *                        M172 compact default disclosure
 *
 * M168-E measured three arms and found the coercion negative and the clean
 * mandate inconclusive. M169 priced the clean arm's first call at $0.0985 to
 * displace $0.0026 of investigation and closed on NO_FURTHER_PROACTIVE_PIPELINE_
 * WORK. M172 then changed what that call hands the model — a median 621
 * model-visible tokens against 6,884, with gold file and gold symbol delivery
 * unchanged on a clean hundred-task holdout.
 *
 * So the M169 verdict is about a treatment that no longer exists, and the
 * question it answered has to be asked again of the one that does.
 *
 * WHAT IS HELD FIXED, AND WHY IT IS HELD BY IMPORT RATHER THAN BY COPY.
 *
 * The mandate text, the visible tool inventory, the normal tool whitelist and
 * the pipeline tool name are taken VERBATIM from `m168Treatment` — not restated
 * here. A copy is free to drift, and if the prose drifted then M173 would be
 * comparing a different treatment to M169's and could not speak to whether the
 * economics changed. The byte-identity is asserted in `m173Treatment.test.ts`
 * and again in the protocol freeze, so "only the product moved" is checked
 * rather than claimed.
 *
 * WHAT IS DELIBERATELY ABSENT FROM ARM B.
 *
 *   no prohibition text          M168-E: coercion went 0-for-5 where it bound
 *   no Grep/Glob denial hook     the same
 *   no anti-loop discipline      it is investigation-policy text
 *   no tool-use discipline       the same
 *   no `detail` argument         the shipped default IS the treatment (§8)
 *
 * The treatment is compact automatic orientation and nothing else.
 */

import {
  M168_ALLOWED_TOOLS,
  M168_MANDATE_TEXT,
  M168_PIPELINE_TOOL_NAME,
  M168_VISIBLE_TOOL_IDS,
  sha256,
} from "./m168Treatment";

export { sha256 };

export const M173_ARMS = Object.freeze(["baseline", "vtrace_compact"] as const);
export type M173Arm = (typeof M173_ARMS)[number];

/** Held by import. Any drift is a protocol-freeze failure, not a note. */
export const M173_PIPELINE_TOOL_NAME = M168_PIPELINE_TOOL_NAME;
export const M173_VISIBLE_TOOL_IDS = M168_VISIBLE_TOOL_IDS;
export const M173_ALLOWED_TOOLS = M168_ALLOWED_TOOLS;
export const M173_MANDATE_TEXT = M168_MANDATE_TEXT;

/**
 * The M168 clean arm's own policy hash, recorded so the freeze can prove the
 * treatment prose is the same one M169 priced. Recomputed, never transcribed.
 */
export const M168_CLEAN_POLICY_SHA256 = sha256(M168_MANDATE_TEXT);

export function claudeMdForArm(arm: M173Arm): string | null {
  return arm === "baseline" ? null : M173_MANDATE_TEXT;
}

export function mcpConfigForArm(
  arm: M173Arm,
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
          M173_VISIBLE_TOOL_IDS.join(","),
        ],
      },
    },
  };
}

export function allowedToolsForArm(arm: M173Arm): readonly string[] {
  if (arm === "baseline") return M173_ALLOWED_TOOLS;
  return [
    ...M173_ALLOWED_TOOLS,
    ...M173_VISIBLE_TOOL_IDS.map((id) => `mcp__vtrace__${id}`),
  ];
}

export interface M173ArmDefinition {
  readonly arm: M173Arm;
  readonly label: string;
  readonly vtracePresent: boolean;
  readonly mandatesPipelineFirst: boolean;
  readonly prohibitionText: false;
  readonly searchGuard: false;
  readonly antiLoopDiscipline: false;
  readonly claudeMdSha256: string | null;
  readonly visibleToolIds: readonly string[];
  /** The disclosure the agent receives from the mandated call. */
  readonly disclosure: "NONE" | "M172_COMPACT_ORIENTATION_DEFAULT";
}

export function armDefinition(arm: M173Arm): M173ArmDefinition {
  const claudeMd = claudeMdForArm(arm);
  return {
    arm,
    label: arm.toUpperCase(),
    vtracePresent: arm !== "baseline",
    mandatesPipelineFirst: arm !== "baseline",
    prohibitionText: false,
    searchGuard: false,
    antiLoopDiscipline: false,
    claudeMdSha256: claudeMd === null ? null : sha256(claudeMd),
    visibleToolIds: arm === "baseline" ? [] : M173_VISIBLE_TOOL_IDS,
    disclosure: arm === "baseline" ? "NONE" : "M172_COMPACT_ORIENTATION_DEFAULT",
  };
}

/**
 * Alternate arm order by task position so neither arm systematically owns the
 * first attempt at a freshly cloned workspace or the earlier half of the
 * execution window. Frozen before execution and never re-derived at run time.
 */
export function buildSchedule(instanceIds: readonly string[]): {
  order: number;
  instanceId: string;
  armOrder: readonly M173Arm[];
}[] {
  const rotations: readonly (readonly M173Arm[])[] = [
    ["baseline", "vtrace_compact"],
    ["vtrace_compact", "baseline"],
  ];
  return instanceIds.map((instanceId, index) => ({
    order: index + 1,
    instanceId,
    armOrder: rotations[index % rotations.length]!,
  }));
}

// ── model-facing disclosure classification ──────────────────────────

export const Disclosure = Object.freeze({
  /** `schemaVersion: run_pipeline.orientation/1` — the M172 shipped default. */
  CompactOrientation: "COMPACT_ORIENTATION",
  /** The authoritative orchestration result. Must never appear in arm B. */
  AuthoritativeDebug: "AUTHORITATIVE_DEBUG",
  /** A failure/not-ready envelope. Never projected; keeps its full shape. */
  Envelope: "NON_RESOLVED_ENVELOPE",
  /** Present but not classifiable from what was captured. */
  Unclassifiable: "UNCLASSIFIABLE",
});
export type Disclosure = (typeof Disclosure)[keyof typeof Disclosure];

export const ORIENTATION_SCHEMA_VERSION = "run_pipeline.orientation/1";

/**
 * Classify one captured `run_pipeline` tool result by what the MODEL saw.
 *
 * The rule is positive-identification-first and fails to `UNCLASSIFIABLE`
 * rather than to "compact": M167's standing rule is that an unobservable must
 * be recorded as unobservable rather than scored as an absence, and M169's
 * repeat control certified two identical errors as an identical delivery by
 * doing the opposite. A debug payload is identified by authoritative-only keys
 * so that a compact packet which happens to be long is still compact.
 */
export function classifyDisclosure(resultText: string): Disclosure {
  if (resultText.trim() === "") return Disclosure.Unclassifiable;
  if (resultText.includes(ORIENTATION_SCHEMA_VERSION)) return Disclosure.CompactOrientation;
  // Authoritative-only surfaces. `productContext` is the delegated full state;
  // `responseBudget` and `contextAccounting` are the machine diagnostics M166
  // moved behind detail=debug. Any one of them means the model saw full state.
  const authoritativeMarkers = ["\"productContext\"", "\"responseBudget\"", "\"contextAccounting\""];
  if (authoritativeMarkers.some((marker) => resultText.includes(marker))) {
    return Disclosure.AuthoritativeDebug;
  }
  if (resultText.includes("\"resolved\": false") || resultText.includes("\"reason\":")) {
    return Disclosure.Envelope;
  }
  return Disclosure.Unclassifiable;
}

/**
 * Baseline leakage, checked per run against everything the arm could carry.
 * An empty finding list is the pass; the strings are recorded so a failure
 * names what leaked rather than only that something did.
 */
export const VTRACE_LEAKAGE_MARKERS: readonly string[] = Object.freeze([
  "mcp__vtrace__",
  "run_pipeline",
  "get_impact_graph",
  "vtrace",
  ".vtrace",
]);

export function findLeakage(text: string): readonly string[] {
  const lower = text.toLowerCase();
  return Object.freeze(VTRACE_LEAKAGE_MARKERS.filter((m) => lower.includes(m.toLowerCase())));
}
