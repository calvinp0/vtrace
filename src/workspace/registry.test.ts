import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";

import { resolveWorktreeIdentity } from "../indexer/worktreeIdentity";
import { resolveWorkspaceConfigPath } from "./config";
import {
  buildWorkspaceRouteIndex,
  captureRepoIdentityRecord,
  RegistrationStatus,
  resolveWorkspaceRegistry,
  routeWorkspaceRequest,
  WorkspaceRouteReason,
  WorkspaceRouteSource,
} from "./registry";
import {
  addSiblingWorktree,
  cleanupWorkspaceFixtures,
  cloneFixtureRepo,
  copyFixtureRepo,
  gitOutput,
  makeFixtureRepo,
  makeWorkspaceRoot,
  writeFixtureWorkspace,
} from "./workspaceFixture";

afterAll(cleanupWorkspaceFixtures);

/** Two repositories, deliberately colliding on basename and layout. */
async function twoRepoWorkspace(options: { primary?: string } = {}) {
  const root = await makeWorkspaceRoot();
  const repoA = await makeFixtureRepo(path.join(root, "x", "requests"), {
    files: { "src/utils.py": "def parse():\n    return 'A'\n" },
  });
  const repoB = await makeFixtureRepo(path.join(root, "y", "requests"), {
    files: { "src/utils.py": "def parse():\n    return 'B'\n" },
  });
  const configPath = resolveWorkspaceConfigPath(repoA);
  const config = await writeFixtureWorkspace({
    configPath,
    repos: [{ alias: "a", rootPath: repoA }, { alias: "b", rootPath: repoB }],
    ...(options.primary === undefined ? {} : { primaryRepoAlias: options.primary }),
  });
  return { root, repoA, repoB, config };
}

describe("M145 identity scenarios (§125, §185)", () => {
  test("a symlinked root is the same worktree", async () => {
    const root = await makeWorkspaceRoot();
    const repo = await makeFixtureRepo(path.join(root, "repo"));
    const link = path.join(root, "link");
    await symlink(repo, link);

    const [direct, viaLink] = await Promise.all([
      resolveWorktreeIdentity(repo),
      resolveWorktreeIdentity(link),
    ]);

    expect(viaLink.worktree.worktreeId).toBe(direct.worktree.worktreeId);
    expect(viaLink.repository.repositoryId).toBe(direct.repository.repositoryId);
  });

  test("a sibling worktree is the same repository and a different worktree", async () => {
    const root = await makeWorkspaceRoot();
    const repo = await makeFixtureRepo(path.join(root, "repo"));
    const sibling = await addSiblingWorktree(repo, path.join(root, "sibling"));

    const [main, linked] = await Promise.all([
      resolveWorktreeIdentity(repo),
      resolveWorktreeIdentity(sibling),
    ]);

    expect(linked.repository.repositoryId).toBe(main.repository.repositoryId);
    expect(linked.worktree.worktreeId).not.toBe(main.worktree.worktreeId);
    // Same object store, so the REPOSITORY instance is shared by design...
    expect(linked.repository.instanceFingerprint).toBe(main.repository.instanceFingerprint);
    // ...while each working tree owns its own git dir, and its own index.
    expect(linked.worktree.instanceFingerprint).not.toBe(main.worktree.instanceFingerprint);
  });

  test("an independent clone at the same HEAD is a different repository", async () => {
    const root = await makeWorkspaceRoot();
    const repo = await makeFixtureRepo(path.join(root, "repo"));
    const clone = await cloneFixtureRepo(repo, path.join(root, "clone"));

    const [source, copy] = await Promise.all([
      resolveWorktreeIdentity(repo),
      resolveWorktreeIdentity(clone),
    ]);

    expect(copy.snapshot.headCommit).toBe(source.snapshot.headCommit);
    expect(copy.repository.repositoryId).not.toBe(source.repository.repositoryId);
  });

  test("a byte-for-byte directory copy does not inherit worktree identity", async () => {
    const root = await makeWorkspaceRoot();
    const repo = await makeFixtureRepo(path.join(root, "repo"));
    const copied = await copyFixtureRepo(repo, path.join(root, "copied"));

    const [source, copy] = await Promise.all([
      resolveWorktreeIdentity(repo),
      resolveWorktreeIdentity(copied),
    ]);

    expect(copy.snapshot.headCommit).toBe(source.snapshot.headCommit);
    expect(copy.worktree.worktreeId).not.toBe(source.worktree.worktreeId);
    expect(copy.repository.instanceFingerprint).not.toBe(source.repository.instanceFingerprint);
  });

  test("identity survives a change of state", async () => {
    const root = await makeWorkspaceRoot();
    const repo = await makeFixtureRepo(path.join(root, "repo"));
    const before = await resolveWorktreeIdentity(repo);

    await writeFile(path.join(repo, "src", "utils.py"), "def parse():\n    return 2\n");
    const dirty = await resolveWorktreeIdentity(repo);
    await gitOutput(repo, ["commit", "-qam", "second"]);
    const after = await resolveWorktreeIdentity(repo);

    // Same worktree throughout — what changed is what it CONTAINS.
    expect(dirty.worktree.worktreeId).toBe(before.worktree.worktreeId);
    expect(after.worktree.worktreeId).toBe(before.worktree.worktreeId);
    expect(dirty.snapshot.dirtyFingerprint).not.toBe(before.snapshot.dirtyFingerprint);
    expect(after.snapshot.headCommit).not.toBe(before.snapshot.headCommit);
  });

  test("a repository replaced at the same path is caught by instance evidence", async () => {
    const root = await makeWorkspaceRoot();
    const slot = path.join(root, "slot");
    await makeFixtureRepo(slot, { files: { "src/utils.py": "first = 1\n" } });
    const before = await resolveWorktreeIdentity(slot);

    await rm(slot, { recursive: true, force: true });
    await makeFixtureRepo(slot, { files: { "src/utils.py": "second = 2\n" } });
    const after = await resolveWorktreeIdentity(slot);

    // The path-derived ids CANNOT see this: they hash the same path.
    expect(after.repository.repositoryId).toBe(before.repository.repositoryId);
    expect(after.worktree.worktreeId).toBe(before.worktree.worktreeId);
    // Instance evidence is the only thing that can, and does.
    expect(after.repository.instanceFingerprint).not.toBe(before.repository.instanceFingerprint);
  });

  test("a non-Git directory records no instance evidence rather than a fake one", async () => {
    const root = await makeWorkspaceRoot();
    const plain = await makeFixtureRepo(path.join(root, "plain"), { withoutGit: true });
    const identity = await resolveWorktreeIdentity(plain);

    expect(identity.repository.isGitRepository).toBe(false);
    expect(identity.repository.instanceFingerprint).toBeNull();
  });
});

describe("M145 registration validation (§108, §109, §110)", () => {
  test("a registration records the identity it vouched for", async () => {
    const root = await makeWorkspaceRoot();
    const repo = await makeFixtureRepo(path.join(root, "repo"));
    const registry = await resolveWorkspaceRegistry({
      config: await writeFixtureWorkspace({
        configPath: resolveWorkspaceConfigPath(repo),
        repos: [{ alias: "a", rootPath: repo }],
      }),
    });

    expect(registry.repositories[0]?.registration).toBe(RegistrationStatus.Verified);
  });

  test("replacing the repository at a registered path is a mismatch, not readiness", async () => {
    const root = await makeWorkspaceRoot();
    const slot = path.join(root, "slot");
    await makeFixtureRepo(slot, { files: { "src/utils.py": "first = 1\n" } });
    const config = await writeFixtureWorkspace({
      configPath: resolveWorkspaceConfigPath(slot),
      repos: [{ alias: "a", rootPath: slot }],
    });
    const configPath = config.configPath;

    // Swap in an unrelated repository and reuse the workspace metadata.
    const stashed = path.join(root, "stashed-config.json");
    await rename(configPath, stashed);
    await rm(slot, { recursive: true, force: true });
    await makeFixtureRepo(slot, { files: { "src/other.py": "second = 2\n" } });
    await mkdir(path.dirname(configPath), { recursive: true });
    await rename(stashed, configPath);

    const registry = await resolveWorkspaceRegistry({ config });
    const repo = registry.repositories[0]!;

    expect(repo.registration).toBe(RegistrationStatus.Mismatch);
    expect(repo.registrationMismatches).toContain("repositoryInstance");

    const route = routeWorkspaceRequest(registry, { alias: "a" });
    expect(route.ok).toBe(false);
    expect(route.ok === false && route.reason).toBe(WorkspaceRouteReason.RegistrationStale);
  });

  test("a deleted registered path is unavailable, never silently ready", async () => {
    const root = await makeWorkspaceRoot();
    const repo = await makeFixtureRepo(path.join(root, "gone"));
    const config = await writeFixtureWorkspace({
      configPath: path.join(root, ".vtrace", "workspace.json"),
      repos: [{ alias: "gone", rootPath: repo }],
    });
    await rm(repo, { recursive: true, force: true });

    const registry = await resolveWorkspaceRegistry({ config });
    const route = routeWorkspaceRequest(registry, { alias: "gone" });

    expect(registry.repositories[0]?.registration).toBe(RegistrationStatus.Unavailable);
    expect(route.ok === false && route.reason).toBe(WorkspaceRouteReason.RegistrationStale);
  });

  test("a pre-M145 registration records nothing and therefore vouches for nothing", async () => {
    const root = await makeWorkspaceRoot();
    const repo = await makeFixtureRepo(path.join(root, "repo"));
    const registry = await resolveWorkspaceRegistry({
      config: await writeFixtureWorkspace({
        configPath: resolveWorkspaceConfigPath(repo),
        repos: [{ alias: "a", rootPath: repo }],
        withoutIdentity: true,
      }),
    });

    // Unrecorded is distinct from verified: silence is not a guarantee, and it
    // must not be turned into a failure either.
    expect(registry.repositories[0]?.registration).toBe(RegistrationStatus.Unrecorded);
    expect(routeWorkspaceRequest(registry, { alias: "a" }).ok).toBe(true);
  });

  test("a moved worktree keeps its repository instance but changes its path identity", async () => {
    const root = await makeWorkspaceRoot();
    const from = path.join(root, "movable");
    await makeFixtureRepo(from);
    const before = await captureRepoIdentityRecord(from);
    const to = path.join(root, "moved");
    await rename(from, to);
    const after = await captureRepoIdentityRecord(to);

    expect(after.repositoryInstance).toBe(before.repositoryInstance!);
    expect(after.worktreeId).not.toBe(before.worktreeId!);
  });
});

describe("M145 explicit routing (§41, §127)", () => {
  test("a single registered repository routes implicitly", async () => {
    const root = await makeWorkspaceRoot();
    const repo = await makeFixtureRepo(path.join(root, "solo"));
    const registry = await resolveWorkspaceRegistry({
      config: await writeFixtureWorkspace({
        configPath: resolveWorkspaceConfigPath(repo),
        repos: [{ alias: "solo", rootPath: repo }],
      }),
    });
    const route = routeWorkspaceRequest(registry, {});

    expect(route.ok && route.source).toBe(WorkspaceRouteSource.SoleMember);
  });

  test("two repositories with no selector and no named primary require a choice", async () => {
    const { config } = await twoRepoWorkspace();
    // The written file always names a primary; strip that to reproduce a config
    // whose primary was only ever inferred from position.
    const registry = await resolveWorkspaceRegistry({
      config: { ...config, primaryRepoAliasExplicit: false },
    });
    const route = routeWorkspaceRequest(registry, {});

    expect(route.ok).toBe(false);
    expect(route.ok === false && route.reason).toBe(WorkspaceRouteReason.RepositoryRequired);
    // Bounded ambiguity metadata, not a pick.
    expect(route.ok === false && route.candidates).toHaveLength(2);
  });

  test("routing by worktree id is exact even when display names collide", async () => {
    const { repoB, config } = await twoRepoWorkspace();
    const registry = await resolveWorkspaceRegistry({ config });
    const worktreeId = (await resolveWorktreeIdentity(repoB)).worktree.worktreeId;
    const route = routeWorkspaceRequest(registry, { worktreeId });

    expect(route.ok && route.repository.alias).toBe("b");
    expect(route.ok && route.source).toBe(WorkspaceRouteSource.WorktreeId);
  });

  test("routing by explicit path selects that member", async () => {
    const { repoA, config } = await twoRepoWorkspace();
    const registry = await resolveWorkspaceRegistry({ config });

    expect(routeWorkspaceRequest(registry, { repoPath: repoA }).ok).toBe(true);
    expect(routeWorkspaceRequest(registry, { repoPath: repoA }).ok
      && routeWorkspaceRequest(registry, { repoPath: repoA }).ok).toBe(true);
  });

  test("an ambiguous display name is rejected, not resolved by order", async () => {
    const { config } = await twoRepoWorkspace();
    const registry = await resolveWorkspaceRegistry({ config });
    // Both members' directories are named `requests`.
    const route = routeWorkspaceRequest(registry, { alias: "requests" });

    expect(route.ok).toBe(false);
    expect(route.ok === false && route.reason).toBe(WorkspaceRouteReason.AmbiguousRepository);
    expect(route.ok === false && route.candidates).toHaveLength(2);
  });

  test("an unambiguous display name resolves", async () => {
    const root = await makeWorkspaceRoot();
    const repoA = await makeFixtureRepo(path.join(root, "alpha"));
    const repoB = await makeFixtureRepo(path.join(root, "beta"));
    const registry = await resolveWorkspaceRegistry({
      config: await writeFixtureWorkspace({
        configPath: path.join(root, ".vtrace", "workspace.json"),
        repos: [{ alias: "one", rootPath: repoA }, { alias: "two", rootPath: repoB }],
      }),
    });
    const route = routeWorkspaceRequest(registry, { alias: "beta" });

    expect(route.ok && route.repository.alias).toBe("two");
    expect(route.ok && route.source).toBe(WorkspaceRouteSource.DisplayName);
  });

  test("a cwd inside a member routes to that member", async () => {
    const { repoB, config } = await twoRepoWorkspace();
    const registry = await resolveWorkspaceRegistry({ config });
    const route = routeWorkspaceRequest(registry, { cwd: path.join(repoB, "src") });

    expect(route.ok && route.repository.alias).toBe("b");
    expect(route.ok && route.source).toBe(WorkspaceRouteSource.Cwd);
  });

  test("a cwd at the workspace root does not guess among members", async () => {
    const { root, config } = await twoRepoWorkspace();
    const registry = await resolveWorkspaceRegistry({
      config: { ...config, primaryRepoAliasExplicit: false },
    });
    const route = routeWorkspaceRequest(registry, { cwd: root });

    expect(route.ok).toBe(false);
    expect(route.ok === false && route.reason).toBe(WorkspaceRouteReason.RepositoryRequired);
  });

  test("a cwd inside a sibling worktree routes to that worktree, not its parent", async () => {
    const root = await makeWorkspaceRoot();
    const main = await makeFixtureRepo(path.join(root, "repo"));
    const sibling = await addSiblingWorktree(main, path.join(root, "repo-feature"));
    const registry = await resolveWorkspaceRegistry({
      config: await writeFixtureWorkspace({
        configPath: path.join(root, ".vtrace", "workspace.json"),
        repos: [{ alias: "main", rootPath: main }, { alias: "feature", rootPath: sibling }],
      }),
    });
    const route = routeWorkspaceRequest(registry, { cwd: path.join(sibling, "src") });

    expect(route.ok && route.repository.alias).toBe("feature");
  });

  test("a repository id registered as two worktrees is ambiguous", async () => {
    const root = await makeWorkspaceRoot();
    const main = await makeFixtureRepo(path.join(root, "repo"));
    const sibling = await addSiblingWorktree(main, path.join(root, "repo-feature"));
    const registry = await resolveWorkspaceRegistry({
      config: await writeFixtureWorkspace({
        configPath: path.join(root, ".vtrace", "workspace.json"),
        repos: [{ alias: "main", rootPath: main }, { alias: "feature", rootPath: sibling }],
      }),
    });
    const repositoryId = (await resolveWorktreeIdentity(main)).repository.repositoryId;
    const route = routeWorkspaceRequest(registry, { repositoryId });

    expect(route.ok).toBe(false);
    expect(route.ok === false && route.reason).toBe(WorkspaceRouteReason.AmbiguousRepository);
  });

  test("an unnamed primary is not a routing default (§75)", async () => {
    const { config } = await twoRepoWorkspace();
    const registry = await resolveWorkspaceRegistry({ config });

    // The file names one, so it IS explicit here...
    expect(registry.defaultAlias).toBe("a");
    // ...but a config that omits it must not promote the first entry.
    const implicit = await resolveWorkspaceRegistry({
      config: { ...config, primaryRepoAliasExplicit: false },
    });
    expect(implicit.defaultAlias).toBeNull();
    expect(routeWorkspaceRequest(implicit, {}).ok).toBe(false);
  });

  test("an explicitly configured default routes when nothing else selects", async () => {
    const { config } = await twoRepoWorkspace({ primary: "b" });
    const registry = await resolveWorkspaceRegistry({ config });
    const route = routeWorkspaceRequest(registry, {});

    expect(route.ok && route.repository.alias).toBe("b");
    expect(route.ok && route.source).toBe(WorkspaceRouteSource.ConfiguredDefault);
  });

  test("registration order does not change routing (§91)", async () => {
    const { repoA, repoB, root } = await twoRepoWorkspace();
    const forward = await resolveWorkspaceRegistry({
      config: await writeFixtureWorkspace({
        configPath: path.join(root, ".vtrace", "forward.json"),
        repos: [{ alias: "a", rootPath: repoA }, { alias: "b", rootPath: repoB }],
        primaryRepoAlias: "a",
      }),
    });
    const reversed = await resolveWorkspaceRegistry({
      config: await writeFixtureWorkspace({
        configPath: path.join(root, ".vtrace", "reversed.json"),
        repos: [{ alias: "b", rootPath: repoB }, { alias: "a", rootPath: repoA }],
        primaryRepoAlias: "a",
      }),
    });

    for (const selector of [{ alias: "a" }, { alias: "b" }, { repoPath: repoA }, { cwd: repoB }]) {
      const one = routeWorkspaceRequest(forward, selector);
      const other = routeWorkspaceRequest(reversed, selector);
      expect(one.ok && one.repository.worktreeId).toBe(other.ok && other.repository.worktreeId);
    }
  });

  test("an unknown selector is unknown, never the nearest member", async () => {
    const { config } = await twoRepoWorkspace();
    const registry = await resolveWorkspaceRegistry({ config });

    expect(routeWorkspaceRequest(registry, { alias: "nope" }).ok === false
      && routeWorkspaceRequest(registry, { alias: "nope" }).reason)
      .toBe(WorkspaceRouteReason.UnknownRepository);
    expect(routeWorkspaceRequest(registry, { worktreeId: "deadbeef" }).ok).toBe(false);
  });

  test("symlinked and canonical spellings route to one member, not two", async () => {
    const root = await makeWorkspaceRoot();
    const repo = await makeFixtureRepo(path.join(root, "repo"));
    const link = path.join(root, "link");
    await symlink(repo, link);
    const registry = await resolveWorkspaceRegistry({
      config: await writeFixtureWorkspace({
        configPath: path.join(root, ".vtrace", "workspace.json"),
        repos: [{ alias: "repo", rootPath: repo }],
      }),
    });
    const index = buildWorkspaceRouteIndex(registry);

    expect(routeWorkspaceRequest(registry, { repoPath: link }, index).ok
      && routeWorkspaceRequest(registry, { repoPath: link }, index).repository.alias).toBe("repo");
  });
});
