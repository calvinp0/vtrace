import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { RunManifestRow } from "./m214Preregistration";
import type { OperationalEvent } from "./m217ContinuationSafety";
import {
  type AgentHarnessObservation,
  auditPairHarnessEquality,
  harnessVersionSummary,
  pairHarnessBinding,
} from "./m220A3PairHarness";

const manifest = (JSON.parse(readFileSync(join(import.meta.dir, "results", "stage5_m214_run_manifest.json"), "utf8")) as { rows: RunManifestRow[] }).rows;

function observed(sequence: number, row: RunManifestRow, version: string, sha: string): OperationalEvent {
  return {
    sequence, kind: "AGENT_HARNESS_OBSERVED", at: "2026-09-28T00:00:00.000Z", runId: row.runId, attemptId: `${row.runId}#${sequence}`,
    detail: { instanceId: row.instanceId, version, sha256: sha, resolvedBinary: `/claude/${version}` },
  } as unknown as OperationalEvent;
}

function current(version: string, sha: string): AgentHarnessObservation {
  return {
    contractVersion: "v", declaredBinary: "/claude", resolvedBinary: `/claude/${version}`, versionOutput: version, version,
    sha256: sha, capabilityVerdict: "AGENT_HARNESS_CAPABILITIES_PASS", capabilityFingerprint: null, issues: [],
  };
}

describe("pair-local harness equality", () => {
  const [first, second, third] = [manifest[0]!, manifest[1]!, manifest[2]!];

  test("the second arm is bound to the first arm's latest attempt; another pair is not", () => {
    const events = [observed(1, first, "2.1.284", "a".repeat(64))];
    expect(pairHarnessBinding(manifest, events, second)?.sha256).toBe("a".repeat(64));
    expect(pairHarnessBinding(manifest, events, third)).toBeNull();
    expect(pairHarnessBinding(manifest, [], second)).toBeNull();
  });

  test("a different digest is PAIR_HARNESS_DRIFT even under the same version string", () => {
    const binding = pairHarnessBinding(manifest, [observed(1, first, "2.1.284", "a".repeat(64))], second);
    expect(auditPairHarnessEquality(binding, current("2.1.284", "a".repeat(64)), second)).toEqual([]);
    expect(auditPairHarnessEquality(binding, current("2.1.284", "c".repeat(64)), second)[0]).toMatch(/^PAIR_HARNESS_DRIFT/);
    expect(auditPairHarnessEquality(binding, { ...current("2.1.284", "a".repeat(64)), sha256: null }, second)[0]).toMatch(/^PAIR_HARNESS_DRIFT/);
  });

  test("the version summary counts pairs per harness and pairs crossing a boundary", () => {
    const events = [
      observed(1, first, "2.1.284", "a".repeat(64)), observed(2, second, "2.1.284", "a".repeat(64)),
      observed(3, manifest[2]!, "2.1.290", "b".repeat(64)), observed(4, manifest[3]!, "2.1.284", "a".repeat(64)),
    ];
    const summary = harnessVersionSummary(manifest, events);
    expect(summary.singleHarnessPairsByVersion).toEqual({ "2.1.284": 1 });
    expect(summary.pairsCrossingHarnessBoundary).toBe(1);
    expect(summary.harnessTransitions).toHaveLength(2);
    expect(summary.descriptiveOnly).toBe(true);
  });
});
