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

// M58 — why a target landed in the required set (or, for optional context, why it
// did NOT). Drives the bounded contract's `required because:` line so the agent can
// tell a must-decide pivot from optional blast-radius context.
export type DigestDecisionRequiredReason =
  | "lead pivot"
  | "hidden pivot"
  | "cross-file co-edit candidate"
  | "optional context only";

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
  /** M58: classification of why this target is required (or optional). */
  requiredReason?: DigestDecisionRequiredReason;
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
 * M58/M65 — bounded target selection. Same hard cap ({@link MAX_DIGEST_DECISION_TARGETS}),
 * same lead + hidden-pivot priority.
 *
 * M65 — impact representatives are NO LONGER required decision targets. The M64 audit of
 * M62C found that required impact representatives were EDITED 0/24 across the 24-task
 * validation yet produced 5 of the 8 open/ignored/invalid required targets, failing two
 * preregistered structured-decision criteria (decision coverage ≥90%, ignored-target rate
 * ≤5%). Demoting impact representatives from required to optional/FYI clears both criteria
 * in M64's simulation (coverage 88.7% → 93.6%, ignored 5.6% → 4.3%, invalid 4.2% → 0.0%),
 * harms no treatment-only win (impact reps are never load-bearing), and reduces the M57B
 * over-anchor over-edit pressure rather than adding to it.
 *
 * Selection now:
 *   - lead pivot — always required;
 *   - hidden / non-traceback co-pivot — required if the existing pivot logic surfaces one;
 *   - ALL cross-file impact representatives — OPTIONAL/FYI context only (bounded), never
 *     required, never closure-scored. They remain visible for orientation.
 * Returns required + optional sets; optional items carry `requiredReason: "optional
 * context only"` and are rendered in a non-numbered O-namespaced FYI section so the
 * required-target parser never counts them.
 */
export interface BoundedDigestDecisionSelection {
  required: DigestDecisionTarget[];
  optional: DigestDecisionTarget[];
}

const MAX_OPTIONAL_CONTEXT_ITEMS = 2;

export function selectBoundedDigestDecisionTargets(
  response: CapsuleV2ProductResponse,
  impact?: CapsuleV2DigestImpactSeam | null,
): BoundedDigestDecisionSelection {
  const pivots = Array.isArray(response.pivots) ? response.pivots : [];
  if (pivots.length === 0) return { required: [], optional: [] };

  const required: DigestDecisionTarget[] = [];
  const optional: DigestDecisionTarget[] = [];
  const seenIdentity = new Set<string>();
  const seenPath = new Set<string>();

  const pushRequired = (t: DigestDecisionTarget): boolean => {
    if (required.length >= MAX_DIGEST_DECISION_TARGETS) return false;
    if (seenIdentity.has(t.target)) return false;
    required.push(t);
    seenIdentity.add(t.target);
    seenPath.add(t.path);
    return true;
  };

  // 1. Lead pivot — always required.
  const lead = pivots[0]!;
  pushRequired({
    kind: "PIVOT",
    target: pivotTargetIdentity(lead),
    path: lead.path,
    reason: pivotReason(lead),
    hidden: pivotIsHidden(lead.roleReason),
    requiredReason: "lead pivot",
  });

  // 2. Hidden / non-traceback co-pivot, if distinct.
  const hiddenCoPivot = pivots.slice(1).find((p) => pivotIsHidden(p.roleReason));
  if (hiddenCoPivot !== undefined) {
    pushRequired({
      kind: "PIVOT",
      target: pivotTargetIdentity(hiddenCoPivot),
      path: hiddenCoPivot.path,
      reason: pivotReason(hiddenCoPivot),
      hidden: true,
      requiredReason: "hidden pivot",
    });
  }

  // 3. M65 — impact representatives: OPTIONAL/FYI context only, never required. Bounded,
  //    cross-file (a different file from every required pivot), deduped by identity.
  const representative = Array.isArray(impact?.representative) ? impact!.representative! : [];
  for (const item of representative) {
    if (optional.length >= MAX_OPTIONAL_CONTEXT_ITEMS) break;
    const identity = impactTargetIdentity(item);
    if (seenPath.has(item.path) || seenIdentity.has(identity)) continue; // cross-file + dedup
    optional.push({
      kind: "IMPACT",
      target: identity,
      path: item.path,
      reason: impactReason(item),
      requiredReason: "optional context only",
    });
    seenIdentity.add(identity);
  }

  return { required, optional };
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

/** Stable per-target id rendered in (and parsed back from) the bounded contract. */
export function digestDecisionTargetId(index: number): string {
  return `T${index + 1}`;
}

// M65 — optional/FYI impact context uses a DISTINCT id namespace (O1, O2, …) so it can
// never collide with a required `target_id` (T1, T2, …) and the closure-scoring parser
// (which only recognizes `\d+.` / `target:` required lines) never reads it as a target.
export function digestDecisionOptionalId(index: number): string {
  return `O${index + 1}`;
}

/**
 * M58/M59 — render the BOUNDED contract. M59 switches the per-target template from a
 * numbered list to an explicit FIELD GRAMMAR (`target_id` / `target` / `decision` /
 * `reason` / `files_touched`) so terse, structured decisions are both easy for the
 * agent to produce and reliable to credit post-hoc. Carries the three explicit
 * decisions (EDIT / RULE_OUT / INSPECT_ONLY_NO_EDIT), the reason-validity rules, strong
 * anti-over-edit guidance, and a separate non-numbered OPTIONAL CONTEXT list. Returns ""
 * when there are no required targets.
 */
export function renderBoundedDigestDecisionContractText(
  required: readonly DigestDecisionTarget[],
  optional: readonly DigestDecisionTarget[] = [],
): string {
  if (required.length === 0) return "";
  const lines: string[] = [DIGEST_DECISION_CONTRACT_START];
  lines.push(
    "Close EVERY required target below with exactly one decision: EDIT, RULE_OUT, or INSPECT_ONLY_NO_EDIT.",
  );
  lines.push("A required target does NOT mean a required edit.");
  lines.push("");
  lines.push("Decision meanings:");
  lines.push("- EDIT: I changed this target because it is necessary for the fix.");
  lines.push(
    "- RULE_OUT: I inspected or reasoned about this target and it does not need changes because <reason>.",
  );
  lines.push(
    "- INSPECT_ONLY_NO_EDIT: I inspected this target, confirmed it is relevant context, but the correct patch belongs elsewhere.",
  );
  lines.push("");
  lines.push("Reason rules:");
  lines.push(
    '- RULE_OUT is valid ONLY when the reason explains why preserving this target is behaviorally correct.',
  );
  lines.push('- "not needed", "irrelevant", or "false positive" ALONE is not enough.');
  lines.push("- A short structured reason IS enough if it identifies the behavior, e.g.:");
  lines.push('    "dependent caller; behavior is fixed in core method X"');
  lines.push('    "false positive; this path handles enum choices, not combinator SQL"');
  lines.push('    "wrapper only; no independent logic to patch"');
  lines.push(
    "- INSPECT_ONLY_NO_EDIT is valid when the target was inspected and relevant but the patch belongs elsewhere.",
  );
  lines.push("");
  lines.push(
    "Required target decisions (fill in decision/reason/files_touched for EACH; keep target_id and target verbatim):",
  );
  required.forEach((t, i) => {
    lines.push("");
    lines.push(`- target_id: ${digestDecisionTargetId(i)}`);
    lines.push(`  target: ${t.kind} ${t.target}`);
    if (t.requiredReason !== undefined) lines.push(`  required because: ${t.requiredReason}`);
    lines.push("  decision: EDIT | RULE_OUT | INSPECT_ONLY_NO_EDIT");
    lines.push(`  reason: ${t.reason}`);
    lines.push("  files_touched: <paths or none>");
  });
  lines.push("");
  lines.push("Anti-over-edit rules:");
  lines.push("- Required target does not mean required edit.");
  lines.push("- Prefer RULE_OUT or INSPECT_ONLY_NO_EDIT when the target is only a caller/dependent.");
  lines.push("- Do not edit impact representatives unless the issue behavior requires a co-edit.");
  lines.push("- Do not expand from an impact representative into unrelated callers.");
  lines.push("- Avoid repeated reads of the same file unless new evidence changes the hypothesis.");
  lines.push("- Stop after each required target has EDIT / RULE_OUT / INSPECT_ONLY_NO_EDIT.");
  if (optional.length > 0) {
    lines.push("");
    lines.push(
      "Optional context / FYI impact references (NOT required decision targets; NOT closure-scored; do not edit unless the fix needs it):",
    );
    optional.forEach((t, i) => {
      lines.push(
        `- ${digestDecisionOptionalId(i)}: ${t.kind} ${t.target} — optional context only: additional dependent/caller`,
      );
    });
    lines.push("These are not required decision targets and are not closure-scored.");
  }
  lines.push(DIGEST_DECISION_CONTRACT_END);
  return lines.join("\n");
}

/**
 * Build the decision contract from a product response + impact seam in one call.
 * Returns both the injectable text and the structured (required) targets (for post-hoc
 * classification without re-parsing the rendered text).
 *
 * M58: with `{ bounded: true }` the contract uses the tighter target selection +
 * three-way decision render. Default (`bounded` absent/false) is byte-identical to M57.
 */
export function buildDigestDecisionContract(
  response: CapsuleV2ProductResponse,
  impact?: CapsuleV2DigestImpactSeam | null,
  options?: { bounded?: boolean },
): { text: string; targets: DigestDecisionTarget[]; optionalTargets: DigestDecisionTarget[] } {
  if (options?.bounded === true) {
    const { required, optional } = selectBoundedDigestDecisionTargets(response, impact);
    return {
      text: renderBoundedDigestDecisionContractText(required, optional),
      targets: required,
      optionalTargets: optional,
    };
  }
  const targets = selectDigestDecisionTargets(response, impact);
  return { text: renderDigestDecisionContractText(targets), targets, optionalTargets: [] };
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
  // Two required-target renders are accepted:
  //   - M57 / M58-early numbered list: `1. PIVOT path::sym`
  //   - M59 field grammar:             `  target: PIVOT path::sym`
  // Only one form ever appears in a given block, so the union preserves order.
  const TARGET_LINE = /^\s*(?:\d+\.|target:)\s+(PIVOT|IMPACT)\s+(\S.*?)\s*$/gm;
  for (const m of block.matchAll(TARGET_LINE)) {
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
  | "INSPECT_ONLY_NO_EDIT"
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
  // M58 — three-way decision + closed/open partition.
  requiredTargetInspectOnlyNoEditCount: number;
  /** EDITED (incl. without-inspection) + RULED_OUT + INSPECT_ONLY_NO_EDIT. */
  requiredTargetClosedCount: number;
  /** IGNORED + INSPECTED_ONLY + INVALID_RULE_OUT. */
  requiredTargetOpenCount: number;
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

// M58 — an INSPECT_ONLY_NO_EDIT decision: the target is RELEVANT context but the
// correct patch belongs elsewhere (distinct from RULE_OUT, which asserts the target is
// not relevant / not needed). Matches the literal contract marker or the prose form.
const INSPECT_ONLY_NO_EDIT_PATTERN =
  /(inspect[_ ]?only[_ ]?no[_ ]?edit|(?:inspected|reviewed|read)\b[^.!?\n]*\b(?:relevant|context)\b[^.!?\n]*\b(?:no (?:edit|change)|belongs elsewhere|patch (?:is|belongs|lives) elsewhere|fix (?:is|belongs|lives) (?:in|elsewhere)|edit(?:ed)? elsewhere|elsewhere)|correct patch belongs elsewhere|relevant context[^.!?\n]*\b(?:no edit|elsewhere)|no edit (?:needed|required) here[^.!?\n]*\b(?:relevant|context|elsewhere))/i;

// A rule-out is only valid when it gives a behavioral reason — not a bare assertion.
// M59 — broadened to credit the TERSE structured-table phrases the bounded contract
// elicits (the M58B agents wrote sound rule-outs in Markdown table cells that the
// original prose-tuned vocabulary under-credited as INVALID_RULE_OUT). New terse forms:
//   - "handles <behavior>, not <issue behavior>"  (the "…not Y" contrast)
//   - "(dependent|mere|only a|just a) caller", "wrapper only"
//   - "fix/patch/edit belongs (in|elsewhere)", "delegates to <symbol>"
//   - "(already )?covered by (the )?edit in <path>", "preserve because <invariant>"
// Deliberately NOT added: bare "not needed" / "false positive" / "irrelevant" / "N/A"
// stay invalid unless paired with one of the behavioral clauses above.
const BEHAVIORAL_REASON_PATTERN =
  /(because|since|already|handle[sd]?\b[^.\n|]*\bnot\b|handled|covered by|not (affected|impacted|reached|involved|relevant|called)|unrelated|only (a|the|used)|read[- ]only|no behav\w*|delegat\w*|wrapper\b|same code path|duplicat\w*|test (file|only)|\bcaller\b|belongs (in|elsewhere)|fix belongs|preserv\w*)/i;

function targetMentioned(target: DigestDecisionTarget, sentence: string): boolean {
  const lower = sentence.toLowerCase();
  if (lower.includes(target.path.toLowerCase())) return true;
  const base = target.path.split("/").pop() ?? target.path;
  if (base.length > 0 && lower.includes(base.toLowerCase())) return true;
  const sym = target.target.includes("::") ? target.target.split("::").pop()! : "";
  if (sym.length > 2 && lower.includes(sym.toLowerCase())) return true;
  return false;
}

// M58 — returns true when the agent explicitly declared this target inspect-only /
// relevant-but-no-edit. Scanned per sentence-unit so the marker + target stay scoped
// together (mirrors ruleOutVerdict).
function inspectOnlyNoEditDeclared(target: DigestDecisionTarget, agentText: string): boolean {
  if (agentText.trim().length === 0) return false;
  const units = agentText.split(/(?<=[.!?\n])\s+/);
  for (const unit of units) {
    if (!INSPECT_ONLY_NO_EDIT_PATTERN.test(unit)) continue;
    if (targetMentioned(target, unit)) return true;
  }
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

// ---------------------------------------------------------------------------
// M59 — structured agent-decision grammar parsing
// ---------------------------------------------------------------------------

export type DigestStructuredDecisionToken = "EDIT" | "RULE_OUT" | "INSPECT_ONLY_NO_EDIT";

/** One decision the AGENT emitted (from the field grammar or a Markdown table row). */
export interface DigestStructuredAgentDecision {
  /** `T1`/`T2`… if the agent kept the target_id, else "". */
  targetId: string;
  /** The target reference the agent wrote (path / path::symbol / `KIND path::symbol`). */
  targetRef: string;
  decision: DigestStructuredDecisionToken;
  reason: string;
}

// Map a free cell/value onto a decision token. Order matters: INSPECT_ONLY_NO_EDIT
// CONTAINS the substring "EDIT", so it must be tested first. A value carrying the
// template's `EDIT | RULE_OUT | INSPECT_ONLY_NO_EDIT` placeholder (multiple options
// separated by `|`) is NOT a real decision.
function decisionTokenIn(value: string): DigestStructuredDecisionToken | null {
  if (value.includes("|")) return null; // unfilled template placeholder
  const u = value.replace(/[*`_]/g, " ").toUpperCase();
  if (/\bINSPECT\s*ONLY/.test(u)) return "INSPECT_ONLY_NO_EDIT";
  if (/\bRULE\s*D?\s*OUT\b/.test(u) || /\bRULED\s*OUT\b/.test(u)) return "RULE_OUT";
  if (/\bEDIT(?:ED)?\b/.test(u)) return "EDIT";
  return null;
}

// Strict: the cell IS exactly a decision token (used to find a Markdown table's
// decision column without mistaking a reason cell like "Direct edit site" for it).
function exactDecisionToken(cell: string): DigestStructuredDecisionToken | null {
  const norm = cell
    .replace(/[*`]/g, "")
    .replace(/[^A-Za-z]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toUpperCase();
  if (norm === "EDIT" || norm === "EDITED") return "EDIT";
  if (norm === "RULE_OUT" || norm === "RULED_OUT" || norm === "RULEOUT") return "RULE_OUT";
  if (norm === "INSPECT_ONLY_NO_EDIT" || norm === "INSPECT_ONLY") return "INSPECT_ONLY_NO_EDIT";
  return null;
}

function stripCell(s: string): string {
  return s.replace(/^[*`\s]+|[*`\s]+$/g, "").trim();
}

/**
 * Parse the decisions the AGENT emitted from its final text. Recognizes BOTH forms:
 *   1. the M59 field grammar — `target_id:` / `target:` / `decision:` / `reason:` blocks;
 *   2. a Markdown decision table — `| target | DECISION | reason |` rows.
 * Pure and conservative: a record is only emitted when a real decision token is present.
 */
export function parseStructuredAgentDecisions(agentText: string): DigestStructuredAgentDecision[] {
  const out: DigestStructuredAgentDecision[] = [];
  if (typeof agentText !== "string" || agentText.trim().length === 0) return out;

  // --- Form 1: field grammar (multi-line records). ---
  let cur: Partial<DigestStructuredAgentDecision> | null = null;
  const flush = () => {
    if (cur && cur.decision && (cur.targetRef || cur.targetId)) {
      out.push({
        targetId: cur.targetId ?? "",
        targetRef: cur.targetRef ?? "",
        decision: cur.decision,
        reason: cur.reason ?? "",
      });
    }
    cur = null;
  };
  for (const rawLine of agentText.split(/\r?\n/)) {
    const line = rawLine.trim();
    let m: RegExpMatchArray | null;
    if ((m = line.match(/^[-*]?\s*target_id:\s*(\S+)/i))) {
      if (cur && cur.decision) flush();
      cur = cur ?? {};
      cur.targetId = m[1]!.replace(/[*`]/g, "");
    } else if ((m = line.match(/^[-*]?\s*target:\s*(.+)$/i))) {
      if (cur && cur.decision) flush();
      cur = cur ?? {};
      cur.targetRef = stripCell(m[1]!);
    } else if ((m = line.match(/^[-*]?\s*decision:\s*(.+)$/i))) {
      const tok = decisionTokenIn(m[1]!);
      if (tok) {
        cur = cur ?? {};
        cur.decision = tok;
      }
    } else if ((m = line.match(/^[-*]?\s*reason:\s*(.+)$/i))) {
      if (cur) cur.reason = stripCell(m[1]!);
    }
  }
  flush();

  // --- Form 2: Markdown table rows. ---
  for (const rawLine of agentText.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line.startsWith("|") || !line.includes("|", 1)) continue;
    const cells = line
      .split("|")
      .map((c) => c.trim())
      .filter((c, i, arr) => !(i === 0 && c === "") && !(i === arr.length - 1 && c === ""));
    if (cells.length < 2) continue;
    if (cells.every((c) => /^:?-{2,}:?$/.test(c) || c === "")) continue; // separator row
    let decIdx = -1;
    let token: DigestStructuredDecisionToken | null = null;
    for (let i = 0; i < cells.length; i++) {
      const t = exactDecisionToken(cells[i]!);
      if (t) {
        decIdx = i;
        token = t;
        break;
      }
    }
    if (decIdx < 0 || token === null) continue; // header / non-decision row
    const targetRef = stripCell(cells[decIdx === 0 ? 1 : 0] ?? "");
    const reason = stripCell(cells[decIdx + 1] ?? cells[cells.length - 1] ?? "");
    if (targetRef.length === 0) continue;
    out.push({ targetId: "", targetRef, decision: token, reason });
  }

  return out;
}

// True when a RULE_OUT reason gives a behavioral justification (not a bare assertion).
function reasonIsBehavioral(reason: string): boolean {
  return reason.trim().length > 0 && BEHAVIORAL_REASON_PATTERN.test(reason);
}

// True when an INSPECT_ONLY_NO_EDIT reason explains why no edit belongs at the target.
// Looser than a rule-out (the decision already concedes relevance), but an empty /
// "N/A" / bare reason is still rejected.
function inspectReasonExplains(reason: string): boolean {
  const r = reason.trim();
  if (r.length === 0) return false;
  if (/^(n\/?a|none|todo|tbd|\?+)$/i.test(r)) return false;
  return (
    reasonIsBehavioral(r) ||
    /(elsewhere|belongs|already|relevant|context|support|handled|no (edit|change)|other (file|method|module)|core method)/i.test(
      r,
    )
  );
}

// Does a structured agent decision refer to this required target? Match on the stable
// target_id, the repo-relative path / basename, or the symbol after `::`.
function structuredDecisionMatches(
  target: DigestDecisionTarget,
  targetId: string,
  rec: DigestStructuredAgentDecision,
): boolean {
  if (rec.targetId.length > 0 && rec.targetId.toUpperCase() === targetId.toUpperCase()) return true;
  const ref = rec.targetRef.toLowerCase();
  if (ref.length === 0) return false;
  if (ref.includes(target.path.toLowerCase())) return true;
  const base = (target.path.split("/").pop() ?? target.path).toLowerCase();
  if (base.length > 0 && ref.includes(base)) return true;
  const sym = target.target.includes("::") ? target.target.split("::").pop()!.toLowerCase() : "";
  if (sym.length > 2 && ref.includes(sym)) return true;
  return false;
}

/**
 * Classify each required target's decision from the tool-call trace, the final
 * patch's edited files, and the agent's final text. Pure; no second model call.
 */
export function classifyDigestDecisionContract(
  input: DigestDecisionClassificationInput,
): DigestDecisionClassification {
  const agentText = input.agentText ?? "";
  // M59 — parse the agent's explicit structured decisions once, up front, so each
  // target can be matched against a table row / field-grammar block.
  const structured = parseStructuredAgentDecisions(agentText);
  const results: DigestDecisionTargetResult[] = input.requiredTargets.map((target, targetIndex) => {
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
      // M59 — an explicit STRUCTURED decision (field grammar / decision table) is the
      // most precise signal; prefer it over the prose scan. Only RULE_OUT and
      // INSPECT_ONLY_NO_EDIT close a non-edited target; a structured EDIT with no actual
      // edit detected is not a closure (falls through to the prose / inspected path).
      const targetId = digestDecisionTargetId(targetIndex);
      const rec = structured.find(
        (r) =>
          (r.decision === "RULE_OUT" || r.decision === "INSPECT_ONLY_NO_EDIT") &&
          structuredDecisionMatches(target, targetId, r),
      );
      if (rec !== undefined) {
        if (rec.decision === "INSPECT_ONLY_NO_EDIT") {
          decision = inspectReasonExplains(rec.reason) ? "INSPECT_ONLY_NO_EDIT" : "INVALID_RULE_OUT";
        } else {
          decision = reasonIsBehavioral(rec.reason) ? "RULED_OUT" : "INVALID_RULE_OUT";
        }
      } else if (inspectOnlyNoEditDeclared(target, agentText)) {
        // M58 — explicit prose inspect-only/relevant-but-no-edit declaration takes
        // precedence over a generic rule-out (it is the more specific decision).
        decision = "INSPECT_ONLY_NO_EDIT";
      } else {
        const verdict = ruleOutVerdict(target, agentText);
        if (verdict === "valid") decision = "RULED_OUT";
        else if (verdict === "invalid") decision = "INVALID_RULE_OUT";
        else if (inspected) decision = "INSPECTED_ONLY";
        else decision = "IGNORED";
      }
    }
    return { target, decision, inspected, edited };
  });

  const count = (d: DigestDecision) => results.filter((r) => r.decision === d).length;
  const editedCount = count("EDITED") + count("EDITED_WITHOUT_INSPECTION");
  const ruledOutCount = count("RULED_OUT");
  const inspectOnlyNoEditCount = count("INSPECT_ONLY_NO_EDIT");
  const inspectedOnlyCount = count("INSPECTED_ONLY");
  const ignoredCount = count("IGNORED");
  const invalidCount = count("INVALID_RULE_OUT");
  return {
    decisionContractPresent: input.requiredTargets.length > 0,
    requiredTargetCount: results.length,
    requiredTargets: results,
    requiredTargetInspectedCount: inspectedOnlyCount,
    requiredTargetEditedCount: editedCount,
    requiredTargetRuledOutCount: ruledOutCount,
    requiredTargetIgnoredCount: ignoredCount,
    requiredTargetInvalidDecisionCount: invalidCount,
    requiredTargetEditedWithoutInspectionCount: count("EDITED_WITHOUT_INSPECTION"),
    requiredTargetInspectOnlyNoEditCount: inspectOnlyNoEditCount,
    // closed = a real decision was reached; open = still unresolved (ignored / read
    // with no decision / a rule-out that doesn't justify itself).
    requiredTargetClosedCount: editedCount + ruledOutCount + inspectOnlyNoEditCount,
    requiredTargetOpenCount: ignoredCount + inspectedOnlyCount + invalidCount,
  };
}
