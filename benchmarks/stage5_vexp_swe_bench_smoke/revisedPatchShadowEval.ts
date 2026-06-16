// M17 — read-only SHADOW evaluation of a pivot-revision revised patch.
//
// The revision pass (`--pivot-revision-pass`) may produce a `_pivot_revision_revised.patch`
// that is NEVER wired into canonical evaluation (canonical Docker always evaluates the
// original first-pass modelPatch). This module is the PURE core that decides whether a
// revised patch is worth a separate, read-only Docker run and builds the single-row JSONL
// to hand the evaluator — a COPY of the canonical row with the model patch swapped to the
// revised patch. It never touches canonical artifacts; the orchestrator (in the runner)
// writes the copy to a distinctly-named shadow file and runs the evaluator against THAT.
//
// Keeping the decision logic here (no fs, no Docker) makes the safety contract unit-testable:
// empty/identical/missing revised patches are refused, and the eval source is provably the
// revised patch.

import { createHash } from "node:crypto";

// Distinct artifact names so shadow files never collide with — or are mistaken for —
// canonical artifacts. The shadow JSONL deliberately does NOT match `swebench-*.jsonl`
// (isCanonicalResultFile), so ingest/report never pick it up as a canonical result.
export const REVISED_SHADOW_ARTIFACT_FILES = {
  meta: "_pivot_revision_shadow_eval.meta.json",
  shadowJsonl: "_pivot_revision_shadow.jsonl",
} as const;

// Field names matching the runner's FIELD_ALIASES (kept local so this module is standalone).
const PATCH_FIELDS = ["modelPatch", "patch", "model_patch", "prediction"] as const;
const INSTANCE_FIELDS = ["instance_id", "instanceId", "instance", "id"] as const;

export function patchHash(patch: string | null): string | null {
  if (patch === null) return null;
  return createHash("sha256").update(patch).digest("hex").slice(0, 16);
}

function pickField(record: Record<string, unknown>, fields: readonly string[]): unknown {
  for (const field of fields) {
    if (record[field] !== undefined && record[field] !== null) return record[field];
  }
  return undefined;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

// A revised patch is a real, evaluable diff (not an empty/placeholder string).
function looksLikePatch(value: string): boolean {
  return value.trim().length > 0 && value.includes("diff --git");
}

export type ShadowSkipReason =
  | "no_canonical_results"
  | "no_canonical_patch"
  | "missing_revised_patch"
  | "empty_revised_patch"
  | "identical_revised_patch";

export interface ShadowPrepareReady {
  readonly status: "ready";
  readonly instanceId: string | null;
  readonly originalPatch: string;
  readonly originalPatchHash: string;
  readonly revisedPatch: string;
  readonly revisedPatchHash: string;
  // Single-row JSONL to hand the evaluator: the canonical row with the model patch
  // swapped to the revised patch and `resolved` reset so the evaluator recomputes it.
  readonly shadowJsonl: string;
}
export interface ShadowPrepareSkipped {
  readonly status: "skipped";
  readonly reason: ShadowSkipReason;
  readonly instanceId: string | null;
  readonly originalPatchHash: string | null;
  readonly revisedPatchHash: string | null;
}
export type ShadowPrepareResult = ShadowPrepareReady | ShadowPrepareSkipped;

// Decide whether a revised patch deserves a shadow eval and, if so, build the eval-source
// JSONL. PURE — no fs, no Docker. Single-instance runs (Stage 5 smoke is one instance per
// label); the first canonical row is the instance.
export function prepareRevisedShadowEval(input: {
  readonly canonicalRecords: ReadonlyArray<Record<string, unknown>>;
  readonly revisedPatch: string | null;
}): ShadowPrepareResult {
  const row = input.canonicalRecords[0];
  const revised = input.revisedPatch;
  const revisedHash = revised === null ? null : patchHash(revised);
  if (row === undefined) {
    return { status: "skipped", reason: "no_canonical_results", instanceId: null, originalPatchHash: null, revisedPatchHash: revisedHash };
  }
  const instanceRaw = pickField(row, INSTANCE_FIELDS);
  const instanceId = typeof instanceRaw === "string" ? instanceRaw : null;
  const originalRaw = pickField(row, PATCH_FIELDS);
  if (!isNonEmptyString(originalRaw)) {
    return { status: "skipped", reason: "no_canonical_patch", instanceId, originalPatchHash: null, revisedPatchHash: revisedHash };
  }
  const originalPatch = originalRaw;
  const originalHash = patchHash(originalPatch)!;
  if (revised === null) {
    return { status: "skipped", reason: "missing_revised_patch", instanceId, originalPatchHash: originalHash, revisedPatchHash: null };
  }
  if (!looksLikePatch(revised)) {
    return { status: "skipped", reason: "empty_revised_patch", instanceId, originalPatchHash: originalHash, revisedPatchHash: revisedHash };
  }
  if (revised === originalPatch || revisedHash === originalHash) {
    return { status: "skipped", reason: "identical_revised_patch", instanceId, originalPatchHash: originalHash, revisedPatchHash: revisedHash };
  }
  // Clone the canonical row, swap every present patch field to the revised patch, ensure
  // modelPatch is set, and reset resolved so the evaluator recomputes from scratch.
  const shadowRow: Record<string, unknown> = { ...row };
  for (const field of PATCH_FIELDS) {
    if (field in shadowRow) shadowRow[field] = revised;
  }
  shadowRow.modelPatch = revised;
  shadowRow.resolved = null;
  return {
    status: "ready",
    instanceId,
    originalPatch,
    originalPatchHash: originalHash,
    revisedPatch: revised,
    revisedPatchHash: revisedHash!,
    shadowJsonl: `${JSON.stringify(shadowRow)}\n`,
  };
}

export type ShadowClassification =
  | "shadow_resolution_success"
  | "shadow_preserves_resolution"
  | "shadow_no_effect"
  | "shadow_harm"
  | "shadow_skipped_empty_or_identical"
  | "shadow_inconclusive";

// Map a skip reason to a classification: a missing/empty/identical revised patch means
// there was nothing meaningful to evaluate; a missing canonical result/patch is an
// inconclusive (infra/precondition) case rather than a "no meaningful revised patch".
export function skipReasonToClassification(reason: ShadowSkipReason): ShadowClassification {
  switch (reason) {
    case "missing_revised_patch":
    case "empty_revised_patch":
    case "identical_revised_patch":
      return "shadow_skipped_empty_or_identical";
    case "no_canonical_results":
    case "no_canonical_patch":
      return "shadow_inconclusive";
  }
}

// Classify an evaluated shadow patch against the original canonical outcome.
export function classifyShadowEval(input: {
  readonly ran: boolean;
  readonly evaluationError: string | null;
  readonly originalResolved: boolean | "unknown";
  readonly revisedResolved: boolean | "unknown";
}): ShadowClassification {
  if (!input.ran || input.evaluationError !== null) return "shadow_inconclusive";
  if (input.originalResolved === "unknown" || input.revisedResolved === "unknown") return "shadow_inconclusive";
  const original = input.originalResolved;
  const revised = input.revisedResolved;
  if (!original && revised) return "shadow_resolution_success";
  if (original && revised) return "shadow_preserves_resolution";
  if (!original && !revised) return "shadow_no_effect";
  return "shadow_harm"; // original resolved, revised failed
}

// M18 — replacement/adoption guardrail.
//
// M17.1 proved that compliance improvement is NOT a safe adoption signal: sphinx r1
// and r2 both improved compliance (unclear[ast.py] → edited[ast.py]) and both had the
// legacy `replacedFinalPatch=true`, yet only r2's revised patch actually RESOLVED in a
// shadow Docker eval — r1's stayed unresolved. So this guardrail draws a hard line:
//
//   - compliance improvement ⇒ a revised patch is at most a `revisionCandidate`.
//   - adoption (`replacementRecommended`) requires a VERIFICATION outcome, and for now
//     the only accepted verification is a shadow Docker eval that either newly resolves
//     the instance or preserves an already-resolved instance without over-editing.
//   - `canonicalReplaced` stays false here: this function only recommends; it never
//     wires a patch into canonical evaluation.
//
// PURE: no fs, no Docker. Decides from a shadow classification (or its absence).

export type RevisionAdoptionEvidenceKind =
  | "shadow_eval"
  | "not_verified"
  | "skipped_empty_or_identical";

export interface RevisionAdoptionEvidence {
  readonly kind: RevisionAdoptionEvidenceKind;
  readonly originalResolved?: boolean;
  readonly revisedResolved?: boolean;
}

export interface RevisionAdoptionDecision {
  /** Compliance improved ⇒ the revised patch is a candidate (NOT yet adoptable). */
  readonly revisionCandidate: boolean;
  /** Verified safe to adopt/evaluate as the final patch (requires shadow eval). */
  readonly replacementRecommended: boolean;
  /** The single signal that decided `replacementRecommended` (telemetry/report). */
  readonly replacementReason: string;
  /** What evidence backs the decision. */
  readonly replacementEvidence: RevisionAdoptionEvidence;
  /** Whether canonical artifacts were ACTUALLY replaced. Always false here (recommend-only). */
  readonly canonicalReplaced: boolean;
}

/**
 * Decide whether a revised patch is merely a candidate or actually safe to adopt.
 *
 * `complianceImproved` is the OLD signal (M14 `decideReplacement`): it can mark a
 * candidate but, on its own, can NEVER recommend replacement. Recommendation is gated
 * on a shadow-eval classification:
 *
 *   shadow_resolution_success           → recommend (original unresolved, revised resolved)
 *   shadow_preserves_resolution         → recommend, UNLESS over-edited
 *   shadow_no_effect / shadow_harm      → reject
 *   shadow_skipped_empty_or_identical   → reject (nothing meaningful to evaluate)
 *   shadow_inconclusive                 → reject (not verified)
 *   no shadow eval (shadow === null)    → reject (not verified)
 *
 * PURE; `canonicalReplaced` is always false — this only recommends.
 */
export function decideRevisionAdoption(input: {
  readonly complianceImproved: boolean;
  readonly shadow: {
    readonly classification: ShadowClassification;
    readonly originalResolved?: boolean;
    readonly revisedResolved?: boolean;
  } | null;
  readonly overEdited?: boolean;
}): RevisionAdoptionDecision {
  const revisionCandidate = input.complianceImproved;
  const canonicalReplaced = false;

  if (input.shadow === null) {
    return {
      revisionCandidate,
      replacementRecommended: false,
      replacementReason: "no_shadow_eval",
      replacementEvidence: { kind: "not_verified" },
      canonicalReplaced,
    };
  }

  const { classification, originalResolved, revisedResolved } = input.shadow;
  const resolutions: { originalResolved?: boolean; revisedResolved?: boolean } = {};
  if (originalResolved !== undefined) resolutions.originalResolved = originalResolved;
  if (revisedResolved !== undefined) resolutions.revisedResolved = revisedResolved;

  const recommend = (reason: string): RevisionAdoptionDecision => ({
    revisionCandidate,
    replacementRecommended: true,
    replacementReason: reason,
    replacementEvidence: { kind: "shadow_eval", ...resolutions },
    canonicalReplaced,
  });
  const reject = (reason: string, kind: RevisionAdoptionEvidenceKind): RevisionAdoptionDecision => ({
    revisionCandidate,
    replacementRecommended: false,
    replacementReason: reason,
    replacementEvidence: { kind, ...resolutions },
    canonicalReplaced,
  });

  switch (classification) {
    case "shadow_resolution_success":
      return recommend("shadow_resolution_success");
    case "shadow_preserves_resolution":
      return input.overEdited === true
        ? reject("shadow_preserves_resolution_over_edit", "shadow_eval")
        : recommend("shadow_preserves_resolution");
    case "shadow_no_effect":
      return reject("shadow_no_effect", "shadow_eval");
    case "shadow_harm":
      return reject("shadow_harm", "shadow_eval");
    case "shadow_skipped_empty_or_identical":
      return reject("shadow_skipped_empty_or_identical", "skipped_empty_or_identical");
    case "shadow_inconclusive":
      return reject("shadow_inconclusive", "not_verified");
  }
}
