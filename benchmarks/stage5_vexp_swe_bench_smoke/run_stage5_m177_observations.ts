/**
 * M177-E — the observation-only measurements.
 *
 * Four things that must be recorded and, except for the first, must NOT be acted
 * on in this milestone:
 *
 *   §30  authoritative impact identity, pre- and post-repair
 *   §26  the terminal really is terminal: the residue below the floor is constant
 *   §35  where the threshold sits
 *   §36  whether the impact budget ladder is monotone — OBSERVE, DO NOT REPAIR
 *
 *   bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m177_observations.ts \
 *     --out benchmarks/stage5_vexp_swe_bench_smoke/results
 *
 * Deterministic, offline, no paid API.
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { compactImpactProductResponse as compactAfter } from "../../src/impact/impactResponseEnvelope";
import { compactImpactProductResponse as compactBefore } from "/home/calvin/bench/vtrace-m177/pre-repair/src/impact/impactResponseEnvelope";

import type { ImpactGraphOutput } from "../../src/impact/getImpactGraph";
import {
  authoritativeImpact,
  IMPACT_UNREACHABLE_MESSAGE,
  openWorkspace,
  residueIsConstantBelowFloor,
} from "./m177ImpactEnvelope";

const PRE_REPAIR_WORKTREE = "/home/calvin/bench/vtrace-m177/pre-repair";
const REPO = path.resolve(import.meta.dir, "results/workspaces/m160_broad_b/pytest-dev__pytest-10081");
const KNOWN_POSITIVE = "src/_pytest/debugging.py::_enter_pdb";
const EMPTY_IMPACT = "src/_pytest/__init__.py::__all__";

/** A fine ladder around the known positive's transition, plus the far field. */
const LADDER = [1, 25, 50, 100, 200, 300, 400, 450, 470, 474, 476, 478, 480, 500, 600, 800, 1_000, 1_200, 1_600, 2_000] as const;

const argOf = (flag: string, fallback: string): string => {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? (process.argv[index + 1] ?? fallback) : fallback;
};

function tryCompact(
  compact: (output: ImpactGraphOutput) => unknown,
  output: ImpactGraphOutput,
): { ok: boolean; unreachable: boolean; response: Record<string, unknown> | null } {
  try {
    return { ok: true, unreachable: false, response: compact(structuredClone(output)) as Record<string, unknown> };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, unreachable: message === IMPACT_UNREACHABLE_MESSAGE, response: null };
  }
}

const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

async function main(): Promise<void> {
  if (!existsSync(PRE_REPAIR_WORKTREE)) throw new Error(`pre-repair worktree missing: ${PRE_REPAIR_WORKTREE}`);
  const out = argOf("--out", path.resolve(import.meta.dir, "results"));
  mkdirSync(out, { recursive: true });
  const db = openWorkspace(REPO);

  try {
    // ── §30 authoritative identity ──────────────────────────────────────────
    // The engine is upstream of the envelope and M177 did not touch it, so this
    // is a check that the diff did what it claims rather than a discovery. It is
    // compared at EQUAL budget only: `getImpactGraph.ts:705` spends `max_tokens`
    // on path selection, so the authoritative result legitimately differs across
    // the ladder and an across-budget comparison would report a false change.
    const identityRows = [];
    for (const symbolFqn of [KNOWN_POSITIVE, EMPTY_IMPACT]) {
      for (const maxTokens of [1, 200, 477, 1_200]) {
        const first = await authoritativeImpact(db, REPO, { symbolFqn, maxTokens });
        const second = await authoritativeImpact(db, REPO, { symbolFqn, maxTokens });
        identityRows.push({
          symbolFqn,
          maxTokens,
          identity: first.identity,
          stableAcrossRepeatedRuns: first.identity === second.identity,
          edges: first.output?.edges.length ?? null,
          directRelations: first.output?.directRelations.length ?? null,
          consumers: first.output?.summary.consumers ?? null,
        });
      }
    }

    // ── §26 the residue below the floor is constant ─────────────────────────
    const failingBudgets = [1, 25, 50, 100, 200, 300, 400] as const;
    const declineBodies = [];
    for (const maxTokens of failingBudgets) {
      const authoritative = await authoritativeImpact(db, REPO, { symbolFqn: KNOWN_POSITIVE, maxTokens });
      const after = tryCompact(compactAfter, authoritative.output!);
      declineBodies.push(after.response);
    }
    const residue = residueIsConstantBelowFloor(declineBodies as never);

    // ── §35/§36 the ladder, both arms, one process, one snapshot per rung ────
    const ladderRows = [];
    for (const maxTokens of LADDER) {
      const authoritative = await authoritativeImpact(db, REPO, { symbolFqn: KNOWN_POSITIVE, maxTokens });
      if (!authoritative.ok || authoritative.output === null) continue;
      const before = tryCompact(compactBefore as never, authoritative.output);
      const after = tryCompact(compactAfter, authoritative.output);
      const afterBudget = record(after.response?.responseBudget);
      const afterDiagnostics = record(after.response?.diagnostics);
      ladderRows.push({
        maxTokens,
        beforeState: before.unreachable ? "impact_response_envelope_unreachable" : before.ok ? "response" : "unexpected",
        afterState: afterDiagnostics?.envelopeDecline === true ? "bounded_decline" : after.ok ? "response" : "unexpected",
        authoritativeIdentity: authoritative.identity,
        retainedEdges: typeof afterBudget?.retainedEdges === "number" ? afterBudget.retainedEdges : null,
        omittedEdges: typeof afterBudget?.omittedEdges === "number" ? afterBudget.omittedEdges : null,
        resultState: typeof afterBudget?.resultState === "string" ? afterBudget.resultState : null,
        serializedCharacters: typeof afterBudget?.serializedCharacters === "number" ? afterBudget.serializedCharacters : null,
      });
    }

    const delivering = ladderRows.filter((row) => row.afterState === "response");
    const threshold = {
      largestBudgetProducingDecline: Math.max(...ladderRows.filter((row) => row.afterState === "bounded_decline").map((row) => row.maxTokens)),
      smallestBudgetProducingResponse: Math.min(...delivering.map((row) => row.maxTokens)),
      deterministic: false,
      whyNotDeterministic: "the response carries `timing` as full-precision floats, so `serializedCharacters` varies by a few characters between otherwise identical runs and the floor jitters by about one token. Measured directly: the same max_tokens=476 request answered on one run and declined on another. The threshold is therefore reported as a location, never used as a gate.",
    };

    // §37's weak property, evaluated over the ladder. Reported, NOT repaired.
    const monotonicityViolations = [];
    for (let index = 1; index < ladderRows.length; index += 1) {
      const previous = ladderRows[index - 1]!;
      const current = ladderRows[index]!;
      if (previous.afterState === "response" && current.afterState === "bounded_decline") {
        monotonicityViolations.push({
          kind: "state_weakened_with_more_budget",
          from: { maxTokens: previous.maxTokens, state: previous.afterState },
          to: { maxTokens: current.maxTokens, state: current.afterState },
        });
      }
      if (previous.retainedEdges !== null && current.retainedEdges !== null
        && current.retainedEdges < previous.retainedEdges) {
        monotonicityViolations.push({
          kind: "evidence_removed_with_more_budget",
          from: { maxTokens: previous.maxTokens, retainedEdges: previous.retainedEdges },
          to: { maxTokens: current.maxTokens, retainedEdges: current.retainedEdges },
        });
      }
    }

    const observations = {
      schemaVersion: "stage5.m177.observations.v1",
      milestone: "M177",
      workstream: "E",
      repoRoot: REPO,
      authoritativeIdentity: {
        note: "§30 — the engine is upstream of the repair and unmodified. Compared at EQUAL budget only; see the comment in this script for why across-budget comparison would be wrong.",
        engineFilesChangedByM177: ["src/impact/getImpactGraph.ts (ImpactDiagnostics.envelopeDecline, an optional response field; no computation)"],
        rows: identityRows,
        allStable: identityRows.every((row) => row.stableAcrossRepeatedRuns),
      },
      terminalConstruction: {
        note: "§26 — a decline that could itself fail to fit would just move the unreachable state one rung down.",
        budgetsProbed: failingBudgets,
        residueConstantBelowFloor: residue.constant,
        distinctResidues: new Set(residue.identities).size,
        argument: "the terminal is built once and RETURNED, never re-measured against a gate that can reject it. Its size is a constant: every field it carries is a frozen constant, a boolean, a non-negative integer, an enum, or one of four identity strings bounded at 200 characters with omission (not truncation) past the bound.",
      },
      threshold,
      ladder: ladderRows,
      monotonicity: {
        note: "§36/§37 — OBSERVED, NOT REPAIRED. Weak property: for a fixed request and authoritative state, more budget must not remove evidence or weaken the delivered state.",
        acceptanceGate: false,
        violations: monotonicityViolations,
        holdsOnThisLadder: monotonicityViolations.length === 0,
        relatedKnownDefect: "M176 measured a genuine non-monotone delivery packer in the run_pipeline path (django__django-10880: orientation at 400/600, delivery_failure at 800/1000, orientation again at 1600). That is budgetDelivery.ts, a different component, and is out of M177's scope.",
      },
    };

    writeFileSync(path.join(out, "stage5_m177_observations.json"), `${JSON.stringify(observations, null, 2)}\n`);
    writeFileSync(path.join(out, "stage5_m177_threshold.json"), `${JSON.stringify({
      schemaVersion: "stage5.m177.threshold.v1",
      milestone: "M177",
      symbolFqn: KNOWN_POSITIVE,
      ...threshold,
      ladder: ladderRows.map((row) => ({ maxTokens: row.maxTokens, before: row.beforeState, after: row.afterState })),
    }, null, 2)}\n`);
    writeFileSync(path.join(out, "stage5_m177_authoritative_identity.json"), `${JSON.stringify({
      schemaVersion: "stage5.m177.authoritative-identity.v1",
      milestone: "M177",
      ...observations.authoritativeIdentity,
    }, null, 2)}\n`);

    console.log(`authoritative identity stable: ${observations.authoritativeIdentity.allStable}`);
    console.log(`residue constant below floor: ${residue.constant} (distinct=${new Set(residue.identities).size})`);
    console.log(`threshold: largest decline=${threshold.largestBudgetProducingDecline} smallest response=${threshold.smallestBudgetProducingResponse}`);
    console.log(`monotonicity violations on this ladder: ${monotonicityViolations.length}`);
    for (const violation of monotonicityViolations) console.log(`  ${JSON.stringify(violation)}`);
  } finally {
    db.close();
  }
}

await main();
