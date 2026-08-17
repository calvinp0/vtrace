/**
 * M156 §57/§69 — what changed on repositories that have NO file failures.
 *
 * The availability gain is only worth having if it costs nothing where nothing
 * was broken. This runner compares the predecessor and candidate availability
 * probes case by case and answers two questions:
 *
 *   preservation  on a repository with zero failed files, does the M156 index
 *                 contain exactly the same evidence — same files, same symbols,
 *                 same edges — as the M154 index?
 *
 *   performance   did per-file exception handling cost anything measurable on a
 *                 clean repository?
 *
 * It computes nothing from the product directly: both inputs are committed probe
 * artifacts, so re-running cannot move a result. A case that was unavailable on
 * the predecessor is EXCLUDED from the preservation denominator — it has no
 * before-state to preserve — and reported separately as a recovery.
 */

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

interface Probe {
  readonly instanceId: string;
  readonly repo: string;
  readonly indexUsable: boolean;
  readonly filesIndexed: number;
  readonly filesFailed: number;
  readonly filesSkipped: number;
  readonly symbols: number;
  readonly edges: number;
  readonly coverageState: string;
  readonly availabilityState: string;
  readonly durationMs: number;
}

interface AvailabilityReport {
  readonly label: string;
  readonly vtraceCommit: string;
  readonly srcDirty: boolean;
  readonly manifestSha256: string;
  readonly selectedTasks: number;
  readonly usableIndexes: number;
  readonly probes: readonly Probe[];
}

const REPO_ROOT = path.resolve(import.meta.dir, "..", "..");
const RESULTS = path.join(REPO_ROOT, "benchmarks/stage5_vexp_swe_bench_smoke/results");

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

async function main(): Promise<void> {
  const before = JSON.parse(
    await readFile(path.join(RESULTS, "stage5_m156_frozen30_availability_before.json"), "utf8"),
  ) as AvailabilityReport;
  const after = JSON.parse(
    await readFile(path.join(RESULTS, "stage5_m156_frozen30_availability_after.json"), "utf8"),
  ) as AvailabilityReport;

  if (before.manifestSha256 !== after.manifestSha256) {
    throw new Error("Refusing to compare: the two sides used different frozen manifests.");
  }
  if (after.srcDirty) {
    // §48/§97: a candidate measured from an edited tree is not the candidate.
    throw new Error("Refusing to compare: the candidate side was measured from a dirty src tree.");
  }

  const beforeById = new Map(before.probes.map((probe) => [probe.instanceId, probe]));
  const changed: Array<Record<string, unknown>> = [];
  const recovered: Array<Record<string, unknown>> = [];
  let preservedCases = 0;
  let comparableCases = 0;
  const cleanBeforeMs: number[] = [];
  const cleanAfterMs: number[] = [];

  for (const candidate of after.probes) {
    const predecessor = beforeById.get(candidate.instanceId);
    if (predecessor === undefined) throw new Error(`Missing predecessor probe: ${candidate.instanceId}`);

    if (!predecessor.indexUsable) {
      // No before-state to preserve. This is the availability gain, reported on
      // its own terms rather than folded into a preservation rate.
      recovered.push({
        instanceId: candidate.instanceId,
        repo: candidate.repo,
        beforeState: predecessor.availabilityState,
        afterState: candidate.availabilityState,
        filesIndexed: candidate.filesIndexed,
        filesFailed: candidate.filesFailed,
        coverageState: candidate.coverageState,
      });
      continue;
    }

    comparableCases += 1;
    const identical = predecessor.filesIndexed === candidate.filesIndexed
      && predecessor.symbols === candidate.symbols
      && predecessor.edges === candidate.edges;
    if (identical) {
      preservedCases += 1;
    } else {
      changed.push({
        instanceId: candidate.instanceId,
        repo: candidate.repo,
        filesIndexed: { before: predecessor.filesIndexed, after: candidate.filesIndexed },
        symbols: { before: predecessor.symbols, after: candidate.symbols },
        edges: { before: predecessor.edges, after: candidate.edges },
        filesFailedAfter: candidate.filesFailed,
      });
    }

    // Latency is only comparable where BOTH sides indexed the same repository
    // successfully and neither had failures to handle.
    if (predecessor.filesFailed === 0 && candidate.filesFailed === 0) {
      cleanBeforeMs.push(predecessor.durationMs);
      cleanAfterMs.push(candidate.durationMs);
    }
  }

  const medianBefore = median(cleanBeforeMs);
  const medianAfter = median(cleanAfterMs);

  const report = {
    schemaVersion: "stage5.m156.clean-preservation.v1",
    milestone: "M156",
    predecessor: { label: before.label, vtraceCommit: before.vtraceCommit },
    candidate: { label: after.label, vtraceCommit: after.vtraceCommit, srcDirty: after.srcDirty },
    manifestSha256: before.manifestSha256,
    denominator: "Cases the PREDECESSOR could index. A case it could not has no before-state to preserve.",
    comparableCases,
    preservedCases,
    changedCases: changed.length,
    preservationRate: comparableCases === 0 ? 0 : preservedCases / comparableCases,
    changed,
    recoveredCases: recovered.length,
    recovered,
    performance: {
      note: "Clean repositories only — both sides zero failed files. Index build wall clock.",
      cases: cleanBeforeMs.length,
      medianMsBefore: medianBefore,
      medianMsAfter: medianAfter,
      medianDeltaMs: medianAfter - medianBefore,
      medianDeltaRatio: medianBefore === 0 ? null : medianAfter / medianBefore,
      // The probe copies each repository before indexing and runs on a shared
      // machine, so this is a coarse signal. It is reported to catch a MATERIAL
      // regression, not to certify a percentage.
      caveat: "Wall clock on a shared machine, one sample per repository. Treat as an order-of-magnitude check.",
    },
  };

  const out = path.join(RESULTS, "stage5_m156_clean27_preservation.json");
  await writeFile(out, `${JSON.stringify(report, null, 2)}\n`);
  // eslint-disable-next-line no-console
  console.error(
    `preserved ${preservedCases}/${comparableCases}, changed ${changed.length}, `
    + `recovered ${recovered.length}; median index ${medianBefore}ms -> ${medianAfter}ms -> ${out}`,
  );
}

await main();
