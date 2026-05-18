import type { RealRepoValidationReport } from "./types";

export function formatValidationReport(
  report: RealRepoValidationReport,
): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}
