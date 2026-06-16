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
