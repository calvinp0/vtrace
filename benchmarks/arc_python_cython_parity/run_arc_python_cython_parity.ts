/**
 * ARC Python/Cython parity validation runner.
 *
 * Invokes the real-repo validation harness (`runRealRepoValidation`) against a
 * Python/Cython-heavy target repository (ARC by default), then writes a
 * deterministic JSON report plus a human-readable markdown summary.
 *
 * This runner is intentionally NOT a `*.test.ts` file: it requires a real
 * checkout of the target repo, so it runs explicitly (`bun run`), not as part
 * of `bun test`. The pure rendering helpers are unit-tested separately in
 * `run_arc_python_cython_parity.test.ts`.
 *
 * Usage:
 *   bun run benchmarks/arc_python_cython_parity/run_arc_python_cython_parity.ts [repoRoot]
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { formatValidationReport } from "../../src/validation/formatReport";
import { runRealRepoValidation } from "../../src/validation/runRealRepoValidation";
import type {
  LogicFlowProbeDefinition,
  RealRepoValidationReport,
} from "../../src/validation/types";

const HERE = path.dirname(fileURLToPath(import.meta.url));

export const DEFAULT_ARC_REPO_ROOT = "/home/calvin/code/ARC";

export const ARC_QUERIES_FILE_PATH = path.join(HERE, "queries.md");

/** Local names probed for surfacing via interesting-symbol surface review. */
export const ARC_INTERESTING_SYMBOLS: readonly string[] = [
  "ARCSpecies",
  "Graph",
  "VF2",
  "kekulize",
  "is_isomorphic",
  "as_dict",
];

export const ARC_INTERESTING_FILES: readonly string[] = [
  "arc/molecule/graph.pyx",
  "arc/molecule/kekulize.pyx",
  "arc/parser/adapter.py",
  "arc/species/species.py",
];

/** Fully-qualified symbols probed through the impact graph ("who calls X"). */
export const ARC_IMPACT_PROBE_SYMBOLS: readonly string[] = [
  // Cython kernels and classes.
  "arc/molecule/kekulize.pyx::kekulize",
  "arc/molecule/graph.pyx::Graph.get_all_edges",
  "arc/molecule/graph.pyx::Graph.is_isomorphic",
  "arc/molecule/vf2.pyx::VF2",
  // Python production classes.
  "arc/species/species.py::ARCSpecies",
  "arc/main.py::ARC",
];

/** Start/end pairs probed through logic-flow search ("flow from X to Y"). */
export const ARC_LOGIC_FLOW_PROBES: readonly LogicFlowProbeDefinition[] = [
  // Reachable Cython call flow — exercises call-edge traversal.
  {
    start: "arc/molecule/vf2.pyx::VF2.find_isomorphism",
    end: "arc/molecule/vf2.pyx::VF2.match",
  },
  // Reachable Cython call flow (single hop).
  {
    start: "arc/molecule/vf2.pyx::VF2.find_isomorphism",
    end: "arc/molecule/vf2.pyx::VF2.isomorphism",
  },
  // Python wrapper -> Cython kernel. `molecule.py` does
  // `from arc.molecule.kekulize import kekulize` and calls `kekulize(self)`;
  // cross-parser resolution now resolves that import against the indexed Cython
  // symbols, so this flow is reachable via a Python -> Cython call edge.
  {
    start: "arc/molecule/molecule.py::Molecule.kekulize",
    end: "arc/molecule/kekulize.pyx::kekulize",
  },
];

export interface ArcParityRunOptions {
  readonly repoRoot: string;
  readonly outputDirectory: string;
}

export async function runArcParityValidation(
  options: ArcParityRunOptions,
): Promise<RealRepoValidationReport> {
  const report = await runRealRepoValidation({
    repoRoot: options.repoRoot,
    queriesFilePath: ARC_QUERIES_FILE_PATH,
    interestingSymbols: ARC_INTERESTING_SYMBOLS,
    interestingFiles: ARC_INTERESTING_FILES,
    impactProbeSymbols: ARC_IMPACT_PROBE_SYMBOLS,
    logicFlowProbes: ARC_LOGIC_FLOW_PROBES,
    controlledChange: {
      targetFilePath: "arc/parser/adapter.py",
      query: "parse_e_elect",
    },
  });

  await mkdir(options.outputDirectory, { recursive: true });
  await writeFile(
    path.join(options.outputDirectory, "arc_python_cython_parity.json"),
    formatValidationReport(report),
  );
  await writeFile(
    path.join(options.outputDirectory, "arc_python_cython_parity.md"),
    renderParityMarkdown(report),
  );

  return report;
}

function bullet(value: boolean | null): string {
  if (value === null) {
    return "n/a";
  }

  return value ? "yes" : "no";
}

function firstNonTestRank(
  results: RealRepoValidationReport["queryResults"][number]["rerankedResults"],
): number | null {
  const index = results.findIndex((candidate) => !candidate.likelyTestCandidate);

  return index === -1 ? null : index + 1;
}

export function renderParityMarkdown(report: RealRepoValidationReport): string {
  const counts = report.summaryCounts;
  const evidence = report.structuralEvidence;
  const lines: string[] = [];

  lines.push("# ARC Python/Cython parity validation report");
  lines.push("");
  lines.push(`- Repo path: \`${report.repoRoot}\``);
  lines.push(`- Source fingerprint (validation run id): \`${report.validationRunId}\``);
  lines.push(`- Query set source: \`${report.querySetSource ?? "(inline)"}\``);
  lines.push(`- RC1 readiness: **${report.rc1ReadinessRecommendation}**`);
  lines.push("");

  lines.push("## Index summary");
  lines.push("");
  lines.push(`- Files indexed: ${counts.indexedFileCount} (python ${counts.indexedPythonFileCount}, cython ${counts.indexedCythonFileCount})`);
  lines.push(`- Symbols indexed: ${counts.indexedSymbolCount} (python ${counts.indexedPythonSymbolCount}, cython ${counts.indexedCythonSymbolCount})`);
  lines.push(`- Edges indexed: ${counts.indexedEdgeCount}`);
  lines.push(`- Parser outcomes: ${counts.parseFailureCount} parse failures, ${counts.readFailureCount} read failures, ${counts.persistenceFailureCount} persistence failures`);
  lines.push("");

  lines.push("## Edges by type");
  lines.push("");
  lines.push("| Edge type | Count |");
  lines.push("| --- | --- |");
  for (const entry of evidence.edgeCountsByType) {
    lines.push(`| ${entry.edgeType} | ${entry.count} |`);
  }
  lines.push("");

  lines.push("## Edges by language");
  lines.push("");
  lines.push("| Language | Edge type | Count |");
  lines.push("| --- | --- | --- |");
  for (const entry of evidence.edgeCountsByLanguage) {
    lines.push(`| ${entry.language} | ${entry.edgeType} | ${entry.count} |`);
  }
  lines.push("");

  lines.push("## Cross-language edges");
  lines.push("");
  if (evidence.crossLanguageEdgeCounts.length === 0) {
    lines.push("None observed.");
  } else {
    lines.push("| Source | Destination | Edge type | Count |");
    lines.push("| --- | --- | --- | --- |");
    for (const entry of evidence.crossLanguageEdgeCounts) {
      lines.push(`| ${entry.srcLanguage} | ${entry.dstLanguage} | ${entry.edgeType} | ${entry.count} |`);
    }
  }
  lines.push("");

  lines.push("## Queries");
  lines.push("");
  lines.push("| Query | Category | Candidates | Cython hits | Expected surface | First non-test rank | Top result | Source-backed pivots |");
  lines.push("| --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const result of report.queryResults) {
    const top = result.rerankedResults[0];
    const topLabel = top === undefined ? "(none)" : `${top.localName} [${top.kind}] ${top.filePath}`;
    lines.push(
      `| ${result.query} | ${result.category} | ${result.rerankedResults.length} | ${result.cythonCandidateCount} | ${bullet(result.surfaceReview.expectedSurfaceObserved)} | ${firstNonTestRank(result.rerankedResults) ?? "n/a"} | ${topLabel} | ${result.capsule.sourceBackedPivotCount} |`,
    );
  }
  lines.push("");

  lines.push("## Impact-graph probes (who-calls / dependents)");
  lines.push("");
  lines.push("| Symbol | Resolved | Language | Dependent symbols | Dependent files | Observed edges | Found dependents |");
  lines.push("| --- | --- | --- | --- | --- | --- | --- |");
  for (const probe of evidence.impactProbes) {
    lines.push(
      `| ${probe.symbolFqn} | ${bullet(probe.resolved)} | ${probe.language ?? "n/a"} | ${probe.dependentSymbolCount} | ${probe.dependentFileCount} | ${probe.observedEdgeTypes.join(", ") || "(none)"} | ${bullet(probe.foundRealDependents)} |`,
    );
  }
  lines.push("");

  lines.push("## Logic-flow probes (wrapper-to-kernel)");
  lines.push("");
  lines.push("| Start | End | Reachable | Paths | Call evidence available | Call evidence used |");
  lines.push("| --- | --- | --- | --- | --- | --- |");
  for (const probe of evidence.logicFlowProbes) {
    lines.push(
      `| ${probe.start} | ${probe.end} | ${bullet(probe.reachable)} | ${probe.pathCount} | ${bullet(probe.callFlowEvidenceAvailable)} | ${bullet(probe.callFlowEvidenceUsed)} |`,
    );
  }
  lines.push("");

  lines.push("## Controlled change (staleness)");
  lines.push("");
  lines.push(`- Status: ${report.controlledChange.status}`);
  lines.push(`- Used temporary copy: ${bullet(report.controlledChange.usedTemporaryCopy)}`);
  lines.push(`- Source repo mutated: ${bullet(report.controlledChange.sourceRepoMutated)}`);
  if (report.controlledChange.fileChangeCounts !== undefined) {
    const fc = report.controlledChange.fileChangeCounts;
    lines.push(`- File changes: +${fc.added} / -${fc.removed} / ~${fc.modified} (unchanged ${fc.unchanged})`);
  }
  if (report.controlledChange.capsuleTrustStatus !== undefined) {
    lines.push(`- Capsule trust status after change: ${report.controlledChange.capsuleTrustStatus}`);
  }
  lines.push("");

  lines.push("## Classified gaps");
  lines.push("");
  if (report.classifiedGaps.length === 0) {
    lines.push("No gaps classified.");
  } else {
    lines.push("| Category | Severity | Finding | Query |");
    lines.push("| --- | --- | --- | --- |");
    for (const gap of report.classifiedGaps) {
      lines.push(`| ${gap.category} | ${gap.severity} | ${gap.findingCode} | ${gap.query ?? ""} |`);
    }
  }
  lines.push("");

  return `${lines.join("\n")}\n`;
}

if (import.meta.main) {
  const repoRoot = process.argv[2] ?? DEFAULT_ARC_REPO_ROOT;
  const outputDirectory = path.join(HERE, "results");

  runArcParityValidation({ repoRoot, outputDirectory })
    .then((report) => {
      process.stdout.write(
        `ARC parity validation complete: ${report.summaryCounts.indexedFileCount} files, ${report.summaryCounts.indexedSymbolCount} symbols, ${report.summaryCounts.indexedEdgeCount} edges. RC1 readiness: ${report.rc1ReadinessRecommendation}\n`,
      );
      process.stdout.write(`Report written to ${outputDirectory}\n`);
    })
    .catch((error: unknown) => {
      process.stderr.write(`ARC parity validation failed: ${String(error)}\n`);
      process.exitCode = 1;
    });
}
