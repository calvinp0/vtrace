import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";
import { promisify } from "node:util";

import { listIndexRuns } from "../db/repositories/indexRunsRepository";
import { listSymbolsForFile } from "../db/repositories/symbolsRepository";
import { openIndexerDatabase } from "../db/sqlite";
import { initRepo } from "./initRepo";
import { readRepoLocalConfig, readRepoLocalState } from "./repoState";
import { REPO_LOCAL_STATE_DIRNAME } from "./types";

const execFile = promisify(execFileCallback);

test("init creates repo-local state for a valid repo", async () => {
  await withFixture(async (repoRoot) => {
    await writeFixtureRepo(repoRoot);

    const result = await initRepo({ repoPath: repoRoot });
    const config = await readRepoLocalConfig(result.paths.configPath);
    const state = await readRepoLocalState(result.paths.statePath);

    assert.equal(result.repoRoot, repoRoot);
    assert.equal(result.paths.stateDir, path.join(repoRoot, REPO_LOCAL_STATE_DIRNAME));
    assert.deepEqual(config, result.config);
    assert.deepEqual(state, result.state);
    assert.equal(config.initialized, true);
    assert.equal(state.initialized, true);
  });
});

test("init performs initial indexing into the repo-local sqlite database", async () => {
  await withFixture(async (repoRoot) => {
    await writeFixtureRepo(repoRoot);

    const result = await initRepo({ repoPath: repoRoot });
    const db = openIndexerDatabase(result.paths.dbPath);

    try {
      const runs = listIndexRuns(db);
      const symbols = listSymbolsForFile(db, "src/service.ts");

      assert.equal(result.indexResult.totalFilesSuccessfullyIndexed, 3);
      assert.equal(runs.length, 1);
      assert.deepEqual(
        symbols.map((symbol) => symbol.localName),
        ["readUser"],
      );
    } finally {
      db.close();
    }
  });
});

test("repeated init on the same repo is safe and preserves repo-local config deterministically", async () => {
  await withFixture(async (repoRoot) => {
    await writeFixtureRepo(repoRoot);

    const first = await initRepo({ repoPath: repoRoot });
    const firstConfig = await readRepoLocalConfig(first.paths.configPath);
    const second = await initRepo({ repoPath: repoRoot });
    const secondConfig = await readRepoLocalConfig(second.paths.configPath);
    const secondState = await readRepoLocalState(second.paths.statePath);
    const db = openIndexerDatabase(second.paths.dbPath);

    try {
      assert.deepEqual(secondConfig, firstConfig);
      assert.equal(second.indexResult.totalFilesSuccessfullyIndexed, first.indexResult.totalFilesSuccessfullyIndexed);
      assert.equal(secondState.readiness.status, "ready");
      assert.equal(secondState.latestRunId, 2);
      assert.equal(listIndexRuns(db).length, 2);
    } finally {
      db.close();
    }
  });
});

test("missing or invalid repo paths fail cleanly", async () => {
  await withFixture(async (repoRoot) => {
    const missingRepoRoot = path.join(repoRoot, "missing");
    const filePath = path.join(repoRoot, "repo.txt");

    await writeFile(filePath, "not a directory\n");

    await assert.rejects(
      initRepo({ repoPath: missingRepoRoot }),
      /Repo not found:/,
    );
    await assert.rejects(
      initRepo({ repoPath: filePath }),
      /Repo not found:/,
    );
  });
});

test("init writes readiness metadata based on persisted indexing state", async () => {
  await withFixture(async (repoRoot) => {
    await writeFixtureRepo(repoRoot);

    const result = await initRepo({ repoPath: repoRoot });
    const state = await readRepoLocalState(result.paths.statePath);

    assert.equal(state.readiness.status, "ready");
    assert.equal(state.latestRunId, 1);
    assert.equal(state.latestRun?.totalSymbols, 3);
    assert.deepEqual(
      state.readiness.checks.map((check) => [check.id, check.ok]),
      [
        ["repo_root_exists", true],
        ["state_directory_exists", true],
        ["config_exists", true],
        ["database_exists", true],
        ["latest_run_present", true],
        ["indexed_files_present", true],
        ["indexed_symbols_present", true],
        ["index_failures_absent", true],
      ],
    );
  });
});

test("init persists explicit last-index snapshot metadata when git HEAD is available", async () => {
  await withFixture(async (repoRoot) => {
    await writeFixtureRepo(repoRoot);
    const head = await initializeGitRepo(repoRoot);

    const result = await initRepo({ repoPath: repoRoot });
    const state = await readRepoLocalState(result.paths.statePath);

    assert.equal(state.lastIndexSnapshot?.lastIndexedHead, head);
    assert.equal(state.lastIndexSnapshot?.lastIndexedSourceFileCount, 3);
    assert.equal(typeof state.lastIndexSnapshot?.lastIndexedAtMs, "number");
    assert.equal(typeof state.lastIndexSnapshot?.lastIndexedSourceFingerprint, "string");
  });
});

test("init detects the repo root from a nested path when a git marker exists", async () => {
  await withFixture(async (repoRoot) => {
    await writeFixtureRepo(repoRoot);
    await mkdir(path.join(repoRoot, ".git"), { recursive: true });
    const nestedPath = path.join(repoRoot, "src");

    const result = await initRepo({ repoPath: nestedPath });

    assert.equal(result.repoRoot, repoRoot);
    assert.equal(result.detectionMode, "marker");
    assert.equal(result.detectionMarker, ".git");
  });
});

async function withFixture(
  run: (repoRoot: string) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "vtrace-init-"));
  const repoRoot = path.join(root, "repo");

  try {
    await mkdir(repoRoot, { recursive: true });
    await run(repoRoot);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function writeFixtureRepo(repoRoot: string): Promise<void> {
  await mkdir(path.join(repoRoot, "src"), { recursive: true });
  await writeFile(
    path.join(repoRoot, "src", "models.ts"),
    "export interface User { id: string }\n",
  );
  await writeFile(
    path.join(repoRoot, "src", "service.ts"),
    [
      "import { User } from \"./models\";",
      "export function readUser(): User {",
      "  throw new Error(\"not implemented\");",
      "}",
      "",
    ].join("\n"),
  );
  await writeFile(path.join(repoRoot, "src", "script.py"), "value = 1\n");
}

async function initializeGitRepo(repoRoot: string): Promise<string> {
  await execGit(repoRoot, ["init"]);
  await execGit(repoRoot, ["config", "user.name", "vtrace-tests"]);
  await execGit(repoRoot, ["config", "user.email", "vtrace@example.com"]);
  await execGit(repoRoot, ["add", "."]);
  await execGit(repoRoot, ["commit", "-m", "initial"]);
  return (await execGit(repoRoot, ["rev-parse", "HEAD"])).trim();
}

async function execGit(
  repoRoot: string,
  args: readonly string[],
): Promise<string> {
  const { stdout } = await execFile("git", [...args], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  return stdout;
}
