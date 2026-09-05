import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { M214_BUDGET, M214_EXCLUSIONS, M214_STOPPING_RULE } from "./m214Preregistration";
import {
  M215_FROZEN_EXTERNAL_REFERENCE_HASH,
  M215_FROZEN_MANIFEST_HASH,
  M215_FROZEN_PREREGISTRATION_HASH,
} from "./m215LaunchExecutor";
import {
  M214_A1_FILE,
  M214_A1_HASH_DOMAIN,
  M214_A1_PARENT,
  M214_A1_RETRY_RESERVE,
  M218_FROZEN_AMENDMENT_HASH,
  auditAmendment,
  buildAmendmentDocument,
  executableAuthorityIdentity,
  m214A1AmendmentHash,
  verifyAmendment,
} from "./m218Amendment";

const RESULTS = join(import.meta.dir, "results");

describe("M214_A1 lineage", () => {
  test("the parent identities are the executor's frozen constants", () => {
    expect(M214_A1_PARENT.preregistrationHash).toBe(M215_FROZEN_PREREGISTRATION_HASH);
    expect(M214_A1_PARENT.manifestHash).toBe(M215_FROZEN_MANIFEST_HASH);
    expect(M214_A1_PARENT.externalReferenceHash).toBe(M215_FROZEN_EXTERNAL_REFERENCE_HASH);
  });

  test("the parent digests equal M214's committed hash record", () => {
    const record = JSON.parse(readFileSync(join(RESULTS, "stage5_m214_preregistration_hash.json"), "utf8")) as {
      recordedHash: string; manifestHash: string; externalReferenceHash: string;
    };
    expect(record.recordedHash).toBe(M214_A1_PARENT.preregistrationHash);
    expect(record.manifestHash).toBe(M214_A1_PARENT.manifestHash);
    expect(record.externalReferenceHash).toBe(M214_A1_PARENT.externalReferenceHash);
  });
});

describe("M214_A1 arithmetic", () => {
  test("$700 ordinary + $35 reserve = $735 hard ceiling, 10 attempts, 200 rows and outcomes", () => {
    expect(M214_A1_RETRY_RESERVE.ordinaryExposure.usd).toBe(700);
    expect(M214_A1_RETRY_RESERVE.retryReserve.usd).toBe(35);
    expect(M214_A1_RETRY_RESERVE.retryReserve.attempts).toBe(10);
    expect(M214_A1_RETRY_RESERVE.hardCeilingUsd).toBe(735);
    expect(M214_A1_RETRY_RESERVE.manifestRows).toBe(200);
    expect(M214_A1_RETRY_RESERVE.intendedValidOutcomes).toBe(200);
    expect(M214_A1_RETRY_RESERVE.retryReserve.fractionOfIntendedRuns).toBe(0.05);
    expect(M214_A1_RETRY_RESERVE.outcomeBearingRunsBeforeAmendment).toBe(0);
    expect(M214_A1_RETRY_RESERVE.authorizesSpend).toBe(false);
  });

  test("retry eligibility is M214's, restated not changed", () => {
    expect(M214_A1_RETRY_RESERVE.retryEligibilityUnchanged.rerunnable).toEqual(M214_EXCLUSIONS.retryPolicy.rerunnable);
    expect(M214_A1_RETRY_RESERVE.retryEligibilityUnchanged.maxAttemptsPerRun).toBe(M214_EXCLUSIONS.retryPolicy.maxAttemptsPerRun);
    expect(M214_A1_RETRY_RESERVE.retryReserve.newRetryClassesCreated).toBe(0);
    expect(Number(M214_BUDGET.totalSpendCapUsd)).toBe(M214_A1_RETRY_RESERVE.ordinaryExposure.usd);
    expect(Number(M214_STOPPING_RULE.intendedRuns)).toBe(M214_A1_RETRY_RESERVE.manifestRows);
  });
});

describe("M214_A1 hashing", () => {
  test("the digest is domain-separated and excludes only the hash, rule and timestamp", () => {
    const a = buildAmendmentDocument("2026-09-05T00:00:00.000Z");
    const b = buildAmendmentDocument("2026-09-06T00:00:00.000Z");
    expect(m214A1AmendmentHash(a)).toBe(m214A1AmendmentHash(b));
    expect(m214A1AmendmentHash(a)).toBe(String(a.amendmentHash));
    expect(m214A1AmendmentHash(a)).toBe(M218_FROZEN_AMENDMENT_HASH);
    const undomained = createHash("sha256").update(JSON.stringify(a)).digest("hex");
    expect(m214A1AmendmentHash(a)).not.toBe(undomained);
    expect(M214_A1_HASH_DOMAIN).toBe("M214_A1_RETRY_RESERVE\n");
  });

  test("a one-byte change moves the digest and fails verification", () => {
    const document = buildAmendmentDocument("2026-09-05T00:00:00.000Z");
    const mutated = { ...document, hardCeilingUsd: 736 };
    expect(m214A1AmendmentHash(mutated)).not.toBe(M218_FROZEN_AMENDMENT_HASH);
    const verification = verifyAmendment(mutated);
    expect(verification.verified).toBe(false);
    expect(verification.issues.some((issue) => issue.includes("hardCeilingUsd"))).toBe(true);
  });

  test("the executable authority identity binds M214 and A1 together", () => {
    const base = executableAuthorityIdentity({
      preregistrationHash: M214_A1_PARENT.preregistrationHash,
      manifestHash: M214_A1_PARENT.manifestHash,
      externalReferenceHash: M214_A1_PARENT.externalReferenceHash,
      amendmentHash: M218_FROZEN_AMENDMENT_HASH,
    });
    const withoutAmendment = executableAuthorityIdentity({ ...base, amendmentHash: "" });
    expect(base.identity).not.toBe(withoutAmendment.identity);
    expect(base.identity).not.toBe(M214_A1_PARENT.preregistrationHash);
  });
});

describe("M214_A1 audit (A3 — financial scope only)", () => {
  test("the frozen document audits clean", () => {
    expect(auditAmendment(buildAmendmentDocument("2026-09-05T00:00:00.000Z"))).toEqual([]);
  });

  test("an amendment that names a task, model or analysis is refused by key", () => {
    const base = buildAmendmentDocument("2026-09-05T00:00:00.000Z");
    for (const [key, value] of [["model", "claude-opus-4-6"], ["tasks", ["x"]], ["statisticalPlan", {}], ["maxTurns", 300]] as const) {
      const issues = auditAmendment({ ...base, [key]: value });
      expect(issues.some((issue) => issue.includes(`'${key}'`))).toBe(true);
    }
  });

  test("an amendment that changes retry eligibility or the per-row cap is refused", () => {
    const base = buildAmendmentDocument("2026-09-05T00:00:00.000Z");
    const eligibility = { ...(base.retryEligibilityUnchanged as Record<string, unknown>), maxAttemptsPerRun: 3 };
    expect(auditAmendment({ ...base, retryEligibilityUnchanged: eligibility }).length).toBeGreaterThan(0);
    const wider = { ...(base.retryEligibilityUnchanged as Record<string, unknown>), rerunnable: ["MODEL_SERVICE_FAILURE", "PATCH_EXTRACTION_FAILURE"] };
    expect(auditAmendment({ ...base, retryEligibilityUnchanged: wider }).some((i) => i.includes("rerunnable"))).toBe(true);
    const cap = { ...(base.ordinaryExposure as Record<string, unknown>), perRowCapUsd: 5 };
    expect(auditAmendment({ ...base, ordinaryExposure: cap }).some((i) => i.includes("perRowCapUsd"))).toBe(true);
  });

  test("an amendment with a different parent is refused", () => {
    const base = buildAmendmentDocument("2026-09-05T00:00:00.000Z");
    const parent = { ...(base.parent as Record<string, unknown>), preregistrationHash: "0".repeat(64) };
    expect(auditAmendment({ ...base, parent }).some((i) => i.includes("parent.preregistrationHash"))).toBe(true);
  });
});

describe("committed amendment artifact", () => {
  test("the committed file recomputes to the pinned digest and audits clean", () => {
    const path = join(RESULTS, M214_A1_FILE);
    if (!existsSync(path)) return;
    const document = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    const verification = verifyAmendment(document);
    expect(verification.issues).toEqual([]);
    expect(verification.recomputedHash).toBe(M218_FROZEN_AMENDMENT_HASH);
  });
});
