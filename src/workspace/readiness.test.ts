import { afterAll, describe, expect, test } from "bun:test";
import { rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { initRepo } from "../setup/initRepo";
import { evaluateWorkspaceReadiness } from "./readiness";
import { RegistrationStatus, resolveWorkspaceRegistry, routeWorkspaceRequest } from "./registry";
import {
  cleanupWorkspaceFixtures,
  makeFixtureRepo,
  makeWorkspaceRoot,
  writeFixtureWorkspace,
} from "./workspaceFixture";

afterAll(cleanupWorkspaceFixtures);

/** Two indexed repositories registered in one workspace. */
async function indexedPair() {
  const root = await makeWorkspaceRoot("m145-readiness-");
  const repoA = await makeFixtureRepo(path.join(root, "a"), {
    files: { "src/utils.py": "def parse():\n    return 'A'\n" },
  });
  const repoB = await makeFixtureRepo(path.join(root, "b"), {
    files: { "src/utils.py": "def parse():\n    return 'B'\n" },
  });
  await initRepo({ repoPath: repoA });
  await initRepo({ repoPath: repoB });
  const config = await writeFixtureWorkspace({
    configPath: path.join(root, ".vtrace", "workspace.json"),
    repos: [{ alias: "a", rootPath: repoA }, { alias: "b", rootPath: repoB }],
    primaryRepoAlias: "a",
  });
  return { root, repoA, repoB, config };
}

describe("M145 workspace readiness isolation (§55, §57, §58, §94)", () => {
  test("a workspace reports counts, never one boolean over a stale member", async () => {
    const { repoB, config } = await indexedPair();
    // B's working tree moves; A is untouched.
    await writeFile(path.join(repoB, "src", "utils.py"), "def parse():\n    return 'B2'\n");

    const readiness = await evaluateWorkspaceReadiness(await resolveWorkspaceRegistry({ config }));

    expect(readiness.total).toBe(2);
    expect(readiness.ready).toBe(1);
    expect(readiness.repos.find((repo) => repo.alias === "a")?.ready).toBe(true);
    expect(readiness.repos.find((repo) => repo.alias === "b")?.ready).toBe(false);
  });

  test("a stale B does not block an A-routed request", async () => {
    const { repoB, config } = await indexedPair();
    await writeFile(path.join(repoB, "src", "utils.py"), "def parse():\n    return 'B2'\n");

    const registry = await resolveWorkspaceRegistry({ config });
    const route = routeWorkspaceRequest(registry, { alias: "a" });
    expect(route.ok).toBe(true);

    const readiness = await evaluateWorkspaceReadiness(registry);
    expect(readiness.repos.find((repo) => repo.alias === "a")?.ready).toBe(true);
  });

  test("a stale A fails closed even though B is ready", async () => {
    const { repoA, config } = await indexedPair();
    await writeFile(path.join(repoA, "src", "utils.py"), "def parse():\n    return 'A2'\n");

    const readiness = await evaluateWorkspaceReadiness(await resolveWorkspaceRegistry({ config }));
    const a = readiness.repos.find((repo) => repo.alias === "a");

    expect(a?.ready).toBe(false);
    expect(a?.index?.sourceFresh).toBe(false);
    expect(readiness.repos.find((repo) => repo.alias === "b")?.ready).toBe(true);
  });

  test("a registered repository with no index reports missing rather than ready", async () => {
    const root = await makeWorkspaceRoot("m145-readiness-");
    const indexed = await makeFixtureRepo(path.join(root, "indexed"));
    const bare = await makeFixtureRepo(path.join(root, "bare"));
    await initRepo({ repoPath: indexed });

    const readiness = await evaluateWorkspaceReadiness(await resolveWorkspaceRegistry({
      config: await writeFixtureWorkspace({
        configPath: path.join(root, ".vtrace", "workspace.json"),
        repos: [{ alias: "indexed", rootPath: indexed }, { alias: "bare", rootPath: bare }],
      }),
    }));

    expect(readiness.missing).toBe(1);
    expect(readiness.repos.find((repo) => repo.alias === "bare")?.index?.state).toBe("index_missing");
  });

  test("a replaced repository is refused before its index is consulted", async () => {
    const root = await makeWorkspaceRoot("m145-readiness-");
    const slot = path.join(root, "slot");
    await makeFixtureRepo(slot, { files: { "src/utils.py": "first = 1\n" } });
    await initRepo({ repoPath: slot });
    const config = await writeFixtureWorkspace({
      configPath: path.join(root, ".vtrace", "workspace.json"),
      repos: [{ alias: "slot", rootPath: slot }],
    });

    // The index that gets left behind belongs to the repository that left.
    await rm(path.join(slot, ".git"), { recursive: true, force: true });
    await makeFixtureRepo(slot, { files: { "src/utils.py": "first = 1\n" } });

    const readiness = await evaluateWorkspaceReadiness(await resolveWorkspaceRegistry({ config }));
    const slotReadiness = readiness.repos[0]!;

    expect(slotReadiness.registration).toBe(RegistrationStatus.Mismatch);
    expect(slotReadiness.ready).toBe(false);
    expect(slotReadiness.index).toBeNull();
    expect(readiness.mismatched).toBe(1);
  });

  test("adding an unrelated repository does not change an existing member's readiness", async () => {
    const { root, repoA, repoB, config } = await indexedPair();
    const before = await evaluateWorkspaceReadiness(await resolveWorkspaceRegistry({ config }));

    const repoC = await makeFixtureRepo(path.join(root, "c"), {
      files: { "src/unrelated.py": "def other():\n    return 3\n" },
    });
    const after = await evaluateWorkspaceReadiness(await resolveWorkspaceRegistry({
      config: await writeFixtureWorkspace({
        configPath: path.join(root, ".vtrace", "with-c.json"),
        repos: [
          { alias: "a", rootPath: repoA },
          { alias: "b", rootPath: repoB },
          { alias: "c", rootPath: repoC },
        ],
      }),
    }));

    for (const alias of ["a", "b"]) {
      expect(after.repos.find((repo) => repo.alias === alias)?.index)
        .toEqual(before.repos.find((repo) => repo.alias === alias)!.index);
    }
  });
});
