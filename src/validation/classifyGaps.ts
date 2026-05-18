import {
  type ClassifiedValidationGap,
  type ValidationFinding,
  ValidationGapCategory,
} from "./types";

export function classifyGap(finding: ValidationFinding): ClassifiedValidationGap {
  const category = resolveGapCategory(finding.code);

  return {
    category,
    findingCode: finding.code,
    severity: finding.severity,
    summary: finding.summary,
    ...(finding.query === undefined ? {} : { query: finding.query }),
    rationale: gapRationale(category, finding.code),
    ...(finding.details === undefined ? {} : { details: finding.details }),
  };
}

export function classifyGaps(
  findings: readonly ValidationFinding[],
): ClassifiedValidationGap[] {
  return [...findings]
    .map(classifyGap)
    .sort(compareClassifiedGaps);
}

function resolveGapCategory(code: string): ValidationGapCategory {
  switch (code) {
    case "indexing.parse_failures_detected":
    case "indexing.no_files_indexed":
    case "indexing.no_symbols_indexed":
    case "indexing.cython_files_without_symbols":
    case "controlled_change.no_symbol_diffs_detected":
    case "controlled_change.file_not_modified_in_diff":
      return ValidationGapCategory.ParserFrontendGap;
    case "retrieval.query_returned_no_candidates":
    case "retrieval.exact_query_expected_surface_missing":
    case "retrieval.no_cython_boundary_candidates":
    case "retrieval.boundary_query_missing_cython_candidate":
    case "retrieval.boundary_query_regressed_vs_baseline":
    case "retrieval.broad_query_regressed_vs_baseline":
    case "retrieval.exact_query_regressed_vs_broad_baseline":
    case "retrieval.narrow_query_regressed_vs_baseline":
    case "retrieval.broad_query_test_candidate_outranks_non_test":
    case "retrieval.broad_query_test_misranking_regressed_vs_baseline":
      return ValidationGapCategory.RetrievalRerankingGap;
    case "capsule.empty_capsule_with_candidates":
    case "capsule.no_source_backed_pivots":
      return ValidationGapCategory.CapsuleShapingGap;
    case "limitation.controlled_change_skipped":
    case "limitation.boundary_query_without_cython_hit":
    case "limitation.parse_failures_completed_conservatively":
      return ValidationGapCategory.AcceptedLimitation;
    default:
      if (code.startsWith("indexing.")) {
        return ValidationGapCategory.ParserFrontendGap;
      }

      if (code.startsWith("retrieval.") || code.startsWith("reranking.")) {
        return ValidationGapCategory.RetrievalRerankingGap;
      }

      if (code.startsWith("capsule.") || code.startsWith("handoff.")) {
        return ValidationGapCategory.CapsuleShapingGap;
      }

      return ValidationGapCategory.AcceptedLimitation;
  }
}

function gapRationale(
  category: ValidationGapCategory,
  code: string,
): string {
  switch (category) {
    case ValidationGapCategory.ParserFrontendGap:
      return `Finding ${code} points to missing or weak structural extraction, indexing, or diff visibility.`;
    case ValidationGapCategory.RetrievalRerankingGap:
      return `Finding ${code} points to relevant indexed structure not surfacing strongly enough in retrieval or reranking.`;
    case ValidationGapCategory.CapsuleShapingGap:
      return `Finding ${code} points to weak packaging of already-retrieved candidates into capsule or handoff output.`;
    case ValidationGapCategory.AcceptedLimitation:
      return `Finding ${code} matches a conservative behavior that is currently documented and explainable for RC1.`;
  }
}

function compareClassifiedGaps(
  left: ClassifiedValidationGap,
  right: ClassifiedValidationGap,
): number {
  return left.category.localeCompare(right.category)
    || severityRank(left.severity) - severityRank(right.severity)
    || left.findingCode.localeCompare(right.findingCode)
    || (left.query ?? "").localeCompare(right.query ?? "");
}

function severityRank(severity: ClassifiedValidationGap["severity"]): number {
  switch (severity) {
    case "error":
      return 0;
    case "warning":
      return 1;
    case "info":
      return 2;
  }
}
