// M145 Workstream D: what a workspace IS, and which member a request addresses.
//
// WHAT WAS ALREADY TRUE
// ----------------
// A workspace config already existed: aliases, root paths, a primary alias. What
// it never had was identity. Every entry was keyed on an alias and a path
// string, so the config could say only "there is a directory here called `arc`",
// and both halves of that are display metadata. §43 is not a style rule — an
// alias is chosen by a human, a basename is chosen by whoever cloned, and
// neither survives the repository at that path being replaced.
//
// WHAT THIS ADDS
// ----------------
// Every registered entry is resolved to its canonical repository/worktree
// identity ONCE, at registry load, and routing then happens against identity.
// That placement is deliberate: §117 forbids `git rev-parse` per candidate or
// per path, and identity is a property of the workspace, not of a query.
//
// The registry also validates registrations against recorded identity. §109's
// control — register a repository at a path, delete it, put an unrelated one
// there, reuse the workspace metadata — must not report `ready`, and before
// M145 it did: `repositoryId` and `worktreeId` are hashes of PATHS, so both
// matched across the swap. Instance evidence is what makes the swap visible.
//
// WHAT THIS DELIBERATELY DOES NOT DO
// ----------------
// It never chooses a repository because a query mentions one, and never ranks
// members. Routing consumes an explicit selector or fails with bounded
// ambiguity metadata. Which repository is RELEVANT is M146's question; this
// module only answers which one was ADDRESSED.

import { realpathSync } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";

import {
  compareInstanceFingerprints,
  resolveWorktreeIdentity,
  type ResolvedWorktreeIdentity,
} from "../indexer/worktreeIdentity";
import type { ResolvedWorkspaceConfig, ResolvedWorkspaceRepoConfig } from "./config";

/** Where a registration stands against the repository actually on disk now. */
export const RegistrationStatus = Object.freeze({
  /** The entry records no identity to check. Cannot fail; cannot vouch either. */
  Unrecorded: "unrecorded",
  /** Recorded identity matches what is on disk. */
  Verified: "verified",
  /** A different repository or worktree now occupies the registered path. */
  Mismatch: "mismatch",
  /** The registered path is gone, or is not a worktree any more. */
  Unavailable: "unavailable",
});

export type RegistrationStatus =
  (typeof RegistrationStatus)[keyof typeof RegistrationStatus];

export const WorkspaceRouteReason = Object.freeze({
  /** Several repositories are registered and nothing in the request picks one. */
  RepositoryRequired: "workspace_repository_required",
  /** The selector named something no registered member matches. */
  UnknownRepository: "workspace_repository_unknown",
  /** The selector matches more than one member. §30/§42: never pick one. */
  AmbiguousRepository: "workspace_repository_ambiguous",
  /** The member exists but its registered path no longer holds that repository. */
  RegistrationStale: "workspace_registration_stale",
});

export type WorkspaceRouteReason =
  (typeof WorkspaceRouteReason)[keyof typeof WorkspaceRouteReason];

/** Which field of the request selected the member. Provenance, not a guess. */
export const WorkspaceRouteSource = Object.freeze({
  WorktreeId: "worktree_id",
  RepositoryId: "repository_id",
  Path: "path",
  Alias: "alias",
  DisplayName: "display_name",
  Cwd: "cwd",
  /** The single registered member, or an explicitly configured default. */
  SoleMember: "sole_member",
  ConfiguredDefault: "configured_default",
});

export type WorkspaceRouteSource =
  (typeof WorkspaceRouteSource)[keyof typeof WorkspaceRouteSource];

export interface RegisteredRepository {
  /** Unique within the workspace by config validation. Display metadata. */
  readonly alias: string;
  /** Directory basename. NOT unique, NOT identity — see §42. */
  readonly displayName: string;
  readonly rootPath: string;
  readonly statePath: string;
  readonly dbPath: string;
  readonly configPath: string;
  readonly enabled: boolean;
  /** null when the registered path could not be resolved at all. */
  readonly identity: ResolvedWorktreeIdentity | null;
  readonly repositoryId: string | null;
  readonly worktreeId: string | null;
  readonly registration: RegistrationStatus;
  /** Which recorded fields disagreed. Empty unless `registration` is a mismatch. */
  readonly registrationMismatches: readonly string[];
}

export interface WorkspaceRegistry {
  /** Stable across restarts: derived from the canonical config location. */
  readonly workspaceId: string;
  readonly configPath: string | null;
  /** False when this is the implicit single-repository workspace. */
  readonly isWorkspace: boolean;
  readonly repositories: readonly RegisteredRepository[];
  /** An alias only when the config named one; never "the first entry" (§75). */
  readonly defaultAlias: string | null;
}

export interface WorkspaceRouteSelector {
  readonly worktreeId?: string | undefined;
  readonly repositoryId?: string | undefined;
  readonly alias?: string | undefined;
  /** An explicit repository path, or any path inside one. */
  readonly repoPath?: string | undefined;
  /** Caller working directory, when a runtime can supply one. */
  readonly cwd?: string | undefined;
}

export interface WorkspaceRouteFailure {
  readonly ok: false;
  readonly reason: WorkspaceRouteReason;
  readonly message: string;
  /** Bounded ambiguity metadata (§59): who matched, never why one would win. */
  readonly candidates: readonly { readonly alias: string; readonly worktreeId: string | null; readonly rootPath: string }[];
  readonly availableRepos: readonly string[];
}

export type WorkspaceRouteResult =
  | { readonly ok: true; readonly repository: RegisteredRepository; readonly source: WorkspaceRouteSource }
  | WorkspaceRouteFailure;

/** Identity recorded in the workspace config for one entry, when present. */
export interface RecordedRepoIdentity {
  readonly repositoryId?: string | undefined;
  readonly worktreeId?: string | undefined;
  readonly repositoryInstance?: string | null | undefined;
  readonly worktreeInstance?: string | null | undefined;
}

export interface ResolveWorkspaceRegistryInput {
  readonly config?: ResolvedWorkspaceConfig | undefined;
  /** The implicit single-repository workspace when no config exists. */
  readonly fallbackRepo?: ResolvedWorkspaceRepoConfig | undefined;
}

/**
 * Resolve every registered entry's identity once. Costs one identity resolution
 * per member — resolved here so that routing, membership, readiness and
 * provenance all read the same answer instead of each re-deriving it.
 */
export async function resolveWorkspaceRegistry(
  input: ResolveWorkspaceRegistryInput,
): Promise<WorkspaceRegistry> {
  const specs = input.config?.repos ?? (input.fallbackRepo === undefined ? [] : [input.fallbackRepo]);
  const repositories = await Promise.all(specs.map((spec) => resolveRegisteredRepository(spec)));

  return {
    workspaceId: workspaceIdFor(input.config?.configPath ?? input.fallbackRepo?.rootPath ?? null),
    configPath: input.config?.configPath ?? null,
    isWorkspace: input.config !== undefined,
    repositories,
    defaultAlias: resolveDefaultAlias(input.config, repositories),
  };
}

async function resolveRegisteredRepository(
  spec: ResolvedWorkspaceRepoConfig,
): Promise<RegisteredRepository> {
  const rootPath = path.resolve(spec.rootPath);
  const base = {
    alias: spec.alias,
    displayName: path.basename(rootPath),
    rootPath,
    statePath: spec.statePath,
    dbPath: spec.dbPath,
    configPath: spec.configPath,
    enabled: spec.enabled,
  };

  // A missing directory is UNAVAILABLE, not a mismatch. Identity resolution
  // answers for any path — a non-existent one still hashes to a non-Git id — so
  // asking it about a deleted registration would report "a different repository
  // is here" about a path where nothing is.
  let identity: ResolvedWorktreeIdentity | null = null;
  if (await isDirectory(rootPath)) {
    identity = await resolveWorktreeIdentity(rootPath).catch(() => null);
  }

  if (identity === null) {
    return {
      ...base,
      identity: null,
      repositoryId: null,
      worktreeId: null,
      registration: RegistrationStatus.Unavailable,
      registrationMismatches: ["root_unavailable"],
    };
  }

  const recorded = readRecordedIdentity(spec);
  const mismatches = compareRecordedIdentity(recorded, identity);

  return {
    ...base,
    identity,
    repositoryId: identity.repository.repositoryId,
    worktreeId: identity.worktree.worktreeId,
    registration: mismatches === null
      ? RegistrationStatus.Unrecorded
      : mismatches.length === 0
        ? RegistrationStatus.Verified
        : RegistrationStatus.Mismatch,
    registrationMismatches: mismatches ?? [],
  };
}

/**
 * `null` when the entry records nothing to check, so "unrecorded" stays distinct
 * from "checked and agreed". Path-derived ids are compared first and instance
 * evidence second, because only the second can see a replacement: after a swap
 * at the same path the ids are byte-identical by construction.
 */
export function compareRecordedIdentity(
  recorded: RecordedRepoIdentity,
  identity: ResolvedWorktreeIdentity,
): string[] | null {
  const declared = recorded.repositoryId !== undefined
    || recorded.worktreeId !== undefined
    || typeof recorded.repositoryInstance === "string"
    || typeof recorded.worktreeInstance === "string";
  if (!declared) return null;

  const mismatches: string[] = [];
  if (recorded.repositoryId !== undefined && recorded.repositoryId !== identity.repository.repositoryId) {
    mismatches.push("repositoryId");
  }
  if (recorded.worktreeId !== undefined && recorded.worktreeId !== identity.worktree.worktreeId) {
    mismatches.push("worktreeId");
  }
  if (compareInstanceFingerprints(recorded.repositoryInstance, identity.repository.instanceFingerprint) === false) {
    mismatches.push("repositoryInstance");
  }
  if (compareInstanceFingerprints(recorded.worktreeInstance, identity.worktree.instanceFingerprint) === false) {
    mismatches.push("worktreeInstance");
  }
  return mismatches;
}

function readRecordedIdentity(spec: ResolvedWorkspaceRepoConfig): RecordedRepoIdentity {
  return {
    ...(spec.repositoryId === undefined ? {} : { repositoryId: spec.repositoryId }),
    ...(spec.worktreeId === undefined ? {} : { worktreeId: spec.worktreeId }),
    ...(spec.repositoryInstance === undefined ? {} : { repositoryInstance: spec.repositoryInstance }),
    ...(spec.worktreeInstance === undefined ? {} : { worktreeInstance: spec.worktreeInstance }),
  };
}

/**
 * A default exists only when the config NAMED one and that alias is registered.
 * `primaryRepoAlias` falls back to the first entry when the file omits it, and
 * §75 rules that out as a routing default: iteration order is not a decision.
 */
function resolveDefaultAlias(
  config: ResolvedWorkspaceConfig | undefined,
  repositories: readonly RegisteredRepository[],
): string | null {
  if (config === undefined) return null;
  if (config.primaryRepoAliasExplicit !== true) return null;
  return repositories.some((repo) => repo.alias === config.primaryRepoAlias)
    ? config.primaryRepoAlias
    : null;
}

async function isDirectory(target: string): Promise<boolean> {
  try {
    return (await stat(target)).isDirectory();
  } catch {
    return false;
  }
}

function workspaceIdFor(seed: string | null): string {
  return seed === null ? "workspace:unbound" : `workspace:${path.resolve(seed)}`;
}

/**
 * Lookup tables built once per registry. Routing by identity or canonical path
 * is a map hit rather than a scan over members (§105/§106); display names get a
 * MULTI-map, because their whole purpose here is to detect collisions.
 */
export interface WorkspaceRouteIndex {
  readonly byWorktreeId: ReadonlyMap<string, RegisteredRepository>;
  readonly byRepositoryId: ReadonlyMap<string, readonly RegisteredRepository[]>;
  readonly byCanonicalPath: ReadonlyMap<string, RegisteredRepository>;
  readonly byAlias: ReadonlyMap<string, RegisteredRepository>;
  readonly byDisplayName: ReadonlyMap<string, readonly RegisteredRepository[]>;
}

export function buildWorkspaceRouteIndex(registry: WorkspaceRegistry): WorkspaceRouteIndex {
  const byWorktreeId = new Map<string, RegisteredRepository>();
  const byRepositoryId = new Map<string, RegisteredRepository[]>();
  const byCanonicalPath = new Map<string, RegisteredRepository>();
  const byAlias = new Map<string, RegisteredRepository>();
  const byDisplayName = new Map<string, RegisteredRepository[]>();

  for (const repo of registry.repositories) {
    byAlias.set(repo.alias, repo);
    push(byDisplayName, repo.displayName, repo);
    byCanonicalPath.set(repo.rootPath, repo);
    // Symlinked and canonical roots are the same worktree, so both spellings
    // must route to one entry rather than to a second, phantom member.
    const canonicalRoot = repo.identity?.worktree.worktreeRoot;
    if (canonicalRoot !== undefined) byCanonicalPath.set(canonicalRoot, repo);
    if (repo.worktreeId !== null) byWorktreeId.set(repo.worktreeId, repo);
    if (repo.repositoryId !== null) push(byRepositoryId, repo.repositoryId, repo);
  }

  return { byWorktreeId, byRepositoryId, byCanonicalPath, byAlias, byDisplayName };
}

function push<T>(map: Map<string, T[]>, key: string, value: T): void {
  const bucket = map.get(key);
  if (bucket === undefined) map.set(key, [value]);
  else bucket.push(value);
}

/**
 * Resolve which registered member a request addresses.
 *
 * Precedence runs from most specific to least: an identity beats a path, a path
 * beats a name, and a name beats an ambient default. Nothing in the query text
 * participates.
 */
export function routeWorkspaceRequest(
  registry: WorkspaceRegistry,
  selector: WorkspaceRouteSelector,
  index: WorkspaceRouteIndex = buildWorkspaceRouteIndex(registry),
): WorkspaceRouteResult {
  const available = registry.repositories.map((repo) => repo.alias);

  if (selector.worktreeId !== undefined) {
    const repo = index.byWorktreeId.get(selector.worktreeId);
    return repo === undefined
      ? unknown(`No registered worktree has id ${selector.worktreeId}.`, available)
      : validated(repo, WorkspaceRouteSource.WorktreeId, available);
  }

  if (selector.repositoryId !== undefined) {
    const repos = index.byRepositoryId.get(selector.repositoryId) ?? [];
    if (repos.length === 0) {
      return unknown(`No registered repository has id ${selector.repositoryId}.`, available);
    }
    // One repository, several registered worktrees: a repository id addresses a
    // repository, and a request has to run against exactly one working tree.
    if (repos.length > 1) {
      return ambiguous(
        `Repository ${selector.repositoryId} is registered as ${repos.length} worktrees. Select one by worktree id or path.`,
        repos,
        available,
      );
    }
    return validated(repos[0]!, WorkspaceRouteSource.RepositoryId, available);
  }

  if (selector.repoPath !== undefined) {
    const repo = matchByPath(registry, index, selector.repoPath);
    return repo === undefined
      ? unknown(`No registered repository contains ${path.resolve(selector.repoPath)}.`, available)
      : validated(repo, WorkspaceRouteSource.Path, available);
  }

  if (selector.alias !== undefined) {
    const byAlias = index.byAlias.get(selector.alias);
    if (byAlias !== undefined) return validated(byAlias, WorkspaceRouteSource.Alias, available);
    const byName = index.byDisplayName.get(selector.alias) ?? [];
    if (byName.length === 0) {
      return unknown(`Unknown workspace repo: ${selector.alias}.`, available);
    }
    if (byName.length > 1) {
      return ambiguous(
        `${byName.length} registered repositories are named ${selector.alias}. Select one by alias, worktree id, or path.`,
        byName,
        available,
      );
    }
    return validated(byName[0]!, WorkspaceRouteSource.DisplayName, available);
  }

  if (selector.cwd !== undefined) {
    const repo = matchByPath(registry, index, selector.cwd);
    if (repo !== undefined) return validated(repo, WorkspaceRouteSource.Cwd, available);
    // A cwd at the workspace root belongs to no member. Falling through to the
    // default is correct; guessing among members is what §76 forbids.
  }

  if (registry.repositories.length === 1) {
    return validated(registry.repositories[0]!, WorkspaceRouteSource.SoleMember, available);
  }

  if (registry.defaultAlias !== null) {
    const repo = index.byAlias.get(registry.defaultAlias);
    if (repo !== undefined) return validated(repo, WorkspaceRouteSource.ConfiguredDefault, available);
  }

  return {
    ok: false,
    reason: WorkspaceRouteReason.RepositoryRequired,
    message: registry.repositories.length === 0
      ? "No repositories are registered in this workspace."
      : `This workspace registers ${registry.repositories.length} repositories and the request names none. Pass a repository alias, worktree id, or root path.`,
    candidates: registry.repositories.map(describeCandidate),
    availableRepos: available,
  };
}

/**
 * Exact canonical root first, then the deepest containing root. Depth ordering
 * is what makes a cwd inside a nested or sibling worktree route to THAT worktree
 * rather than to whichever ancestor happens to be registered too (M132).
 */
function matchByPath(
  registry: WorkspaceRegistry,
  index: WorkspaceRouteIndex,
  candidatePath: string,
): RegisteredRepository | undefined {
  // Both spellings are tried: registered roots are stored canonicalised, so a
  // symlinked path only meets them after resolution, while a path under a
  // directory that no longer exists can still be matched literally.
  const resolved = path.resolve(candidatePath);
  const canonical = canonicalizePath(resolved);
  for (const spelling of canonical === resolved ? [resolved] : [resolved, canonical]) {
    const exact = index.byCanonicalPath.get(spelling);
    if (exact !== undefined) return exact;
  }

  let deepest: RegisteredRepository | undefined;
  let deepestLength = -1;
  for (const repo of registry.repositories) {
    for (const root of [repo.rootPath, repo.identity?.worktree.worktreeRoot]) {
      if (root === undefined) continue;
      const contains = [resolved, canonical].some((spelling) => (
        spelling === root || spelling.startsWith(`${root}${path.sep}`)
      ));
      if (!contains) continue;
      if (root.length > deepestLength) {
        deepest = repo;
        deepestLength = root.length;
      }
    }
  }
  return deepest;
}

function canonicalizePath(target: string): string {
  try {
    return realpathSync(target);
  } catch {
    return target;
  }
}

/**
 * A member that resolved by identity can still be unusable: the path may be gone
 * or now hold a different repository. Routing reports that instead of handing
 * back a member whose index would answer for something else.
 */
function validated(
  repository: RegisteredRepository,
  source: WorkspaceRouteSource,
  available: readonly string[],
): WorkspaceRouteResult {
  if (repository.registration === RegistrationStatus.Unavailable) {
    return {
      ok: false,
      reason: WorkspaceRouteReason.RegistrationStale,
      message: `Workspace repo ${repository.alias} is registered at ${repository.rootPath}, which cannot be resolved as a worktree.`,
      candidates: [describeCandidate(repository)],
      availableRepos: available,
    };
  }
  if (repository.registration === RegistrationStatus.Mismatch) {
    return {
      ok: false,
      reason: WorkspaceRouteReason.RegistrationStale,
      message: `Workspace repo ${repository.alias} no longer matches the repository recorded at ${repository.rootPath} (${repository.registrationMismatches.join(", ")}). Re-register it before querying.`,
      candidates: [describeCandidate(repository)],
      availableRepos: available,
    };
  }
  return { ok: true, repository, source };
}

function unknown(message: string, available: readonly string[]): WorkspaceRouteFailure {
  return {
    ok: false,
    reason: WorkspaceRouteReason.UnknownRepository,
    message,
    candidates: [],
    availableRepos: available,
  };
}

function ambiguous(
  message: string,
  candidates: readonly RegisteredRepository[],
  available: readonly string[],
): WorkspaceRouteFailure {
  return {
    ok: false,
    reason: WorkspaceRouteReason.AmbiguousRepository,
    message,
    candidates: candidates.map(describeCandidate),
    availableRepos: available,
  };
}

function describeCandidate(repository: RegisteredRepository): {
  alias: string;
  worktreeId: string | null;
  rootPath: string;
} {
  return { alias: repository.alias, worktreeId: repository.worktreeId, rootPath: repository.rootPath };
}

/**
 * The identity to persist when a repository is REGISTERED. Written once, at the
 * moment the user vouches for the path, and never refreshed behind their back —
 * a registration that silently re-records itself cannot detect a replacement.
 */
export async function captureRepoIdentityRecord(repoRoot: string): Promise<RecordedRepoIdentity> {
  const identity = await resolveWorktreeIdentity(repoRoot);
  return {
    repositoryId: identity.repository.repositoryId,
    worktreeId: identity.worktree.worktreeId,
    repositoryInstance: identity.repository.instanceFingerprint,
    worktreeInstance: identity.worktree.instanceFingerprint,
  };
}

/** The membership scopes a workspace exposes to the path resolver (§96). */
export function workspaceMembershipScopes(
  registry: WorkspaceRegistry,
  indexedPathsFor: (repository: RegisteredRepository) => () => readonly string[],
): readonly {
  worktreeId: string;
  repositoryId: string;
  alias: string;
  worktreeRoot: string;
  indexedPaths: () => readonly string[];
}[] {
  return registry.repositories
    .filter((repo) => repo.worktreeId !== null && repo.repositoryId !== null)
    .map((repo) => ({
      worktreeId: repo.worktreeId!,
      repositoryId: repo.repositoryId!,
      alias: repo.alias,
      worktreeRoot: repo.identity?.worktree.worktreeRoot ?? repo.rootPath,
      indexedPaths: indexedPathsFor(repo),
    }));
}
