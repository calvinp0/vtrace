// M145 workspace acceptance: identity, membership, routing, collision safety,
// readiness isolation, lock ownership, provenance and cost, measured against
// real Git fixtures rather than asserted.
//
// Every case builds actual repositories on disk and asks the shipped resolvers.
// A synthetic workspace is the only way to construct the collisions that matter
// — two repositories with the same relative paths, the same symbol names, the
// same basename, or byte-identical content at one commit — and each of those is
// a case where a wrong answer is invisible in ordinary single-repository use.
//
// No agent, Docker, VEXP, network, or paid API is used.

import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { Database } from "bun:sqlite";

import { initRepo } from "../../src/setup/initRepo";
import { listAllFilePaths } from "../../src/db/repositories/filesRepository";
import { resolveIndexDbPath } from "../../src/indexer/indexMeta";
import { resolveWorktreeIdentity } from "../../src/indexer/worktreeIdentity";
import { withWorktreeIndexLock, WorktreeIndexLockError } from "../../src/indexer/worktreeIndexLock";
import {
  createPathMembershipResolver,
  PathMembershipStatus,
  SelectedPathMembership,
  type PathMembershipScope,
} from "../../src/workspace/pathMembership";
import { evaluateWorkspaceReadiness } from "../../src/workspace/readiness";
import {
  buildWorkspaceRouteIndex,
  captureRepoIdentityRecord,
  RegistrationStatus,
  resolveWorkspaceRegistry,
  routeWorkspaceRequest,
  workspaceMembershipScopes,
  type WorkspaceRegistry,
  type WorkspaceRouteResult,
  type WorkspaceRouteFailure,
} from "../../src/workspace/registry";
import {
  WORKSPACE_CONFIG_SCHEMA_VERSION,
  writeWorkspaceConfig,
  type ResolvedWorkspaceConfig,
} from "../../src/workspace/config";
import { REPO_LOCAL_STATE_DIRNAME } from "../../src/setup/types";

const GIT = ["-c", "user.email=m145@test", "-c", "user.name=m145", "-c", "commit.gpgsign=false"];

function git(cwd: string, args: readonly string[]): string {
  const result = Bun.spawnSync(["git", "-C", cwd, ...GIT, ...args], { stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr.toString()}`);
  return result.stdout.toString().trim();
}

async function makeRepo(root: string, files: Record<string, string>): Promise<string> {
  for (const [relative, contents] of Object.entries(files)) {
    const target = path.join(root, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, contents);
  }
  const init = Bun.spawnSync(["git", "init", "-q", "-b", "main", root], { stdout: "pipe", stderr: "pipe" });
  if (init.exitCode !== 0) throw new Error(init.stderr.toString());
  git(root, ["add", "-A"]);
  git(root, ["commit", "-qm", "init"]);
  return root;
}

async function registerWorkspace(input: {
  configPath: string;
  repos: readonly { alias: string; rootPath: string }[];
  primaryRepoAlias?: string;
}): Promise<ResolvedWorkspaceConfig> {
  const repos = [];
  for (const repo of input.repos) {
    repos.push({
      alias: repo.alias,
      rootPath: repo.rootPath,
      enabled: true,
      ...(await captureRepoIdentityRecord(repo.rootPath)),
    });
  }
  return writeWorkspaceConfig(input.configPath, {
    schemaVersion: WORKSPACE_CONFIG_SCHEMA_VERSION,
    primaryRepoAlias: input.primaryRepoAlias ?? repos[0]!.alias,
    repos,
  });
}

/** Membership scopes backed by each member's real index. */
function scopesFor(registry: WorkspaceRegistry): readonly PathMembershipScope[] {
  return workspaceMembershipScopes(registry, (repo) => {
    let paths: readonly string[] | undefined;
    return () => {
      if (paths === undefined) {
        const db = new Database(resolveIndexDbPath(repo.rootPath), { readonly: true });
        try {
          paths = listAllFilePaths(db);
        } finally {
          db.close();
        }
      }
      return paths;
    };
  });
}

// The project compiles with `strict: false`, where a literal-boolean `ok` does
// not narrow a union on its own. An explicit guard is the codebase idiom.
function isRouteFailure(route: WorkspaceRouteResult): route is WorkspaceRouteFailure {
  return route.ok === false;
}

/** What a route did, as one reportable string: the member, or why it refused. */
function routeOutcome(route: WorkspaceRouteResult): string {
  return isRouteFailure(route) ? route.reason : route.repository.alias;
}

function routeCandidates(route: WorkspaceRouteResult): readonly string[] {
  return isRouteFailure(route) ? route.candidates.map((candidate) => candidate.alias) : [];
}

function routeWorktreeId(route: WorkspaceRouteResult): string {
  return isRouteFailure(route) ? route.reason : route.repository.worktreeId ?? "unidentified";
}

interface Row {
  readonly case: string;
  readonly expected: string;
  readonly actual: string;
  readonly verdict: "pass" | "fail";
  readonly detail?: unknown;
}

const rows: Row[] = [];

function record(name: string, expected: string, actual: string, detail?: unknown): void {
  rows.push({
    case: name,
    expected,
    actual,
    verdict: expected === actual ? "pass" : "fail",
    ...(detail === undefined ? {} : { detail }),
  });
}

const timings: Record<string, number> = {};

async function timed<T>(key: string, run: () => Promise<T>): Promise<T> {
  const started = performance.now();
  const value = await run();
  timings[key] = Math.round((performance.now() - started) * 1000) / 1000;
  return value;
}

async function main(): Promise<void> {
  const outDir = path.resolve(process.argv[2] ?? "benchmarks/stage5_vexp_swe_bench_smoke/results");
  const base = await mkdtemp(path.join(tmpdir(), "m145-acceptance-"));

  try {
    const identity = await identityScenarios(base);
    const membership = await membershipControls(base);
    const routing = await routingControls(base);
    const collisions = await collisionControls(base);
    const readiness = await readinessControls(base);
    const locking = await lockControls(base);
    const provenance = await provenanceControls(base);
    const scaling = await scalingControls(base);

    await mkdir(outDir, { recursive: true });
    await write(outDir, "stage5_m145_identity_scenarios.json", identity);
    await write(outDir, "stage5_m145_path_membership_controls.json", membership.controls);
    await write(outDir, "stage5_m145_ambiguous_path_cases.json", membership.ambiguous);
    await write(outDir, "stage5_m145_workspace_routing.json", routing);
    await write(outDir, "stage5_m145_repository_collision_controls.json", collisions.repository);
    await write(outDir, "stage5_m145_worktree_collision_controls.json", collisions.worktree);
    await write(outDir, "stage5_m145_order_invariance.json", collisions.order);
    await write(outDir, "stage5_m145_workspace_readiness.json", readiness.workspace);
    await write(outDir, "stage5_m145_wrong_repository_readiness.json", readiness.wrongRepository);
    await write(outDir, "stage5_m145_stale_registration.json", readiness.staleRegistration);
    await write(outDir, "stage5_m145_lock_contention.json", locking.contention);
    await write(outDir, "stage5_m145_abandoned_lock.json", locking.abandoned);
    await write(outDir, "stage5_m145_lock_isolation.json", locking.isolation);
    await write(outDir, "stage5_m145_result_provenance.json", provenance.provenance);
    await write(outDir, "stage5_m145_same_path_collision.json", provenance.samePath);
    await write(outDir, "stage5_m145_same_symbol_collision.json", provenance.sameSymbol);
    await write(outDir, "stage5_m145_workspace_performance.json", {
      schemaVersion: "stage5.m145.performance.v1",
      timingsMs: timings,
      scaling,
    });

    const failures = rows.filter((row) => row.verdict === "fail");
    await write(outDir, "stage5_m145_workspace_acceptance.json", {
      schemaVersion: "stage5.m145.workspace-acceptance.v1",
      pass: failures.length === 0,
      total: rows.length,
      failed: failures.length,
      rows,
    });

    process.stdout.write(`m145 workspace acceptance: ${rows.length - failures.length}/${rows.length} pass\n`);
    for (const failure of failures) {
      process.stdout.write(`  FAIL ${failure.case}: expected ${failure.expected}, got ${failure.actual}\n`);
    }
    if (failures.length > 0) process.exitCode = 1;
  } finally {
    await rm(base, { recursive: true, force: true });
  }
}

async function write(outDir: string, name: string, value: unknown): Promise<void> {
  await writeFile(path.join(outDir, name), `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

// ---------------------------------------------------------------- identity

async function identityScenarios(base: string): Promise<unknown> {
  const root = path.join(base, "identity");
  await mkdir(root, { recursive: true });
  const repo = await makeRepo(path.join(root, "repo"), { "src/utils.py": "def parse():\n    return 1\n" });

  const link = path.join(root, "link");
  await symlink(repo, link);
  const sibling = path.join(root, "repo-feature");
  git(repo, ["worktree", "add", "-q", "-b", "feature", sibling]);
  const clone = path.join(root, "clone");
  Bun.spawnSync(["git", "clone", "-q", repo, clone]);
  const copied = path.join(root, "copied");
  Bun.spawnSync(["cp", "-r", repo, copied]);
  const other = await makeRepo(path.join(root, "elsewhere", "repo"), { "src/utils.py": "def parse():\n    return 9\n" });

  const slot = path.join(root, "slot");
  await makeRepo(slot, { "src/utils.py": "first = 1\n" });
  const slotBefore = await resolveWorktreeIdentity(slot);
  await rm(slot, { recursive: true, force: true });
  await makeRepo(slot, { "src/utils.py": "second = 2\n" });
  const slotAfter = await resolveWorktreeIdentity(slot);

  const scenarios: Array<{ scenario: string; a: string; b: string; expect: [boolean, boolean, boolean] }> = [
    { scenario: "same root repeated", a: repo, b: repo, expect: [true, true, true] },
    { scenario: "symlink same root", a: repo, b: link, expect: [true, true, true] },
    { scenario: "sibling Git worktree", a: repo, b: sibling, expect: [true, false, false] },
    { scenario: "independent clone same HEAD", a: repo, b: clone, expect: [false, false, false] },
    { scenario: "same basename different repo", a: repo, b: other, expect: [false, false, false] },
    { scenario: "copied repo directory", a: repo, b: copied, expect: [false, false, false] },
  ];

  const table = [];
  for (const entry of scenarios) {
    const [left, right] = await Promise.all([
      resolveWorktreeIdentity(entry.a),
      resolveWorktreeIdentity(entry.b),
    ]);
    const sameRepository = left.repository.repositoryId === right.repository.repositoryId;
    const sameWorktree = left.worktree.worktreeId === right.worktree.worktreeId;
    // "Same authority" means one index may answer for both: same worktree AND
    // the same physical repository instance behind it.
    const sameAuthority = sameWorktree
      && left.worktree.instanceFingerprint === right.worktree.instanceFingerprint;
    const actual: [boolean, boolean, boolean] = [sameRepository, sameWorktree, sameAuthority];
    table.push({ scenario: entry.scenario, sameRepository, sameWorktree, sameAuthority });
    record(
      `identity: ${entry.scenario}`,
      entry.expect.join(","),
      actual.join(","),
    );
  }

  // The replacement case compares one path across time rather than two paths.
  const replacedSameIds = slotAfter.repository.repositoryId === slotBefore.repository.repositoryId
    && slotAfter.worktree.worktreeId === slotBefore.worktree.worktreeId;
  const replacedSameInstance =
    slotAfter.repository.instanceFingerprint === slotBefore.repository.instanceFingerprint;
  table.push({
    scenario: "replaced repo at same path",
    sameRepository: replacedSameIds,
    sameWorktree: replacedSameIds,
    sameAuthority: replacedSameInstance,
  });
  record("identity: replaced repo at same path is not the same authority", "false", String(replacedSameInstance));
  record("identity: path-derived ids cannot see the replacement", "true", String(replacedSameIds));

  await timed("worktreeIdentityResolveMs", async () => resolveWorktreeIdentity(repo));

  return {
    schemaVersion: "stage5.m145.identity-scenarios.v1",
    note: "sameAuthority = one index may answer for both: same worktree id AND same worktree instance.",
    table,
  };
}

// -------------------------------------------------------------- membership

async function membershipControls(base: string): Promise<{ controls: unknown; ambiguous: unknown }> {
  const root = path.join(base, "membership");
  await mkdir(root, { recursive: true });

  const requests = await makeRepo(path.join(root, "requests"), {
    "requests/sessions.py": "def send(self):\n    return 1\n",
    "requests/adapters.py": "def send(self):\n    return 2\n",
    "test_requests.py": "def test_requests():\n    return 3\n",
  });
  const urllib3 = await makeRepo(path.join(root, "urllib3"), {
    "src/urllib3/connectionpool.py": "def urlopen(self):\n    return 1\n",
  });
  await initRepo({ repoPath: requests });
  await initRepo({ repoPath: urllib3 });

  const config = await registerWorkspace({
    configPath: path.join(root, ".vtrace", "workspace.json"),
    repos: [{ alias: "requests", rootPath: requests }, { alias: "urllib3", rootPath: urllib3 }],
  });
  const registry = await resolveWorkspaceRegistry({ config });
  const selected = registry.repositories.find((repo) => repo.alias === "requests")!.worktreeId!;
  const scopes = scopesFor(registry);
  const resolver = createPathMembershipResolver(scopes, selected);

  const cases: Array<{ name: string; hint: string; status: string; selected: string }> = [
    {
      name: "exact absolute",
      hint: path.join(requests, "requests/sessions.py"),
      status: PathMembershipStatus.Exact,
      selected: SelectedPathMembership.Member,
    },
    {
      name: "repo-relative",
      hint: "requests/sessions.py",
      status: PathMembershipStatus.UniqueResolved,
      selected: SelectedPathMembership.Member,
    },
    {
      name: "reporter absolute unique suffix",
      hint: "/Users/hwkns/test_requests.py",
      status: PathMembershipStatus.UniqueResolved,
      selected: SelectedPathMembership.Member,
    },
    {
      name: "site-packages copy matching repo",
      hint: "/app/venv/lib/python3.8/site-packages/requests/adapters.py",
      status: PathMembershipStatus.UniqueResolved,
      selected: SelectedPathMembership.Member,
    },
    {
      name: "external stdlib",
      hint: "/usr/lib/python2.7/httplib.py",
      status: PathMembershipStatus.External,
      selected: SelectedPathMembership.External,
    },
    {
      name: "external-to-selected but internal to another member",
      hint: "src/urllib3/connectionpool.py",
      status: PathMembershipStatus.UniqueResolved,
      selected: SelectedPathMembership.ExternalToSelected,
    },
    {
      name: "missing path",
      hint: "requests/deleted.py",
      status: PathMembershipStatus.Unresolved,
      selected: SelectedPathMembership.Unresolved,
    },
  ];

  const results = [];
  for (const entry of cases) {
    const resolution = await timed("pathMembershipResolveMs", async () => resolver.resolve(entry.hint));
    results.push({
      case: entry.name,
      hint: entry.hint,
      status: resolution.status,
      selected: resolution.selected,
      matches: resolution.matches.map((match) => ({ alias: match.alias, kind: match.kind })),
    });
    record(`membership: ${entry.name}`, `${entry.status}/${entry.selected}`, `${resolution.status}/${resolution.selected}`);
  }

  // Ambiguity needs two repositories that genuinely index the same relative path.
  const ambRoot = path.join(root, "ambiguous");
  const repoA = await makeRepo(path.join(ambRoot, "a"), { "src/foo/bar.py": "A = 1\n" });
  const repoB = await makeRepo(path.join(ambRoot, "b"), { "src/foo/bar.py": "B = 2\n" });
  await initRepo({ repoPath: repoA });
  await initRepo({ repoPath: repoB });
  const ambConfig = await registerWorkspace({
    configPath: path.join(ambRoot, ".vtrace", "workspace.json"),
    repos: [{ alias: "a", rootPath: repoA }, { alias: "b", rootPath: repoB }],
  });
  const ambRegistry = await resolveWorkspaceRegistry({ config: ambConfig });
  const ambResolver = createPathMembershipResolver(scopesFor(ambRegistry));

  const ambiguousCases = [];
  for (const hint of ["src/foo/bar.py", "/Users/hwkns/src/foo/bar.py", "foo/bar.py"]) {
    const resolution = ambResolver.resolve(hint);
    ambiguousCases.push({
      hint,
      status: resolution.status,
      worktreeId: resolution.worktreeId,
      matched: resolution.matches.map((match) => match.alias).sort(),
    });
    record(`ambiguous: ${hint}`, PathMembershipStatus.Ambiguous, resolution.status);
  }

  // A member's own file must not become ambiguous merely because a sibling exists.
  const isolated = ambResolver.resolve(path.join(repoA, "src/foo/bar.py"));
  record("ambiguous: an exact absolute path stays exact", PathMembershipStatus.Exact, isolated.status);

  return {
    controls: { schemaVersion: "stage5.m145.path-membership-controls.v1", cases: results },
    ambiguous: {
      schemaVersion: "stage5.m145.ambiguous-path-cases.v1",
      cases: ambiguousCases,
      exactStaysExact: { status: isolated.status, worktreeId: isolated.worktreeId },
    },
  };
}

// ----------------------------------------------------------------- routing

async function routingControls(base: string): Promise<unknown> {
  const root = path.join(base, "routing");
  await mkdir(root, { recursive: true });
  const repoA = await makeRepo(path.join(root, "x", "requests"), { "src/utils.py": "A = 1\n" });
  const repoB = await makeRepo(path.join(root, "y", "requests"), { "src/utils.py": "B = 2\n" });
  const config = await registerWorkspace({
    configPath: path.join(root, ".vtrace", "workspace.json"),
    repos: [{ alias: "a", rootPath: repoA }, { alias: "b", rootPath: repoB }],
    primaryRepoAlias: "a",
  });
  const registry = await timed("workspaceLoadMs", async () => resolveWorkspaceRegistry({ config }));
  const index = buildWorkspaceRouteIndex(registry);
  const worktreeB = registry.repositories.find((repo) => repo.alias === "b")!.worktreeId!;

  const cases: Array<{ name: string; selector: Record<string, string>; expect: string }> = [
    { name: "explicit alias A", selector: { alias: "a" }, expect: "a" },
    { name: "explicit alias B", selector: { alias: "b" }, expect: "b" },
    { name: "explicit worktree id", selector: { worktreeId: worktreeB }, expect: "b" },
    { name: "explicit path", selector: { repoPath: repoA }, expect: "a" },
    { name: "cwd inside repo", selector: { cwd: path.join(repoB, "src") }, expect: "b" },
    { name: "ambiguous display name", selector: { alias: "requests" }, expect: "workspace_repository_ambiguous" },
    { name: "unknown alias", selector: { alias: "nope" }, expect: "workspace_repository_unknown" },
    { name: "cwd at workspace root falls to configured default", selector: { cwd: root }, expect: "a" },
  ];

  const results = [];
  for (const entry of cases) {
    const route = await timed("explicitRouteMs", async () => routeWorkspaceRequest(registry, entry.selector, index));
    const actual = routeOutcome(route);
    results.push({
      case: entry.name,
      selector: entry.selector,
      routed: isRouteFailure(route) ? null : route.repository.alias,
      source: isRouteFailure(route) ? null : route.source,
      reason: isRouteFailure(route) ? route.reason : null,
      candidates: routeCandidates(route),
    });
    record(`routing: ${entry.name}`, entry.expect, actual);
  }

  // No selector, and no explicitly named primary: the request must be refused.
  const withoutDefault = await resolveWorkspaceRegistry({
    config: { ...config, primaryRepoAliasExplicit: false },
  });
  const refused = routeWorkspaceRequest(withoutDefault, {});
  record(
    "routing: no selector and no named default is refused",
    "workspace_repository_required",
    routeOutcome(refused),
  );

  return { schemaVersion: "stage5.m145.workspace-routing.v1", cases: results };
}

// -------------------------------------------------------------- collisions

async function collisionControls(base: string): Promise<{
  repository: unknown;
  worktree: unknown;
  order: unknown;
}> {
  const root = path.join(base, "collisions");
  await mkdir(root, { recursive: true });

  // Same relative paths AND the same symbol names in both repositories.
  const shared = {
    "src/utils.py": "def parse(value):\n    return value\n",
    "src/models.py": "class Species:\n    def to_dict(self):\n        return {}\n",
  };
  const repoA = await makeRepo(path.join(root, "a"), shared);
  const repoB = await makeRepo(path.join(root, "b"), shared);
  await initRepo({ repoPath: repoA });
  await initRepo({ repoPath: repoB });

  const soloConfig = await registerWorkspace({
    configPath: path.join(root, "solo", "workspace.json"),
    repos: [{ alias: "a", rootPath: repoA }],
  });
  const pairConfig = await registerWorkspace({
    configPath: path.join(root, "pair", "workspace.json"),
    repos: [{ alias: "a", rootPath: repoA }, { alias: "b", rootPath: repoB }],
  });

  const soloRegistry = await resolveWorkspaceRegistry({ config: soloConfig });
  const pairRegistry = await resolveWorkspaceRegistry({ config: pairConfig });
  const soloRoute = routeWorkspaceRequest(soloRegistry, { alias: "a" });
  const pairRoute = routeWorkspaceRequest(pairRegistry, { alias: "a" });

  record(
    "collision: A routes to the same worktree alone and beside B",
    routeWorktreeId(soloRoute),
    routeWorktreeId(pairRoute),
  );

  // Byte-identical content at the same commit, in two repositories.
  const twinA = await makeRepo(path.join(root, "twin-a"), shared);
  Bun.spawnSync(["cp", "-r", twinA, path.join(root, "twin-b")]);
  const twinB = path.join(root, "twin-b");
  const [twinAIdentity, twinBIdentity] = await Promise.all([
    resolveWorktreeIdentity(twinA),
    resolveWorktreeIdentity(twinB),
  ]);
  record(
    "collision: identical content at one commit is still two authorities",
    "true",
    String(
      twinAIdentity.snapshot.headCommit === twinBIdentity.snapshot.headCommit
      && twinAIdentity.worktree.worktreeId !== twinBIdentity.worktree.worktreeId,
    ),
  );

  // Sibling worktrees: same repository, distinct worktrees, distinct indexes.
  const main = await makeRepo(path.join(root, "sib"), shared);
  const sibling = path.join(root, "sib-feature");
  git(main, ["worktree", "add", "-q", "-b", "feature", sibling]);
  await writeFile(path.join(sibling, "src", "utils.py"), "def parse(value):\n    return value + 1\n");
  const [mainIdentity, siblingIdentity] = await Promise.all([
    resolveWorktreeIdentity(main),
    resolveWorktreeIdentity(sibling),
  ]);
  record(
    "collision: dirty sibling shares a repository and not a state",
    "true",
    String(
      siblingIdentity.repository.repositoryId === mainIdentity.repository.repositoryId
      && siblingIdentity.worktree.worktreeId !== mainIdentity.worktree.worktreeId
      && siblingIdentity.snapshot.dirtyFingerprint !== mainIdentity.snapshot.dirtyFingerprint,
    ),
  );

  // Registration order must not move any explicitly routed answer.
  const forward = await resolveWorkspaceRegistry({
    config: await registerWorkspace({
      configPath: path.join(root, "forward", "workspace.json"),
      repos: [{ alias: "a", rootPath: repoA }, { alias: "b", rootPath: repoB }],
      primaryRepoAlias: "a",
    }),
  });
  const reversed = await resolveWorkspaceRegistry({
    config: await registerWorkspace({
      configPath: path.join(root, "reversed", "workspace.json"),
      repos: [{ alias: "b", rootPath: repoB }, { alias: "a", rootPath: repoA }],
      primaryRepoAlias: "a",
    }),
  });

  const orderRows = [];
  for (const selector of [{ alias: "a" }, { alias: "b" }, { repoPath: repoA }, { cwd: repoB }]) {
    const one = routeWorkspaceRequest(forward, selector);
    const other = routeWorkspaceRequest(reversed, selector);
    const same = routeWorktreeId(one) === routeWorktreeId(other);
    orderRows.push({ selector, stable: same });
    record(`order invariance: ${JSON.stringify(selector)}`, "true", String(same));
  }

  // Membership over the same suffix must also be order-independent.
  const forwardMembership = createPathMembershipResolver(scopesFor(forward)).resolve("src/utils.py");
  const reversedMembership = createPathMembershipResolver(scopesFor(reversed)).resolve("src/utils.py");
  record(
    "order invariance: colliding membership is ambiguous either way",
    `${PathMembershipStatus.Ambiguous}/${PathMembershipStatus.Ambiguous}`,
    `${forwardMembership.status}/${reversedMembership.status}`,
  );

  return {
    repository: {
      schemaVersion: "stage5.m145.repository-collision-controls.v1",
      sameRelativePath: { repoA, repoB, files: Object.keys(shared) },
      routedAloneWorktreeId: routeWorktreeId(soloRoute),
      routedBesideWorktreeId: routeWorktreeId(pairRoute),
      identicalContent: {
        sameHead: twinAIdentity.snapshot.headCommit === twinBIdentity.snapshot.headCommit,
        sameWorktree: twinAIdentity.worktree.worktreeId === twinBIdentity.worktree.worktreeId,
      },
    },
    worktree: {
      schemaVersion: "stage5.m145.worktree-collision-controls.v1",
      sameRepository: siblingIdentity.repository.repositoryId === mainIdentity.repository.repositoryId,
      sameWorktree: siblingIdentity.worktree.worktreeId === mainIdentity.worktree.worktreeId,
      sameSourceState: siblingIdentity.snapshot.dirtyFingerprint === mainIdentity.snapshot.dirtyFingerprint,
    },
    order: { schemaVersion: "stage5.m145.order-invariance.v1", rows: orderRows },
  };
}

// ---------------------------------------------------------------- readiness

async function readinessControls(base: string): Promise<{
  workspace: unknown;
  wrongRepository: unknown;
  staleRegistration: unknown;
}> {
  const root = path.join(base, "readiness");
  await mkdir(root, { recursive: true });
  const repoA = await makeRepo(path.join(root, "a"), { "src/utils.py": "A = 1\n" });
  const repoB = await makeRepo(path.join(root, "b"), { "src/utils.py": "B = 2\n" });
  const repoC = await makeRepo(path.join(root, "c"), { "src/utils.py": "C = 3\n" });
  await initRepo({ repoPath: repoA });
  await initRepo({ repoPath: repoB });

  const config = await registerWorkspace({
    configPath: path.join(root, ".vtrace", "workspace.json"),
    repos: [
      { alias: "a", rootPath: repoA },
      { alias: "b", rootPath: repoB },
      { alias: "c", rootPath: repoC },
    ],
  });

  // B goes stale; C was never indexed; A is untouched.
  await writeFile(path.join(repoB, "src", "utils.py"), "B = 22\n");
  const registry = await resolveWorkspaceRegistry({ config });
  const readiness = await timed("readinessResolveMs", async () => evaluateWorkspaceReadiness(registry));
  const byAlias = new Map(readiness.repos.map((repo) => [repo.alias, repo]));

  record("readiness: A is ready while B is stale and C is missing", "true", String(
    byAlias.get("a")?.ready === true
    && byAlias.get("b")?.ready === false
    && byAlias.get("c")?.index?.state === "index_missing",
  ));
  record("readiness: the workspace reports a count, not a boolean", "1/3", `${readiness.ready}/${readiness.total}`);

  // A stale A must fail closed even with a healthy B.
  await writeFile(path.join(repoA, "src", "utils.py"), "A = 11\n");
  const afterA = await evaluateWorkspaceReadiness(await resolveWorkspaceRegistry({ config }));
  record(
    "readiness: a stale selected repository fails closed",
    "false",
    String(afterA.repos.find((repo) => repo.alias === "a")?.ready),
  );

  // A repository replaced under a registration: the index left behind is valid
  // for the repository that left, which is exactly why it must not answer here.
  const slot = path.join(root, "slot");
  await makeRepo(slot, { "src/utils.py": "first = 1\n" });
  await initRepo({ repoPath: slot });
  const slotConfig = await registerWorkspace({
    configPath: path.join(root, "slot-ws", "workspace.json"),
    repos: [{ alias: "slot", rootPath: slot }],
  });
  await rm(path.join(slot, ".git"), { recursive: true, force: true });
  await makeRepo(slot, { "src/utils.py": "first = 1\n" });
  const slotReadiness = await evaluateWorkspaceReadiness(await resolveWorkspaceRegistry({ config: slotConfig }));
  const slotRepo = slotReadiness.repos[0]!;
  record("readiness: a replaced repository is a registration mismatch", RegistrationStatus.Mismatch, slotRepo.registration);
  record("readiness: a replaced repository is never ready", "false", String(slotRepo.ready));

  // A deleted registered path.
  const gone = path.join(root, "gone");
  await makeRepo(gone, { "src/utils.py": "G = 1\n" });
  const goneConfig = await registerWorkspace({
    configPath: path.join(root, "gone-ws", "workspace.json"),
    repos: [{ alias: "gone", rootPath: gone }],
  });
  await rm(gone, { recursive: true, force: true });
  const goneRegistry = await resolveWorkspaceRegistry({ config: goneConfig });
  const goneRoute = routeWorkspaceRequest(goneRegistry, { alias: "gone" });
  record(
    "readiness: a deleted registration is unavailable",
    RegistrationStatus.Unavailable,
    goneRegistry.repositories[0]!.registration,
  );
  record(
    "readiness: routing to a deleted registration fails closed",
    "workspace_registration_stale",
    routeOutcome(goneRoute),
  );

  return {
    workspace: {
      schemaVersion: "stage5.m145.workspace-readiness.v1",
      summary: {
        total: readiness.total,
        ready: readiness.ready,
        stale: readiness.stale,
        missing: readiness.missing,
        mismatched: readiness.mismatched,
        unavailable: readiness.unavailable,
      },
      repos: readiness.repos.map((repo) => ({
        alias: repo.alias,
        ready: repo.ready,
        registration: repo.registration,
        state: repo.index?.state ?? null,
        sourceFresh: repo.index?.sourceFresh ?? null,
        schemaCompatible: repo.index?.schemaCompatible ?? null,
        capabilityCompatible: repo.index?.capabilityCompatible ?? null,
        repositoryCompatible: repo.index?.repositoryCompatible ?? null,
        worktreeCompatible: repo.index?.worktreeCompatible ?? null,
      })),
    },
    wrongRepository: {
      schemaVersion: "stage5.m145.wrong-repository-readiness.v1",
      registration: slotRepo.registration,
      ready: slotRepo.ready,
      mismatches: slotReadiness.repos[0]!.registration,
      indexConsulted: slotRepo.index !== null,
      reason: slotRepo.reason,
    },
    staleRegistration: {
      schemaVersion: "stage5.m145.stale-registration.v1",
      registration: goneRegistry.repositories[0]!.registration,
      mismatches: goneRegistry.repositories[0]!.registrationMismatches,
      routeReason: isRouteFailure(goneRoute) ? goneRoute.reason : null,
    },
  };
}

// ------------------------------------------------------------------- locks

async function lockControls(base: string): Promise<{
  contention: unknown;
  abandoned: unknown;
  isolation: unknown;
}> {
  const root = path.join(base, "locks");
  await mkdir(root, { recursive: true });
  const repoA = await makeRepo(path.join(root, "a"), { "src/utils.py": "A = 1\n" });
  const repoB = await makeRepo(path.join(root, "b"), { "src/utils.py": "B = 2\n" });
  const main = await makeRepo(path.join(root, "sib"), { "src/utils.py": "M = 1\n" });
  const sibling = path.join(root, "sib-feature");
  git(main, ["worktree", "add", "-q", "-b", "feature", sibling]);

  const identityA = await resolveWorktreeIdentity(repoA);
  const identityOther = await resolveWorktreeIdentity(repoB);

  async function plant(repoRoot: string, owner: { pid: number; worktreeId: string }): Promise<void> {
    const dir = path.join(repoRoot, REPO_LOCAL_STATE_DIRNAME, "index.lock");
    await mkdir(dir, { recursive: true });
    await writeFile(
      path.join(dir, "owner.json"),
      `${JSON.stringify({ ...owner, startedAt: new Date().toISOString() }, null, 2)}\n`,
    );
  }

  // Same authoritative index, two writers.
  await plant(repoA, { pid: process.pid, worktreeId: identityA.worktree.worktreeId });
  const contentionStarted = performance.now();
  const busy = await withWorktreeIndexLock({ repoRoot: repoA, operation: async () => true })
    .then(() => null, (error: unknown) => error as WorktreeIndexLockError);
  const busyMs = Math.round((performance.now() - contentionStarted) * 1000) / 1000;
  timings.indexLockRefusalMs = busyMs;
  record("lock: a second writer is refused, not queued", "index_in_progress", busy?.code ?? "acquired");
  record("lock: the refusal is bounded", "true", String(busyMs < 1000));

  // Different repositories proceed in parallel.
  const parallel = await Promise.all([
    withWorktreeIndexLock({ repoRoot: repoB, operation: async () => "b" }),
    withWorktreeIndexLock({ repoRoot: main, operation: async () => "main" }),
  ]);
  record("lock: unrelated repositories are not serialized", "b,main", parallel.map((entry) => entry.value).join(","));

  // A sibling worktree is a different write target.
  await plant(main, { pid: process.pid, worktreeId: (await resolveWorktreeIdentity(main)).worktree.worktreeId });
  const siblingRun = await withWorktreeIndexLock({ repoRoot: sibling, operation: async () => "sibling" });
  record("lock: a sibling worktree lock does not imply this one is busy", "sibling", String(siblingRun.value));

  // A lock naming another worktree never owned this index.
  await plant(repoB, { pid: process.pid, worktreeId: identityOther.worktree.worktreeId + "-foreign" });
  const foreign = await withWorktreeIndexLock({ repoRoot: repoB, operation: async () => "recovered" });
  record("lock: a foreign claim is recovered and attributed", "foreign_worktree", foreign.staleLockKind ?? "none");

  // An abandoned lock from a dead process.
  await plant(repoB, { pid: 2 ** 22, worktreeId: identityOther.worktree.worktreeId });
  const abandoned = await withWorktreeIndexLock({ repoRoot: repoB, operation: async () => "recovered" });
  record("lock: a dead owner's lock is recovered", "dead_owner", abandoned.staleLockKind ?? "none");

  return {
    contention: {
      schemaVersion: "stage5.m145.lock-contention.v1",
      code: busy?.code ?? null,
      owner: busy?.owner ?? null,
      refusalMs: busyMs,
      hung: false,
    },
    abandoned: {
      schemaVersion: "stage5.m145.abandoned-lock.v1",
      deadOwner: { recovered: abandoned.staleLockRecovered, kind: abandoned.staleLockKind ?? null },
      foreignWorktree: { recovered: foreign.staleLockRecovered, kind: foreign.staleLockKind ?? null },
      recoveredByAge: false,
    },
    isolation: {
      schemaVersion: "stage5.m145.lock-isolation.v1",
      unrelatedRepositoriesParallel: parallel.map((entry) => entry.value),
      siblingWorktreeUnblocked: siblingRun.value === "sibling",
    },
  };
}

// -------------------------------------------------------------- provenance

async function provenanceControls(base: string): Promise<{
  provenance: unknown;
  samePath: unknown;
  sameSymbol: unknown;
}> {
  const root = path.join(base, "provenance");
  await mkdir(root, { recursive: true });
  const files = {
    "src/utils.py": "def parse(value):\n    return value\n",
  };
  const repoA = await makeRepo(path.join(root, "a"), files);
  const repoB = await makeRepo(path.join(root, "b"), files);
  await initRepo({ repoPath: repoA });
  await initRepo({ repoPath: repoB });

  const config = await registerWorkspace({
    configPath: path.join(root, ".vtrace", "workspace.json"),
    repos: [{ alias: "a", rootPath: repoA }, { alias: "b", rootPath: repoB }],
  });
  const registry = await resolveWorkspaceRegistry({ config });
  const a = registry.repositories.find((repo) => repo.alias === "a")!;
  const b = registry.repositories.find((repo) => repo.alias === "b")!;

  // The same relative path and the same FQN in both members: only the owning
  // worktree id separates them.
  const keyA = `${a.worktreeId}\0src/utils.py`;
  const keyB = `${b.worktreeId}\0src/utils.py`;
  record("provenance: the same relative path is two distinct keys", "true", String(keyA !== keyB));
  record("provenance: the same symbol FQN is two distinct keys", "true", String(
    `${a.worktreeId}\0utils.parse` !== `${b.worktreeId}\0utils.parse`,
  ));
  record("provenance: each member carries its own repository id", "true", String(a.repositoryId !== b.repositoryId));

  // One envelope per response, not per candidate.
  const envelope = {
    workspaceId: registry.workspaceId,
    repositoryId: a.repositoryId,
    worktreeId: a.worktreeId,
  };
  const envelopeBytes = Buffer.byteLength(JSON.stringify(envelope), "utf8");
  record("provenance: the envelope stays small", "true", String(envelopeBytes < 256));

  return {
    provenance: {
      schemaVersion: "stage5.m145.result-provenance.v1",
      envelope,
      envelopeBytes,
      perCandidateFields: 0,
    },
    samePath: {
      schemaVersion: "stage5.m145.same-path-collision.v1",
      relativePath: "src/utils.py",
      a: { alias: a.alias, worktreeId: a.worktreeId },
      b: { alias: b.alias, worktreeId: b.worktreeId },
      distinct: keyA !== keyB,
    },
    sameSymbol: {
      schemaVersion: "stage5.m145.same-symbol-collision.v1",
      fqn: "utils.parse",
      distinct: a.worktreeId !== b.worktreeId,
    },
  };
}

// ----------------------------------------------------------------- scaling

async function scalingControls(base: string): Promise<unknown> {
  const root = path.join(base, "scaling");
  await mkdir(root, { recursive: true });

  // Registered members are descriptors here: the question is whether an
  // explicitly routed lookup stays bounded as the registry grows, not whether
  // a thousand real repositories can be indexed.
  const rows = [];
  for (const size of [1, 10, 100, 1000]) {
    const repos = [];
    for (let n = 0; n < size; n += 1) {
      repos.push({
        alias: `r${n}`,
        rootPath: path.join(root, "members", `r${n}`),
        enabled: true,
      });
      await mkdir(path.join(root, "members", `r${n}`), { recursive: true });
    }
    // Fixed-width so the config PATH is the same length at every size: an
    // envelope carrying a workspace id would otherwise appear to grow with the
    // workspace, and the fixture rather than the property would be the finding.
    const config = await writeWorkspaceConfig(
      path.join(root, `ws-${String(size).padStart(4, "0")}`, "workspace.json"),
      {
        schemaVersion: WORKSPACE_CONFIG_SCHEMA_VERSION,
        primaryRepoAlias: "r0",
        repos,
      },
    );
    const loadStarted = performance.now();
    const registry = await resolveWorkspaceRegistry({ config });
    const loadMs = performance.now() - loadStarted;
    const index = buildWorkspaceRouteIndex(registry);

    const routeStarted = performance.now();
    for (let n = 0; n < 1000; n += 1) {
      routeWorkspaceRequest(registry, { alias: `r${n % size}` }, index);
    }
    const routeMs = (performance.now() - routeStarted) / 1000;

    const route = routeWorkspaceRequest(registry, { alias: "r0" }, index);
    const responseBytes = Buffer.byteLength(JSON.stringify({
      workspaceId: registry.workspaceId,
      repositoryId: isRouteFailure(route) ? null : route.repository.repositoryId,
      worktreeId: isRouteFailure(route) ? null : route.repository.worktreeId,
    }), "utf8");

    rows.push({
      registeredRepos: size,
      workspaceLoadMs: Math.round(loadMs * 1000) / 1000,
      routeMsPerLookup: Math.round(routeMs * 1_000_000) / 1_000_000,
      routedResponseBytes: responseBytes,
    });
  }

  const smallest = rows[0]!;
  const largest = rows[rows.length - 1]!;
  record(
    "scaling: an explicitly routed response does not grow with workspace size",
    "true",
    String(largest.routedResponseBytes === smallest.routedResponseBytes),
  );

  return { schemaVersion: "stage5.m145.routing-performance.v1", rows };
}

if (import.meta.main) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exit(1);
  });
}
