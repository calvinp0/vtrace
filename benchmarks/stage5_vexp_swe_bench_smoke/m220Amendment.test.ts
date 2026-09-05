import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { M214_EXCLUSIONS, M214_STOPPING_RULE } from "./m214Preregistration";
import {
  M215_FROZEN_EXTERNAL_REFERENCE_HASH,
  M215_FROZEN_MANIFEST_HASH,
  M215_FROZEN_PREREGISTRATION_HASH,
} from "./m215LaunchExecutor";
import { M218_FROZEN_AMENDMENT_HASH, M214_A1_FILE } from "./m218Amendment";
import {
  M214_A2_FILE,
  M214_A2_HASH_DOMAIN,
  M214_A2_PARENT,
  M214_A2_SUBSCRIPTION_QUOTA_SCHEDULING,
  M220_FROZEN_A2_HASH,
  M220_PAUSE_STATE,
  auditA2Amendment,
  auditSessionAuthorityBinding,
  buildA2AmendmentDocument,
  executableAuthorityIdentityA2,
  loadActiveSessionAuthority,
  m214A2AmendmentHash,
  verifyA2Amendment,
} from "./m220Amendment";

const RESULTS = join(import.meta.dir, "results");

describe("M214_A2 lineage", () => {
  test("the parent identities are the executor's frozen constants and A1's pinned digest", () => {
    expect(M214_A2_PARENT.preregistrationHash).toBe(M215_FROZEN_PREREGISTRATION_HASH);
    expect(M214_A2_PARENT.manifestHash).toBe(M215_FROZEN_MANIFEST_HASH);
    expect(M214_A2_PARENT.externalReferenceHash).toBe(M215_FROZEN_EXTERNAL_REFERENCE_HASH);
    expect(M214_A2_PARENT.a1AmendmentHash).toBe(M218_FROZEN_AMENDMENT_HASH);
    expect(M214_A2_PARENT.a1AmendmentFile).toBe(M214_A1_FILE);
  });

  test("the parent digests equal the committed M214 and A1 hash records", () => {
    const m214 = JSON.parse(readFileSync(join(RESULTS, "stage5_m214_preregistration_hash.json"), "utf8")) as {
      recordedHash: string; manifestHash: string; externalReferenceHash: string;
    };
    const a1 = JSON.parse(readFileSync(join(RESULTS, "stage5_m214_a1_amendment_hash.json"), "utf8")) as { recordedHash: string };
    expect(m214.recordedHash).toBe(M214_A2_PARENT.preregistrationHash);
    expect(m214.manifestHash).toBe(M214_A2_PARENT.manifestHash);
    expect(m214.externalReferenceHash).toBe(M214_A2_PARENT.externalReferenceHash);
    expect(a1.recordedHash).toBe(M214_A2_PARENT.a1AmendmentHash);
  });
});

describe("M214_A2 content", () => {
  test("scope is operational, nothing frozen changes, and the pause is not a failure", () => {
    const a2 = M214_A2_SUBSCRIPTION_QUOTA_SCHEDULING;
    expect(a2.scope).toBe("OPERATIONAL_QUOTA_WINDOW_SCHEDULING_ONLY");
    expect(a2.outcomeBearingRunsBeforeAmendment).toBe(0);
    expect(a2.authorizesSpend).toBe(false);
    expect(a2.pauseState.marker).toBe(M220_PAUSE_STATE);
    expect(a2.pauseState.isFailure).toBe(false);
    expect(a2.pauseState.consumesRetryAttempt).toBe(false);
    expect(a2.quotaInterruption.classificationVerdict).toBe("QUOTA_INTERRUPTION_ALREADY_COVERED_BY_FROZEN_RETRY_AUTHORITY");
    expect(M214_EXCLUSIONS.retryPolicy.rerunnable).toContain(a2.quotaInterruption.frozenClass);
    expect(a2.quotaInterruption.newRetryClassesCreated).toBe(0);
    expect(a2.financialEnvelopeUnchanged.hardCeilingUsd).toBe(735);
    expect(a2.financialEnvelopeUnchanged.manifestRows).toBe(M214_STOPPING_RULE.intendedRuns);
    expect(a2.retryEligibilityUnchanged.maxAttemptsPerRun).toBe(M214_EXCLUSIONS.retryPolicy.maxAttemptsPerRun);
    expect(a2.unchanged).toContain("fixed-N target");
    expect(a2.unchanged).toContain("statistical analysis");
  });

  test("no permitted pause reason is outcome-shaped", () => {
    for (const reason of M214_A2_SUBSCRIPTION_QUOTA_SCHEDULING.pauseState.permittedReasons) {
      expect(/win|pass|resolved|delta|effect|p-?value|discordant|saving/i.test(reason)).toBe(false);
    }
  });
});

describe("M214_A2 hashing", () => {
  test("the digest is domain-separated, excludes only the hash, rule and timestamp, and is the pinned constant", () => {
    const a = buildA2AmendmentDocument("2026-09-05T00:00:00.000Z");
    const b = buildA2AmendmentDocument("2026-09-06T00:00:00.000Z");
    expect(m214A2AmendmentHash(a)).toBe(m214A2AmendmentHash(b));
    expect(m214A2AmendmentHash(a)).toBe(String(a.amendmentHash));
    expect(m214A2AmendmentHash(a)).toBe(M220_FROZEN_A2_HASH);
    expect(m214A2AmendmentHash(a)).not.toBe(createHash("sha256").update(JSON.stringify(a)).digest("hex"));
    expect(M214_A2_HASH_DOMAIN).toBe("M214_A2_SUBSCRIPTION_QUOTA_SCHEDULING\n");
    expect(M220_FROZEN_A2_HASH).not.toBe(M218_FROZEN_AMENDMENT_HASH);
  });

  test("a one-byte change moves the digest and fails verification (F26)", () => {
    const document = buildA2AmendmentDocument("2026-09-05T00:00:00.000Z");
    const pause = { ...(document.pauseState as Record<string, unknown>), consumesRetryAttempt: true };
    const mutated = { ...document, pauseState: pause };
    expect(m214A2AmendmentHash(mutated)).not.toBe(M220_FROZEN_A2_HASH);
    const verification = verifyA2Amendment(mutated);
    expect(verification.verified).toBe(false);
    expect(verification.issues.some((issue) => issue.includes("consumesRetryAttempt"))).toBe(true);
  });

  test("the executable authority identity binds M214, A1 and A2 together", () => {
    const base = executableAuthorityIdentityA2({
      preregistrationHash: M214_A2_PARENT.preregistrationHash,
      manifestHash: M214_A2_PARENT.manifestHash,
      externalReferenceHash: M214_A2_PARENT.externalReferenceHash,
      a1AmendmentHash: M218_FROZEN_AMENDMENT_HASH,
      a2AmendmentHash: M220_FROZEN_A2_HASH,
    });
    expect(executableAuthorityIdentityA2({ ...base, a2AmendmentHash: "" }).identity).not.toBe(base.identity);
    expect(executableAuthorityIdentityA2({ ...base, a1AmendmentHash: "" }).identity).not.toBe(base.identity);
    expect(base.identity).not.toBe("782f8a94e5d6bb8e09000b16c37a1037d72cb40537523ab61db0c53fa80ef086");
  });
});

describe("M214_A2 audit (operational scope only)", () => {
  test("the frozen document audits clean", () => {
    expect(auditA2Amendment(buildA2AmendmentDocument("2026-09-05T00:00:00.000Z"))).toEqual([]);
  });

  test("an amendment that names a task, model, analysis or ceiling is refused by key", () => {
    const base = buildA2AmendmentDocument("2026-09-05T00:00:00.000Z");
    for (const [key, value] of [["model", "x"], ["tasks", ["x"]], ["statisticalPlan", {}], ["hardCeilingUsd", 900], ["executionOrder", []]] as const) {
      expect(auditA2Amendment({ ...base, [key]: value }).some((issue) => issue.includes(`'${key}'`))).toBe(true);
    }
  });

  test("an amendment that reclassifies a quota interruption as valid, or invents a class, is refused", () => {
    const base = buildA2AmendmentDocument("2026-09-05T00:00:00.000Z");
    const q = base.quotaInterruption as Record<string, unknown>;
    expect(auditA2Amendment({ ...base, quotaInterruption: { ...q, frozenClass: "QUOTA_EXHAUSTED" } }).length).toBeGreaterThan(0);
    expect(auditA2Amendment({ ...base, quotaInterruption: { ...q, newRetryClassesCreated: 1 } }).length).toBeGreaterThan(0);
    const eligibility = { ...(base.retryEligibilityUnchanged as Record<string, unknown>), maxAttemptsPerRun: 99 };
    expect(auditA2Amendment({ ...base, retryEligibilityUnchanged: eligibility }).length).toBeGreaterThan(0);
  });

  test("a session-authority binding refuses a foreign A1 or missing A1", () => {
    const authority = loadActiveSessionAuthority(RESULTS);
    const bound = {
      preregistrationHash: M214_A2_PARENT.preregistrationHash,
      manifestHash: M214_A2_PARENT.manifestHash,
      externalReferenceHash: M214_A2_PARENT.externalReferenceHash,
      a1AmendmentHash: M218_FROZEN_AMENDMENT_HASH,
    };
    expect(auditSessionAuthorityBinding(authority, bound)).toEqual([]);
    expect(auditSessionAuthorityBinding(authority, { ...bound, a1AmendmentHash: "0".repeat(64) }).length).toBe(1);
    expect(auditSessionAuthorityBinding(authority, { ...bound, a1AmendmentHash: undefined }).length).toBe(1);
    expect(auditSessionAuthorityBinding(authority, { ...bound, manifestHash: "0".repeat(64) }).length).toBe(1);
    expect(auditSessionAuthorityBinding(undefined, bound).length).toBe(1);
  });
});

describe("committed A2 artifact", () => {
  test("the committed file recomputes to the pinned digest and audits clean", () => {
    const path = join(RESULTS, M214_A2_FILE);
    if (!existsSync(path)) return;
    const verification = verifyA2Amendment(JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>);
    expect(verification.issues).toEqual([]);
    expect(verification.recomputedHash).toBe(M220_FROZEN_A2_HASH);
  });
});
