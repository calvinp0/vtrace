/**
 * M162-D preparation — freeze the three-arm pilot corpus, schedule, and protocol.
 *
 * Nothing here runs an agent. It selects and freezes, so that the selection
 * cannot be influenced by anything the pilot later shows.
 *
 * The corpus comes from M161's extension manifest, which was frozen BEFORE any
 * paired30 outcome was observed. Cases 1-30 were consumed by M161; 31-100 were
 * never run, never graded, and never inspected against treatment behaviour.
 * That makes them a genuinely unconsumed population rather than a fresh draw
 * made after seeing what M161 concluded.
 *
 *   bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m162_pilot_protocol.ts
 */

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { FROZEN_CALLABLE_TOOL_IDS } from "./m162Callable";

const PILOT_SIZE = 12;
const ARMS = ["baseline", "static", "callable"] as const;

interface FrozenCase {
  readonly order: number;
  readonly instanceId: string;
  readonly repo: string;
  readonly difficulty: string;
  readonly stratum: string;
  readonly baseCommit: string;
  readonly expectedFiles: readonly string[];
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/**
 * Repository-balanced selection over frozen metadata only.
 *
 * Round-robin across repositories in first-appearance order, taking each
 * repository's lowest frozen `order` first. Selection therefore depends only on
 * the manifest's own frozen ordering and repository labels — never on retrieval
 * quality, Top-1 correctness, candidate counts, or gold reachability, none of
 * which are even read here.
 */
export function selectRepoBalanced(
  pool: readonly FrozenCase[],
  size: number,
): readonly FrozenCase[] {
  const byRepo = new Map<string, FrozenCase[]>();
  for (const entry of [...pool].sort((a, b) => a.order - b.order)) {
    const bucket = byRepo.get(entry.repo) ?? [];
    bucket.push(entry);
    byRepo.set(entry.repo, bucket);
  }

  const repos = [...byRepo.keys()];
  const selected: FrozenCase[] = [];
  let round = 0;
  while (selected.length < size) {
    let tookAny = false;
    for (const repo of repos) {
      if (selected.length >= size) break;
      const bucket = byRepo.get(repo)!;
      if (bucket.length <= round) continue;
      selected.push(bucket[round]!);
      tookAny = true;
    }
    if (!tookAny) break;
    round += 1;
  }

  return selected.sort((a, b) => a.order - b.order);
}

/**
 * Rotating arm order, a function of the task's position alone.
 *
 * Each arm leads exactly a third of the tasks, so provider drift or
 * time-of-day effects cannot land preferentially on one arm — and because the
 * rotation is derived from position, it cannot be nudged after an outcome.
 */
export function buildArmSchedule(
  cases: readonly FrozenCase[],
): ReadonlyArray<{ order: number; instanceId: string; armOrder: readonly string[] }> {
  return cases.map((entry, index) => ({
    order: index + 1,
    instanceId: entry.instanceId,
    armOrder: [
      ARMS[index % 3]!,
      ARMS[(index + 1) % 3]!,
      ARMS[(index + 2) % 3]!,
    ],
  }));
}

function main(): void {
  const resultsDir = path.resolve("benchmarks/stage5_vexp_swe_bench_smoke/results");
  mkdirSync(resultsDir, { recursive: true });

  const extension = JSON.parse(readFileSync(path.join(resultsDir, "stage5_m161_extension_manifest.json"), "utf8"));
  const paired30 = JSON.parse(readFileSync(path.join(resultsDir, "stage5_m161_paired30_manifest.json"), "utf8"));
  const grades = JSON.parse(readFileSync(path.join(resultsDir, "stage5_m161_grades.json"), "utf8"));

  const allCases: FrozenCase[] = extension.extension.cases;
  const consumedIds = new Set<string>((paired30.cases as FrozenCase[]).map((entry) => entry.instanceId));

  // Every id M161 actually graded, whatever its manifest position.
  const gradedIds = new Set<string>();
  const gradeRows: unknown[] = Array.isArray(grades) ? grades : (grades.cases ?? grades.grades ?? []);
  for (const row of gradeRows) {
    if (row !== null && typeof row === "object" && "instanceId" in row) {
      gradedIds.add(String((row as { instanceId: unknown }).instanceId));
    }
  }

  const pool = allCases.filter((entry) => !consumedIds.has(entry.instanceId) && !gradedIds.has(entry.instanceId));

  const contamination = {
    manifestCaseCount: allCases.length,
    paired30Consumed: consumedIds.size,
    m161GradedIds: gradedIds.size,
    paired30IsStrictPrefix: allCases.slice(0, 30).every((entry) => consumedIds.has(entry.instanceId)),
    untouchedPoolSize: pool.length,
    poolOverlapWithGraded: pool.filter((entry) => gradedIds.has(entry.instanceId)).length,
    frozenBeforeAnyOutcome: extension.frozenBeforeAnyRetrievalOrAgent === true,
    verified: {
      neverLiveRun: "no pool id appears in M161 grades",
      neverOutcomeInspected: "M161 transcript inspection covered only the 30 paired cases",
      notSelectedOnTreatmentBehaviour: "selection reads order/repo/difficulty only; no retrieval or capsule field is consulted",
    },
  };

  const selected = selectRepoBalanced(pool, PILOT_SIZE);
  const schedule = buildArmSchedule(selected);

  const repoShares = new Map<string, number>();
  for (const entry of selected) repoShares.set(entry.repo, (repoShares.get(entry.repo) ?? 0) + 1);

  const manifest = {
    schemaVersion: 1,
    milestone: "M162",
    workstream: "D",
    title: "M162 three-arm architecture pilot manifest",
    productSha: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    sourceManifest: "stage5_m161_extension_manifest.json",
    sourceManifestFrozenAt: extension.frozenAt ?? null,
    caseCount: selected.length,
    selectionRule:
      "Round-robin across repositories in first-appearance order, taking each repository's lowest frozen order first. "
      + "Frozen metadata only: no retrieval, capsule, or outcome field is read.",
    contamination,
    repositories: [...repoShares.keys()].sort(),
    repositoryShares: Object.fromEntries([...repoShares.entries()].sort()),
    maxRepositoryShare: Math.max(...repoShares.values()) / selected.length,
    cases: selected,
  };
  const manifestHash = sha256(JSON.stringify(manifest.cases));

  const scheduleArtifact = {
    schemaVersion: 1,
    milestone: "M162",
    workstream: "D",
    title: "M162 three-arm execution schedule",
    rule: "Arm order rotates with task position; each arm leads exactly a third of the tasks.",
    armLeadCounts: Object.fromEntries(ARMS.map((arm) => [
      arm, schedule.filter((entry) => entry.armOrder[0] === arm).length,
    ])),
    totalArms: schedule.length * ARMS.length,
    schedule,
  };
  const scheduleHash = sha256(JSON.stringify(scheduleArtifact.schedule));

  // M161 actuals: 60 live arms for $41.07 over ~3h07m.
  const m161CostPerArm = 41.07 / 60;
  const m161WallClockPerArmMinutes = (3 * 60 + 7) / 60;

  const costEstimate = {
    schemaVersion: 1,
    milestone: "M162",
    workstream: "D",
    basis: "M161 actuals: 60 live arms, $41.07, ~3h07m wall clock, on the same agent, model, and turn caps.",
    perArmUsd: Math.round(m161CostPerArm * 1000) / 1000,
    knownPositiveControl: {
      arms: 1,
      estimatedUsd: Math.round(m161CostPerArm * 1000) / 1000,
      note: "A single short synthetic task on a tiny fixture; expected well below the M161 average.",
    },
    pilot: {
      tasks: PILOT_SIZE,
      arms: PILOT_SIZE * ARMS.length,
      estimatedUsd: Math.round(PILOT_SIZE * ARMS.length * m161CostPerArm * 100) / 100,
      range: {
        low: Math.round(PILOT_SIZE * ARMS.length * m161CostPerArm * 0.7 * 100) / 100,
        high: Math.round(PILOT_SIZE * ARMS.length * m161CostPerArm * 1.5 * 100) / 100,
        why:
          "CALLABLE's cost is the open question: tool results add context the agent would otherwise "
          + "have gathered itself, and it is not yet known whether that nets out cheaper or dearer. "
          + "The high end assumes CALLABLE runs materially dearer than M161's static arm.",
      },
    },
    localIndexBuild: {
      armsNeedingAnIndex: PILOT_SIZE * 2,
      medianSecondsPerIndex: 42,
      estimatedMinutes: Math.round(PILOT_SIZE * 2 * 42 / 60),
      note: "STATIC and CALLABLE both need a fresh index at the frozen product SHA; stored indexes fail closed as schema_incompatible. BASELINE needs none.",
    },
    wallClock: {
      estimatedHours: Math.round(PILOT_SIZE * ARMS.length * m161WallClockPerArmMinutes / 60 * 10) / 10,
      note: "Live runs are sequential — they share results/_agent_stream.jsonl and must not overlap.",
    },
    totalEstimatedUsd: Math.round((PILOT_SIZE * ARMS.length + 1) * m161CostPerArm * 100) / 100,
  };

  const protocolArtifact = {
    schemaVersion: 1,
    milestone: "M162",
    workstream: "D",
    title: "M162 three-arm pilot protocol",
    frozenBeforeExecution: true,
    question:
      "Was M161's flat pass-rate a limit of VTRACE's repository intelligence, or of the static-injection "
      + "architecture that delivered it?",
    arms: {
      baseline: { staticCapsule: false, callableTools: false, historicalPolicyBlocks: false, mcpServers: [] },
      static: { staticCapsule: true, callableTools: false, historicalPolicyBlocks: false, mcpServers: [] },
      callable: {
        staticCapsule: false, callableTools: true, historicalPolicyBlocks: false,
        mcpServers: ["vtrace"], tools: [...FROZEN_CALLABLE_TOOL_IDS],
      },
    },
    heldIdentical: [
      "model", "agent version", "system prompt", "task prompt", "budget", "turn cap",
      "timeout", "ordinary repository tools", "grader", "environment", "dataset (--data)",
    ],
    toolSetFrozen: [...FROZEN_CALLABLE_TOOL_IDS],
    manifestHash,
    scheduleHash,
    rerunPolicy: {
      allowed: [
        "API or network failure", "agent process infrastructure crash", "workspace corruption",
        "grader infrastructure failure", "MCP transport infrastructure failure",
      ],
      notAllowed: [
        "the agent wrote a bad patch", "the agent ignored VTRACE",
        "VTRACE returned bad but valid context", "the baseline got unlucky",
      ],
      note: "Every rerun is recorded. Infrastructure failures are treatment failures; agent behaviour is data.",
    },
    significance: {
      claimable: "descriptive per-task comparison and discordance inspection",
      notClaimable: "statistical significance; n=12 supports none",
    },
    midSweepChanges: "Prohibited. Tool descriptions, schemas, policy, manifest, and schedule are frozen at the hashes above.",
  };

  for (const [name, value] of [
    ["stage5_m162_pilot_candidate_pool.json", {
      schemaVersion: 1, milestone: "M162", workstream: "D",
      title: "Untouched M161 pre-frozen extension population",
      contamination, poolSize: pool.length, pool,
    }],
    ["stage5_m162_pilot_manifest.json", { ...manifest, manifestHash }],
    ["stage5_m162_arm_schedule.json", { ...scheduleArtifact, scheduleHash }],
    ["stage5_m162_live_cost_estimate.json", costEstimate],
    ["stage5_m162_protocol.json", protocolArtifact],
  ] as const) {
    writeFileSync(path.join(resultsDir, name), `${JSON.stringify(value, null, 2)}\n`);
  }

  console.log(JSON.stringify({
    untouchedPool: pool.length,
    selected: selected.length,
    repositories: manifest.repositories.length,
    maxRepositoryShare: manifest.maxRepositoryShare,
    manifestHash,
    scheduleHash,
    estimatedUsd: costEstimate.totalEstimatedUsd,
    estimatedRange: [costEstimate.pilot.range.low, costEstimate.pilot.range.high],
    indexMinutes: costEstimate.localIndexBuild.estimatedMinutes,
    wallClockHours: costEstimate.wallClock.estimatedHours,
  }, null, 2));
}

main();
