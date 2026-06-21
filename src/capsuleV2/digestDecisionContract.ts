// M57 — Digest decision contract.
//
// Turns the already-surfaced enriched digest into an ACTION-BINDING contract: a
// bounded list of REQUIRED DIGEST TARGETS (lead pivot, the hidden/non-traceback
// co-pivot when the digest surfaces one, and up to two cross-file impact
// representatives) that the agent must each either EDIT or explicitly RULE_OUT
// before finalizing a patch. The goal is not more context — it is to make the
// agent USE the context already surfaced (M56C found surfacing works but action is
// weak).
//
// Pure: no clock, no IO, no fabrication. The targets are projected from the SAME
// typed `CapsuleV2ProductResponse` (+ impact seam) the digest is built from, so the
// contract's target identities are byte-consistent with the digest's.
//
// This module also carries the POST-HOC classifier that maps a tool-call trace +
// the final patch + the agent's final text onto a per-target decision
// (EDITED / RULED_OUT / INSPECTED_ONLY / IGNORED / EDITED_WITHOUT_INSPECTION /
// INVALID_RULE_OUT). The existing M13 `pivotInspectionCompliance` checker consumes
// pre-extracted edited/inspected file sets and operates on the M12 pivot contract,
// not on raw tool-call traces or these decision-contract targets, so it cannot make
// the ignored-vs-inspected / edited-without-inspection distinctions this milestone
// requires; the classifier here reuses M13's rule-out *concept* (a rule-out is only
// valid when it both refers to the target and gives a behavioral reason).

import type {
  CapsuleV2ProductResponse,
  CapsuleV2ProductItem,
  CapsuleV2DigestImpactSeam,
  CapsuleV2DigestImpactItem,
} from "./productAdapter";

// Exact sentinels so post-hoc validation can detect the contract unambiguously —
// NOT via generic digest glyphs (●/○/→) or `budget:` lines.
export const DIGEST_DECISION_CONTRACT_START = "<VTRACE_DIGEST_DECISION_CONTRACT_START>";
export const DIGEST_DECISION_CONTRACT_END = "<VTRACE_DIGEST_DECISION_CONTRACT_END>";

// Hard cap on required targets. Bounded to prevent the cost explosion M56C exposed:
// at most lead pivot + one hidden/co-pivot + two impact representatives.
export const MAX_DIGEST_DECISION_TARGETS = 4;
export const MAX_DIGEST_DECISION_IMPACT_TARGETS = 2;

const MAX_REASON_CHARS = 140;

export type DigestDecisionTargetKind = "PIVOT" | "IMPACT";

/** One required decision target rendered in the contract. */
export interface DigestDecisionTarget {
  kind: DigestDecisionTargetKind;
  /** Stable identity used in the contract line: fqName | path::symbol | path. */
  target: string;
  /** Repo-relative file path used for tool-call / patch matching. */
  path: string;
  /** One-sentence reason this target was surfaced (from the digest evidence). */
  reason: string;
  /** True for the lead pivot; true for the derived hidden/non-traceback co-pivot. */
  hidden?: boolean;
}

// A pivot is "hidden / non-traceback" when its decisive reason is NOT a literal
// source-line anchor in the issue. Mirrors the harness `pivotIsHidden` and
// renderHuman `isSourceAnchoredPivot` convention (role_reason text), kept here so
// the module stays self-contained.
function pivotIsHidden(roleReason: string): boolean {
  return !(roleReason ?? "").includes("source line anchor");
}

/** The stable target identity used in the digest: fqName, else `path::symbol`, else path. */
function pivotTargetIdentity(item: CapsuleV2ProductItem): string {
  if (typeof item.fqName === "string" && item.fqName.trim().length > 0) return item.fqName;
  const symbol = typeof item.symbol === "string" ? item.symbol.trim() : "";
  return symbol.length > 0 ? `${item.path}::${symbol}` : item.path;
}

function impactTargetIdentity(item: CapsuleV2DigestImpactItem): string {
  const symbol = typeof item.symbol === "string" ? item.symbol.trim() : "";
  return symbol.length > 0 ? `${item.path}::${symbol}` : item.path;
}

function oneLine(text: string): string {
  const collapsed = (text ?? "").replace(/\s+/g, " ").trim();
  return collapsed.length > MAX_REASON_CHARS ? `${collapsed.slice(0, MAX_REASON_CHARS - 1).trimEnd()}…` : collapsed;
}

function pivotReason(item: CapsuleV2ProductItem): string {
  const evidence = Array.isArray(item.evidence) && item.evidence.length > 0 ? item.evidence[0] : "";
  return oneLine(evidence || item.roleReason || "surfaced as an edit target");
}

function impactReason(item: CapsuleV2DigestImpactItem): string {
  if (typeof item.why === "string" && item.why.trim().length > 0) return oneLine(item.why);
  return oneLine(`${item.role} of a pivot — verify whether this co-edit is required`);
}

/**
 * Select the bounded required-decision target set from the product response and the
 * optional impact seam. Selection (capped at {@link MAX_DIGEST_DECISION_TARGETS}):
 *   1. lead pivot (pivots[0])
 *   2. the first non-lead pivot that is hidden/non-traceback (if the digest surfaces one)
 *   3. up to {@link MAX_DIGEST_DECISION_IMPACT_TARGETS} impact representatives that are
 *      cross-file (a different file from every already-selected target) and not a
 *      duplicate identity of an already-selected target.
 * Returns [] when there is no pivot (e.g. a no_context capsule).
 */
export function selectDigestDecisionTargets(
  response: CapsuleV2ProductResponse,
  impact?: CapsuleV2DigestImpactSeam | null,
): DigestDecisionTarget[] {
  const pivots = Array.isArray(response.pivots) ? response.pivots : [];
  if (pivots.length === 0) return [];

  const targets: DigestDecisionTarget[] = [];
  const seenIdentity = new Set<string>();
  const seenPath = new Set<string>();

  const pushTarget = (t: DigestDecisionTarget): boolean => {
    if (targets.length >= MAX_DIGEST_DECISION_TARGETS) return false;
    if (seenIdentity.has(t.target)) return false;
    targets.push(t);
    seenIdentity.add(t.target);
    seenPath.add(t.path);
    return true;
  };

  // 1. Lead pivot — always required.
  const lead = pivots[0]!;
  pushTarget({
    kind: "PIVOT",
    target: pivotTargetIdentity(lead),
    path: lead.path,
    reason: pivotReason(lead),
    hidden: pivotIsHidden(lead.roleReason),
  });

  // 2. Hidden / non-traceback co-pivot, if the digest surfaces one.
  const hiddenCoPivot = pivots.slice(1).find((p) => pivotIsHidden(p.roleReason));
  if (hiddenCoPivot !== undefined) {
    pushTarget({
      kind: "PIVOT",
      target: pivotTargetIdentity(hiddenCoPivot),
      path: hiddenCoPivot.path,
      reason: pivotReason(hiddenCoPivot),
      hidden: true,
    });
  }

  // 3. Cross-file, non-duplicate impact representatives (up to the impact cap).
  const representative = Array.isArray(impact?.representative) ? impact!.representative! : [];
  let impactAdded = 0;
  for (const item of representative) {
    if (impactAdded >= MAX_DIGEST_DECISION_IMPACT_TARGETS) break;
    if (targets.length >= MAX_DIGEST_DECISION_TARGETS) break;
    const identity = impactTargetIdentity(item);
    // cross-file relative to already-selected targets, and not an obvious duplicate.
    if (seenPath.has(item.path) || seenIdentity.has(identity)) continue;
    if (pushTarget({ kind: "IMPACT", target: identity, path: item.path, reason: impactReason(item) })) {
      impactAdded += 1;
    }
  }

  return targets;
}

/**
 * Render the sentinel-wrapped decision contract for the given required targets.
 * Returns "" when there are no targets (so the contract is simply absent).
 */
export function renderDigestDecisionContractText(targets: readonly DigestDecisionTarget[]): string {
  if (targets.length === 0) return "";
  const lines: string[] = [DIGEST_DECISION_CONTRACT_START];
  lines.push(
    "Before finalizing your patch, every REQUIRED DIGEST TARGET below must be either edited or explicitly ruled out.",
  );
  lines.push("");
  lines.push("Required targets:");
  targets.forEach((t, i) => {
    lines.push(`${i + 1}. ${t.kind} ${t.target}`);
    lines.push("   decision: EDIT | RULE_OUT");
    lines.push(`   reason: ${t.reason}`);
  });
  lines.push("");
  lines.push("Rules:");
  lines.push("- Do not ignore required targets.");
  lines.push("- A Search/Grep hit is not enough; inspect/read the file or explain why it is ruled out.");
  lines.push("- If the patch does not touch a required target, state why preserving it is correct.");
  lines.push(
    "- Prefer small edits. Do not edit non-gold/non-relevant impact rows just because they are listed.",
  );
  lines.push(DIGEST_DECISION_CONTRACT_END);
  return lines.join("\n");
}

/**
 * Build the decision contract from a product response + impact seam in one call.
 * Returns both the injectable text and the structured targets (for post-hoc
 * classification without re-parsing the rendered text).
 */
export function buildDigestDecisionContract(
  response: CapsuleV2ProductResponse,
  impact?: CapsuleV2DigestImpactSeam | null,
): { text: string; targets: DigestDecisionTarget[] } {
  const targets = selectDigestDecisionTargets(response, impact);
  return { text: renderDigestDecisionContractText(targets), targets };
}

// ---------------------------------------------------------------------------
// Post-hoc detection + classification
// ---------------------------------------------------------------------------

export interface ParsedDigestDecisionTarget {
  kind: DigestDecisionTargetKind;
  target: string;
  /** Best-effort repo-relative path (the part before `::`). */
  path: string;
}

export interface ParsedDigestDecisionContract {
  present: boolean;
  targets: ParsedDigestDecisionTarget[];
}

/**
 * Detect + parse the decision contract from an injected snapshot / context string.
 * Presence requires BOTH sentinels — generic digest glyphs never count.
 */
export function parseDigestDecisionContract(text: string): ParsedDigestDecisionContract {
  const start = text.indexOf(DIGEST_DECISION_CONTRACT_START);
  const end = text.indexOf(DIGEST_DECISION_CONTRACT_END);
  if (start < 0 || end < 0 || end < start) return { present: false, targets: [] };
  const block = text.slice(start, end);
  const targets: ParsedDigestDecisionTarget[] = [];
  for (const m of block.matchAll(/^\s*\d+\.\s+(PIVOT|IMPACT)\s+(\S.*?)\s*$/gm)) {
    const kind = m[1] as DigestDecisionTargetKind;
    const target = m[2]!.trim();
    const path = target.split("::")[0]!.trim();
    targets.push({ kind, target, path });
  }
  return { present: true, targets };
}

export type DigestDecision =
  | "EDITED"
  | "RULED_OUT"
  | "INSPECTED_ONLY"
  | "IGNORED"
  | "EDITED_WITHOUT_INSPECTION"
  | "INVALID_RULE_OUT";

/** Minimal ordered tool-call shape the classifier needs (decoupled from the harness). */
export interface DigestDecisionToolCall {
  category: string; // "read" | "search" | "edit" | "other"
  path?: string | null;
}

export interface DigestDecisionClassificationInput {
  requiredTargets: readonly DigestDecisionTarget[];
  /** Ordered tool calls (read/search/edit/...) with paths where applicable. */
  toolCalls: readonly DigestDecisionToolCall[];
  /** Repo-relative files modified by the final patch. */
  editedFiles: readonly string[];
  /** The agent's final/assistant text, scanned for rule-out justifications. */
  agentText?: string;
}

export interface DigestDecisionTargetResult {
  target: DigestDecisionTarget;
  decision: DigestDecision;
  inspected: boolean;
  edited: boolean;
}

export interface DigestDecisionClassification {
  decisionContractPresent: boolean;
  requiredTargetCount: number;
  requiredTargets: DigestDecisionTargetResult[];
  requiredTargetInspectedCount: number;
  requiredTargetEditedCount: number;
  requiredTargetRuledOutCount: number;
  requiredTargetIgnoredCount: number;
  requiredTargetInvalidDecisionCount: number;
  requiredTargetEditedWithoutInspectionCount: number;
}

// Strip a benchmark workspace prefix (`…/.bench-repos/<repo>/`) so absolute
// tool-call paths compare against repo-relative target/patch paths.
function toRepoRelative(p: string): string {
  const m = /\.bench-repos\/[^/]+\/(.+)$/.exec(p);
  return (m ? m[1]! : p).replace(/^\.\//, "");
}

function pathsMatch(a: string, b: string): boolean {
  const na = toRepoRelative(a);
  const nb = toRepoRelative(b);
  if (na === nb) return true;
  return na.endsWith(`/${nb}`) || nb.endsWith(`/${na}`);
}

const RULE_OUT_PATTERN =
  /(rule[d]?\s*out|ruled_out|rule_out|does ?n['o]t need|do(es)? not need|no (edit|change)s? (needed|required)|not (require|need)\w*\s+(a\s+|any\s+)?(edit|change|modif)|leav\w*\s+\S+\s+unchanged|preserv\w*|no change needed|safe to (leave|skip)|out of scope)/i;

// A rule-out is only valid when it gives a behavioral reason — not a bare assertion.
const BEHAVIORAL_REASON_PATTERN =
  /(because|since|already|handled|covered by|not (affected|impacted|reached|involved|relevant|called)|unrelated|only (a|the|used)|read[- ]only|no behav\w*|delegat\w*|same code path|duplicat\w*|test (file|only)|caller of)/i;

function targetMentioned(target: DigestDecisionTarget, sentence: string): boolean {
  const lower = sentence.toLowerCase();
  if (lower.includes(target.path.toLowerCase())) return true;
  const base = target.path.split("/").pop() ?? target.path;
  if (base.length > 0 && lower.includes(base.toLowerCase())) return true;
  const sym = target.target.includes("::") ? target.target.split("::").pop()! : "";
  if (sym.length > 2 && lower.includes(sym.toLowerCase())) return true;
  return false;
}

// Returns "valid" | "invalid" | null (no rule-out attempt referencing the target).
function ruleOutVerdict(target: DigestDecisionTarget, agentText: string): "valid" | "invalid" | null {
  if (agentText.trim().length === 0) return null;
  // Split into sentence-ish / line units so a rule-out + reason are scoped together.
  const units = agentText.split(/(?<=[.!?\n])\s+/);
  let invalidSeen = false;
  for (const unit of units) {
    if (!RULE_OUT_PATTERN.test(unit)) continue;
    if (!targetMentioned(target, unit)) continue;
    if (BEHAVIORAL_REASON_PATTERN.test(unit)) return "valid";
    invalidSeen = true;
  }
  return invalidSeen ? "invalid" : null;
}

/**
 * Classify each required target's decision from the tool-call trace, the final
 * patch's edited files, and the agent's final text. Pure; no second model call.
 */
export function classifyDigestDecisionContract(
  input: DigestDecisionClassificationInput,
): DigestDecisionClassification {
  const agentText = input.agentText ?? "";
  const results: DigestDecisionTargetResult[] = input.requiredTargets.map((target) => {
    // First read / first edit indices for this target (ordered trace).
    let firstReadIdx = -1;
    let firstEditIdx = -1;
    input.toolCalls.forEach((call, idx) => {
      const p = call.path;
      if (typeof p !== "string" || p.length === 0) return;
      if (!pathsMatch(p, target.path)) return;
      if (call.category === "read" && firstReadIdx < 0) firstReadIdx = idx;
      if (call.category === "edit" && firstEditIdx < 0) firstEditIdx = idx;
    });
    const editedViaPatch = input.editedFiles.some((f) => pathsMatch(f, target.path));
    const inspected = firstReadIdx >= 0;
    const edited = editedViaPatch || firstEditIdx >= 0;

    let decision: DigestDecision;
    if (edited) {
      // Inspected before edit? (a read precedes the first edit, or there is no edit
      // tool call but the file was read before being patched.)
      const inspectedBeforeEdit =
        inspected && (firstEditIdx < 0 || firstReadIdx <= firstEditIdx);
      decision = inspectedBeforeEdit ? "EDITED" : "EDITED_WITHOUT_INSPECTION";
    } else {
      const verdict = ruleOutVerdict(target, agentText);
      if (verdict === "valid") decision = "RULED_OUT";
      else if (verdict === "invalid") decision = "INVALID_RULE_OUT";
      else if (inspected) decision = "INSPECTED_ONLY";
      else decision = "IGNORED";
    }
    return { target, decision, inspected, edited };
  });

  const count = (d: DigestDecision) => results.filter((r) => r.decision === d).length;
  return {
    decisionContractPresent: input.requiredTargets.length > 0,
    requiredTargetCount: results.length,
    requiredTargets: results,
    requiredTargetInspectedCount: count("INSPECTED_ONLY"),
    requiredTargetEditedCount: count("EDITED") + count("EDITED_WITHOUT_INSPECTION"),
    requiredTargetRuledOutCount: count("RULED_OUT"),
    requiredTargetIgnoredCount: count("IGNORED"),
    requiredTargetInvalidDecisionCount: count("INVALID_RULE_OUT"),
    requiredTargetEditedWithoutInspectionCount: count("EDITED_WITHOUT_INSPECTION"),
  };
}
