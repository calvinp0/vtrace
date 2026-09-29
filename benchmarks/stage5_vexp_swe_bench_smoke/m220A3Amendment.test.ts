import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { M214_AGENT } from "./m214Preregistration";
import { M218_FROZEN_AMENDMENT_HASH } from "./m218Amendment";
import { M220_FROZEN_A2_HASH } from "./m220Amendment";
import {
  M214_A3_AGENT_HARNESS_COMPATIBILITY,
  M214_A3_FILE,
  M214_A3_PARENT,
  M220A3_FROZEN_HASH,
  M220A3_HARNESS_CAPABILITIES,
  auditA3Amendment,
  auditHarnessAmendmentBinding,
  buildA3AmendmentDocument,
  loadActiveHarnessAmendment,
  m214A3AmendmentHash,
  verifyA3Amendment,
} from "./m220A3Amendment";

const RESULTS = join(import.meta.dir, "results");

describe("M214_A3 lineage", () => {
  test("the parents are A2's lineage plus A2's pinned digest", () => {
    expect(M214_A3_PARENT.a1AmendmentHash).toBe(M218_FROZEN_AMENDMENT_HASH);
    expect(M214_A3_PARENT.a2AmendmentHash).toBe(M220_FROZEN_A2_HASH);
  });

  test("the committed amendment recomputes to the pinned digest and binds", () => {
    const committed = JSON.parse(readFileSync(join(RESULTS, M214_A3_FILE), "utf8")) as Record<string, unknown>;
    expect(verifyA3Amendment(committed).issues).toEqual([]);
    const active = loadActiveHarnessAmendment(RESULTS);
    expect(active.amendmentHash).toBe(M220A3_FROZEN_HASH);
    expect(auditHarnessAmendmentBinding(active, {
      preregistrationHash: M214_A3_PARENT.preregistrationHash,
      manifestHash: M214_A3_PARENT.manifestHash,
      externalReferenceHash: M214_A3_PARENT.externalReferenceHash,
      a1AmendmentHash: M214_A3_PARENT.a1AmendmentHash,
      a2AmendmentHash: M214_A3_PARENT.a2AmendmentHash,
    })).toEqual([]);
    expect(auditHarnessAmendmentBinding(active, {
      preregistrationHash: M214_A3_PARENT.preregistrationHash,
      manifestHash: M214_A3_PARENT.manifestHash,
      externalReferenceHash: M214_A3_PARENT.externalReferenceHash,
      a1AmendmentHash: M214_A3_PARENT.a1AmendmentHash,
      a2AmendmentHash: "0".repeat(64),
    }).length).toBe(1);
  });
});

describe("M214_A3 content", () => {
  test("operational scope, zero outcome-bearing runs, no spend, model identity not weakened", () => {
    const a3 = M214_A3_AGENT_HARNESS_COMPATIBILITY;
    expect(a3.scope).toBe("OPERATIONAL_AGENT_HARNESS_IDENTITY_ONLY");
    expect(a3.outcomeBearingRunsBeforeAmendment).toBe(0);
    expect(a3.authorizesSpend).toBe(false);
    expect(a3.modelIdentityUnchanged.weakened).toBe(false);
    expect(a3.financialEnvelopeUnchanged.hardCeilingUsd).toBe(735);
    expect(a3.supersededRule.m214FrozenValue).toBe(M214_AGENT.version);
    expect(a3.supersededRule.retainedInM214Artifact).toBe(true);
  });

  test("no capability names a release, and every capability names its consumer", () => {
    for (const capability of M220A3_HARNESS_CAPABILITIES) {
      expect(/\b\d+\.\d+\.\d+\b/.test(JSON.stringify(capability))).toBe(false);
      expect(capability.usedBy.length).toBeGreaterThan(0);
    }
  });

  test("a re-pin or a frozen-property key is refused", () => {
    const base = buildA3AmendmentDocument("2026-09-28T00:00:00.000Z");
    expect(auditA3Amendment(base)).toEqual([]);
    const repin = JSON.parse(JSON.stringify(base)) as { capabilityContract: { capabilities: { requirement: string }[] } };
    repin.capabilityContract.capabilities[0]!.requirement = "Claude Code 2.1.283 exactly";
    expect(auditA3Amendment(repin as unknown as Record<string, unknown>).length).toBeGreaterThan(0);
    expect(auditA3Amendment({ ...base, agentVersion: "2.1.283" }).length).toBeGreaterThan(0);
  });

  test("the digest excludes only the hash, the rule and the timestamp", () => {
    const a = buildA3AmendmentDocument("2026-09-28T00:00:00.000Z");
    const b = buildA3AmendmentDocument("2027-01-01T00:00:00.000Z");
    expect(a.amendmentHash).toBe(b.amendmentHash);
    expect(m214A3AmendmentHash(a)).toBe(M220A3_FROZEN_HASH);
    expect(m214A3AmendmentHash({ ...a, scope: "SOMETHING_ELSE" })).not.toBe(M220A3_FROZEN_HASH);
  });
});
