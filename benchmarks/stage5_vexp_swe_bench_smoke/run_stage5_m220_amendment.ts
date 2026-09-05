/**
 * M220 §4 — write the M214_A2_SUBSCRIPTION_QUOTA_SCHEDULING amendment and its hash record.
 *
 * The amendment is generated from the frozen constants, hashed under its own
 * domain, and written beside M214's artifacts and A1 WITHOUT touching them. The
 * hash record cross-checks the recomputed digest against the constant pinned in
 * `m220Amendment.ts`, against M214's committed hash record and against A1's
 * committed hash record, so the three-step lineage is verified at generation
 * time rather than asserted.
 *
 * Idempotent: a second run writes byte-identical content apart from
 * `generatedAt`, which the digest excludes.
 *
 *   bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m220_amendment.ts
 */

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  M214_A2_AMENDMENT_ID,
  M214_A2_FILE,
  M214_A2_HASH_FILE,
  M214_A2_PARENT,
  M220_FROZEN_A2_HASH,
  buildA2AmendmentDocument,
  m214A2AmendmentHash,
  verifyA2Amendment,
} from "./m220Amendment";

const RESULTS_DIR = join(import.meta.dir, "results");

function sha256(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

function main(): void {
  const generatedAt = new Date().toISOString();
  const document = buildA2AmendmentDocument(generatedAt);
  const path = join(RESULTS_DIR, M214_A2_FILE);
  writeFileSync(path, `${JSON.stringify(document, null, 2)}\n`);

  const written = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  const verification = verifyA2Amendment(written);
  const recomputed = m214A2AmendmentHash(written);

  // The parents' own hash records, read rather than restated.
  const m214Record = JSON.parse(
    readFileSync(join(RESULTS_DIR, "stage5_m214_preregistration_hash.json"), "utf8"),
  ) as { recordedHash: string; manifestHash: string; externalReferenceHash: string };
  const a1Record = JSON.parse(
    readFileSync(join(RESULTS_DIR, "stage5_m214_a1_amendment_hash.json"), "utf8"),
  ) as { recordedHash: string; recomputedFromWrittenFile: string; frozenHashPinnedInCode: string };
  const lineageIssues: string[] = [];
  if (m214Record.recordedHash !== M214_A2_PARENT.preregistrationHash) lineageIssues.push("parent preregistration hash differs from M214's record");
  if (m214Record.manifestHash !== M214_A2_PARENT.manifestHash) lineageIssues.push("parent manifest hash differs from M214's record");
  if (m214Record.externalReferenceHash !== M214_A2_PARENT.externalReferenceHash) lineageIssues.push("parent external-reference hash differs from M214's record");
  if (a1Record.recordedHash !== M214_A2_PARENT.a1AmendmentHash) lineageIssues.push("parent A1 hash differs from A1's record");
  if (a1Record.frozenHashPinnedInCode !== M214_A2_PARENT.a1AmendmentHash) lineageIssues.push("parent A1 pinned constant differs from A1's record");

  const parentBytes = {
    preregistration: sha256(readFileSync(join(RESULTS_DIR, M214_A2_PARENT.preregistrationFile))),
    manifest: sha256(readFileSync(join(RESULTS_DIR, M214_A2_PARENT.manifestFile))),
    externalReference: sha256(readFileSync(join(RESULTS_DIR, M214_A2_PARENT.externalReferenceFile))),
    a1Amendment: sha256(readFileSync(join(RESULTS_DIR, M214_A2_PARENT.a1AmendmentFile))),
    a1AmendmentHashRecord: sha256(readFileSync(join(RESULTS_DIR, "stage5_m214_a1_amendment_hash.json"))),
  };

  const record = {
    schemaVersion: "stage5.m214-a2.amendment-hash.v1",
    amendmentId: M214_A2_AMENDMENT_ID,
    file: M214_A2_FILE,
    hashRule: String(written.amendmentHashRule),
    recordedHash: String(written.amendmentHash),
    recomputedFromWrittenFile: recomputed,
    frozenHashPinnedInCode: M220_FROZEN_A2_HASH,
    matchesPinnedConstant: recomputed === M220_FROZEN_A2_HASH,
    auditIssues: verification.auditIssues,
    verified: verification.verified,
    parent: {
      ...M214_A2_PARENT,
      parentRecordsAgree: lineageIssues.length === 0,
      lineageIssues,
      parentFileBytesSha256: parentBytes,
      parentBytesUntouchedByThisScript: true,
    },
    executableAuthority: verification.executableAuthority,
    scope: written.scope,
    pauseState: (written.pauseState as { marker: string }).marker,
    pairSplitMarker: (written.pairSplit as { marker: string }).marker,
    quotaInterruption: {
      classificationVerdict: (written.quotaInterruption as { classificationVerdict: string }).classificationVerdict,
      frozenClass: (written.quotaInterruption as { frozenClass: string }).frozenClass,
      newRetryClassesCreated: (written.quotaInterruption as { newRetryClassesCreated: number }).newRetryClassesCreated,
    },
    financialEnvelopeUnchanged: written.financialEnvelopeUnchanged,
    spendAuthorizationStatus: "SPEND_AUTHORIZATION_PENDING",
    launchHarnessRequirement:
      "The launcher MUST verify M214's three frozen digests, A1's digest AND this amendment's digest "
      + "against the constants pinned in code, and must bind the executable authority (M214 + A1 + A2) "
      + "before any paid row. A quota-window session launched against M214 + A1 alone is refused once A2 "
      + "is active; a COHORT launch without a declared per-session pair cap is refused by name.",
    generatedAt,
  };
  writeFileSync(join(RESULTS_DIR, M214_A2_HASH_FILE), `${JSON.stringify(record, null, 2)}\n`);
  process.stdout.write(
    `amendment ${M214_A2_AMENDMENT_ID}: recomputed ${recomputed}; pinned ${M220_FROZEN_A2_HASH}; `
    + `matches=${record.matchesPinnedConstant}; audit issues ${verification.auditIssues.length}; `
    + `lineage issues ${lineageIssues.length}\nexecutable authority ${verification.executableAuthority.identity}\n`,
  );
  if (!record.matchesPinnedConstant || !verification.verified || lineageIssues.length > 0) process.exitCode = 1;
}

main();
