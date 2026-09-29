/**
 * M220-A3 §6, §7 — pair-local harness equality and the harness-version
 * metadata, over the operations ledger.
 *
 * Under A3 the Claude Code release is operational METADATA, not experiment
 * identity: it may change between sessions, and between complete pairs, as
 * long as the capability contract still holds. What may NOT change is the
 * harness inside one causal pair. Arm 2 of a task must run on the same
 * executable arm 1 ran on, or the pair compares Baseline-on-harness-A with
 * VTRACE-on-harness-B.
 *
 * The identity that decides "same harness" is the sha256 of the executable
 * actually spawned. A version string is what the binary SAYS it is; the
 * digest is what it IS, and two builds can share a version string.
 *
 * PURE. The facts come from `AGENT_HARNESS_OBSERVED` events the executor
 * appends to the operations ledger before every spawn; nothing here reads a
 * result, a resolution or an arm comparison.
 */

import type { RunManifestRow } from "./m214Preregistration";
import type { OperationalEvent } from "./m217ContinuationSafety";
import { type FrozenPair, frozenPairs, pairForRow } from "./m220QuotaSession";

export const M220A3_PAIR_HARNESS_VERSION = "stage5.m220-a3.pair-harness.v1" as const;

export type HarnessCapabilityVerdict = "AGENT_HARNESS_CAPABILITIES_PASS" | "AGENT_HARNESS_CAPABILITY_MISMATCH";

/** What the executor learns about the harness before a spawn. Everything here is telemetry except the verdict and the digest. */
export interface AgentHarnessObservation {
  readonly contractVersion: string;
  /** M214's declared launcher path (the `claude` symlink). */
  readonly declaredBinary: string;
  /** The executable the symlink resolved to; this is what is spawned. */
  readonly resolvedBinary: string;
  /** `claude --version`, verbatim and parsed. Metadata, never compared to a pin. */
  readonly versionOutput: string;
  readonly version: string;
  /** sha256 of the resolved executable. The pair-local identity key. */
  readonly sha256: string | null;
  readonly capabilityVerdict: HarnessCapabilityVerdict;
  readonly capabilityFingerprint: string | null;
  readonly issues: readonly string[];
}

/** The executor's dependency: observe the harness it is about to use. Implementations may cache the probe per digest. */
export interface AgentHarnessGate {
  observe(): AgentHarnessObservation;
  /** The A3 digest whose contract this gate enforces; a COHORT row requires the frozen one. */
  readonly amendmentHash?: string;
}

/** The subset recorded on every `AGENT_HARNESS_OBSERVED` event. Paths and versions only; no secret can appear here. */
export function harnessEventDetail(observation: AgentHarnessObservation, row: RunManifestRow): Record<string, unknown> {
  return {
    instanceId: row.instanceId,
    arm: row.arm,
    armOrderIndex: row.armOrderIndex,
    declaredBinary: observation.declaredBinary,
    resolvedBinary: observation.resolvedBinary,
    version: observation.version,
    versionOutput: observation.versionOutput,
    sha256: observation.sha256,
    capabilityVerdict: observation.capabilityVerdict,
    capabilityFingerprint: observation.capabilityFingerprint,
    contractVersion: observation.contractVersion,
  };
}

export interface RecordedHarness {
  readonly sequence: number;
  readonly runId: string | null;
  readonly attemptId: string | null;
  readonly instanceId: string;
  readonly resolvedBinary: string;
  readonly version: string;
  readonly sha256: string | null;
}

function recorded(event: OperationalEvent): RecordedHarness {
  const detail = event.detail as Record<string, unknown>;
  return {
    sequence: event.sequence,
    runId: event.runId,
    attemptId: event.attemptId,
    instanceId: String(detail.instanceId ?? ""),
    resolvedBinary: String(detail.resolvedBinary ?? ""),
    version: String(detail.version ?? ""),
    sha256: typeof detail.sha256 === "string" ? detail.sha256 : null,
  };
}

export function recordedHarnesses(events: readonly OperationalEvent[]): readonly RecordedHarness[] {
  return Object.freeze(events.filter((event) => event.kind === "AGENT_HARNESS_OBSERVED").map(recorded));
}

/**
 * §6 — the harness the NEXT attempt of `row` must use, or null when nothing
 * binds it yet.
 *
 * The binding is the most recent attempt of the pair's OTHER arm. A settled
 * row gets no further attempt, so for a second arm that is the attempt that
 * settled the first; for a first arm being retried after its partner already
 * ran (never the case in frozen order, but not assumed) it is the partner's.
 * Retries of the SAME arm do not bind each other: two attempts of one arm are
 * never compared with each other.
 */
export function pairHarnessBinding(
  manifest: readonly RunManifestRow[], events: readonly OperationalEvent[], row: RunManifestRow,
  pairs: readonly FrozenPair[] = frozenPairs(manifest),
): RecordedHarness | null {
  const pair = pairForRow(pairs, row);
  const partner = pair.rows[0].runId === row.runId ? pair.rows[1] : pair.rows[0];
  const partnerObservations = recordedHarnesses(events).filter((entry) => entry.runId === partner.runId);
  return partnerObservations[partnerObservations.length - 1] ?? null;
}

/** §6 — PAIR_HARNESS_DRIFT when the harness about to be spawned is not the one the partner arm ran on. */
export function auditPairHarnessEquality(
  binding: RecordedHarness | null, current: AgentHarnessObservation, row: RunManifestRow,
): readonly string[] {
  if (binding === null) return [];
  if (current.sha256 === null) {
    return [`PAIR_HARNESS_DRIFT: ${row.runId}'s partner arm ran on harness ${binding.version} (${binding.sha256 ?? "no digest"}), and the harness about to be spawned has no digest, so equality cannot be proven`];
  }
  if (binding.sha256 === null) {
    return [`PAIR_HARNESS_DRIFT: ${row.runId}'s partner arm recorded no harness digest, so equality with ${current.version} (${current.sha256.slice(0, 16)}) cannot be proven`];
  }
  if (binding.sha256 !== current.sha256) {
    return [
      `PAIR_HARNESS_DRIFT: ${row.runId}'s partner arm (${binding.runId}) ran on Claude Code ${binding.version} at `
      + `${binding.resolvedBinary} (sha256 ${binding.sha256.slice(0, 16)}), the harness now resolved is ${current.version} at `
      + `${current.resolvedBinary} (sha256 ${current.sha256.slice(0, 16)}); both arms of one task must use one harness, `
      + "so this arm is not started",
    ];
  }
  return [];
}

// ── §7 — descriptive harness-version metadata for the final report ───

export interface HarnessVersionSummary {
  readonly schemaVersion: typeof M220A3_PAIR_HARNESS_VERSION;
  readonly versionsObserved: readonly string[];
  readonly digestsObserved: readonly string[];
  /** Pairs whose every recorded attempt used one harness, grouped by that harness's version. */
  readonly singleHarnessPairsByVersion: Readonly<Record<string, number>>;
  readonly pairsCrossingHarnessBoundary: number;
  readonly pairsCrossingHarnessBoundaryIds: readonly string[];
  readonly harnessTransitions: readonly { readonly fromVersion: string; readonly toVersion: string; readonly atSequence: number }[];
  readonly descriptiveOnly: true;
  readonly note: string;
}

/**
 * Outcome-blind: counts pairs by the harness they ran on, never by what they
 * produced. Expected `pairsCrossingHarnessBoundary` is 0, because the
 * executor refuses arm 2 on a different harness; a non-zero value is a defect
 * report, not a stratum.
 */
export function harnessVersionSummary(
  manifest: readonly RunManifestRow[], events: readonly OperationalEvent[],
): HarnessVersionSummary {
  const observations = recordedHarnesses(events);
  const pairs = frozenPairs(manifest);
  const byVersion: Record<string, number> = {};
  const crossing: string[] = [];
  for (const pair of pairs) {
    const runIds = new Set(pair.rows.map((entry) => entry.runId));
    const mine = observations.filter((entry) => entry.runId !== null && runIds.has(entry.runId));
    if (mine.length === 0) continue;
    // A pair's harness is the harness of the latest attempt of each arm; retries
    // of one arm under an earlier harness are not part of the causal pair.
    const latest = pair.rows
      .map((entry) => mine.filter((observation) => observation.runId === entry.runId).at(-1))
      .filter((entry): entry is RecordedHarness => entry !== undefined);
    const digests = new Set(latest.map((entry) => entry.sha256 ?? `unhashed:${entry.version}`));
    if (digests.size > 1) {
      crossing.push(pair.instanceId);
      continue;
    }
    if (latest.length === 2) {
      const version = latest[0]!.version;
      byVersion[version] = (byVersion[version] ?? 0) + 1;
    }
  }
  const transitions: { fromVersion: string; toVersion: string; atSequence: number }[] = [];
  for (let index = 1; index < observations.length; index += 1) {
    const before = observations[index - 1]!;
    const after = observations[index]!;
    if (before.sha256 !== after.sha256) {
      transitions.push({ fromVersion: before.version, toVersion: after.version, atSequence: after.sequence });
    }
  }
  return {
    schemaVersion: M220A3_PAIR_HARNESS_VERSION,
    versionsObserved: Object.freeze([...new Set(observations.map((entry) => entry.version))]),
    digestsObserved: Object.freeze([...new Set(observations.map((entry) => entry.sha256 ?? "(none)"))]),
    singleHarnessPairsByVersion: Object.freeze(byVersion),
    pairsCrossingHarnessBoundary: crossing.length,
    pairsCrossingHarnessBoundaryIds: Object.freeze(crossing),
    harnessTransitions: Object.freeze(transitions),
    descriptiveOnly: true,
    note:
      "descriptive metadata: which harness each pair ran on. It is never used to stratify, select, weight or "
      + "tune outcomes, and is not consulted during execution except to refuse a second arm on a different harness",
  };
}
