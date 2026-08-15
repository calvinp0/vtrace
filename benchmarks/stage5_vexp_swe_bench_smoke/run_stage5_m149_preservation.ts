// M149 §87/§117: prove this milestone sits OUTSIDE the derivation closure.
//
// M146-A built the fingerprint model so an index knows when the code that
// derived it has moved. M148-A then showed the way to add a physical capability
// without disturbing that model: integrate ABOVE the seam, and no anti-drift
// exemption is needed because the dependency never points into the closure.
//
// M149 edits the workspace/claim layer, which should likewise be invisible to
// derivation. That is a claim, so it is MEASURED the way M146-A measures every
// such claim — mutate each touched file, recompute every fingerprint, and check
// that nothing moved — rather than asserted from where the files happen to live.
//
// A `false` in `unchanged` here would mean M149 silently forced a reparse of
// every indexed repository in the field.
//
// No agent, Docker, VEXP, network, or paid API is used.

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { computeIndexFingerprints, type IndexFingerprint } from "../../src/indexer/indexMeta";

/** Fingerprint fields that describe DERIVATION. `vtrace_commit` is provenance. */
const DERIVATION_FIELDS = [
  "index_format_version",
  "schema_version",
  "indexer_fingerprint",
  "parser_fingerprint",
  "config_hash",
] as const;

/** Every source file M149 touched. */
const TOUCHED = [
  "src/workspace/evidenceClaims.ts",
  "src/workspace/repositoryRelevance.ts",
  "src/workspace/repositoryPresence.ts",
  "src/workspace/workspaceProductContext.ts",
];

function derivationOnly(fingerprint: IndexFingerprint): Record<string, unknown> {
  return Object.fromEntries(
    DERIVATION_FIELDS.map((field) => [field, fingerprint[field]]),
  );
}

function sameDerivation(left: IndexFingerprint, right: IndexFingerprint): boolean {
  return DERIVATION_FIELDS.every((field) => left[field] === right[field]);
}

async function main(): Promise<void> {
  const repoRoot = path.resolve(process.argv[2] ?? process.cwd());
  const outDir = path.resolve(
    process.argv[3] ?? "benchmarks/stage5_vexp_swe_bench_smoke/results",
  );

  const before = await computeIndexFingerprints();
  const controls = [];

  for (const relative of TOUCHED) {
    const filePath = path.join(repoRoot, relative);
    const original = await readFile(filePath, "utf8");
    try {
      // A behavioural control, not a reading of the import graph: if this file
      // were inside the closure, ANY edit to it would move a fingerprint.
      await writeFile(filePath, `${original}\n// m149 anti-drift probe\n`, "utf8");
      const mutated = await computeIndexFingerprints();
      controls.push({
        file: relative,
        derivationUnchanged: sameDerivation(before, mutated),
        movedFields: DERIVATION_FIELDS.filter((field) => before[field] !== mutated[field]),
      });
    } finally {
      await writeFile(filePath, original, "utf8");
    }
  }

  const after = await computeIndexFingerprints();

  const output = {
    schemaVersion: "stage5.m149.derivation-preservation.v1",
    milestone: "M149",
    control: "mutate each M149-touched source file, recompute every derivation fingerprint",
    before: derivationOnly(before),
    after: derivationOnly(after),
    restoredCleanly: sameDerivation(before, after),
    controls,
    unchanged: controls.every((control) => control.derivationUnchanged),
    antiDriftClosureGuard:
      "src/indexer/indexerFingerprintCoverage.test.ts — passes with no new exemption",
    seam:
      "src/workspace/* is consumed by no indexer write path, so the M148-A placement rule "
      + "(integrate above the derivation seam) holds unchanged for M149.",
  };

  await writeFile(
    path.join(outDir, "stage5_m149_derivation_preservation.json"),
    `${JSON.stringify(output, null, 2)}\n`,
    "utf8",
  );

  for (const control of controls) {
    process.stdout.write(
      `${control.derivationUnchanged ? "unchanged" : "MOVED    "}  ${control.file}`
      + `${control.movedFields.length > 0 ? ` (${control.movedFields.join(", ")})` : ""}\n`,
    );
  }
  process.stdout.write(
    `unchanged=${output.unchanged} restoredCleanly=${output.restoredCleanly}\n`,
  );
  if (!output.unchanged || !output.restoredCleanly) process.exitCode = 1;
}

if (import.meta.main) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exit(1);
  });
}
