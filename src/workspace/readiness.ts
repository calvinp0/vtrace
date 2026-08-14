// M145 Workstream F: readiness across a workspace, without a lie at the top.
//
// M141 made readiness one authoritative evaluation per worktree, decomposed into
// dimensions that are all evaluated rather than short-circuited. A workspace does
// not get to collapse several of those into a single boolean: §55/§57 forbid
// `ready=true` for a workspace holding one stale member, because a request may
// route to exactly that member.
//
// So the workspace answer is a COUNT, and the gate is per member. An A-routed
// request consults A's readiness and nothing else — B being stale is B's problem
// (§58), and A being stale fails closed even when B is fine (§94).
//
// Registration compatibility sits ALONGSIDE M141's dimensions rather than inside
// them. M141's `repositoryCompatible` asks whether the stored INDEX belongs to
// this worktree; registration asks whether the repository the workspace REGISTERED
// is still the one at that path. Both can fail independently, and folding them
// together would blur exactly the distinction §147 asks M145 to sharpen.

import {
  evaluateIndexReadiness,
  summarizeIndexReadiness,
  type IndexReadinessSummary,
} from "../indexer/indexReadiness";
import { RegistrationStatus, type RegisteredRepository, type WorkspaceRegistry } from "./registry";

export interface WorkspaceRepoReadiness {
  readonly alias: string;
  readonly rootPath: string;
  readonly repositoryId: string | null;
  readonly worktreeId: string | null;
  readonly enabled: boolean;
  readonly registration: RegistrationStatus;
  /** null when the registered path could not be resolved at all. */
  readonly index: IndexReadinessSummary | null;
  /** True only when the registration is sound AND the index is usable. */
  readonly ready: boolean;
  readonly reason: string;
}

export interface WorkspaceReadiness {
  readonly workspaceId: string;
  readonly total: number;
  readonly ready: number;
  readonly stale: number;
  readonly missing: number;
  readonly mismatched: number;
  readonly unavailable: number;
  readonly repos: readonly WorkspaceRepoReadiness[];
}

/**
 * Evaluate every registered member. Identity resolved by the registry is reused
 * rather than re-derived, so this costs no additional Git subprocess (§117).
 */
export async function evaluateWorkspaceReadiness(
  registry: WorkspaceRegistry,
  options: { readonly probe?: "manifest" | "full" } = {},
): Promise<WorkspaceReadiness> {
  const repos = await Promise.all(
    registry.repositories.map((repo) => evaluateRepoReadiness(repo, options.probe ?? "manifest")),
  );

  return {
    workspaceId: registry.workspaceId,
    total: repos.length,
    ready: repos.filter((repo) => repo.ready).length,
    stale: repos.filter((repo) => repo.index?.state === "source_stale").length,
    missing: repos.filter((repo) => repo.index?.state === "index_missing").length,
    mismatched: repos.filter((repo) => repo.registration === RegistrationStatus.Mismatch).length,
    unavailable: repos.filter((repo) => repo.registration === RegistrationStatus.Unavailable).length,
    repos,
  };
}

export async function evaluateRepoReadiness(
  repository: RegisteredRepository,
  probe: "manifest" | "full" = "manifest",
): Promise<WorkspaceRepoReadiness> {
  const base = {
    alias: repository.alias,
    rootPath: repository.rootPath,
    repositoryId: repository.repositoryId,
    worktreeId: repository.worktreeId,
    enabled: repository.enabled,
    registration: repository.registration,
  };

  if (repository.identity === null || repository.registration === RegistrationStatus.Unavailable) {
    return {
      ...base,
      index: null,
      ready: false,
      reason: `Registered path cannot be resolved as a worktree: ${repository.rootPath}`,
    };
  }

  // A registration mismatch is decided before the index is consulted. The index
  // under a replaced checkout may look perfectly fresh for the repository it was
  // built from; that is precisely why it must not answer for this one.
  if (repository.registration === RegistrationStatus.Mismatch) {
    return {
      ...base,
      index: null,
      ready: false,
      reason: `A different repository now occupies ${repository.rootPath} (${repository.registrationMismatches.join(", ")}).`,
    };
  }

  const readiness = await evaluateIndexReadiness(repository.rootPath, {
    identity: repository.identity,
    probe,
  });
  const index = summarizeIndexReadiness(readiness);

  return {
    ...base,
    index,
    ready: index.ready,
    reason: index.ready ? "ready" : `${index.state} (${index.reason})`,
  };
}
