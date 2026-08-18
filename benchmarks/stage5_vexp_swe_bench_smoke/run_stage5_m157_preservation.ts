/**
 * M157 §77/§78 — availability and structural preservation, M156 -> M157.
 *
 * M157 changes the capsule's delivery layer and nothing in the indexer, so the
 * expectation is total: the same repositories index, the same ones degrade, and
 * every repository that was CLEAN under M156 yields identical file, symbol and
 * edge counts. That is a strong enough claim to be worth measuring rather than
 * asserting, because it is exactly the claim a stray import or a shared helper
 * would quietly break.
 *
 * Both inputs are probe artifacts produced by their own side's binary. A case
 * that was unavailable on the predecessor is excluded from the preservation
 * denominator (it has no before-state to preserve) and reported separately.
 *
 * NO Claude, NO Docker, NO agent run, NO API calls, NO network.
 */

import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
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
}

interface AvailabilityReport {
  readonly label: string;
  readonly vtraceCommit: string;
  readonly srcDirty: boolean;
  readonly manifestSha256: string;
  readonly usableIndexes: number;
  readonly degradedIndexes: number;
  readonly unavailableIndexes: number;
  readonly degradedInstanceIds: readonly string[];
  readonly probes: readonly Probe[];
}

const RESULTS = path.join(import.meta.dir, "results");

/** The structural evidence a delivery-layer change has no business moving. */
function structure(probe: Probe): string {
  return JSON.stringify({
    files: probe.filesIndexed,
    symbols: probe.symbols,
    edges: probe.edges,
    failed: probe.filesFailed,
    skipped: probe.filesSkipped,
  });
}

async function main(): Promise<void> {
  const argv = Bun.argv.slice(2);
  const get = (flag: string): string => {
    const index = argv.indexOf(flag);
    if (index < 0 || argv[index + 1] === undefined) throw new Error(`${flag} is required.`);
    return argv[index + 1]!;
  };

  const optional = (flag: string, fallback: string): string => {
    const index = argv.indexOf(flag);
    return index < 0 || argv[index + 1] === undefined ? fallback : argv[index + 1]!;
  };
  const beforePath = get("--before");
  const afterPath = get("--after");
  // M158 §80-§82: the destination used to be hardcoded, so reusing this runner
  // for a later checkpoint overwrote the earlier milestone's committed evidence.
  const milestone = optional("--milestone", "M157");
  const checkpoint = optional("--checkpoint", "M156 final -> M157 final");
  const note = optional(
    "--note",
    "M157 changes the capsule delivery layer only. Index counts are expected to be "
    + "identical, and availability is expected to hold at 30/30 (§77, §78).",
  );
  const out = optional(
    "--out",
    path.join(RESULTS, `stage5_${milestone.toLowerCase()}_frozen30_availability.json`),
  );
  if (existsSync(out) && !argv.includes("--allow-overwrite")) {
    const existing = JSON.parse(await readFile(out, "utf8")) as { milestone?: string };
    if (existing.milestone !== undefined && existing.milestone !== milestone) {
      throw new Error(
        `refusing to overwrite ${existing.milestone} evidence at ${out} with a ${milestone} run. `
        + "Pass --out to name this milestone's own destination "
        + "(or --allow-overwrite if replacing it really is the intent).",
      );
    }
  }
  const before = JSON.parse(await readFile(beforePath, "utf8")) as AvailabilityReport;
  const after = JSON.parse(await readFile(afterPath, "utf8")) as AvailabilityReport;

  if (before.manifestSha256 !== after.manifestSha256) {
    throw new Error("Refusing to compare: the two sides used different frozen manifests.");
  }
  if (after.srcDirty) {
    // §87/§88: a candidate measured from an edited tree is not the candidate.
    throw new Error("Refusing to compare: the candidate side was measured from a dirty src tree.");
  }

  const beforeById = new Map(before.probes.map((probe) => [probe.instanceId, probe]));
  const changed: Array<Record<string, unknown>> = [];
  let cleanComparable = 0;
  let cleanPreserved = 0;

  for (const candidate of after.probes) {
    const predecessor = beforeById.get(candidate.instanceId);
    if (predecessor === undefined || !predecessor.indexUsable) continue;

    // The clean subset: repositories with no file failures on EITHER side.
    if (predecessor.filesFailed === 0 && candidate.filesFailed === 0) {
      cleanComparable += 1;
      if (structure(predecessor) === structure(candidate)) cleanPreserved += 1;
    }
    if (structure(predecessor) !== structure(candidate)) {
      changed.push({
        instanceId: candidate.instanceId,
        repo: candidate.repo,
        before: JSON.parse(structure(predecessor)),
        after: JSON.parse(structure(candidate)),
      });
    }
  }

  const report = {
    schemaVersion: "stage5.m157.preservation.v1",
    milestone,
    checkpoint,
    note,
    predecessor: { label: before.label, commit: before.vtraceCommit, eval: beforePath },
    candidate: { label: after.label, commit: after.vtraceCommit, eval: afterPath, srcDirty: after.srcDirty },
    availability: {
      before: {
        usable: before.usableIndexes,
        degraded: before.degradedIndexes,
        unavailable: before.unavailableIndexes,
        degradedInstanceIds: [...before.degradedInstanceIds].sort(),
      },
      after: {
        usable: after.usableIndexes,
        degraded: after.degradedIndexes,
        unavailable: after.unavailableIndexes,
        degradedInstanceIds: [...after.degradedInstanceIds].sort(),
      },
      availabilityPreserved:
        before.usableIndexes === after.usableIndexes
        && before.unavailableIndexes === after.unavailableIndexes
        && before.degradedIndexes === after.degradedIndexes,
      degradedSetIdentical:
        [...before.degradedInstanceIds].sort().join() === [...after.degradedInstanceIds].sort().join(),
    },
    cleanSubset: {
      comparableCases: cleanComparable,
      preservedCases: cleanPreserved,
      fullyPreserved: cleanComparable > 0 && cleanComparable === cleanPreserved,
    },
    changedCases: changed.length,
    changed,
  };

  await writeFile(out, `${JSON.stringify(report, null, 2)}\n`);
  // eslint-disable-next-line no-console
  console.error(
    `${checkpoint}: usable ${before.usableIndexes}->${after.usableIndexes}, `
    + `unavailable ${before.unavailableIndexes}->${after.unavailableIndexes}, `
    + `degraded ${before.degradedIndexes}->${after.degradedIndexes}, `
    + `clean ${cleanPreserved}/${cleanComparable} structurally identical, `
    + `changedCases=${changed.length} -> ${out}`,
  );
}

await main();
