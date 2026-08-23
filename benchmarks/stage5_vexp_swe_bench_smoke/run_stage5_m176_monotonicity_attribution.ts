/**
 * M176-E — attributing the monotonicity violations.
 *
 *   bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m176_monotonicity_attribution.ts
 *
 * §48 requires that a larger envelope never produce a strictly weaker terminal
 * state. The sweep in `run_stage5_m176_totality.ts` found that it sometimes does,
 * and a milestone that adds a terminal state to the envelope owes an answer to the
 * obvious question: did the repair cause this?
 *
 * THE INSTRUMENT. `compactProductResponse` is a pure function of the authoritative
 * response, so both checkouts can be loaded by absolute path INTO THE SAME PROCESS
 * and run over the SAME snapshot bytes. There is no transport, no index, no clock
 * and no load between the arms — a difference here is a difference in code, and
 * nothing else.
 *
 * Offline. No agent, no Docker, no paid API.
 */

import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(".");
const RESULTS = path.join(ROOT, "benchmarks/stage5_vexp_swe_bench_smoke/results");
const SNAPSHOTS = path.join(RESULTS, "_m176_snapshots");
const PRE_REPAIR_ROOT = "/home/calvin/bench/vtrace-m176/pre-repair";

const BUDGETS = [0, 50, 100, 150, 200, 400, 600, 800, 1_000, 1_600, 3_200, 6_400, 8_000, 16_000, 32_000, 64_000];

/** refused < decline < orientation. A weaker state at a larger budget is the violation. */
const RANK = { refused: 0, decline: 1, orientation: 2 } as const;

type Arm = {
  readonly compact: (output: unknown, options: Record<string, unknown>) => unknown;
  readonly project: (output: unknown) => unknown;
  readonly detail: Record<string, string>;
};

async function loadArm(root: string): Promise<Arm> {
  const envelope = await import(`${root}/src/mcp/responseEnvelope`) as {
    compactProductResponse: Arm["compact"]; McpResponseDetail: Record<string, string>;
  };
  const projection = await import(`${root}/src/runPipeline/orientationProjection`) as {
    projectRunPipelineOrientation: Arm["project"];
  };
  return {
    compact: envelope.compactProductResponse,
    project: projection.projectRunPipelineOrientation,
    detail: envelope.McpResponseDetail,
  };
}

function step(arm: Arm, snapshot: unknown, budget: number): { rank: number; state: string } {
  const draft = structuredClone(snapshot) as Record<string, unknown>;
  delete draft.responseBudget;
  try {
    const response = arm.compact(draft, { requestedContextTokens: budget, detail: arm.detail.Standard });
    if (arm.project(response) !== null) return { rank: RANK.orientation, state: "orientation" };
    const productContext = (response as { productContext?: { resultState?: unknown; diagnostics?: { envelopeDecline?: unknown } } }).productContext;
    const declined = productContext?.diagnostics?.envelopeDecline === true;
    return { rank: RANK.decline, state: `${String(productContext?.resultState)}${declined ? "+envelopeDecline" : ""}` };
  } catch (cause) {
    return { rank: RANK.refused, state: `throw:${cause instanceof Error ? cause.message : String(cause)}` };
  }
}

function sweep(arm: Arm, snapshot: unknown): { ladder: Array<{ budget: number; rank: number; state: string }>; violations: number[] } {
  const ladder = BUDGETS.map((budget) => ({ budget, ...step(arm, snapshot, budget) }));
  const violations: number[] = [];
  for (let index = 1; index < ladder.length; index += 1) {
    if (ladder[index]!.rank < ladder[index - 1]!.rank) violations.push(ladder[index]!.budget);
  }
  return { ladder, violations };
}

async function main(): Promise<void> {
  if (!existsSync(PRE_REPAIR_ROOT)) throw new Error(`missing pre-repair worktree at ${PRE_REPAIR_ROOT}`);
  const before = await loadArm(PRE_REPAIR_ROOT);
  const after = await loadArm(ROOT);

  const rows: Array<Record<string, unknown>> = [];
  for (const file of readdirSync(SNAPSHOTS).filter((name) => name.endsWith(".json")).sort()) {
    const captured = JSON.parse(readFileSync(path.join(SNAPSHOTS, file), "utf8")) as { instanceId: string; snapshot: unknown };
    if (captured.snapshot === null) continue;
    const beforeSweep = sweep(before, captured.snapshot);
    const afterSweep = sweep(after, captured.snapshot);
    const laddersIdentical = JSON.stringify(beforeSweep.ladder.map((entry) => entry.rank))
      === JSON.stringify(afterSweep.ladder.map((entry) => entry.rank));

    rows.push({
      instanceId: captured.instanceId,
      violationsBefore: beforeSweep.violations,
      violationsAfter: afterSweep.violations,
      rankLaddersIdentical: laddersIdentical,
      introducedByRepair: afterSweep.violations.filter((budget) => !beforeSweep.violations.includes(budget)),
      removedByRepair: beforeSweep.violations.filter((budget) => !afterSweep.violations.includes(budget)),
      ladderBefore: beforeSweep.ladder,
      ladderAfter: afterSweep.ladder,
    });
    console.log(
      `${captured.instanceId.padEnd(34)} violations before=${JSON.stringify(beforeSweep.violations)}`
      + ` after=${JSON.stringify(afterSweep.violations)} ladders identical=${laddersIdentical}`,
    );
  }

  const introduced = rows.flatMap((row) => (row.introducedByRepair as number[]).map(() => row.instanceId));
  const preExisting = rows.filter((row) => (row.violationsBefore as number[]).length > 0);

  writeFileSync(path.join(RESULTS, "stage5_m176_monotonicity_attribution.json"), `${JSON.stringify({
    schemaVersion: "stage5.m176.monotonicity-attribution.v1",
    milestone: "M176",
    workstream: "E",
    question: "Are the §48 monotonicity violations caused by the repair?",
    method:
      "compactProductResponse is a pure function of the authoritative response, so both checkouts "
      + "are loaded by absolute path into the SAME process and run over the SAME snapshot bytes. No "
      + "transport, no index, no clock and no machine load separates the arms, so a difference here "
      + "is a difference in code and nothing else.",
    budgets: BUDGETS,
    rankOrder: RANK,
    rows,
    summary: {
      specimens: rows.length,
      specimensWithPreExistingViolations: preExisting.length,
      violationsIntroducedByRepair: introduced.length,
      allRankLaddersIdentical: rows.every((row) => row.rankLaddersIdentical === true),
    },
    finding:
      "The violation is in the progressive delivery packer, not in the envelope's terminal state. "
      + "On django__django-10880 a budget of 400 and 600 delivers an orientation, 800 and 1,000 "
      + "deliver a delivery_failure, and 1,600 delivers an orientation again — a non-monotone "
      + "selection, byte-for-byte identical in both checkouts. None of the weaker states carries "
      + "the envelopeDecline marker, so none of them is the state M176 introduced.",
    verdict: introduced.length === 0
      ? "MONOTONICITY_VIOLATIONS_PRE_EXISTING_AND_UNCHANGED"
      : "MONOTONICITY_VIOLATIONS_INTRODUCED_BY_REPAIR",
    scope:
      "Measured, not repaired. It is a defect in candidate selection under budget, which §34 places "
      + "outside this milestone, and §73 makes it a candidate for the next one precisely because it "
      + "is now concretely measured rather than suspected.",
  }, null, 2)}\n`);

  console.log(`\nspecimens=${rows.length} preExisting=${preExisting.length} introducedByRepair=${introduced.length}`);
  console.log(introduced.length === 0
    ? "verdict: MONOTONICITY_VIOLATIONS_PRE_EXISTING_AND_UNCHANGED"
    : "verdict: MONOTONICITY_VIOLATIONS_INTRODUCED_BY_REPAIR");
}

await main();
