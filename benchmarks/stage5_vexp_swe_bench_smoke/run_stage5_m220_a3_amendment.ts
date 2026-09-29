/**
 * M220-A3 — write the M214_A3_AGENT_HARNESS_COMPATIBILITY amendment and its hash record.
 *
 * Generated from the frozen constants, hashed under its own domain, and written
 * beside M214, A1 and A2 WITHOUT touching them. The hash record cross-checks the
 * recomputed digest against the constant pinned in `m220A3Amendment.ts` and
 * against A2's committed hash record, so the four-step lineage is verified at
 * generation time rather than asserted.
 *
 * Idempotent: a second run writes byte-identical content apart from
 * `generatedAt`, which the digest excludes.
 *
 *   bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m220_a3_amendment.ts
 */

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  M214_A3_AMENDMENT_ID,
  M214_A3_FILE,
  M214_A3_HASH_FILE,
  M214_A3_PARENT,
  M220A3_FROZEN_HASH,
  M220A3_HARNESS_CONTRACT_VERSION,
  buildA3AmendmentDocument,
  m214A3AmendmentHash,
  verifyA3Amendment,
} from "./m220A3Amendment";
import { M214_A2_HASH_FILE } from "./m220Amendment";

const RESULTS_DIR = join(import.meta.dir, "results");

function sha256(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

function main(): void {
  const generatedAt = new Date().toISOString();
  const document = buildA3AmendmentDocument(generatedAt);
  const path = join(RESULTS_DIR, M214_A3_FILE);
  writeFileSync(path, `${JSON.stringify(document, null, 2)}\n`);

  const written = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  const verification = verifyA3Amendment(written);
  const recomputed = m214A3AmendmentHash(written);

  // A2's own hash record, read rather than restated; it already verified M214 and A1.
  const a2Record = JSON.parse(readFileSync(join(RESULTS_DIR, M214_A2_HASH_FILE), "utf8")) as {
    recordedHash: string; frozenHashPinnedInCode: string; verified: boolean;
    parent: { preregistrationHash: string; manifestHash: string; externalReferenceHash: string; a1AmendmentHash: string };
  };
  const lineageIssues: string[] = [];
  if (a2Record.recordedHash !== M214_A3_PARENT.a2AmendmentHash) lineageIssues.push("parent A2 hash differs from A2's record");
  if (a2Record.frozenHashPinnedInCode !== M214_A3_PARENT.a2AmendmentHash) lineageIssues.push("parent A2 pinned constant differs from A2's record");
  if (a2Record.verified !== true) lineageIssues.push("A2's own record is not verified");
  if (a2Record.parent.preregistrationHash !== M214_A3_PARENT.preregistrationHash) lineageIssues.push("parent preregistration hash differs from A2's lineage");
  if (a2Record.parent.manifestHash !== M214_A3_PARENT.manifestHash) lineageIssues.push("parent manifest hash differs from A2's lineage");
  if (a2Record.parent.externalReferenceHash !== M214_A3_PARENT.externalReferenceHash) lineageIssues.push("parent external-reference hash differs from A2's lineage");
  if (a2Record.parent.a1AmendmentHash !== M214_A3_PARENT.a1AmendmentHash) lineageIssues.push("parent A1 hash differs from A2's lineage");

  const parentBytes = {
    preregistration: sha256(readFileSync(join(RESULTS_DIR, M214_A3_PARENT.preregistrationFile))),
    manifest: sha256(readFileSync(join(RESULTS_DIR, M214_A3_PARENT.manifestFile))),
    externalReference: sha256(readFileSync(join(RESULTS_DIR, M214_A3_PARENT.externalReferenceFile))),
    a1Amendment: sha256(readFileSync(join(RESULTS_DIR, M214_A3_PARENT.a1AmendmentFile))),
    a2Amendment: sha256(readFileSync(join(RESULTS_DIR, M214_A3_PARENT.a2AmendmentFile))),
    a2AmendmentHashRecord: sha256(readFileSync(join(RESULTS_DIR, M214_A2_HASH_FILE))),
  };

  const record = {
    schemaVersion: "stage5.m214-a3.amendment-hash.v1",
    amendmentId: M214_A3_AMENDMENT_ID,
    file: M214_A3_FILE,
    hashRule: String(written.amendmentHashRule),
    recordedHash: String(written.amendmentHash),
    recomputedFromWrittenFile: recomputed,
    frozenHashPinnedInCode: M220A3_FROZEN_HASH,
    matchesPinnedConstant: recomputed === M220A3_FROZEN_HASH,
    auditIssues: verification.auditIssues,
    verified: verification.verified,
    parent: {
      ...M214_A3_PARENT,
      parentRecordsAgree: lineageIssues.length === 0,
      lineageIssues,
      parentFileBytesSha256: parentBytes,
      parentBytesUntouchedByThisScript: true,
    },
    executableAuthority: verification.executableAuthority,
    scope: written.scope,
    outcomeBearingRunsBeforeAmendment: written.outcomeBearingRunsBeforeAmendment,
    contractVersion: M220A3_HARNESS_CONTRACT_VERSION,
    agentVersionPinned: false,
    financialEnvelopeUnchanged: written.financialEnvelopeUnchanged,
    spendAuthorizationStatus: "SPEND_AUTHORIZATION_PENDING",
    launchHarnessRequirement:
      "The launcher MUST verify M214's three digests, A1's, A2's AND this amendment's against the constants pinned "
      + "in code and bind the executable authority (M214 + A1 + A2 + A3) before any paid row. It must prove the "
      + "resolved Claude Code executable against the capability contract before every session, record its path, "
      + "version and digest per session and attempt, and refuse the second arm of a pair on a different executable. "
      + "No Claude Code release is pinned.",
    generatedAt,
  };
  writeFileSync(join(RESULTS_DIR, M214_A3_HASH_FILE), `${JSON.stringify(record, null, 2)}\n`);
  process.stdout.write(
    `amendment ${M214_A3_AMENDMENT_ID}: recomputed ${recomputed}; pinned ${M220A3_FROZEN_HASH}; `
    + `matches=${record.matchesPinnedConstant}; audit issues ${verification.auditIssues.length}; `
    + `lineage issues ${lineageIssues.length}\nexecutable authority ${verification.executableAuthority.identity}\n`,
  );
  if (!record.matchesPinnedConstant || !verification.verified || lineageIssues.length > 0) process.exitCode = 1;
}

main();
