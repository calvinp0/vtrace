/**
 * M216 §12, §33, §34, §35 — the non-frozen research population.
 *
 * Every real-substrate control in this milestone runs against tasks that are NOT
 * in M214's frozen 100, and the rows they run are not frozen manifest rows. Two
 * separate protections, because they fail differently:
 *
 *   * the INSTANCE is outside the frozen population, so no frozen task acquires
 *     a container, an agent process or an evaluation "just for infrastructure";
 *   * the MANIFEST is a research manifest with its own digest, so a result
 *     produced here is refused by a COHORT ledger on the hash as well as on the
 *     mode. A single guard would be one edit away from being the only one.
 *
 * The instances are drawn from SWE-bench Verified's complement — the 400 tasks
 * M214 did not freeze — so they are real SWE-bench instances with real images
 * and a real evaluator answer, not a hand-made fixture that would prove the
 * adapters work on something no benchmark resembles.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import {
  M214_BUDGET,
  M214_MODEL,
  M214_AGENT,
  type M214Arm,
  type RunManifestRow,
  budgetIdentity,
  m214ManifestHash,
} from "./m214Preregistration";
import type { FrozenAuthorities, HashVerification } from "./m215LaunchExecutor";

export const M216_RESEARCH_EXPERIMENT = "M216_RESEARCH_NON_EVALUATION" as const;
export const M216_RESEARCH_SEED = "M216-RESEARCH-NON-EVALUATION-v1" as const;
export const M216_RESEARCH_DATASET_FILE = "_m216_research/research_instances.jsonl" as const;

export interface ResearchInstance {
  readonly instanceId: string;
  readonly repo: string;
  readonly baseCommit: string;
  readonly image: string;
  readonly problemStatement: string;
}

/**
 * The two research instances, pinned by id and base commit.
 *
 * Two rather than one because §44 requires both arm orders to be exercised on
 * the real substrate, and one task can only demonstrate one of them.
 *
 * The first choice was psf/requests, on the reasoning that M192 found it is the
 * repository whose installed copy an unpinned workdir silently resolves — so it
 * would be the instance most likely to expose a source-identity mistake. It ran
 * the container controls fine and then sat at 0% CPU for fifteen minutes inside
 * the evaluator: `test_requests.py` makes live HTTP calls, so the official
 * evaluation blocks on the network until swebench's own timeout kills it. That
 * is a property of the fixture, not of the binding, and a research instance
 * whose evaluation cannot finish cannot demonstrate that the evaluator works.
 *
 * pylint's suites are offline and their FAIL_TO_PASS targets are single test
 * functions, so the real evaluator returns a real verdict in minutes.
 */
export const M216_RESEARCH_INSTANCES: readonly Omit<ResearchInstance, "problemStatement">[] =
  Object.freeze([
    Object.freeze({
      instanceId: "pylint-dev__pylint-7080",
      repo: "pylint-dev/pylint",
      baseCommit: "3c5eca2ded3dd2b59ebaf23eb289453b5d2930f0",
      image: "swebench/sweb.eval.x86_64.pylint-dev_1776_pylint-7080:latest",
    }),
    Object.freeze({
      instanceId: "pylint-dev__pylint-6903",
      repo: "pylint-dev/pylint",
      baseCommit: "ca80f03a43bc39e4cc2c67dc99817b3c9f13b8a6",
      image: "swebench/sweb.eval.x86_64.pylint-dev_1776_pylint-6903:latest",
    }),
  ]);

/**
 * §12's prerequisite, asserted before a container is started rather than after.
 *
 * The check is against the frozen manifest's own instance ids, read from the
 * committed artifact, so it cannot drift from the population it is protecting.
 */
export function assertNotInFrozenPopulation(
  instanceIds: readonly string[], frozenInstanceIds: ReadonlySet<string>,
): readonly string[] {
  return instanceIds.filter((id) => frozenInstanceIds.has(id));
}

export function frozenInstanceIds(manifestRows: readonly RunManifestRow[]): ReadonlySet<string> {
  return new Set(manifestRows.map((row) => row.instanceId));
}

/**
 * A research row shaped exactly like a manifest row.
 *
 * Shaped exactly, because the point of the integration control is to traverse
 * the production path. A row with a different shape would exercise a different
 * branch, and the thing being tested is the branch the cohort will take.
 */
export function researchRow(
  instance: Omit<ResearchInstance, "problemStatement">,
  arm: M214Arm,
  armOrder: readonly M214Arm[],
  executionOrder: number,
  vtraceProductTreeSha: string,
  vtraceCommit: string,
): RunManifestRow {
  return {
    runId: `${M216_RESEARCH_EXPERIMENT}:${instance.instanceId}:${arm}`,
    instanceId: instance.instanceId,
    repo: instance.repo,
    baseCommit: instance.baseCommit,
    arm,
    pairedTaskId: instance.instanceId,
    armOrderIndex: armOrder.indexOf(arm),
    armOrder: [...armOrder],
    executionOrder,
    seed: M216_RESEARCH_SEED,
    agentVersion: M214_AGENT.version,
    model: M214_MODEL.model,
    vtraceCommit: arm === "vtrace" ? vtraceCommit : null,
    vtraceProductTreeSha: arm === "vtrace" ? vtraceProductTreeSha : null,
    containerImage: instance.image,
    budgetIdentity: budgetIdentity(),
    maxTurns: M214_BUDGET.maxTurns,
    perRunCostCapUsd: M214_BUDGET.perRunCostCapUsd,
    status: "PLANNED",
  } as RunManifestRow;
}

export interface ResearchManifest {
  readonly rows: readonly RunManifestRow[];
  readonly manifestHash: string;
}

/**
 * Build the research manifest for a given pair order.
 *
 * `orders` names, per instance, which arm runs first. §44 wants both, and the
 * caller supplies them explicitly rather than the builder choosing, because a
 * builder that picked the order would be making an experiment decision.
 */
export function buildResearchManifest(
  orders: readonly (readonly [string, readonly M214Arm[]])[],
  vtraceProductTreeSha: string,
  vtraceCommit: string,
): ResearchManifest {
  const rows: RunManifestRow[] = [];
  let order = 0;
  for (const [instanceId, armOrder] of orders) {
    const instance = M216_RESEARCH_INSTANCES.find((entry) => entry.instanceId === instanceId);
    if (instance === undefined) throw new Error(`unknown research instance: ${instanceId}`);
    for (const arm of armOrder) {
      rows.push(researchRow(instance, arm, armOrder, order++, vtraceProductTreeSha, vtraceCommit));
    }
  }
  return { rows: Object.freeze(rows), manifestHash: m214ManifestHash(rows) };
}

function verification(artifact: string, digest: string): HashVerification {
  return { artifact, expected: digest, actual: digest, verified: true };
}

/**
 * Authorities for a research run: the real preregistration, the real external
 * reference, and a manifest that is deliberately NOT the frozen one.
 *
 * The preregistration and external-reference digests are the genuine committed
 * ones and are checked against the frozen constants by the caller, so a research
 * run still cannot proceed against a mutated experiment. Only the manifest is
 * substituted, and substituting it is what makes the result unable to enter the
 * cohort.
 */
export function researchAuthorities(
  frozen: FrozenAuthorities, manifest: ResearchManifest,
): FrozenAuthorities {
  return {
    preregistration: frozen.preregistration,
    manifest: manifest.rows,
    externalReference: frozen.externalReference,
    preregistrationHash: frozen.preregistrationHash,
    manifestHash: verification("stage5_m216_research_manifest (NON_EVALUATION)", manifest.manifestHash),
    externalReferenceHash: frozen.externalReferenceHash,
    verified: frozen.preregistrationHash.verified && frozen.externalReferenceHash.verified,
    issues: Object.freeze(
      frozen.preregistrationHash.verified && frozen.externalReferenceHash.verified
        ? []
        : ["the frozen preregistration or external reference does not verify"],
    ),
  };
}

// ── The research dataset, for the real evaluator ────────────────────

export interface ResearchDataset {
  readonly path: string;
  readonly instances: readonly ResearchInstance[];
  readonly present: boolean;
}

/**
 * Load the generated research dataset.
 *
 * It is generated rather than committed because it carries SWE-bench gold
 * patches and FAIL_TO_PASS lists, which are exactly the artifacts §28 forbids
 * from reaching an agent. It lives outside the tracked tree and is never on any
 * path an arm can read.
 */
export function loadResearchDataset(resultsDir: string): ResearchDataset {
  const path = join(resultsDir, M216_RESEARCH_DATASET_FILE);
  if (!existsSync(path)) return { path, instances: Object.freeze([]), present: false };
  const instances: ResearchInstance[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (line.trim().length === 0) continue;
    const row = JSON.parse(line) as Record<string, unknown>;
    const instanceId = String(row.instance_id);
    const pinned = M216_RESEARCH_INSTANCES.find((entry) => entry.instanceId === instanceId);
    if (pinned === undefined) continue;
    instances.push({
      ...pinned,
      problemStatement: String(row.problem_statement ?? ""),
    });
  }
  return { path, instances: Object.freeze(instances), present: instances.length > 0 };
}

export function researchDatasetDigest(dataset: ResearchDataset): string {
  return createHash("sha256")
    .update(dataset.instances.map((entry) => `${entry.instanceId}:${entry.baseCommit}`).join("\n"))
    .digest("hex");
}
