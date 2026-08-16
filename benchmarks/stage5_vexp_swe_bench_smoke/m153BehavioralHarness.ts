// Shared harness for running the behavioural cross-repository corpus through
// the REAL product surface, in the two modes M153 must keep apart (§25).
//
//   ORACLE mode     the context is bound directly to the known-correct
//                   repository, so routing is bypassed entirely. Measures
//                   in-repository behavioural retrieval — i.e. M150.
//
//   WORKSPACE mode  the context is bound to a host carrying a workspace that
//                   registers every corpus repository, and the request names no
//                   path and no symbol. Measures repository nomination.
//
// Keeping them separate is the whole point: a routing defect and a retrieval
// defect produce the same wrong answer, and only running both tells them apart.
//
// No agent, Docker, VEXP, network or paid API.

import { execFile as execFileCallback } from "node:child_process";
import { existsSync, rmSync, statSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { initRepo } from "../../src/setup/initRepo";
import { resolveRepoLocalPaths } from "../../src/setup/repoState";
import { defaultMcpToolRegistry } from "../../src/mcp/tools";
import { MCP_SERVER_ID, MCP_SERVER_SCHEMA, McpToolId } from "../../src/mcp/types";
import type { McpServerContext } from "../../src/mcp/types";
import { resolveWorkspaceConfigPath, writeWorkspaceConfig } from "../../src/workspace/config";
import { resolveSessionDbPath } from "../../src/session/sessionStore";

import {
  BEHAVIORAL_CASES,
  CORPUS_REPOSITORIES,
  type BehavioralCase,
} from "./behavioralCrossRepoCorpus";

const execFile = promisify(execFileCallback);

export const CROSS_REPO_ROOT = path.join(
  import.meta.dir,
  "results/workspaces/cross_repo",
);

export function repoRootFor(key: string): string {
  const repo = CORPUS_REPOSITORIES.find((entry) => entry.key === key);
  if (repo === undefined) throw new Error(`unknown corpus repository: ${key}`);
  return path.join(CROSS_REPO_ROOT, repo.instanceId);
}

export function contextBoundTo(repoRoot: string): McpServerContext {
  const paths = resolveRepoLocalPaths(repoRoot);
  return {
    serverId: MCP_SERVER_ID,
    repoRoot,
    dbPath: paths.dbPath,
    configPath: paths.configPath,
    statePath: paths.statePath,
    initialized: true,
    config: null,
    state: null,
  } as McpServerContext;
}

export async function callTool(
  context: McpServerContext,
  toolId: McpToolId,
  input: Record<string, unknown>,
): Promise<any> {
  return (await defaultMcpToolRegistry.getByToolId(toolId)!.handler({
    context,
    request: { schema: MCP_SERVER_SCHEMA, requestId: "m153", toolId, input },
  })) as any;
}

/**
 * Index a repository and migrate its product state into `session.sqlite`.
 *
 * Two things make this less obvious than it looks. `initRepo` alone leaves the
 * pre-M152 mixed layout in place, which the product correctly refuses to read,
 * so `index_repo` has to follow it to perform the migration. And `initRepo` is
 * not idempotent over an existing index — a second call fails on
 * `UNIQUE constraint failed: edges.id` — so the store is removed first rather
 * than rebuilt in place. Wiping also means every baseline starts from a tree
 * indexed by the code under measurement, which is what makes the two sides of a
 * paired comparison comparable at all.
 */
export async function prepareRepository(repoRoot: string): Promise<void> {
  await rm(path.join(repoRoot, ".vtrace"), { recursive: true, force: true });
  await initRepo({ repoPath: repoRoot });
  const result = await callTool(contextBoundTo(repoRoot), McpToolId.IndexRepo, {});
  if (result.ok !== true) {
    throw new Error(`index_repo failed for ${repoRoot}: ${result.error?.message ?? "unknown"}`);
  }
}

/**
 * Discard every corpus repository's mutable product state, leaving its index
 * untouched.
 *
 * WHY A BENCHMARK NEEDS THIS
 * --------------------------
 * M152 gave product state its own lifecycle, which is correct, and the
 * consequence for benchmarking is that runs stop being independent. Two effects
 * were measured, not theorised:
 *
 *   - re-running a corpus with `--skip-prepare` changed delivered item counts,
 *     because observations written by the previous run were still there;
 *   - with the behavioural lane enabled, a workspace request routed to a
 *     DIFFERENT repository, and that repository then accumulated observations
 *     which perturbed later oracle calls in the same pass — so the arm under
 *     test was changing its own control.
 *
 * Neither is a product defect: §97 permits the final delivery to write. Both
 * make a paired comparison meaningless, because the arms no longer start from
 * the same state.
 *
 * Only `session.sqlite` is removed. The index is repository-derived evidence and
 * rebuilding it would be both wasteful and a different experiment; the product
 * recreates the session store on demand, verified to return identical context
 * before and after.
 */
export function resetSessionState(repoRoots: readonly string[]): void {
  for (const root of repoRoots) {
    rmSync(resolveSessionDbPath(root), { force: true });
  }
}

/** Every repository a run may write product state into, including the host. */
export function sessionScopeFor(hostRoot: string): readonly string[] {
  return [...CORPUS_REPOSITORIES.map((repo) => repoRootFor(repo.key)), hostRoot];
}

/**
 * A fingerprint of a repository's mutable product state. Used to PROVE the
 * paired-arm invariant rather than assert it: both arms must start each case
 * from the same fingerprint, and neither may inherit the other's writes.
 */
export function sessionFingerprint(repoRoot: string): { path: string; bytes: number } {
  const target = resolveSessionDbPath(repoRoot);
  return {
    path: target,
    bytes: existsSync(target) ? statSync(target).size : 0,
  };
}

export interface WorkspaceHostOptions {
  /** Where the host repository is created. */
  readonly hostRoot: string;
  /** Corpus repositories to register. Defaults to all of them. */
  readonly members?: readonly string[];
  /**
   * The configured default. M151 semantics make this the fallback when no lane
   * decides, so the baseline measures how often a request is answered by the
   * default rather than by evidence.
   */
  readonly primaryRepoAlias?: string;
  /** Extra members registered but not backed by a corpus repository (§62). */
  readonly syntheticMembers?: readonly { alias: string; rootPath: string }[];
}

/**
 * A host repository carrying the workspace config. It is deliberately NOT one of
 * the corpus repositories: making a member the host would give that member an
 * advantage no other member has, and the baseline is meant to measure routing,
 * not hosting.
 */
export async function buildWorkspaceHost(options: WorkspaceHostOptions): Promise<string> {
  const { hostRoot } = options;
  await mkdir(path.join(hostRoot, "src"), { recursive: true });
  await writeFile(
    path.join(hostRoot, "src", "host_marker.py"),
    "def host_marker_only():\n    return 'workspace host, not a corpus member'\n",
  );
  await execFile("git", ["init", "--initial-branch=main", hostRoot]);
  await execFile("git", ["-C", hostRoot, "config", "user.email", "m153@example.com"]);
  await execFile("git", ["-C", hostRoot, "config", "user.name", "M153"]);
  await execFile("git", ["-C", hostRoot, "add", "."]);
  await execFile("git", ["-C", hostRoot, "commit", "-m", "workspace host"]);
  await prepareRepository(hostRoot);

  const memberKeys = options.members ?? CORPUS_REPOSITORIES.map((repo) => repo.key);
  const repos = [
    ...memberKeys.map((key) => ({ alias: key, rootPath: repoRootFor(key), enabled: true })),
    ...(options.syntheticMembers ?? []).map((member) => ({ ...member, enabled: true })),
  ];

  await writeWorkspaceConfig(resolveWorkspaceConfigPath(hostRoot), {
    schemaVersion: "1.0.0",
    name: "behavioral_cross_repo",
    primaryRepoAlias: options.primaryRepoAlias ?? memberKeys[0]!,
    repos,
  } as never);

  return hostRoot;
}

export interface DeliveredItem {
  readonly path: string;
  readonly symbol: string;
  readonly roles: readonly string[];
}

/** How a delivered item relates to the case's ground truth (§24). */
export const ItemClass = Object.freeze({
  Relevant: "RELEVANT",
  UsefulSupport: "USEFUL_SUPPORT",
  Neutral: "NEUTRAL",
  Misleading: "MISLEADING",
});
export type ItemClass = (typeof ItemClass)[keyof typeof ItemClass];

/**
 * The index stores a symbol by its LEAF name, so `Session.get_adapter` is
 * delivered as `get_adapter` in `requests/sessions.py`. Matching on
 * (path, leaf) is therefore what the corpus's dotted FQNs mean in practice.
 */
function leafOf(fqName: string): { path: string; leaf: string } {
  const [filePath, symbol = ""] = fqName.split("::");
  const segments = symbol.split(".");
  return { path: filePath ?? "", leaf: segments[segments.length - 1] ?? "" };
}

function matches(item: DeliveredItem, fqName: string): boolean {
  const { path: filePath, leaf } = leafOf(fqName);
  return item.path === filePath && item.symbol === leaf;
}

export interface CaseOutcome {
  readonly caseId: string;
  readonly mode: "oracle" | "workspace";
  readonly ok: boolean;
  readonly errorCode: string | null;
  readonly routedRepository: string | null;
  readonly routeOutcome: string | null;
  readonly routeSource: string | null;
  readonly decidingTier: string | null;
  readonly abstained: boolean;
  readonly itemsDelivered: number;
  readonly delivered: readonly { path: string; symbol: string; class: ItemClass }[];
  readonly repositoryCorrect: boolean | null;
  readonly primaryTop1: boolean;
  readonly primaryTop3: boolean;
  readonly requiredSupportPresent: boolean;
  readonly misleadingDelivered: number;
  readonly emptyContext: boolean;
  readonly falsePremiseReconstructed: boolean | null;
  readonly absenceHeld: boolean | null;
  readonly cleanAnswer: boolean;
  readonly latencyMs: number;
  readonly routingBytes: number;
}

/** Alias of the corpus repository a delivered path belongs to, if any. */
function repositoryOfRoute(result: any): string | null {
  const routing = result.ok
    ? result.output?.workspaceRouting
    : result.error?.details?.workspaceRouting;
  return routing?.leadRepository ?? null;
}

export function scoreCase(
  entry: BehavioralCase,
  result: any,
  mode: "oracle" | "workspace",
  latencyMs: number,
): CaseOutcome {
  const routing = result.ok
    ? result.output?.workspaceRouting
    : result.error?.details?.workspaceRouting;
  const items: DeliveredItem[] = (result.output?.productContext?.items ?? []).map((item: any) => ({
    path: item.path,
    symbol: item.symbol,
    roles: item.roles ?? [],
  }));

  const primaries = entry.expected.filter((e) => e.role === "PRIMARY_IMPLEMENTER");
  const required = entry.expected.filter((e) => e.role !== "PRIMARY_IMPLEMENTER" && e.role !== "CONSUMER");
  const alternates = entry.acceptableAlternates ?? [];

  const classify = (item: DeliveredItem): ItemClass => {
    if (entry.expected.some((e) => matches(item, e.fqName))) return ItemClass.Relevant;
    if (alternates.some((a) => matches(item, a))) return ItemClass.UsefulSupport;
    if (entry.distractors.some((d) => matches(item, d.fqName))) return ItemClass.Misleading;
    return ItemClass.Neutral;
  };

  const delivered = items.map((item) => ({
    path: item.path,
    symbol: item.symbol,
    class: classify(item),
  }));

  const indexOfPrimary = items.findIndex((item) => primaries.some((p) => matches(item, p.fqName)));
  const primaryTop1 = indexOfPrimary === 0;
  const primaryTop3 = indexOfPrimary >= 0 && indexOfPrimary < 3;
  const requiredSupportPresent = required.length === 0
    || required.every((r) => items.some((item) => matches(item, r.fqName)));
  const misleadingDelivered = delivered.filter((d) => d.class === ItemClass.Misleading).length;
  const emptyContext = items.length === 0;

  // §84: for a false-premise request, success is reconstructing the real
  // mechanism — delivering at least one genuinely expected definition — rather
  // than returning nothing or returning only the attractive wrong symbol.
  const falsePremiseReconstructed = entry.falsePremise && entry.expectAbsence !== true
    ? indexOfPrimary >= 0
    : null;

  // §86/§87: an explicit identifier lookup for a symbol that does not exist must
  // NOT answer with the mechanism its prose twin correctly reconstructs.
  const absenceHeld = entry.expectAbsence === true
    ? emptyContext || delivered.every((d) => d.class !== ItemClass.Misleading)
    : null;

  const routedRepository = repositoryOfRoute(result);
  const repositoryCorrect = entry.expectedRepository === null
    ? null
    : mode === "oracle"
      ? true
      : routedRepository === entry.expectedRepository;

  const cleanAnswer = entry.expectAbsence === true
    ? absenceHeld === true
    : primaryTop1 && requiredSupportPresent && misleadingDelivered === 0;

  return {
    caseId: entry.id,
    mode,
    ok: result.ok === true,
    errorCode: result.ok === true ? null : (result.error?.code ?? null),
    routedRepository,
    routeOutcome: routing?.outcome ?? null,
    routeSource: routing?.routeSource ?? null,
    decidingTier: routing?.decidingTier ?? null,
    abstained: routing?.outcome === "abstained",
    itemsDelivered: items.length,
    delivered,
    repositoryCorrect,
    primaryTop1,
    primaryTop3,
    requiredSupportPresent,
    misleadingDelivered,
    emptyContext,
    falsePremiseReconstructed,
    absenceHeld,
    cleanAnswer,
    latencyMs,
    routingBytes: routing === undefined || routing === null ? 0 : JSON.stringify(routing).length,
  };
}

export async function runCase(
  entry: BehavioralCase,
  mode: "oracle" | "workspace",
  hostRoot: string,
): Promise<CaseOutcome> {
  // An ambiguous case has no oracle repository by construction.
  if (mode === "oracle" && entry.expectedRepository === null) {
    return scoreCase(entry, { ok: false, error: { code: "no_oracle_repository" } }, mode, 0);
  }
  const root = mode === "oracle" ? repoRootFor(entry.expectedRepository!) : hostRoot;
  const started = Date.now();
  const result = await callTool(contextBoundTo(root), McpToolId.GetCodeContext, {
    query: entry.query,
  });
  return scoreCase(entry, result, mode, Date.now() - started);
}

export function aggregate(outcomes: readonly CaseOutcome[], cases: readonly BehavioralCase[]) {
  const byId = new Map(cases.map((entry) => [entry.id, entry]));
  const scored = outcomes.filter((outcome) => {
    const entry = byId.get(outcome.caseId);
    return entry !== undefined && entry.expectAbsence !== true && entry.ambiguous !== true;
  });
  const absence = outcomes.filter((o) => byId.get(o.caseId)?.expectAbsence === true);
  const falsePremise = outcomes.filter((o) => {
    const entry = byId.get(o.caseId);
    return entry?.falsePremise === true && entry.expectAbsence !== true;
  });
  const routable = outcomes.filter((o) => byId.get(o.caseId)?.expectedRepository != null);
  const pct = (n: number, d: number) => (d === 0 ? null : Number(((n / d) * 100).toFixed(1)));

  return {
    casesScored: scored.length,
    repositoryTop1: pct(routable.filter((o) => o.repositoryCorrect === true).length, routable.length),
    primaryTop1: pct(scored.filter((o) => o.primaryTop1).length, scored.length),
    primaryTop3: pct(scored.filter((o) => o.primaryTop3).length, scored.length),
    requiredSupportPresent: pct(scored.filter((o) => o.requiredSupportPresent).length, scored.length),
    falsePremiseReconstructed: pct(
      falsePremise.filter((o) => o.falsePremiseReconstructed === true).length,
      falsePremise.length,
    ),
    absenceHeld: pct(absence.filter((o) => o.absenceHeld === true).length, absence.length),
    casesWithMisleading: pct(scored.filter((o) => o.misleadingDelivered > 0).length, scored.length),
    misleadingPerCase: scored.length === 0
      ? null
      : Number((scored.reduce((sum, o) => sum + o.misleadingDelivered, 0) / scored.length).toFixed(2)),
    emptyContext: pct(scored.filter((o) => o.emptyContext).length, scored.length),
    cleanAnswerRate: pct(scored.filter((o) => o.cleanAnswer).length, scored.length),
    abstentions: outcomes.filter((o) => o.abstained).length,
    errors: outcomes.filter((o) => !o.ok).length,
  };
}

export { BEHAVIORAL_CASES };
