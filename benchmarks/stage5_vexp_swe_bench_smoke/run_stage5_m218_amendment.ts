/**
 * M218 §4, §6 — write the M214_A1_RETRY_RESERVE amendment and its hash record.
 *
 * The amendment is generated from the frozen constants, hashed under its own
 * domain, and written beside M214's artifacts WITHOUT touching them. The hash
 * record cross-checks the recomputed digest against the constant pinned in
 * `m218Amendment.ts` and against the parent digests recorded by M214, so the
 * lineage is verified at generation time rather than asserted.
 *
 * Idempotent: a second run writes byte-identical content apart from
 * `generatedAt`, which the digest excludes.
 *
 *   bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m218_amendment.ts
 */

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  M214_A1_AMENDMENT_ID,
  M214_A1_FILE,
  M214_A1_HASH_FILE,
  M214_A1_PARENT,
  M218_FROZEN_AMENDMENT_HASH,
  buildAmendmentDocument,
  m214A1AmendmentHash,
  verifyAmendment,
} from "./m218Amendment";

const RESULTS_DIR = join(import.meta.dir, "results");

function sha256(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

function main(): void {
  const generatedAt = new Date().toISOString();
  const document = buildAmendmentDocument(generatedAt);
  const path = join(RESULTS_DIR, M214_A1_FILE);
  writeFileSync(path, `${JSON.stringify(document, null, 2)}\n`);

  const written = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  const verification = verifyAmendment(written);
  const recomputed = m214A1AmendmentHash(written);

  // The parent's own hash record, read rather than restated, so the lineage
  // check has an independent authority on the other side.
  const parentRecord = JSON.parse(
    readFileSync(join(RESULTS_DIR, "stage5_m214_preregistration_hash.json"), "utf8"),
  ) as { recordedHash: string; manifestHash: string; externalReferenceHash: string };
  const lineageIssues: string[] = [];
  if (parentRecord.recordedHash !== M214_A1_PARENT.preregistrationHash) lineageIssues.push("parent preregistration hash differs from M214's record");
  if (parentRecord.manifestHash !== M214_A1_PARENT.manifestHash) lineageIssues.push("parent manifest hash differs from M214's record");
  if (parentRecord.externalReferenceHash !== M214_A1_PARENT.externalReferenceHash) lineageIssues.push("parent external-reference hash differs from M214's record");

  const parentBytes = {
    preregistration: sha256(readFileSync(join(RESULTS_DIR, M214_A1_PARENT.preregistrationFile))),
    manifest: sha256(readFileSync(join(RESULTS_DIR, M214_A1_PARENT.manifestFile))),
    externalReference: sha256(readFileSync(join(RESULTS_DIR, M214_A1_PARENT.externalReferenceFile))),
  };

  const record = {
    schemaVersion: "stage5.m214-a1.amendment-hash.v1",
    amendmentId: M214_A1_AMENDMENT_ID,
    file: M214_A1_FILE,
    hashRule: String(written.amendmentHashRule),
    recordedHash: String(written.amendmentHash),
    recomputedFromWrittenFile: recomputed,
    frozenHashPinnedInCode: M218_FROZEN_AMENDMENT_HASH,
    matchesPinnedConstant: recomputed === M218_FROZEN_AMENDMENT_HASH,
    auditIssues: verification.auditIssues,
    verified: verification.verified,
    parent: {
      ...M214_A1_PARENT,
      parentRecordAgrees: lineageIssues.length === 0,
      lineageIssues,
      parentFileBytesSha256: parentBytes,
      parentBytesUntouchedByThisScript: true,
    },
    executableAuthority: verification.executableAuthority,
    financialEnvelope: {
      ordinaryExposureUsd: (written.ordinaryExposure as { usd: number }).usd,
      retryReserveUsd: (written.retryReserve as { usd: number }).usd,
      retryReserveAttempts: (written.retryReserve as { attempts: number }).attempts,
      hardCeilingUsd: written.hardCeilingUsd,
      manifestRows: written.manifestRows,
      intendedValidOutcomes: written.intendedValidOutcomes,
    },
    spendAuthorizationStatus: "SPEND_AUTHORIZATION_PENDING",
    launchHarnessRequirement:
      "The launcher MUST verify M214's three frozen digests AND this amendment's digest against the "
      + "constants pinned in code, and must bind the executable authority (M214 + A1) before any paid "
      + "row. Launching against the original $700 authority alone is refused once A1 is active.",
    generatedAt,
  };
  writeFileSync(join(RESULTS_DIR, M214_A1_HASH_FILE), `${JSON.stringify(record, null, 2)}\n`);
  process.stdout.write(
    `amendment ${M214_A1_AMENDMENT_ID}: recomputed ${recomputed}; pinned ${M218_FROZEN_AMENDMENT_HASH}; `
    + `matches=${record.matchesPinnedConstant}; audit issues ${verification.auditIssues.length}; `
    + `lineage issues ${lineageIssues.length}\nexecutable authority ${verification.executableAuthority.identity}\n`,
  );
  if (!record.matchesPinnedConstant || !verification.verified || lineageIssues.length > 0) process.exitCode = 1;
}

main();
