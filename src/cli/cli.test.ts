import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { symlink } from "node:fs/promises";
import { test } from "bun:test";

import { buildCapsule, createSourceBackedCapsuleBuilder } from "../capsule/buildCapsule";
import { createCharacterBudget } from "../capsule/budget";
import { CapsuleInclusionReasonKind, type CapsuleSupportingCandidate } from "../capsule/types";
import { persistCapsuleManifest } from "../db/repositories/capsuleManifestsRepository";
import { listIndexRuns } from "../db/repositories/indexRunsRepository";
import {
  listObservationsForSession,
  persistObservation,
} from "../db/repositories/observationsRepository";
import { ObservationKind, ObservationSource } from "../observations/types";
import { listSymbolsForFile } from "../db/repositories/symbolsRepository";
import { openIndexerDatabase } from "../db/sqlite";
import { EdgeType, SymbolKind, type SymbolRecord } from "../domain/types";
import {
  SymbolSearchMatchField,
  SymbolSearchMatchType,
  type GraphSearchResult,
} from "../retrieval/types";
import { resolveCodexConfigPath } from "../runtime/codexConfig";
import { resolveClaudeCodeConfigPath } from "../runtime/claudeCodeConfig";
import { recordObservedFileChanges } from "../runtime/fileWatcher";
import { resolveStableLauncherPath } from "../runtime/launcher";
import { resolveRepoLocalPaths } from "../setup/repoState";
import { REPO_LOCAL_STATE_DIRNAME } from "../setup/types";
import { resolveWorkspaceConfigPath } from "../workspace/config";
import { runCli } from "./index";

test("index --json prints a stable machine-readable summary with no progress pollution", async () => {
  await withFixture(async ({ repoRoot, dbPath }) => {
    await writeFixtureRepo(repoRoot);

    const first = await runCli(["index", repoRoot, "--json"], { dbPath });
    const second = await runCli(["index", repoRoot, "--json"], { dbPath });

    assert.equal(first.exitCode, 0);
    assert.equal(first.stderr, "");
    assert.equal(second.exitCode, 0);
    assert.equal(second.stdout, first.stdout);
    assert.doesNotMatch(first.stdout, /==>/, "JSON output must not contain progress phase headers");

    const summary = JSON.parse(first.stdout);
    assert.deepEqual(summary, {
      totalFilesScanned: 3,
      totalFilesAttemptedForParse: 3,
      totalFilesSuccessfullyIndexed: 3,
      totalParseFailures: 0,
      totalSkippedUnregisteredLanguage: 0,
      totalSkippedUnsupportedLanguage: 0,
      totalReadFailures: 0,
      totalPersistenceFailures: 0,
      totalSymbols: summary.totalSymbols,
      totalRelationships: summary.totalRelationships,
      files: [
        {
          path: "src/models.ts",
          language: "typescript",
          status: "indexed",
          diagnostics: [],
        },
        {
          path: "src/script.py",
          language: "python",
          status: "indexed",
          diagnostics: [],
        },
        {
          path: "src/service.ts",
          language: "typescript",
          status: "indexed",
          diagnostics: [],
        },
      ],
    });
    assert.equal(typeof summary.totalSymbols, "number");
    assert.equal(typeof summary.totalRelationships, "number");
    assert.equal(summary.totalSymbols > 0, true);
  });
});

test("index command prints phase headers and a human-readable final summary by default", async () => {
  await withFixture(async ({ repoRoot, dbPath }) => {
    await writeFixtureRepo(repoRoot);

    const result = await runCli(["index", repoRoot], { dbPath });

    assert.equal(result.exitCode, 0);
    assert.equal(result.stderr, "");
    assert.match(result.stdout, /^==> Detecting repo root/m);
    assert.match(result.stdout, /^==> Scanning repository/m);
    assert.match(result.stdout, /^==> Parsing source files/m);
    assert.match(result.stdout, /^==> Extracting symbols and relationships/m);
    assert.match(result.stdout, /^==> Writing local index/m);
    assert.match(result.stdout, /^==> Index complete/m);
    assert.match(result.stdout, /files: 3/);
    assert.match(result.stdout, /symbols: \d+/);
    assert.match(result.stdout, /relationships: \d+/);
    assert.match(result.stdout, /status: \w+/);
    assert.match(result.stdout, /done: \d+ files? discovered/);
    assert.match(result.stdout, /done: 3 parsed, 0 skipped, 0 failed/);
  });
});

test("index reports unsupported JavaScript as a successful path-rich skip", async () => {
  await withFixture(async ({ repoRoot, dbPath }) => {
    await writeFixtureRepo(repoRoot);
    await mkdir(path.join(repoRoot, "frontend"), { recursive: true });
    await writeFile(path.join(repoRoot, "frontend", "eslint.config.js"), "export default [];\n");

    const human = await runCli(["index", repoRoot, "--mode", "full"], { dbPath });
    assert.equal(human.exitCode, 0);
    assert.match(human.stdout, /3 parsed, 1 skipped, 0 failed/);
    assert.match(human.stdout, /frontend\/eslint\.config\.js — javascript\/unregistered_language — No parser registered for language: javascript/);

    const json = await runCli(["index", repoRoot, "--mode", "incremental", "--json"], { dbPath });
    assert.equal(json.exitCode, 0);
    const output = JSON.parse(json.stdout);
    assert.deepEqual(output.files.find((file: { path: string }) => file.path === "frontend/eslint.config.js"), {
      path: "frontend/eslint.config.js",
      language: "javascript",
      status: "unregistered_language",
      diagnostics: [],
      error: {
        code: "unregistered_language",
        message: "No parser registered for language: javascript",
        filePath: "frontend/eslint.config.js",
        language: "javascript",
      },
    });
  });
});

test("index failure summaries retain paths, languages, statuses, and multiple diagnostics", async () => {
  await withFixture(async ({ repoRoot, dbPath }) => {
    await mkdir(path.join(repoRoot, "src"), { recursive: true });
    await writeFile(path.join(repoRoot, "src", "broken.py"), "def broken(:\n");
    await writeFile(path.join(repoRoot, "src", "broken.pyx"), "cdef int broken(\n");

    const result = await runCli(["index", repoRoot, "--mode", "full"], { dbPath });
    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, /Indexing failed/);
    assert.match(result.stderr, /Failed files: 2/);
    assert.match(result.stderr, /src\/broken\.py — python\/parse_failed — Parser failed:/);
    assert.match(result.stderr, /src\/broken\.pyx — cython\/parse_failed — Parser failed:/);
  });
});

test("index --quiet runs cleanly and still emits the final human summary on stdout", async () => {
  await withFixture(async ({ repoRoot, dbPath }) => {
    await writeFixtureRepo(repoRoot);

    const result = await runCli(["index", repoRoot, "--quiet"], { dbPath });

    assert.equal(result.exitCode, 0);
    assert.equal(result.stderr, "");
    assert.match(result.stdout, /Index complete/);
    assert.match(result.stdout, /files: 3/);
  });
});

test("index --no-progress is accepted as an alias for --quiet", async () => {
  await withFixture(async ({ repoRoot, dbPath }) => {
    await writeFixtureRepo(repoRoot);

    const result = await runCli(["index", repoRoot, "--no-progress"], { dbPath });

    assert.equal(result.exitCode, 0);
    assert.match(result.stdout, /Index complete/);
  });
});

test("index failure surfaces a `Reason:` / `Next:` block on stderr", async () => {
  await withFixture(async ({ repoRoot, dbPath }) => {
    await writeFixtureRepo(repoRoot);

    const missingRepo = path.join(repoRoot, "no-such-subdir");
    const result = await runCli(["index", missingRepo], { dbPath });

    assert.equal(result.exitCode, 1);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /^Indexing could not finish\./m);
    assert.match(result.stderr, /^Reason: /m);
    assert.match(result.stderr, /^Next: /m);
  });
});

test("index rejects unknown flags with a usage hint", async () => {
  await withFixture(async ({ repoRoot }) => {
    await writeFixtureRepo(repoRoot);

    const result = await runCli(["index", repoRoot, "--bogus"]);
    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, /Usage: index <repo> \[--repo-root <worktree>\] \[--json\]/);
  });
});

test("index and status accept explicit --repo-root worktree selection", async () => {
  await withFixture(async ({ repoRoot }) => {
    await writeFixtureRepo(repoRoot);
    const indexed = await runCli(["index", "--repo-root", repoRoot, "--json"]);
    assert.equal(indexed.exitCode, 0);
    const status = await runCli(["status", "--repo-root", repoRoot, "--json"]);
    assert.equal(status.exitCode, 0);
    assert.equal(JSON.parse(status.stdout).repoRoot, repoRoot);
  });
});

test("init command bootstraps repo-local state and prints readiness metadata", async () => {
  await withFixture(async ({ repoRoot }) => {
    await writeFixtureRepo(repoRoot);

    const first = await runCli(["init", repoRoot]);
    const second = await runCli(["init", repoRoot]);

    assert.equal(first.exitCode, 0);
    assert.equal(first.stderr, "");
    assert.equal(second.exitCode, 0);
    assert.equal(second.stderr, "");

    const firstOutput = JSON.parse(first.stdout);
    const secondOutput = JSON.parse(second.stdout);
    const db = openIndexerDatabase(secondOutput.paths.dbPath);

    try {
      assert.equal(firstOutput.repoRoot, repoRoot);
      assert.equal(firstOutput.paths.stateDir, path.join(repoRoot, REPO_LOCAL_STATE_DIRNAME));
      assert.equal(firstOutput.initialized, true);
      assert.equal(firstOutput.readiness.status, "ready");
      assert.equal(firstOutput.latestRunId, 1);
      assert.equal(secondOutput.latestRunId, 2);
      assert.deepEqual(
        JSON.parse(await readFile(firstOutput.paths.configPath, "utf8")),
        {
          schemaVersion: "1.0.0",
          repoRoot,
          stateDir: path.join(repoRoot, REPO_LOCAL_STATE_DIRNAME),
          dbPath: path.join(repoRoot, REPO_LOCAL_STATE_DIRNAME, "index.sqlite"),
          statePath: path.join(repoRoot, REPO_LOCAL_STATE_DIRNAME, "state.json"),
          initialized: true,
        },
      );
      assert.equal(JSON.parse(await readFile(firstOutput.paths.statePath, "utf8")).readiness.status, "ready");
      assert.equal(listIndexRuns(db).length, 2);
      await assert.rejects(
        readFile(resolveWorkspaceConfigPath(repoRoot), "utf8"),
        { code: "ENOENT" },
      );
    } finally {
      db.close();
    }
  });
});

test("workspace init creates a primary workspace config without indexing", async () => {
  await withFixture(async ({ repoRoot }) => {
    await writeFixtureRepo(repoRoot);

    const result = await runCli(["workspace", "init", "--alias", "primary"], { cwd: repoRoot });
    const output = JSON.parse(result.stdout);
    const configPath = resolveWorkspaceConfigPath(repoRoot);
    const config = JSON.parse(await readFile(configPath, "utf8"));

    assert.equal(result.exitCode, 0);
    assert.equal(result.stderr, "");
    assert.equal(output.action, "created");
    assert.deepEqual(output.workspace, {
      configPath,
      name: null,
      primaryRepoAlias: "primary",
      repoCount: 1,
    });
    // M145: registration records the identity that was vouched for, so a later
    // repository at the same path can be told apart from this one. The fixture
    // is not a Git worktree, so there is no instance evidence to record — a
    // recorded `null` is the honest answer, not a placeholder.
    assert.deepEqual(config, {
      schemaVersion: "1.0.0",
      primaryRepoAlias: "primary",
      repos: [
        {
          alias: "primary",
          rootPath: repoRoot,
          enabled: true,
          repositoryId: config.repos[0].repositoryId,
          worktreeId: config.repos[0].worktreeId,
          repositoryInstance: null,
          worktreeInstance: null,
        },
      ],
    });
    assert.match(config.repos[0].repositoryId, /^[0-9a-f]{24}$/u);
    assert.match(config.repos[0].worktreeId, /^[0-9a-f]{24}$/u);
    await assert.rejects(
      readFile(path.join(repoRoot, REPO_LOCAL_STATE_DIRNAME, "index.sqlite"), "utf8"),
      { code: "ENOENT" },
    );
  });
});

test("workspace init defaults the primary alias from the repo directory name", async () => {
  await withFixture(async ({ repoRoot }) => {
    await writeFixtureRepo(repoRoot);

    const result = await runCli(["workspace", "init", repoRoot]);
    const output = JSON.parse(result.stdout);

    assert.equal(result.exitCode, 0);
    assert.equal(output.workspace.primaryRepoAlias, path.basename(repoRoot));
    assert.deepEqual(output.primaryRepo, {
      alias: path.basename(repoRoot),
      rootPath: repoRoot,
      enabled: true,
    });
  });
});

test("workspace add appends an enabled repo without indexing it", async () => {
  await withFixture(async ({ repoRoot }) => {
    const siblingRoot = path.join(path.dirname(repoRoot), "sibling");
    await writeFixtureRepo(repoRoot);
    await mkdir(siblingRoot, { recursive: true });
    await writeFixtureRepo(siblingRoot);
    await runCli(["workspace", "init", "--alias", "main"], { cwd: repoRoot });

    const result = await runCli(["workspace", "add", "sibling", siblingRoot], { cwd: repoRoot });
    const output = JSON.parse(result.stdout);
    const config = JSON.parse(await readFile(resolveWorkspaceConfigPath(repoRoot), "utf8"));

    assert.equal(result.exitCode, 0);
    assert.equal(result.stderr, "");
    assert.equal(output.action, "added");
    assert.deepEqual(output.addedRepo, {
      alias: "sibling",
      rootPath: siblingRoot,
      enabled: true,
    });
    assert.deepEqual(
      config.repos.map((repo: { alias: string; rootPath: string; enabled: boolean }) => ({
        alias: repo.alias,
        rootPath: repo.rootPath,
        enabled: repo.enabled,
      })),
      [
        { alias: "main", rootPath: repoRoot, enabled: true },
        { alias: "sibling", rootPath: siblingRoot, enabled: true },
      ],
    );
    // Distinct roots are distinct registrations, and `add` records the second
    // one's identity rather than inheriting the first's.
    assert.notEqual(config.repos[0].worktreeId, config.repos[1].worktreeId);
    await assert.rejects(
      readFile(path.join(siblingRoot, REPO_LOCAL_STATE_DIRNAME, "index.sqlite"), "utf8"),
      { code: "ENOENT" },
    );
  });
});

test("workspace add rejects duplicate aliases and duplicate root paths", async () => {
  await withFixture(async ({ repoRoot }) => {
    const siblingRoot = path.join(path.dirname(repoRoot), "sibling");
    await writeFixtureRepo(repoRoot);
    await mkdir(siblingRoot, { recursive: true });
    await writeFixtureRepo(siblingRoot);
    await runCli(["workspace", "init", "--alias", "main"], { cwd: repoRoot });
    await runCli(["workspace", "add", "sibling", siblingRoot], { cwd: repoRoot });

    const duplicateAlias = await runCli(["workspace", "add", "sibling", repoRoot], { cwd: repoRoot });
    const duplicateRoot = await runCli(["workspace", "add", "copy", siblingRoot], { cwd: repoRoot });

    assert.equal(duplicateAlias.exitCode, 1);
    assert.equal(duplicateAlias.stdout, "");
    assert.match(duplicateAlias.stderr, /Workspace repo alias already exists: sibling/);
    assert.equal(duplicateRoot.exitCode, 1);
    assert.equal(duplicateRoot.stdout, "");
    assert.match(duplicateRoot.stderr, new RegExp(`Workspace repo rootPath already exists: ${escapeRegExp(siblingRoot)}`));
  });
});

test("workspace add rejects missing repo paths explicitly", async () => {
  await withFixture(async ({ repoRoot }) => {
    const missingRoot = path.join(path.dirname(repoRoot), "missing");
    await writeFixtureRepo(repoRoot);
    await runCli(["workspace", "init", "--alias", "main"], { cwd: repoRoot });

    const result = await runCli(["workspace", "add", "missing", missingRoot], { cwd: repoRoot });

    assert.deepEqual(result, {
      exitCode: 1,
      stdout: "",
      stderr: `workspace failed: Repo path does not exist or is not a directory: ${missingRoot}\n`,
    });
  });
});

test("workspace list and status report configured repos deterministically", async () => {
  await withFixture(async ({ repoRoot }) => {
    const siblingRoot = path.join(path.dirname(repoRoot), "sibling");
    await writeFixtureRepo(repoRoot);
    await mkdir(siblingRoot, { recursive: true });
    await writeFixtureRepo(siblingRoot);
    await runCli(["init", repoRoot]);
    await runCli(["workspace", "init", "--alias", "main"], { cwd: repoRoot });
    await runCli(["workspace", "add", "sibling", siblingRoot], { cwd: repoRoot });

    const firstList = await runCli(["workspace", "list"], { cwd: repoRoot });
    const secondList = await runCli(["workspace", "list"], { cwd: repoRoot });
    const status = await runCli(["workspace", "status"], { cwd: repoRoot });
    const listOutput = JSON.parse(firstList.stdout);
    const statusOutput = JSON.parse(status.stdout);

    assert.equal(firstList.exitCode, 0);
    assert.equal(firstList.stdout, secondList.stdout);
    assert.deepEqual(
      listOutput.repos.map((repo: { alias: string; rootPath: string; enabled: boolean }) => repo),
      [
        { alias: "main", rootPath: repoRoot, enabled: true },
        { alias: "sibling", rootPath: siblingRoot, enabled: true },
      ],
    );
    assert.equal(status.exitCode, 0);
    assert.deepEqual(
      statusOutput.repos.map((repo: {
        alias: string;
        rootPath: string;
        enabled: boolean;
        configExists: boolean;
        indexExists: boolean;
        reason: string | null;
      }) => ({
        alias: repo.alias,
        rootPath: repo.rootPath,
        enabled: repo.enabled,
        configExists: repo.configExists,
        indexExists: repo.indexExists,
        reason: repo.reason,
      })),
      [
        {
          alias: "main",
          rootPath: repoRoot,
          enabled: true,
          configExists: true,
          indexExists: true,
          reason: null,
        },
        {
          alias: "sibling",
          rootPath: siblingRoot,
          enabled: true,
          configExists: false,
          indexExists: false,
          reason: `Repo-local config is missing. Run \`vtrace init ${siblingRoot}\` or \`vtrace setup ${siblingRoot}\`.`,
        },
      ],
    );
  });
});

test("setup on a clean repo initializes state, installs Claude config, and keeps runtime optional", async () => {
  await withFixture(async ({ repoRoot }) => {
    await writeFixtureRepo(repoRoot);

    const result = await runCli(["setup"], { cwd: repoRoot });

    assert.equal(result.exitCode, 0);
    assert.equal(result.stderr, "");

    const config = await readClaudeCodeConfig(repoRoot);
    const state = JSON.parse(await readFile(path.join(repoRoot, REPO_LOCAL_STATE_DIRNAME, "state.json"), "utf8"));

    assert.match(result.stdout, /^Setup complete/m);
    assert.match(result.stdout, /Repo state/m);
    assert.match(result.stdout, new RegExp(`Repo root: ${escapeRegExp(repoRoot)}`));
    assert.match(result.stdout, /Setup action: initialized repo-local state and index/);
    assert.match(result.stdout, /Index: .*latest run 1/);
    assert.match(result.stdout, /Action: created MCP config/);
    assert.match(result.stdout, /Action: not requested/);
    assert.match(result.stdout, /Open Claude Code in this repo/);
    assert.equal(state.latestRunId, 1);
    assertExpectedClaudeCodeServer(config, repoRoot);
  });
});

test("repeated setup is safe and reuses existing ready repo state without another index run", async () => {
  await withFixture(async ({ repoRoot }) => {
    await writeFixtureRepo(repoRoot);

    const first = await runCli(["setup", repoRoot]);
    const second = await runCli(["setup", repoRoot]);
    const db = openIndexerDatabase(path.join(repoRoot, REPO_LOCAL_STATE_DIRNAME, "index.sqlite"));

    try {
      assert.equal(first.exitCode, 0);
      assert.equal(second.exitCode, 0);
      assert.match(second.stdout, /^Setup checked this repo and reused the existing ready state/m);
      assert.match(second.stdout, /Setup action: kept existing repo-local state and index/);
      assert.match(second.stdout, /Action: left current config in place/);
      assert.equal(listIndexRuns(db).length, 1);
    } finally {
      db.close();
    }
  });
});

test("claude-config dry-run preserves existing config and update writes the stable launcher entry", async () => {
  await withFixture(async ({ repoRoot }) => {
    await writeFixtureRepo(repoRoot);
    const configPath = resolveClaudeCodeConfigPath(repoRoot);
    await mkdir(path.dirname(configPath), { recursive: true });
    await writeFile(
      configPath,
      `${JSON.stringify({
        projects: {
          [repoRoot]: {
            allowedTools: ["Bash(echo hi)"],
            mcpServers: {
              vtrace: {
                type: "stdio",
                command: "bash",
                args: ["/tmp/old-vtrace", "mcp-serve", "--repo", repoRoot],
                env: {},
              },
            },
          },
        },
      }, null, 2)}\n`,
    );

    const dryRun = await runCli(["claude-config", repoRoot, "--dry-run"]);
    const beforeUpdate = await readFile(configPath, "utf8");
    const updated = await runCli(["claude-config", repoRoot]);
    const afterUpdate = await readClaudeCodeConfig(repoRoot);

    assert.equal(dryRun.exitCode, 0);
    assert.match(dryRun.stdout, /^Claude Code config preview/m);
    assert.match(dryRun.stdout, /Action: updated MCP config \(dry run\)/);
    assert.equal(beforeUpdate.includes("/tmp/old-vtrace"), true);
    assert.equal(updated.exitCode, 0);
    assert.match(updated.stdout, /^Claude Code config updated/m);
    assert.match(updated.stdout, /Action: updated MCP config/);
    assert.match(updated.stdout, /Open Claude Code in this repo/);
    assert.deepEqual(afterUpdate.projects[repoRoot].allowedTools, ["Bash(echo hi)"]);
    assertExpectedClaudeCodeServer(afterUpdate, repoRoot);
  });
});

test("claude-config supports codex and writes the project-scoped .codex/config.toml entry", async () => {
  await withFixture(async ({ repoRoot }) => {
    await writeFixtureRepo(repoRoot);
    const configPath = resolveCodexConfigPath(repoRoot);

    await mkdir(path.dirname(configPath), { recursive: true });
    await writeFile(
      configPath,
      [
        'model = "gpt-5"',
        "",
        "[mcp_servers.vtrace]",
        'command = "bash"',
        `args = ["/tmp/old-vtrace", "mcp-serve", "--repo", ${JSON.stringify(repoRoot)}]`,
        `cwd = ${JSON.stringify(repoRoot)}`,
        "",
      ].join("\n"),
    );

    const dryRun = await runCli(["claude-config", repoRoot, "--agent", "codex", "--dry-run"]);
    const beforeUpdate = await readFile(configPath, "utf8");
    const updated = await runCli(["claude-config", repoRoot, "--agent", "codex"]);
    const jsonStatus = await runCli(["claude-config", repoRoot, "--agent", "codex", "--json"]);
    const afterUpdate = await readFile(configPath, "utf8");
    const jsonOutput = JSON.parse(jsonStatus.stdout);

    assert.equal(dryRun.exitCode, 0);
    assert.match(dryRun.stdout, /^Codex config preview/m);
    assert.match(dryRun.stdout, /Action: updated MCP config \(dry run\)/);
    assert.equal(beforeUpdate.includes("/tmp/old-vtrace"), true);
    assert.equal(updated.exitCode, 0);
    assert.match(updated.stdout, /^Codex config updated/m);
    assert.match(updated.stdout, /Config file: \.codex\/config\.toml/);
    assert.match(updated.stdout, /Vtrace MCP configured for Codex\./);
    assert.match(updated.stdout, /In Codex, \/mcp should show get_code_context\./);
    assert.match(updated.stdout, /Codex should use get_code_context before manual file exploration\./);
    assert.match(updated.stdout, /Open Codex in this repo/);
    assert.equal(jsonStatus.exitCode, 0);
    assert.equal(jsonOutput.ok, true);
    assert.equal(jsonOutput.command, "claude-config");
    assert.equal(jsonOutput.result.selectedAgent, "codex");
    assert.equal(jsonOutput.result.agentConfig.action, "unchanged");
    assert.equal(jsonOutput.result.agentConfig.displayName, "Codex");
    assert.equal(jsonOutput.result.agentConfig.configPath, configPath);
    assert.equal(afterUpdate, buildExpectedCodexConfigToml(repoRoot, ['model = "gpt-5"']));
    await assert.rejects(
      readFile(path.join(repoRoot, ".mcp.json"), "utf8"),
      { code: "ENOENT" },
    );
  });
});

test("claude-config surfaces a clear Codex config conflict when .codex is a file", async () => {
  await withFixture(async ({ repoRoot }) => {
    await writeFixtureRepo(repoRoot);
    await writeFile(path.join(repoRoot, ".codex"), "");

    const result = await runCli(["claude-config", repoRoot, "--agent", "codex"]);

    assert.equal(result.exitCode, 1);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /^Agent config was not updated\./m);
    assert.match(result.stderr, /Codex project config directory is blocked by a file:/);
    assert.match(result.stderr, /Remove or rename it so vtrace can write \.codex\/config\.toml\./);
    assert.equal(/ENOTDIR/.test(result.stderr), false);
  });
});

test("setup surfaces a clear Codex config conflict when .codex is a file", async () => {
  await withFixture(async ({ repoRoot }) => {
    await writeFixtureRepo(repoRoot);
    await writeFile(path.join(repoRoot, ".codex"), "");

    const result = await runCli(["setup", repoRoot, "--agent", "codex"]);

    assert.equal(result.exitCode, 1);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /^Setup could not finish\./m);
    assert.match(result.stderr, /Codex project config directory is blocked by a file:/);
    assert.match(result.stderr, /Remove or rename it so vtrace can write \.codex\/config\.toml\./);
    assert.equal(/ENOTDIR/.test(result.stderr), false);
  });
});

test("daemon status surfaces explicit runtime state and lifecycle commands are inspectable", async () => {
  await withFixture(async ({ repoRoot }) => {
    await writeFixtureRepo(repoRoot);
    await runCli(["setup", repoRoot]);

    const initialStatus = await runCli(["daemon", "status", repoRoot]);
    const started = await runCli(["daemon", "start", repoRoot]);
    const runningStatus = await runCli(["daemon", "status", repoRoot]);
    const logs = await runCli(["daemon", "logs", repoRoot]);
    const stopped = await runCli(["daemon", "stop", repoRoot]);
    const finalStatus = await runCli(["daemon", "status", repoRoot]);

    assert.equal(initialStatus.exitCode, 0);
    assert.match(initialStatus.stdout, /^Runtime status/m);
    assert.match(initialStatus.stdout, /State: not running/);
    assert.equal(started.exitCode, 0);
    assert.match(started.stdout, /^Runtime started/m);
    assert.match(started.stdout, /State: running/);
    assert.equal(runningStatus.exitCode, 0);
    assert.match(runningStatus.stdout, /State: running/);
    assert.match(runningStatus.stdout, /PID: \d+/);
    assert.equal(logs.exitCode, 0);
    assert.match(logs.stdout, /^Runtime logs/m);
    assert.match(logs.stdout, /daemon_started/);
    assert.equal(stopped.exitCode, 0);
    assert.match(stopped.stdout, /^Runtime stopped/m);
    assert.match(finalStatus.stdout, /State: not running/);
  });
});

test("status and doctor surface common readiness and config failure states clearly", async () => {
  await withFixture(async ({ repoRoot }) => {
    await writeFixtureRepo(repoRoot);

    const beforeSetup = await runCli(["status", repoRoot]);
    await runCli(["setup", repoRoot]);
    const afterSetup = await runCli(["doctor", repoRoot]);

    assert.equal(beforeSetup.exitCode, 0);
    assert.equal(afterSetup.exitCode, 0);
    assert.match(beforeSetup.stdout, /^Status/m);
    assert.match(beforeSetup.stdout, /Repo state/m);
    assert.match(beforeSetup.stdout, /Setup: not initialized/);
    assert.match(beforeSetup.stdout, /Index state/m);
    assert.match(beforeSetup.stdout, /State: not initialized yet/);
    assert.match(beforeSetup.stdout, /Freshness: unknown/);
    assert.match(beforeSetup.stdout, /Claude Code config state/m);
    assert.match(beforeSetup.stdout, /State: not installed/);
    assert.match(beforeSetup.stdout, /Next steps/m);
    assert.match(beforeSetup.stdout, /vtrace setup/);

    assert.match(afterSetup.stdout, /^Doctor/m);
    assert.match(afterSetup.stdout, /Setup: initialized/);
    assert.match(afterSetup.stdout, /State: ready/);
    assert.match(afterSetup.stdout, /Index freshness/m);
    assert.match(afterSetup.stdout, /State: fresh/);
    assert.match(afterSetup.stdout, /The current repo appears consistent with the last indexed snapshot\./);
    assert.match(afterSetup.stdout, /State: installed and current/);
    assert.ok(
      afterSetup.stdout.includes(`State file: ${REPO_LOCAL_STATE_DIRNAME}/runtime.json`),
    );
  });
});

test("setup --json returns a stable explicit envelope on clean and already-ready repos", async () => {
  await withFixture(async ({ repoRoot }) => {
    await writeFixtureRepo(repoRoot);

    const first = await runCli(["setup", repoRoot, "--json"]);
    const second = await runCli(["setup", repoRoot, "--json"]);
    const firstOutput = JSON.parse(first.stdout);
    const secondOutput = JSON.parse(second.stdout);

    assert.equal(first.exitCode, 0);
    assert.equal(first.stderr, "");
    assert.deepEqual(Object.keys(firstOutput), [
      "ok",
      "command",
      "repoRoot",
      "timestampMs",
      "result",
      "warnings",
      "nextSteps",
      "error",
    ]);
    assert.equal(firstOutput.ok, true);
    assert.equal(firstOutput.command, "setup");
    assert.equal(firstOutput.repoRoot, repoRoot);
    assert.equal(typeof firstOutput.timestampMs, "number");
    assert.equal(firstOutput.result.selectedAgent, "claude-code");
    assert.equal(firstOutput.result.initAction, "initialized");
    assert.equal(firstOutput.result.agentConfig.action, "created");
    assert.equal(firstOutput.result.runtime.action, "not_requested");
    assert.equal(firstOutput.result.runtime.status.running, false);
    assert.equal(firstOutput.result.readiness.status, "ready");
    assert.equal(Array.isArray(firstOutput.nextSteps), true);
    assert.equal(firstOutput.error, null);

    assert.equal(second.exitCode, 0);
    assert.equal(secondOutput.ok, true);
    assert.equal(secondOutput.result.initAction, "reused_existing_ready_state");
    assert.equal(secondOutput.result.agentConfig.action, "unchanged");
    assert.equal(secondOutput.result.agentConfig.displayName, "Claude Code");
  });
});

test("status --json and doctor --json return stable explicit shell state", async () => {
  await withFixture(async ({ repoRoot }) => {
    await writeFixtureRepo(repoRoot);

    const beforeSetup = await runCli(["status", repoRoot, "--json"]);
    await runCli(["setup", repoRoot]);
    const afterSetup = await runCli(["doctor", repoRoot, "--json"]);
    const beforeOutput = JSON.parse(beforeSetup.stdout);
    const afterOutput = JSON.parse(afterSetup.stdout);

    assert.equal(beforeSetup.exitCode, 0);
    assert.equal(beforeOutput.ok, true);
    assert.equal(beforeOutput.command, "status");
    assert.equal(beforeOutput.repoRoot, repoRoot);
    assert.equal(beforeOutput.result.selectedAgent, "claude-code");
    assert.equal(beforeOutput.result.repoState.initialized, false);
    assert.equal(beforeOutput.result.indexState.indexPresent, false);
    assert.equal(beforeOutput.result.indexState.freshness.state, "unknown");
    assert.equal(beforeOutput.result.indexState.freshness.autoReindex.enabled, false);
    assert.equal(beforeOutput.result.indexState.watcher.autoReindexEnabled, false);
    assert.equal(beforeOutput.result.indexState.watcher.reindexState, "idle");
    assert.equal(beforeOutput.result.agentConfig.installed, false);
    assert.equal(beforeOutput.result.runtime.running, false);
    assert.equal(beforeOutput.error, null);

    assert.equal(afterSetup.exitCode, 0);
    assert.equal(afterOutput.ok, true);
    assert.equal(afterOutput.command, "doctor");
    assert.equal(afterOutput.result.repoState.initialized, true);
    assert.equal(afterOutput.result.indexState.readiness.status, "ready");
    assert.equal(afterOutput.result.indexState.freshness.state, "fresh");
    assert.equal(afterOutput.result.indexState.freshness.autoReindex.state, "idle");
    assert.equal(typeof afterOutput.result.indexState.freshness.snapshot.lastIndexedSourceFingerprint, "string");
    assert.equal(afterOutput.result.agentConfig.matchesExpected, true);
    assert.equal(typeof afterOutput.result.runtime.statePath, "string");
    assert.equal(Array.isArray(afterOutput.nextSteps), true);
  });
});

test("status and doctor surface fresh index freshness for a matching git-backed snapshot", async () => {
  await withFixture(async ({ repoRoot }) => {
    await writeFixtureRepo(repoRoot);
    const committedHead = await initializeGitRepo(repoRoot);

    await runCli(["setup", repoRoot]);
    const status = await runCli(["status", repoRoot]);
    const doctor = await runCli(["doctor", repoRoot]);

    assert.equal(status.exitCode, 0);
    assert.match(status.stdout, /Freshness: fresh/);
    assert.match(status.stdout, /Open Claude Code in this repo; vtrace can use the current indexed snapshot as-is\./);

    assert.equal(doctor.exitCode, 0);
    assert.match(doctor.stdout, /Index freshness/);
    assert.match(doctor.stdout, /State: fresh/);
    assert.match(doctor.stdout, /The current repo appears consistent with the last indexed snapshot\./);
    assert.match(doctor.stdout, /No re-index is recommended right now\./);

    const doctorJson = JSON.parse((await runCli(["doctor", repoRoot, "--json"])).stdout);
    assert.equal(doctorJson.result.indexState.freshness.state, "fresh");
    assert.equal(doctorJson.result.indexState.freshness.snapshot.lastIndexedHead, committedHead);
    assert.equal(typeof doctorJson.result.indexState.freshness.snapshot.lastIndexedSourceFingerprint, "string");
    assert.equal(doctorJson.result.indexState.freshness.currentHead, committedHead);
    assert.deepEqual(doctorJson.result.indexState.freshness.comparison, {
      currentSourceFileCount: 3,
      fingerprintMatches: true,
    });
  });
});

test("status and doctor report fresh immediately after indexing a dirty working tree", async () => {
  await withFixture(async ({ repoRoot }) => {
    await writeFixtureRepo(repoRoot);
    const committedHead = await initializeGitRepo(repoRoot);
    await writeFile(
      path.join(repoRoot, "src", "service.ts"),
      [
        "import { User } from \"./models\";",
        "export function readUser(): User {",
        "  return { id: \"dirty-indexed\" };",
        "}",
        "",
      ].join("\n"),
    );

    await runCli(["setup", repoRoot]);
    const status = await runCli(["status", repoRoot]);
    const doctorJson = JSON.parse((await runCli(["doctor", repoRoot, "--json"])).stdout);

    assert.equal(status.exitCode, 0);
    assert.match(status.stdout, /Freshness: fresh/);
    assert.equal(doctorJson.result.indexState.freshness.state, "fresh");
    assert.equal(doctorJson.result.indexState.freshness.snapshot.lastIndexedHead, committedHead);
    assert.deepEqual(doctorJson.result.indexState.freshness.comparison, {
      currentSourceFileCount: 3,
      fingerprintMatches: true,
    });
  });
});

test("status and doctor surface possibly stale freshness warnings without mutating repo-local state", async () => {
  await withFixture(async ({ repoRoot }) => {
    await writeFixtureRepo(repoRoot);
    await initializeGitRepo(repoRoot);
    await runCli(["setup", repoRoot]);

    await writeFile(
      path.join(repoRoot, "src", "service.ts"),
      [
        "import { User } from \"./models\";",
        "export function readUser(): User {",
        "  return { id: \"stale\" };",
        "}",
        "",
      ].join("\n"),
    );
    await writeFile(path.join(repoRoot, "src", "new-service.ts"), "export const createdLater = true;\n");

    const statePath = path.join(repoRoot, REPO_LOCAL_STATE_DIRNAME, "state.json");
    const db = openIndexerDatabase(path.join(repoRoot, REPO_LOCAL_STATE_DIRNAME, "index.sqlite"));

    try {
      const beforeState = await readFile(statePath, "utf8");
      const beforeRunCount = listIndexRuns(db).length;

      const status = await runCli(["status", repoRoot]);
      const doctor = await runCli(["doctor", repoRoot]);
      const doctorJson = JSON.parse((await runCli(["doctor", repoRoot, "--json"])).stdout);

      const afterState = await readFile(statePath, "utf8");
      const afterRunCount = listIndexRuns(db).length;

      assert.equal(status.exitCode, 0);
      assert.match(status.stdout, /Freshness: possibly stale/);
      assert.match(status.stdout, /Indexed source files appear to have changed since the last indexed snapshot\./);
      assert.match(status.stdout, /Re-index before relying on vtrace for fresh structural guidance\./);

      assert.equal(doctor.exitCode, 0);
      assert.match(doctor.stdout, /State: possibly stale/);
      assert.match(doctor.stdout, /Vtrace detected likely drift since the last indexed snapshot\./);
      assert.match(doctor.stdout, /indexed source file count differs from the last indexed snapshot/);
      assert.match(doctor.stdout, /indexed source fingerprint differs from the last indexed snapshot/);
      assert.match(doctor.stdout, /Retrieval, skeletons, impact graphs, and pipeline output may reflect older structure in changed areas\./);
      assert.match(doctor.stdout, /Re-index this repo before relying on vtrace for fresh structural guidance\./);

      assert.equal(doctorJson.result.indexState.freshness.state, "possibly_stale");
      assert.deepEqual(doctorJson.result.indexState.freshness.comparison, {
        currentSourceFileCount: 4,
        fingerprintMatches: false,
      });

      assert.equal(afterState, beforeState);
      assert.equal(afterRunCount, beforeRunCount);
    } finally {
      db.close();
    }
  });
});

test("status --json surfaces watcher auto-reindex state deterministically", async () => {
  await withFixture(async ({ repoRoot }) => {
    await writeFixtureRepo(repoRoot);
    await runCli(["setup", repoRoot]);
    const paths = resolveRepoLocalPaths(repoRoot);

    await recordObservedFileChanges({
      repoRoot,
      statePath: paths.statePath,
      changedFilePaths: ["src/service.ts", "src/models.ts"],
      nowMs: 7_000,
      autoReindexEnabled: true,
    });

    const status = await runCli(["status", repoRoot, "--json"]);
    const output = JSON.parse(status.stdout);

    assert.equal(status.exitCode, 0);
    assert.equal(output.result.indexState.watcher.autoReindexEnabled, true);
    assert.equal(output.result.indexState.watcher.reindexState, "pending_changes");
    assert.equal(output.result.indexState.watcher.pendingChangedFileCount, 2);
    assert.deepEqual(output.result.indexState.watcher.changedFiles, ["src/models.ts", "src/service.ts"]);
    assert.equal(output.result.indexState.freshness.autoReindex.enabled, true);
    assert.equal(output.result.indexState.freshness.autoReindex.state, "pending_changes");
    assert.deepEqual(output.result.indexState.freshness.autoReindex.changedFiles, ["src/models.ts", "src/service.ts"]);
  });
});

test("index command refreshes last-index metadata after a successful re-index on repo-local state", async () => {
  await withFixture(async ({ repoRoot }) => {
    await writeFixtureRepo(repoRoot);
    await initializeGitRepo(repoRoot);
    await runCli(["setup", repoRoot]);

    await writeFile(path.join(repoRoot, "src", "models.ts"), "export interface User { id: string; email: string }\n");
    await execGit(repoRoot, ["add", "src/models.ts"]);
    await execGit(repoRoot, ["commit", "-m", "change models"]);
    const updatedHead = (await execGit(repoRoot, ["rev-parse", "HEAD"])).trim();

    const reindex = await runCli(["index", repoRoot]);
    const state = JSON.parse(await readFile(path.join(repoRoot, REPO_LOCAL_STATE_DIRNAME, "state.json"), "utf8"));
    const status = await runCli(["status", repoRoot, "--json"]);
    const statusOutput = JSON.parse(status.stdout);

    assert.equal(reindex.exitCode, 0);
    assert.equal(state.lastIndexSnapshot.lastIndexedHead, updatedHead);
    assert.equal(typeof state.lastIndexSnapshot.lastIndexedSourceFingerprint, "string");
    assert.equal(statusOutput.result.indexState.freshness.state, "fresh");
    assert.equal(statusOutput.result.indexState.freshness.snapshot.lastIndexedHead, updatedHead);
    assert.equal(typeof statusOutput.result.indexState.freshness.snapshot.lastIndexedSourceFingerprint, "string");
  });
});

test("daemon commands support --json with explicit stable result fields", async () => {
  await withFixture(async ({ repoRoot }) => {
    await writeFixtureRepo(repoRoot);
    await runCli(["setup", repoRoot]);

    const before = JSON.parse((await runCli(["daemon", "status", repoRoot, "--json"])).stdout);
    const started = JSON.parse((await runCli(["daemon", "start", repoRoot, "--json"])).stdout);
    const logs = JSON.parse((await runCli(["daemon", "logs", repoRoot, "--json"])).stdout);
    const stopped = JSON.parse((await runCli(["daemon", "stop", repoRoot, "--json"])).stdout);

    assert.equal(before.command, "daemon.status");
    assert.equal(before.ok, true);
    assert.equal(before.result.runtime.running, false);
    assert.equal(before.result.runtime.pid, null);

    assert.equal(started.command, "daemon.start");
    assert.equal(started.ok, true);
    assert.equal(started.result.action, "started");
    assert.equal(started.result.runtime.running, true);
    assert.equal(typeof started.result.runtime.pid, "number");

    assert.equal(logs.command, "daemon.logs");
    assert.equal(logs.ok, true);
    assert.equal(typeof logs.result.logPath, "string");
    assert.equal(typeof logs.result.hasContent, "boolean");
    assert.equal(typeof logs.result.content, "string");

    assert.equal(stopped.command, "daemon.stop");
    assert.equal(stopped.ok, true);
    assert.equal(stopped.result.action, "stopped");
    assert.equal(stopped.result.runtime.running, false);
  });
});

test("agent selection remains narrow: claude-code works and unsupported agents fail clearly", async () => {
  await withFixture(async ({ repoRoot }) => {
    await writeFixtureRepo(repoRoot);

    const supported = await runCli(["setup", repoRoot, "--agent", "claude-code", "--json"]);
    const setupText = await runCli(["setup", repoRoot, "--agent", "claude-code"]);
    const unsupported = await runCli(["status", repoRoot, "--agent", "other-agent", "--json"]);
    const supportedOutput = JSON.parse(supported.stdout);
    const unsupportedOutput = JSON.parse(unsupported.stdout);
    const claudeMd = await readFile(path.join(repoRoot, "CLAUDE.md"), "utf8");

    assert.equal(supported.exitCode, 0);
    assert.equal(supportedOutput.ok, true);
    assert.equal(supportedOutput.result.selectedAgent, "claude-code");
    assert.equal(supportedOutput.result.agentGuidance.path, path.join(repoRoot, "CLAUDE.md"));
    assert.equal(supportedOutput.result.agentGuidance.target, "CLAUDE.md");
    assert.equal(supportedOutput.result.agentGuidance.action, "created");
    assert.match(claudeMd, /<!-- vtrace:start -->/);
    assert.match(claudeMd, /get_code_context/);
    assert.equal(/gitnexus/i.test(claudeMd), false);
    await assert.rejects(
      readFile(path.join(repoRoot, "AGENTS.md"), "utf8"),
      { code: "ENOENT" },
    );
    assert.match(setupText.stdout, /Claude Code guidance/);
    assert.match(setupText.stdout, /Action: Vtrace guidance block already current/);
    assert.match(setupText.stdout, /Guidance block: CLAUDE\.md/);

    assert.equal(unsupported.exitCode, 1);
    assert.equal(unsupported.stderr, "");
    assert.equal(unsupportedOutput.ok, false);
    assert.equal(unsupportedOutput.command, "status");
    assert.equal(unsupportedOutput.repoRoot, null);
    assert.match(unsupportedOutput.error.message, /Unsupported agent: other-agent/);
    assert.match(unsupportedOutput.error.message, /claude-code/);
    assert.match(unsupportedOutput.error.message, /codex/);
  });
});

test("setup accepts --agent claude as an alias for claude-code and writes CLAUDE.md", async () => {
  await withFixture(async ({ repoRoot }) => {
    await writeFixtureRepo(repoRoot);

    const setup = await runCli(["setup", repoRoot, "--agent", "claude", "--json"]);
    const setupOutput = JSON.parse(setup.stdout);
    const claudeMd = await readFile(path.join(repoRoot, "CLAUDE.md"), "utf8");

    assert.equal(setup.exitCode, 0);
    assert.equal(setupOutput.ok, true);
    assert.equal(setupOutput.result.selectedAgent, "claude-code");
    assert.equal(setupOutput.result.agentGuidance.target, "CLAUDE.md");
    assert.match(claudeMd, /<!-- vtrace:start -->/);
    assert.match(claudeMd, /get_code_context/);
    await assert.rejects(
      readFile(path.join(repoRoot, "AGENTS.md"), "utf8"),
      { code: "ENOENT" },
    );
  });
});

test("setup and status support codex as a second real backend", async () => {
  await withFixture(async ({ repoRoot }) => {
    await writeFixtureRepo(repoRoot);

    const setup = await runCli(["setup", repoRoot, "--agent", "codex", "--json"]);
    const setupText = await runCli(["setup", repoRoot, "--agent", "codex"]);
    const status = await runCli(["status", repoRoot, "--agent", "codex"]);
    const doctor = await runCli(["doctor", repoRoot, "--agent", "codex", "--json"]);
    const setupOutput = JSON.parse(setup.stdout);
    const doctorOutput = JSON.parse(doctor.stdout);
    const configPath = resolveCodexConfigPath(repoRoot);
    const config = await readFile(configPath, "utf8");
    const agents = await readFile(path.join(repoRoot, "AGENTS.md"), "utf8");

    assert.equal(setup.exitCode, 0);
    assert.equal(setupOutput.ok, true);
    assert.equal(setupOutput.result.selectedAgent, "codex");
    assert.equal(setupOutput.result.agentConfig.displayName, "Codex");
    assert.equal(setupOutput.result.agentConfig.configPath, configPath);
    assert.equal(setupOutput.result.agentConfig.matchesExpected, true);
    assert.equal(setupOutput.result.agentGuidance.path, path.join(repoRoot, "AGENTS.md"));
    assert.equal(setupOutput.result.agentGuidance.target, "AGENTS.md");
    assert.equal(setupOutput.result.agentGuidance.action, "created");
    assert.equal(config, buildExpectedCodexConfigToml(repoRoot));
    assert.match(agents, /<!-- vtrace:start -->/);
    assert.match(agents, /get_code_context/);
    assert.equal(/gitnexus/i.test(agents), false);
    assert.equal(setupText.exitCode, 0);
    assert.match(setupText.stdout, /Codex guidance/);
    assert.match(setupText.stdout, /Action: Vtrace guidance block already current/);
    assert.match(setupText.stdout, /Guidance block: AGENTS\.md/);
    assert.match(setupText.stdout, /Vtrace MCP configured for Codex\./);
    assert.match(setupText.stdout, /In Codex, \/mcp should show get_code_context\./);
    assert.match(setupText.stdout, /For broad repo tasks, Codex should use get_code_context before manual file exploration\./);
    await assert.rejects(
      readFile(path.join(repoRoot, ".mcp.json"), "utf8"),
      { code: "ENOENT" },
    );

    assert.equal(status.exitCode, 0);
    assert.match(status.stdout, /Codex config state/);
    assert.match(status.stdout, /Config file: \.codex\/config\.toml/);
    assert.match(status.stdout, /Freshness: fresh/);
    assert.match(status.stdout, /vtrace can use the current indexed snapshot as-is\./);

    assert.equal(doctor.exitCode, 0);
    assert.equal(doctorOutput.ok, true);
    assert.equal(doctorOutput.command, "doctor");
    assert.equal(doctorOutput.result.selectedAgent, "codex");
    assert.equal(doctorOutput.result.agentConfig.displayName, "Codex");
    assert.equal(doctorOutput.result.agentConfig.matchesExpected, true);
  });
});

test("claude-config accepts --agent claude-code and writes Claude local MCP config", async () => {
  await withFixture(async ({ repoRoot }) => {
    await writeFixtureRepo(repoRoot);

    const result = await runCli(["claude-config", repoRoot, "--agent", "claude-code"]);
    const config = await readClaudeCodeConfig(repoRoot);

    assert.equal(result.exitCode, 0);
    assert.match(result.stdout, /^Claude Code config installed/m);
    assertExpectedClaudeCodeServer(config, repoRoot);
  });
});

test("claude-config --json returns a stable explicit envelope and supports dry-run", async () => {
  await withFixture(async ({ repoRoot }) => {
    await writeFixtureRepo(repoRoot);
    const configPath = resolveClaudeCodeConfigPath(repoRoot);
    await mkdir(path.dirname(configPath), { recursive: true });
    await writeFile(
      configPath,
      `${JSON.stringify({
        projects: {
          [repoRoot]: {
            mcpServers: {
              vtrace: {
                type: "stdio",
                command: "bash",
                args: ["/tmp/old-vtrace", "mcp-serve", "--repo", repoRoot],
                env: {},
              },
            },
          },
        },
      }, null, 2)}\n`,
    );

    const dryRun = await runCli(["claude-config", repoRoot, "--dry-run", "--json"]);
    const beforeUpdate = await readFile(configPath, "utf8");
    const updated = await runCli(["claude-config", repoRoot, "--json"]);
    const afterUpdate = await readClaudeCodeConfig(repoRoot);
    const dryRunOutput = JSON.parse(dryRun.stdout);
    const updatedOutput = JSON.parse(updated.stdout);

    assert.equal(dryRun.exitCode, 0);
    assert.equal(dryRun.stderr, "");
    assert.deepEqual(Object.keys(dryRunOutput), [
      "ok",
      "command",
      "repoRoot",
      "timestampMs",
      "result",
      "warnings",
      "nextSteps",
      "error",
    ]);
    assert.equal(dryRunOutput.ok, true);
    assert.equal(dryRunOutput.command, "claude-config");
    assert.equal(dryRunOutput.repoRoot, repoRoot);
    assert.equal(dryRunOutput.result.selectedAgent, "claude-code");
    assert.equal(dryRunOutput.result.agentConfig.action, "updated");
    assert.equal(dryRunOutput.result.agentConfig.dryRun, true);
    assert.equal(dryRunOutput.result.agentConfig.installed, true);
    assert.equal(dryRunOutput.error, null);
    assert.equal(beforeUpdate.includes("/tmp/old-vtrace"), true);

    assert.equal(updated.exitCode, 0);
    assert.equal(updated.stderr, "");
    assert.equal(updatedOutput.ok, true);
    assert.equal(updatedOutput.command, "claude-config");
    assert.equal(updatedOutput.result.selectedAgent, "claude-code");
    assert.equal(updatedOutput.result.agentConfig.action, "updated");
    assert.equal(updatedOutput.result.agentConfig.dryRun, false);
    assert.equal(updatedOutput.result.agentConfig.displayName, "Claude Code");
    assert.equal(updatedOutput.result.agentConfig.launcher.command, "bash");
    assert.equal(updatedOutput.error, null);
    assertExpectedClaudeCodeServer(afterUpdate, repoRoot);
  });
});

test("claude-config --json failures are explicit and keep stderr empty", async () => {
  await withFixture(async ({ repoRoot }) => {
    await writeFixtureRepo(repoRoot);

    const result = await runCli(["claude-config", repoRoot, "--agent", "other-agent", "--json"]);
    const output = JSON.parse(result.stdout);

    assert.equal(result.exitCode, 1);
    assert.equal(result.stderr, "");
    assert.equal(output.ok, false);
    assert.equal(output.command, "claude-config");
    assert.equal(output.repoRoot, null);
    assert.equal(output.result, null);
    assert.equal(Array.isArray(output.nextSteps), true);
    assert.match(output.error.message, /Unsupported agent: other-agent/);
    assert.match(output.error.message, /claude-code/);
    assert.match(output.error.message, /codex/);
  });
});

test.skip("init followed by capsule succeeds on the same repo and resolution remains deterministic", async () => {
  await withFixture(async ({ repoRoot }) => {
    await writeCapsuleFixtureRepo(repoRoot);

    const initialized = await runCli(["init", repoRoot]);
    const first = await runCli(["capsule", repoRoot, "Session"]);
    const second = await runCli(["capsule", repoRoot, "Session"]);

    assert.equal(initialized.exitCode, 0);
    assert.equal(first.exitCode, 0);
    assert.equal(first.stderr, "");
    assert.equal(second.stdout, first.stdout);

    const output = JSON.parse(first.stdout);
    assert.equal(output.query, "Session");
    assert.equal(output.intent, "explain");
    assert.equal(output.routingProfile.id, "explain");
    assert.equal(output.capsuleProfile.id, "explain_stable");
  });
});

test("capsule v2 --pivot-neighborhood --json emits a bounded pivot_neighborhood array", async () => {
  await withFixture(async ({ repoRoot }) => {
    await writeCapsuleFixtureRepo(repoRoot);
    await runCli(["init", repoRoot]);

    const withFlag = await runCli([
      "capsule", repoRoot, "createSession in src/session.ts#L4-L6 returns wrong value",
      "--intent", "auto", "--budget", "8000", "--pivot-neighborhood", "--json",
    ]);
    assert.equal(withFlag.exitCode, 0);
    const out = JSON.parse(withFlag.stdout);
    // The flag threads through end-to-end: the v2 result carries the additive
    // pivot_neighborhood array (empty when no pivot symbol identity resolves).
    assert.ok(Array.isArray(out.pivot_neighborhood), "expected a pivot_neighborhood array");
    for (const ctx of out.pivot_neighborhood) {
      assert.ok(ctx.excerpts.length <= 4, "per-pivot excerpt budget enforced");
      for (const e of ctx.excerpts) {
        assert.ok(e.text.split("\n").length <= 12, "12-line ceiling enforced");
      }
    }

    // Default (no flag): the field is absent, so existing capsule v2 output is unchanged.
    const withoutFlag = await runCli([
      "capsule", repoRoot, "createSession in src/session.ts#L4-L6 returns wrong value",
      "--intent", "auto", "--budget", "8000", "--json",
    ]);
    assert.equal(withoutFlag.exitCode, 0);
    const withoutFlagOutput = JSON.parse(withoutFlag.stdout);
    assert.equal(withoutFlagOutput.pivot_neighborhood, undefined);
    // JSON parity with the MCP get_context_capsule (v2) tool: both the plain and
    // the --pivot-neighborhood v2 JSON paths carry the same accounting block.
    assert.equal(withoutFlagOutput.accounting.method, "chars_div_4");
    assert.equal(typeof withoutFlagOutput.accounting.latencyMs, "number");
    assert.equal(out.accounting.method, "chars_div_4");
  });
});

test("capsule v2 --pivot-neighborhood human output leads with an inspect-first block; v1/default does not", async () => {
  await withFixture(async ({ repoRoot }) => {
    await writeCapsuleFixtureRepo(repoRoot);
    await runCli(["init", repoRoot]);

    // Capsule v2 + neighborhood (human, no --json): the compact, guidance-only
    // inspect-first block leads the injected context.
    const v2 = await runCli([
      "capsule", repoRoot, "createSession in src/session.ts#L4-L6 returns wrong value",
      "--intent", "auto", "--budget", "8000", "--pivot-neighborhood",
    ]);
    assert.equal(v2.exitCode, 0);
    assert.ok(v2.stdout.includes("VTRACE inspect-first"), "v2 human output carries the inspect-first block");
    assert.ok(v2.stdout.includes("guidance, not enforcement"), "block is explicitly guidance, not enforcement");
    assert.ok(v2.stdout.indexOf("VTRACE inspect-first") < v2.stdout.indexOf("intent:"), "inspect-first leads the context");

    // v1/default path (legacy mode, no --intent/--budget): no inspect-first block.
    const v1 = await runCli(["capsule", repoRoot, "createSession in src/session.ts returns wrong value"]);
    assert.equal(v1.exitCode, 0);
    assert.ok(!v1.stdout.includes("VTRACE inspect-first"), "v1/default path must not emit the inspect-first block");
  });
});

test.skip("run-pipeline --capsule-engine v2 emits the v2 section and records effective=v2", async () => {
  await withFixture(async ({ repoRoot }) => {
    await writeCapsuleFixtureRepo(repoRoot);
    await runCli(["init", repoRoot]);

    const result = await runCli([
      "run-pipeline", repoRoot,
      "modify createSession in SessionManager to accept a label",
      "--capsule-engine", "v2", "--capsule-intent", "modify",
    ]);
    assert.equal(result.exitCode, 0);

    const output = JSON.parse(result.stdout);
    assert.equal(output.contextEngine, "v2");
    assert.equal(output.capsuleV2.engine, "v2");
    assert.equal(output.capsuleEngine.requested, "v2");
    assert.equal(output.capsuleEngine.effective, "v2");
    assert.equal(output.capsuleEngine.fallbackReason, null);
    // Same shared inspect-first projection the MCP/Stage-5 paths use.
    assert.equal(output.capsuleEngine.compactInspectFirst, true);
    assert.notEqual(output.inspectFirst, null);
  });
});

test.skip("run-pipeline --capsule-engine v1 and legacy stay on v1 but record the request", async () => {
  await withFixture(async ({ repoRoot }) => {
    await writeCapsuleFixtureRepo(repoRoot);
    await runCli(["init", repoRoot]);

    for (const requested of ["v1", "legacy"]) {
      const result = await runCli([
        "run-pipeline", repoRoot, "Session", "--capsule-engine", requested,
      ]);
      assert.equal(result.exitCode, 0);
      const output = JSON.parse(result.stdout);
      assert.equal(output.contextEngine, undefined);
      assert.equal(output.capsuleV2, undefined);
      assert.equal(output.capsuleEngine.requested, requested);
      assert.equal(output.capsuleEngine.effective, "v1");
      assert.equal(output.capsuleEngine.fallbackReason, null);
      assert.equal(output.capsuleEngine.compactInspectFirst, false);
    }
  });
});

test.skip("run-pipeline default records effective=v1 and rejects an unknown engine", async () => {
  await withFixture(async ({ repoRoot }) => {
    await writeCapsuleFixtureRepo(repoRoot);
    await runCli(["init", repoRoot]);

    const def = await runCli(["run-pipeline", repoRoot, "Session"]);
    assert.equal(def.exitCode, 0);
    const output = JSON.parse(def.stdout);
    assert.deepEqual(output.capsuleEngine, {
      requested: "default",
      effective: "v1",
      fallbackReason: null,
      compactInspectFirst: false,
    });

    // An unrecognized engine is a usage error, not a silent downgrade.
    const bogus = await runCli([
      "run-pipeline", repoRoot, "Session", "--capsule-engine", "v9",
    ]);
    assert.notEqual(bogus.exitCode, 0);
    assert.match(bogus.stderr + bogus.stdout, /capsule-engine must be one of/);
  });
});

test("CLI run-pipeline uses one capsule, treats aliases as deprecated, and rejects v1 before repo access", async () => {
  await withFixture(async ({ repoRoot }) => {
    await writeCapsuleFixtureRepo(repoRoot);
    await runCli(["init", repoRoot]);

    const current = await runCli(["run-pipeline", repoRoot, "modify createSession", "--capsule-intent", "modify"]);
    const deprecatedDefault = await runCli([
      "run-pipeline", repoRoot, "modify createSession", "--capsule-engine", "default", "--capsule-intent", "modify",
    ]);
    const deprecatedV2 = await runCli([
      "run-pipeline", repoRoot, "modify createSession", "--capsule-engine", "v2", "--capsule-intent", "modify",
    ]);
    for (const result of [current, deprecatedDefault, deprecatedV2]) assert.equal(result.exitCode, 0);

    const outputs = [current, deprecatedDefault, deprecatedV2].map((result) => JSON.parse(result.stdout));
    assert.deepEqual(outputs[1].capsuleResult, outputs[0].capsuleResult);
    assert.deepEqual(outputs[2].capsuleResult, outputs[0].capsuleResult);
    assert.equal(outputs[0].capsule.implementation, "hybrid");
    assert.equal(outputs[0].runtime.retrievalImplementation, "product-retrieval-v2");
    assert.deepEqual(outputs[0].capsule.compatibilityWarnings, []);
    assert.match(outputs[1].capsule.compatibilityWarnings[0], /deprecated and ignored/);
    assert.match(outputs[2].capsule.compatibilityWarnings[0], /deprecated and ignored/);
    assert.equal(outputs[0].capsuleEngine, undefined);
  });

  const rejected = await runCli([
    "run-pipeline", "/definitely/not/indexed", "modify createSession", "--capsule-engine", "v1",
  ]);
  assert.notEqual(rejected.exitCode, 0);
  assert.match(rejected.stderr + rejected.stdout, /Remove capsule_engine=v1/);
  assert.doesNotMatch(rejected.stderr + rejected.stdout, /Repo not indexed/);
});

test("CLI capsule omission uses the authoritative hybrid result", async () => {
  await withFixture(async ({ repoRoot }) => {
    await writeCapsuleFixtureRepo(repoRoot);
    await runCli(["init", repoRoot]);
    const result = await runCli(["capsule", repoRoot, "modify createSession", "--json"]);
    assert.equal(result.exitCode, 0);
    const output = JSON.parse(result.stdout);
    assert.ok(Array.isArray(output.pivots));
    assert.ok(Array.isArray(output.support));
    assert.equal(output.productContext.task, "modify createSession");
    assert.notEqual(output.productContext.modelVisibleContext, "");
  });
});

test.skip("capsule --mode micro --json returns a skip directive (not empty context) when no pivot is recovered", async () => {
  await withFixture(async ({ repoRoot }) => {
    await writeCapsuleFixtureRepo(repoRoot);
    await runCli(["init", repoRoot]);

    const result = await runCli(["capsule", repoRoot, "zzqq nonexistent xyzzy gibberish", "--mode", "micro", "--json"]);
    assert.equal(result.exitCode, 0);

    const output = JSON.parse(result.stdout);
    // A no-pivot micro task is a VALID skip decision, surfaced via the diagnostics.
    assert.equal(output.diagnostics.actual_mode, "skip");
    assert.equal(output.diagnostics.recommended_mode, "skip");
    assert.equal(output.diagnostics.pivot_count, 0);
    assert.equal(output.diagnostics.search_budget, "high");
    assert.equal(output.diagnostics.action_header.has_target, false);
    // The skip is no longer opaque: rejected-candidate diagnostics are emitted and
    // the reason names WHY no pivot was chosen (Requirement 1/2). A gibberish query
    // surfaces no candidates, so the reason is the empty-pool diagnosis.
    assert.equal(output.diagnostics.candidate_count_before_roles, 0);
    assert.equal(output.diagnostics.discarded_candidate_count, 0);
    assert.deepEqual(output.diagnostics.top_discarded_candidates, []);
    assert.match(output.diagnostics.retrieval_reason, /no candidates recovered/);
    // The body carries a decisive "do not inject context" directive rather than an
    // empty/misdirecting capsule (Requirement 1).
    assert.match(output.context, /## Recommended first action/);
    assert.match(output.context, /Do not inject context for this task\./);
  });
});

test.skip("capsule --mode micro --json reports rejected candidates and a discard reason on a skip", async () => {
  await withFixture(async ({ repoRoot }) => {
    await writeCapsuleFixtureRepo(repoRoot);
    await runCli(["init", repoRoot]);

    // A query that matches only the failing-test symbols (never edit targets) so
    // candidates ARE recovered but every one is discarded — distinguishing a
    // discarded pool from an empty pool (Requirement 2).
    const result = await runCli([
      "capsule",
      repoRoot,
      "failing tests: tests.session.SessionTest.test_create_session",
      "--mode",
      "micro",
      "--json",
    ]);
    assert.equal(result.exitCode, 0);
    const output = JSON.parse(result.stdout);

    if (output.diagnostics.actual_mode !== "skip") {
      // The fixture recovered a real pivot — still a valid, non-vague outcome.
      assert.equal(output.diagnostics.pivot_count, 1);
      return;
    }
    // On a skip, the diagnostics expose the rejected pool so an over-strict gate is
    // visible, and the reason is NOT the empty-pool diagnosis when candidates exist.
    assert.ok(output.diagnostics.candidate_count_before_roles >= 0);
    if (output.diagnostics.candidate_count_before_roles > 0) {
      assert.notEqual(output.diagnostics.retrieval_reason, "");
      assert.doesNotMatch(output.diagnostics.retrieval_reason, /^no candidates recovered/);
    }
    for (const discard of output.diagnostics.top_discarded_candidates) {
      assert.ok(typeof discard.discard_reason === "string" && discard.discard_reason.length > 0);
      assert.ok("scores" in discard && "evidence" in discard);
    }
  });
});

test.skip("capsule --mode micro --json leads with a decisive action header when a pivot is recovered", async () => {
  await withFixture(async ({ repoRoot }) => {
    await writeCapsuleFixtureRepo(repoRoot);
    await runCli(["init", repoRoot]);

    const result = await runCli(["capsule", repoRoot, "SessionManager createSession", "--mode", "micro", "--json"]);
    assert.equal(result.exitCode, 0);
    const output = JSON.parse(result.stdout);

    // Either a decisive injected target or an honest skip — never a vague capsule.
    if (output.diagnostics.actual_mode === "skip") {
      assert.equal(output.diagnostics.action_header.has_target, false);
      return;
    }
    assert.equal(output.diagnostics.action_header.has_target, true);
    assert.ok(output.diagnostics.action_header.pivot_file.length > 0);
    assert.ok(output.diagnostics.action_header.pivot_symbol.length > 0);
    // Micro is one-pivot / one-support by policy (Requirement 2).
    assert.equal(output.diagnostics.pivot_count, 1);
    assert.ok(output.diagnostics.support_count <= 1);
    assert.match(output.context, /## Recommended first action/);
    assert.match(output.context, /Open\/edit `.+::.+` first\./);
    // The support section, when present, is explicitly not an edit target.
    if (output.context.includes("## Support context")) {
      assert.match(output.context, /## Support context — do not edit first/);
    }
  });
});

test("init followed by handoff succeeds on the same repo", async () => {
  await withFixture(async ({ repoRoot }) => {
    await writeCapsuleFixtureRepo(repoRoot);

    const initialized = await runCli(["init", repoRoot]);
    const result = await runCli(["handoff", repoRoot, "Session"]);

    assert.equal(initialized.exitCode, 0);
    assert.equal(result.exitCode, 0);
    assert.equal(result.stderr, "");

    const output = JSON.parse(result.stdout);
    assert.deepEqual(output.schema, {
      name: "vtrace.external_handoff",
      version: "1.0.0",
    });
    assert.equal(output.selectedIntent, "explain");
    assert.equal(output.provenance.repoRoot, repoRoot);
  });
});

test("init followed by intent succeeds on the same repo", async () => {
  await withFixture(async ({ repoRoot }) => {
    await writeIntentFixtureRepo(repoRoot);

    const initialized = await runCli(["init", repoRoot]);
    const result = await runCli(["intent", repoRoot, "fix session bug"]);

    assert.equal(initialized.exitCode, 0);
    assert.equal(result.exitCode, 0);
    assert.equal(result.stderr, "");

    const output = JSON.parse(result.stdout);
    assert.equal(output.intent, "debug");
    assert.equal(output.profile.id, "debug");
  });
});

test("init followed by runs succeeds on the same repo", async () => {
  await withFixture(async ({ repoRoot }) => {
    await writeFixtureRepo(repoRoot);

    const initialized = await runCli(["init", repoRoot]);
    const result = await runCli(["runs", repoRoot]);

    assert.equal(initialized.exitCode, 0);
    assert.equal(result.exitCode, 0);
    assert.equal(result.stderr, "");

    const output = JSON.parse(result.stdout);
    assert.deepEqual(output.runs.map((run: { id: number }) => run.id), [1]);
    assert.equal(output.runs[0].totalFiles, 3);
    // M140: 3 definitions + the file's module scope symbol.
    assert.equal(output.runs[0].totalSymbols, 4);
  });
});

test("init followed by check-capsule succeeds where a manifest exists", async () => {
  await withFixture(async ({ repoRoot }) => {
    await writeFixtureRepo(repoRoot);

    const firstInit = await runCli(["init", repoRoot]);
    const { manifestId } = persistSourceBackedFixtureManifest(repoRoot);
    const secondInit = await runCli(["init", repoRoot]);
    const result = await runCli(["check-capsule", repoRoot, manifestId, "2"]);

    assert.equal(firstInit.exitCode, 0);
    assert.equal(secondInit.exitCode, 0);
    assert.equal(result.exitCode, 0);
    assert.equal(result.stderr, "");

    const output = JSON.parse(result.stdout);
    assert.equal(output.capsuleId, manifestId);
    assert.equal(output.sourceRunId, 1);
    assert.equal(output.comparisonRunId, 2);
    assert.equal(output.status, "fresh");
  });
});

test("inspect-file prints persisted data for a known file", async () => {
  await withFixture(async ({ repoRoot, dbPath }) => {
    await writeFixtureRepo(repoRoot);
    await runCli(["index", repoRoot], { dbPath });

    const result = await runCli(["inspect-file", "./src/service.ts"], { dbPath });

    assert.equal(result.exitCode, 0);
    assert.equal(result.stderr, "");

    const output = JSON.parse(result.stdout);
    assert.equal(output.file.path, "src/service.ts");
    assert.deepEqual(
      output.symbols.map((symbol: { localName: string; kind: string }) => [
        symbol.localName,
        symbol.kind,
      ]),
      [["readUser", SymbolKind.Function]],
    );
    // readUser imports User and also uses it as a return type, so the file now
    // carries both an imports edge and a references edge for the same pair.
    assert.equal(output.edges.length, 2);
    assert.deepEqual(
      output.edges.map((edge: { edgeType: string }) => edge.edgeType).sort(),
      [EdgeType.Imports, EdgeType.References],
    );
  });
});

test("inspect-symbol prints persisted data for a known symbol", async () => {
  await withFixture(async ({ repoRoot, dbPath }) => {
    await writeFixtureRepo(repoRoot);
    await runCli(["index", repoRoot], { dbPath });
    const db = openIndexerDatabase(dbPath);

    try {
      const symbol = listSymbolsForFile(db, "src/service.ts")[0];
      assert.notEqual(symbol, undefined);

      const result = await runCli(["inspect-symbol", symbol!.id], { dbPath });

      assert.equal(result.exitCode, 0);
      assert.equal(result.stderr, "");

      const output = JSON.parse(result.stdout);
      assert.equal(output.symbol.id, symbol!.id);
      assert.equal(output.symbol.localName, "readUser");
      assert.equal(output.edges.length, 2);
      assert.equal(
        output.edges.every((edge: { srcSymbolId: string }) => edge.srcSymbolId === symbol!.id),
        true,
      );
    } finally {
      db.close();
    }
  });
});

test("skeleton command returns structural output for an indexed file", async () => {
  await withFixture(async ({ repoRoot }) => {
    await writeFixtureRepo(repoRoot);
    await runCli(["index", repoRoot]);

    const result = await runCli(["skeleton", repoRoot, "src/service.ts", "--detail", "detailed"]);

    assert.equal(result.exitCode, 0);
    assert.equal(result.stderr, "");

    const output = JSON.parse(result.stdout);
    assert.equal(output.detail, "detailed");
    assert.equal(output.files.length, 1);
    assert.equal(output.files[0].status, "ok");
    assert.equal(output.files[0].filePath, "src/service.ts");
    assert.equal(output.files[0].declarations[0].name, "readUser");
    // JSON parity with the MCP get_skeleton tool: the same accounting block.
    assert.equal(output.accounting.method, "chars_div_4");
    assert.equal(output.accounting.uniqueFilesCounted, 1);
    assert.equal(typeof output.accounting.latencyMs, "number");
    assert.equal(output.accounting.latencyMs >= 0, true);
  });
});

test("impact-graph command returns the deterministic structural graph for an indexed symbol", async () => {
  await withFixture(async ({ repoRoot }) => {
    await writeFixtureRepo(repoRoot);
    await runCli(["index", repoRoot]);

    const result = await runCli([
      "impact-graph",
      repoRoot,
      "src/models.ts::User",
      "--depth",
      "2",
      "--format",
      "tree",
    ]);

    assert.equal(result.exitCode, 0);
    assert.equal(result.stderr, "");

    const output = JSON.parse(result.stdout);
    assert.equal(output.ok, true);
    assert.equal(output.output.resolvedSymbol.fqName, "src/models.ts::User");
    assert.equal(output.output.requested.format, "tree");
    assert.deepEqual(output.output.dependentFiles, ["src/service.ts"]);
    assert.equal(output.output.view.lines.some((line: string) => line.includes("src/service.ts::readUser")), true);
    // JSON parity with the MCP get_impact_graph tool: the same accounting block.
    assert.equal(output.output.accounting.method, "chars_div_4");
    assert.equal(output.output.accounting.uniqueFilesCounted >= 1, true);
    assert.equal(output.output.accounting.estimatedNaiveFullFileTokens > 0, true);
    assert.equal(output.output.responseBudget.withinEnvelope, true);
    // The CLI and MCP surfaces both remove repeated node source bodies; compact
    // relation evidence remains the authoritative provenance representation.
    const dependent = output.output.nodes.find(
      (node: { fqName: string }) => node.fqName === "src/service.ts::readUser",
    );
    assert.ok(dependent, "expected the readUser dependent node");
    assert.equal(dependent.sourceExcerpt, undefined);
  });
});

test.skip("capsule command now shows intent, routing profile, capsule profile, and source-backed capsule output", async () => {
  await withFixture(async ({ repoRoot }) => {
    await writeCapsuleFixtureRepo(repoRoot);

    const indexed = await runCli(["index", repoRoot]);
    const first = await runCli(["capsule", repoRoot, "Session"]);
    const second = await runCli(["capsule", repoRoot, "Session"]);

    assert.equal(indexed.exitCode, 0);
    assert.equal(first.exitCode, 0);
    assert.equal(first.stderr, "");
    assert.equal(second.stdout, first.stdout);

    const output = JSON.parse(first.stdout);
    assert.equal(output.query, "Session");
    assert.equal(output.intent, "explain");
    assert.equal(output.classification.intent, "explain");
    assert.equal(output.classification.explanation.reasonKind, "no_rule_match_fallback");
    assert.equal(output.routingProfile.id, "explain");
    assert.equal(output.capsuleProfile.id, "explain_stable");
    assert.equal(output.capsuleProfile.targetIntent, "explain");
    assert.equal(output.capsule.profileBudgetUsage.pivotCharactersMax > 0, true);
    assert.equal(output.capsule.profileBudgetUsage.supportCharactersMax > 0, true);
    assert.equal(output.capsule.budget.model, "character_count");
    assert.equal(Array.isArray(output.capsule.pivots), true);
    assert.equal(Array.isArray(output.capsule.supportingItems), true);
    assert.equal(output.capsule.pivots.length, 2);
    assert.equal(output.capsule.pivots.every((item: { role: string }) => item.role === "pivot"), true);
    assert.equal(output.capsule.pivots.some((item: { contentMode: string }) => item.contentMode === "full"), true);
    assert.equal(
      output.capsule.pivots.some((item: { content: { source?: string } }) => {
        return item.content.source?.includes("class SessionManager") ?? false;
      }),
      true,
    );
    assert.equal(
      output.capsule.supportingItems.every((item: { role: string; compressed: boolean }) => {
        return item.role === "support" && item.compressed;
      }),
      true,
    );
    assert.equal(
      output.capsule.supportingItems.every((item: { contentMode: string }) => item.contentMode !== "full"),
      true,
    );
    assert.equal(
      output.capsule.supportingItems.every(
        (item: { inclusionReasons: string[] | undefined }) => (item.inclusionReasons?.length ?? 0) > 0,
      ),
      true,
    );
  });
});

test.skip("capsule default output now includes machine-readable diagnostics", async () => {
  await withFixture(async ({ repoRoot }) => {
    await writeCapsuleFixtureRepo(repoRoot);
    await runCli(["index", repoRoot]);

    const result = await runCli(["capsule", repoRoot, "Session"]);
    assert.equal(result.exitCode, 0);
    const output = JSON.parse(result.stdout);
    assert.ok(output.diagnostics);
    assert.equal(output.diagnostics.mode, "standard");
    assert.ok(["skip", "micro", "standard", "full"].includes(output.diagnostics.recommended_mode));
    assert.ok(["low", "medium", "high"].includes(output.diagnostics.target_confidence));
    assert.equal(Array.isArray(output.diagnostics.likely_files), true);
    assert.equal(Array.isArray(output.diagnostics.likely_symbols), true);
  });
});

test.skip("capsule --json emits compact diagnostics + context without inspection prose", async () => {
  await withFixture(async ({ repoRoot }) => {
    await writeCapsuleFixtureRepo(repoRoot);
    await runCli(["index", repoRoot]);

    const result = await runCli(["capsule", repoRoot, "Session", "--json"]);
    assert.equal(result.exitCode, 0);
    const output = JSON.parse(result.stdout);
    assert.deepEqual(Object.keys(output).sort(), ["context", "diagnostics"]);
    assert.equal(typeof output.context, "string");
    assert.equal(output.diagnostics.context_chars, output.context.length);
    // The compact context must not re-dump the raw query/problem statement block.
    assert.equal(output.context.includes("routingProfile"), false);
  });
});

test.skip("capsule --mode micro keeps the context within the micro char budget", async () => {
  await withFixture(async ({ repoRoot }) => {
    await writeCapsuleFixtureRepo(repoRoot);
    await runCli(["index", repoRoot]);

    const micro = await runCli(["capsule", repoRoot, "Session", "--mode", "micro", "--json"]);
    assert.equal(micro.exitCode, 0);
    const microOut = JSON.parse(micro.stdout);
    assert.equal(microOut.diagnostics.mode, "micro");
    // micro budget is 1500 chars; context may carry a truncation marker.
    assert.ok(microOut.diagnostics.context_chars <= 1_500 + 40);
    assert.ok(microOut.diagnostics.context_items <= 2);
  });
});

test.skip("capsule --mode micro recovers an aggregate implementation target (django-10880)", async () => {
  await withFixture(async ({ repoRoot }) => {
    await writeMicroTargetFixtureRepo(repoRoot);
    await runCli(["index", repoRoot]);

    // Mirrors django__django-10880: a subquery test name + a bare "SQL" mention.
    // Neither should force a full capsule, and micro must point at the aggregate
    // implementation rather than the test or nothing.
    const query = [
      "failing tests: test_aggregation_subquery_annotation_multiline (aggregation.tests.AggregateTestCase)",
      "issue: Count annotation containing a Case condition and distinct=True produces wrong SQL",
    ].join("\n");
    const result = await runCli(["capsule", repoRoot, query, "--mode", "micro", "--json"]);
    assert.equal(result.exitCode, 0);

    const out = JSON.parse(result.stdout);
    // A bare "SQL" / "subquery" must not escalate to full.
    assert.notEqual(out.diagnostics.recommended_mode, "full");
    // The implementation target is recovered, not the test.
    assert.ok(
      out.diagnostics.likely_files.some((file: string) => file.includes("aggregates.py")),
      `expected an aggregate implementation file, got ${JSON.stringify(out.diagnostics.likely_files)}`,
    );
    assert.ok(out.diagnostics.likely_files.length > 0);
    assert.ok(out.diagnostics.likely_files.every((file: string) => !/test/i.test(file)));
    assert.ok(out.diagnostics.context_items > 0);
    // Stays within the micro budget.
    assert.equal(out.diagnostics.mode, "micro");
    assert.ok(out.diagnostics.context_chars <= 1_500 + 40);
    assert.ok(out.diagnostics.context_items <= 2);
  });
});

test.skip("capsule --mode micro ranks the aggregate target above the central Model hub (django-10880)", async () => {
  await withFixture(async ({ repoRoot }) => {
    await writeMicroTargetFixtureRepo(repoRoot);
    await runCli(["index", repoRoot]);

    const query = [
      "failing tests: test_aggregation_subquery_annotation_multiline (aggregation.tests.AggregateTestCase)",
      "issue: Count annotation containing a Case condition and distinct=True produces wrong SQL",
    ].join("\n");
    // Allow room for the hub to appear as trailing support so the penalty is
    // visible in diagnostics — it must still rank below the aggregate target.
    const result = await runCli(["capsule", repoRoot, query, "--mode", "micro", "--max-items", "3", "--json"]);
    assert.equal(result.exitCode, 0);

    const out = JSON.parse(result.stdout);

    const aggIndex = out.diagnostics.likely_files.findIndex((file: string) => file.includes("aggregates.py"));
    const baseIndex = out.diagnostics.likely_files.findIndex((file: string) => file.includes("base.py"));
    assert.ok(aggIndex !== -1, `expected aggregates.py, got ${JSON.stringify(out.diagnostics.likely_files)}`);
    // aggregates ranks before base.py::Model (or the hub is excluded entirely).
    assert.ok(baseIndex === -1 || aggIndex < baseIndex,
      `aggregates (#${aggIndex}) must rank before base (#${baseIndex})`);

    // When the hub is surfaced, the diagnostics explain the downrank.
    const selection: Array<Record<string, any>> = out.diagnostics.selection ?? [];
    const modelSel = selection.find((item) => item.path.includes("base.py"));
    if (modelSel) {
      assert.ok(modelSel.scores.hub_penalty > 0, "Model selection must carry a hub penalty");
      assert.ok(modelSel.scores.in_degree_or_dependent_count >= 5);
      assert.equal(modelSel.scores.local_evidence_score, 0);
      assert.ok(modelSel.evidence.some((line: string) => /downranked: generic hub/.test(line)));
    }
    const aggSel = selection.find((item) => item.path.includes("aggregates.py"));
    assert.ok(aggSel, "aggregate target must be in the selection diagnostics");
    assert.equal(aggSel?.scores.hub_penalty, 0, "the real target must not be penalized");
  });
});

test.skip("capsule --mode micro ranks aggregates.py above the sql/subqueries module variable (django-10880)", async () => {
  await withFixture(async ({ repoRoot }) => {
    await writeMicroTargetFixtureRepo(repoRoot);
    await runCli(["index", repoRoot]);

    const query = [
      "failing tests: test_aggregation_subquery_annotation_multiline (aggregation.tests.AggregateTestCase)",
      "issue: Count annotation containing a Case condition and distinct=True produces wrong SQL",
    ].join("\n");
    // Room for the module variable to surface so the ordering is observable.
    const result = await runCli(["capsule", repoRoot, query, "--mode", "micro", "--max-items", "5", "--json"]);
    assert.equal(result.exitCode, 0);
    const out = JSON.parse(result.stdout);

    // aggregates.py is the first likely edit-target file; the sql/subqueries
    // module variable is never ranked ahead of it.
    const aggIndex = out.diagnostics.likely_files.findIndex((file: string) => file.includes("aggregates.py"));
    const subIndex = out.diagnostics.likely_files.findIndex((file: string) => file.includes("subqueries.py"));
    assert.ok(aggIndex !== -1, `expected aggregates.py, got ${JSON.stringify(out.diagnostics.likely_files)}`);
    assert.ok(subIndex === -1 || aggIndex < subIndex,
      `aggregates (#${aggIndex}) must rank before subqueries (#${subIndex})`);

    // Selection is sorted by final score (Requirement 1).
    const selection: Array<Record<string, any>> = out.diagnostics.selection ?? [];
    assert.ok(selection.length > 0);
    for (let index = 1; index < selection.length; index += 1) {
      assert.ok(selection[index - 1]!.scores.final >= selection[index]!.scores.final,
        "selection must be sorted by final score");
    }
    // Diagnostics expose the new fields.
    const top = selection[0]!;
    for (const key of ["final", "local_evidence_score", "hub_penalty", "actionability", "actionability_penalty", "domain"]) {
      assert.ok(key in top.scores, `selection scores must include ${key}`);
    }
    assert.equal(top.scores.actionability, 1, "the top micro target must be actionable");

    // If the module variable surfaced as trailing support, it is flagged low
    // actionability and penalized.
    const compilerSel = selection.find((item) => item.path.includes("subqueries.py"));
    if (compilerSel) {
      assert.equal(compilerSel.scores.actionability, 0);
      assert.ok(compilerSel.scores.actionability_penalty > 0);
    }
  });
});

test.skip("capsule --mode standard is not damaged by the micro hub penalty", async () => {
  await withFixture(async ({ repoRoot }) => {
    await writeMicroTargetFixtureRepo(repoRoot);
    await runCli(["index", repoRoot]);

    // Standard mode does not go through micro hub-penalised recovery (it uses
    // routeQuery directly); it must still assemble a non-empty capsule and may
    // freely include the central Model hub as support context.
    const result = await runCli(["capsule", repoRoot, "Aggregate Count as_sql", "--mode", "standard", "--json"]);
    assert.equal(result.exitCode, 0);
    const out = JSON.parse(result.stdout);
    assert.equal(out.diagnostics.mode, "standard");
    assert.ok(out.diagnostics.context_items > 0, "standard mode must still emit context");
    assert.ok(
      out.diagnostics.likely_files.some((file: string) => file.includes("aggregates.py")),
      `standard should still surface the aggregate target, got ${JSON.stringify(out.diagnostics.likely_files)}`,
    );
  });
});

test.skip("capsule --mode micro recovers ModelAdmin options target (django-11095)", async () => {
  await withFixture(async ({ repoRoot }) => {
    await writeMicroTargetFixtureRepo(repoRoot);
    await runCli(["index", repoRoot]);

    // Mirrors django__django-11095: surface the admin options implementation
    // (ModelAdmin / get_inline_instances), not the failing test.
    const query = [
      "failing tests: test_get_inline_instances_override_get_inlines (admin_inlines.tests.GenericInlineModelAdminTest)",
      "issue: add ModelAdmin.get_inlines() hook to set inlines based on the request or model instance",
    ].join("\n");
    const result = await runCli(["capsule", repoRoot, query, "--mode", "micro", "--json"]);
    assert.equal(result.exitCode, 0);

    const out = JSON.parse(result.stdout);
    assert.notEqual(out.diagnostics.recommended_mode, "full");
    assert.ok(
      out.diagnostics.likely_files.some((file: string) => file.includes("options.py"))
        || out.diagnostics.likely_symbols.some((symbol: string) =>
          /ModelAdmin|get_inline/.test(symbol)),
      `expected options.py / ModelAdmin target, got ${JSON.stringify(out.diagnostics)}`,
    );
    assert.ok(out.diagnostics.likely_files.length > 0);
    assert.ok(out.diagnostics.likely_files.every((file: string) => !/test/i.test(file)));
    assert.ok(out.diagnostics.context_items > 0);
    assert.equal(out.diagnostics.mode, "micro");
    assert.ok(out.diagnostics.context_chars <= 1_500 + 40);
    assert.ok(out.diagnostics.context_items <= 2);
  });
});

test.skip("capsule --mode micro recommends skip rather than emitting an empty capsule", async () => {
  await withFixture(async ({ repoRoot }) => {
    await writeMicroTargetFixtureRepo(repoRoot);
    await runCli(["index", repoRoot]);

    // A failing test + issue that name nothing in the index: micro must NOT
    // recover a target. It must then recommend skip — never emit a tiny,
    // misdirecting capsule with context_items: 0 / likely_files: [].
    const query = [
      "failing tests: test_frobnicate_widget (frobnicator.tests.WidgetGlyphTestCase)",
      "issue: adjust the frobnicator widget glyph spacing in the theme",
    ].join("\n");
    const result = await runCli(["capsule", repoRoot, query, "--mode", "micro", "--json"]);
    assert.equal(result.exitCode, 0);

    const out = JSON.parse(result.stdout);
    assert.equal(out.diagnostics.recommended_mode, "skip");
    assert.equal(out.diagnostics.context_items, 0);
    assert.deepEqual(out.diagnostics.likely_files, []);
    // No oriented context is injected — context_items is 0 and the action header
    // has no target — but the body carries a decisive "do not inject" directive
    // rather than being silently empty (Requirement 1). The benchmark keys the
    // skip off `actual_mode`, not emptiness, so this is still a valid no-context
    // policy.
    assert.equal(out.diagnostics.actual_mode, "skip");
    assert.equal(out.diagnostics.action_header.has_target, false);
    assert.match(out.context, /Do not inject context for this task\./);
  });
});

test("capsule rejects an unknown mode and bad numeric flags", async () => {
  await withFixture(async ({ repoRoot }) => {
    await writeCapsuleFixtureRepo(repoRoot);
    await runCli(["index", repoRoot]);

    const badMode = await runCli(["capsule", repoRoot, "Session", "--mode", "huge"]);
    assert.equal(badMode.exitCode, 1);
    assert.match(badMode.stderr, /micro\|standard\|full/);

    const badItems = await runCli(["capsule", repoRoot, "Session", "--max-items", "-3"]);
    assert.equal(badItems.exitCode, 1);
    assert.match(badItems.stderr, /non-negative integer/);
  });
});

test("handoff command prints deterministic payload output", async () => {
  await withFixture(async ({ repoRoot }) => {
    await writeCapsuleFixtureRepo(repoRoot);

    const indexed = await runCli(["index", repoRoot]);
    const first = await runCli(["handoff", repoRoot, "Session"]);
    const second = await runCli(["handoff", repoRoot, "Session"]);

    assert.equal(indexed.exitCode, 0);
    assert.equal(first.exitCode, 0);
    assert.equal(first.stderr, "");
    assert.equal(second.stdout, first.stdout);

    const output = JSON.parse(first.stdout);
    assert.deepEqual(output.schema, {
      name: "vtrace.external_handoff",
      version: "1.0.0",
    });
    assert.equal(output.query, "Session");
    assert.equal(output.selectedIntent, "explain");
    assert.equal(output.classification.intent, "explain");
    assert.equal(output.classification.explanation.reasonKind, "no_rule_match_fallback");
    assert.equal(output.routingProfile.id, "explain");
    assert.equal(output.capsuleProfile.id, "explain_stable");
    assert.equal(output.capsule.budget.model, "character_count");
    assert.equal(Array.isArray(output.capsule.items), true);
    assert.equal(output.capsule.items.length > 0, true);
    assert.equal(output.capsule.items[0].role, "pivot");
    assert.equal(
      output.capsule.items.some((item: { content: { source?: string } }) => {
        return item.content.source?.includes("class SessionManager") ?? false;
      }),
      true,
    );
    assert.deepEqual(output.provenance, {
      repoRoot,
      repoId: null,
      sourceRunId: 1,
      manifestId: null,
      payloadSchemaVersion: "1.0.0",
      generation: {
        sourceKind: "intent_aware_capsule_pipeline",
        builderKind: "deterministic_packager",
        generatedAtMs: null,
      },
    });
    assert.deepEqual(output.trust, {
      capsuleStaleness: null,
    });
  });
});

test.skip("different intents can lead to visibly different capsule shapes on the same seeded repo", async () => {
  await withFixture(async ({ repoRoot }) => {
    await writeProfileAwareCapsuleFixtureRepo(repoRoot);

    const indexed = await runCli(["index", repoRoot]);
    const debugResult = await runCli(["capsule", repoRoot, "fix session bug"]);
    const refactorResult = await runCli(["capsule", repoRoot, "refactor session"]);

    assert.equal(indexed.exitCode, 0);
    assert.equal(debugResult.exitCode, 0);
    assert.equal(refactorResult.exitCode, 0);

    const debugOutput = JSON.parse(debugResult.stdout);
    const refactorOutput = JSON.parse(refactorResult.stdout);

    assert.equal(debugOutput.intent, "debug");
    assert.equal(debugOutput.routingProfile.id, "debug");
    assert.equal(debugOutput.capsuleProfile.id, "debug_tight");
    assert.equal(refactorOutput.intent, "refactor");
    assert.equal(refactorOutput.routingProfile.id, "refactor");
    assert.equal(refactorOutput.capsuleProfile.id, "refactor_structural");
    assert.equal(
      debugOutput.capsule.pivots.length + debugOutput.capsule.supportingItems.length
        < refactorOutput.capsule.pivots.length + refactorOutput.capsule.supportingItems.length,
      true,
    );
  });
});

test.skip("existing cli commands remain unchanged after adding handoff", async () => {
  await withFixture(async ({ repoRoot }) => {
    await writeCapsuleFixtureRepo(repoRoot);
    await runCli(["index", repoRoot]);

    const capsule = await runCli(["capsule", repoRoot, "Session"]);
    const intent = await runCli(["intent", repoRoot, "Session"]);

    assert.equal(capsule.exitCode, 0);
    assert.equal(intent.exitCode, 0);

    const capsuleOutput = JSON.parse(capsule.stdout);
    const intentOutput = JSON.parse(intent.stdout);

    assert.equal("schema" in capsuleOutput, false);
    assert.equal(capsuleOutput.intent, "explain");
    assert.equal(capsuleOutput.capsuleProfile.id, "explain_stable");
    assert.equal("schema" in intentOutput, false);
    assert.equal(intentOutput.intent, "explain");
    assert.equal(intentOutput.profile.id, "explain");
  });
});

test("runs command lists persisted runs deterministically", async () => {
  await withFixture(async ({ repoRoot }) => {
    await writeFixtureRepo(repoRoot);

    const firstIndex = await runCli(["index", repoRoot]);
    const secondIndex = await runCli(["index", repoRoot]);
    const first = await runCli(["runs", repoRoot]);
    const second = await runCli(["runs", repoRoot]);

    assert.equal(firstIndex.exitCode, 0);
    assert.equal(secondIndex.exitCode, 0);
    assert.equal(first.exitCode, 0);
    assert.equal(first.stderr, "");
    assert.equal(second.stdout, first.stdout);

    const output = JSON.parse(first.stdout);
    assert.deepEqual(output, {
      runs: [
        {
          id: 1,
          createdAtMs: output.runs[0].createdAtMs,
          totalFiles: 3,
          totalSymbols: 4,
          fileChangeCounts: {
            added: 0,
            removed: 0,
            modified: 0,
            unchanged: 0,
          },
          symbolChangeCounts: {
            added: 0,
            removed: 0,
            modified: 0,
            unchanged: 0,
          },
        },
        {
          id: 2,
          previousRunId: 1,
          createdAtMs: output.runs[1].createdAtMs,
          totalFiles: 3,
          totalSymbols: 4,
          fileChangeCounts: {
            added: 0,
            removed: 0,
            modified: 0,
            unchanged: 3,
          },
          symbolChangeCounts: {
            added: 0,
            removed: 0,
            modified: 0,
            unchanged: 4,
          },
        },
      ],
    });
    assert.equal(typeof output.runs[0].createdAtMs, "number");
    assert.equal(typeof output.runs[1].createdAtMs, "number");
  });
});

test("intent command prints deterministic intent-routing inspection output", async () => {
  await withFixture(async ({ repoRoot }) => {
    await writeIntentFixtureRepo(repoRoot);

    const indexed = await runCli(["index", repoRoot]);
    const first = await runCli(["intent", repoRoot, "fix session bug"]);
    const second = await runCli(["intent", repoRoot, "fix session bug"]);

    assert.equal(indexed.exitCode, 0);
    assert.equal(first.exitCode, 0);
    assert.equal(first.stderr, "");
    assert.equal(second.stdout, first.stdout);

    const output = JSON.parse(first.stdout);
    assert.equal(output.query, "fix session bug");
    assert.equal(output.intent, "debug");
    assert.equal(output.classification.intent, "debug");
    assert.equal(output.classification.explanation.reasonKind, "rule_match");
    assert.equal(output.profile.id, "debug");
    assert.equal(output.profile.backend, "fts");
    assert.equal(output.profile.candidatePoolSize, 16);
    assert.equal(Array.isArray(output.rerankedResults), true);
    assert.equal(output.rerankedResults.length > 0, true);
    assert.equal(typeof output.rerankedResults[0].lexicalScore, "number");
    assert.equal(typeof output.rerankedResults[0].finalScore, "number");
  });
});

test("intent command surfaces fallback-to-explain classification clearly", async () => {
  await withFixture(async ({ repoRoot }) => {
    await writeIntentFixtureRepo(repoRoot);
    await runCli(["index", repoRoot]);

    const result = await runCli(["intent", repoRoot, "session manager"]);

    assert.equal(result.exitCode, 0);
    assert.equal(result.stderr, "");

    const output = JSON.parse(result.stdout);
    assert.equal(output.intent, "explain");
    assert.equal(output.classification.intent, "explain");
    assert.equal(output.classification.explanation.reasonKind, "no_rule_match_fallback");
    assert.equal(output.classification.explanation.fallbackApplied, true);
    assert.equal(output.profile.id, "explain");
    assert.equal(output.rerankedResults.length > 0, true);
  });
});

test("runs command fails cleanly when the repo has not been indexed", async () => {
  await withFixture(async ({ repoRoot }) => {
    await writeFixtureRepo(repoRoot);

    const result = await runCli(["runs", repoRoot]);

    assert.deepEqual(result, {
      exitCode: 1,
      stdout: "",
      stderr: `Repo not indexed: ${repoRoot}\n`,
    });
  });
});

test("intent command fails cleanly when the repo has not been indexed", async () => {
  await withFixture(async ({ repoRoot }) => {
    await writeIntentFixtureRepo(repoRoot);

    const result = await runCli(["intent", repoRoot, "fix session bug"]);

    assert.deepEqual(result, {
      exitCode: 1,
      stdout: "",
      stderr: `Repo not indexed: ${repoRoot}\n`,
    });
  });
});

test("check-capsule returns fresh for unchanged later runs when appropriate", async () => {
  await withFixture(async ({ repoRoot }) => {
    await writeFixtureRepo(repoRoot);
    await runCli(["index", repoRoot]);
    const { manifestId } = persistSourceBackedFixtureManifest(repoRoot);
    await runCli(["index", repoRoot]);

    const first = await runCli(["check-capsule", repoRoot, manifestId, "2"]);
    const second = await runCli(["check-capsule", repoRoot, manifestId, "2"]);

    assert.equal(first.exitCode, 0);
    assert.equal(first.stderr, "");
    assert.equal(second.stdout, first.stdout);

    const output = JSON.parse(first.stdout);
    assert.equal(output.capsuleId, manifestId);
    assert.equal(output.sourceRunId, 1);
    assert.equal(output.comparisonRunId, 2);
    assert.equal(output.status, "fresh");
    assert.deepEqual(
      output.items.map((item: { itemOrdinal: number; status: string; sourceBacked: boolean }) => [
        item.itemOrdinal,
        item.status,
        item.sourceBacked,
      ]),
      [
        [0, "fresh", true],
        [1, "fresh", false],
      ],
    );
  });
});

test("check-capsule returns stale with explicit reasons when appropriate", async () => {
  await withFixture(async ({ repoRoot }) => {
    await writeFixtureRepo(repoRoot);
    await runCli(["index", repoRoot]);
    const { manifestId } = persistSourceBackedFixtureManifest(repoRoot);
    await writeFile(
      path.join(repoRoot, "src", "service.ts"),
      `
import { User } from "./models";
export function readUser(): User { throw new Error("not implemented"); }
export function writeUser(): User { throw new Error("not implemented"); }
`,
    );
    await runCli(["index", repoRoot]);

    const result = await runCli(["check-capsule", repoRoot, manifestId, "2"]);

    assert.equal(result.exitCode, 0);
    assert.equal(result.stderr, "");

    const output = JSON.parse(result.stdout);
    assert.equal(output.status, "stale");
    assert.deepEqual(
      output.items.map((item: { itemOrdinal: number; status: string; reasons: Array<{ kind: string }> }) => ({
        itemOrdinal: item.itemOrdinal,
        status: item.status,
        reasons: item.reasons.map((reason) => reason.kind),
      })),
      [
        {
          itemOrdinal: 0,
          status: "stale",
          reasons: ["file_modified_source_backed"],
        },
        {
          itemOrdinal: 1,
          status: "fresh",
          reasons: [],
        },
      ],
    );
  });
});

test("check-capsule fails cleanly for unknown manifest ids", async () => {
  await withFixture(async ({ repoRoot }) => {
    await writeFixtureRepo(repoRoot);
    await runCli(["index", repoRoot]);

    const result = await runCli(["check-capsule", repoRoot, "missing-manifest", "1"]);

    assert.deepEqual(result, {
      exitCode: 1,
      stdout: "",
      stderr: "Capsule manifest not found: missing-manifest\n",
    });
  });
});

test("check-capsule fails cleanly for unknown comparison run ids", async () => {
  await withFixture(async ({ repoRoot }) => {
    await writeFixtureRepo(repoRoot);
    await runCli(["index", repoRoot]);
    const { manifestId } = persistSourceBackedFixtureManifest(repoRoot);

    const result = await runCli(["check-capsule", repoRoot, manifestId, "999"]);

    assert.deepEqual(result, {
      exitCode: 1,
      stdout: "",
      stderr: "Index run not found: 999\n",
    });
  });
});

test("invalid commands fail cleanly", async () => {
  const result = await runCli(["wat"]);

  assert.equal(result.exitCode, 1);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /^Usage:/m);
  assert.match(result.stderr, /vtrace setup \[repo\] \[--start-runtime\]/);
  assert.match(result.stderr, /vtrace mcp-serve --repo <repo>/);
  assert.match(result.stderr, /docs\/getting_started\.md/);
});

test("--help succeeds and the symlinked launcher resolves the real package root", async () => {
  await withFixture(async ({ repoRoot }) => {
    await writeFixtureRepo(repoRoot);
    const fakePrefixBin = path.join(path.dirname(repoRoot), "global-bin");
    const symlinkPath = path.join(fakePrefixBin, "vtrace");
    const realLauncherPath = path.resolve(process.cwd(), "bin", "vtrace");

    await mkdir(fakePrefixBin, { recursive: true });
    await symlink(realLauncherPath, symlinkPath);

    const helpResult = await runExternalCommand(symlinkPath, ["--help"]);
    const setupResult = await runExternalCommand(symlinkPath, ["setup", "--agent", "codex", repoRoot]);

    assert.equal(helpResult.exitCode, 0);
    assert.equal(helpResult.stderr, "");
    assert.match(helpResult.stdout, /^Usage:/m);
    assert.match(helpResult.stdout, /vtrace setup \[repo\] \[--start-runtime\]/);

    assert.equal(setupResult.exitCode, 0);
    assert.equal(setupResult.stderr, "");
    assert.match(setupResult.stdout, /^Setup complete|^Setup checked this repo/m);
    assert.match(setupResult.stdout, /Codex config/m);
    assert.match(setupResult.stdout, /Config file: \.codex\/config\.toml/);
  });
});

test("init command fails cleanly when the repo path is missing", async () => {
  await withFixture(async ({ repoRoot }) => {
    const missingRepoRoot = path.join(path.dirname(repoRoot), "missing-repo");
    const result = await runCli(["init", missingRepoRoot]);

    assert.deepEqual(result, {
      exitCode: 1,
      stdout: "",
      stderr: `init failed: Repo not found: ${missingRepoRoot}\n`,
    });
  });
});

test("intent command fails cleanly when the repo path is missing", async () => {
  await withFixture(async ({ repoRoot }) => {
    const missingRepoRoot = path.join(path.dirname(repoRoot), "missing-repo");
    const result = await runCli(["intent", missingRepoRoot, "fix session bug"]);

    assert.deepEqual(result, {
      exitCode: 1,
      stdout: "",
      stderr: `Repo not found: ${missingRepoRoot}\n`,
    });
  });
});

test("capsule command fails cleanly when the repo has not been indexed", async () => {
  await withFixture(async ({ repoRoot }) => {
    await writeCapsuleFixtureRepo(repoRoot);

    const result = await runCli(["capsule", repoRoot, "Session"]);

    assert.deepEqual(result, {
      exitCode: 1,
      stdout: "",
      stderr: `Repo not indexed: ${repoRoot}\n`,
    });
  });
});

test("handoff command fails cleanly when the repo has not been indexed", async () => {
  await withFixture(async ({ repoRoot }) => {
    await writeCapsuleFixtureRepo(repoRoot);

    const result = await runCli(["handoff", repoRoot, "Session"]);

    assert.deepEqual(result, {
      exitCode: 1,
      stdout: "",
      stderr: `Repo not indexed: ${repoRoot}\n`,
    });
  });
});

test("capsule command fails cleanly when the repo path is missing", async () => {
  await withFixture(async ({ repoRoot }) => {
    const missingRepoRoot = path.join(path.dirname(repoRoot), "missing-repo");
    const result = await runCli(["capsule", missingRepoRoot, "Session"]);

    assert.deepEqual(result, {
      exitCode: 1,
      stdout: "",
      stderr: `Repo not found: ${missingRepoRoot}\n`,
    });
  });
});

test("handoff command fails cleanly when the repo path is missing", async () => {
  await withFixture(async ({ repoRoot }) => {
    const missingRepoRoot = path.join(path.dirname(repoRoot), "missing-repo");
    const result = await runCli(["handoff", missingRepoRoot, "Session"]);

    assert.deepEqual(result, {
      exitCode: 1,
      stdout: "",
      stderr: `Repo not found: ${missingRepoRoot}\n`,
    });
  });
});

test("missing file lookups fail cleanly with deterministic messages", async () => {
  await withFixture(async ({ repoRoot, dbPath }) => {
    await writeFixtureRepo(repoRoot);
    await runCli(["index", repoRoot], { dbPath });

    const result = await runCli(["inspect-file", "src/missing.ts"], { dbPath });

    assert.deepEqual(result, {
      exitCode: 1,
      stdout: "",
      stderr: "File not found: src/missing.ts\n",
    });
  });
});

test("missing symbol lookups fail cleanly with deterministic messages", async () => {
  await withFixture(async ({ repoRoot, dbPath }) => {
    await writeFixtureRepo(repoRoot);
    await runCli(["index", repoRoot], { dbPath });

    const result = await runCli(["inspect-symbol", "missing-symbol"], { dbPath });

    assert.deepEqual(result, {
      exitCode: 1,
      stdout: "",
      stderr: "Symbol not found: missing-symbol\n",
    });
  });
});

function seedRepeatedPassiveSession(
  db: ReturnType<typeof openIndexerDatabase>,
  repoRoot: string,
  sessionId: string,
): void {
  const sourceRunId = listIndexRuns(db).at(-1)?.id;

  for (const [index, createdAtMs] of [100, 120, 140].entries()) {
    persistObservation(db, {
      repoRoot,
      sessionId,
      kind: ObservationKind.ToolCall,
      source: ObservationSource.McpAuto,
      toolName: "run_pipeline",
      summary: `Repeated capsule ${index}`,
      body: `tool=run_pipeline\nquery=cli compression\npivot_count=1\nsupport_count=2\ncall=${index}`,
      queryText: "cli compression",
      intent: "explain",
      sourceRunId,
      createdAtMs,
      linkedFilePaths: ["src/service.ts"],
    });
  }
  persistObservation(db, {
    repoRoot,
    sessionId,
    kind: ObservationKind.Decision,
    source: ObservationSource.Manual,
    toolName: "save_observation",
    summary: "Durable decision kept",
    body: "Manual decision retained across CLI compression.",
    queryText: "durable decision",
    createdAtMs: 160,
    linkedFilePaths: ["src/service.ts"],
  });
}

test("compress-sessions consolidates repeated passive observations, preserves durable ones, and is idempotent", async () => {
  await withFixture(async ({ repoRoot, dbPath }) => {
    await writeFixtureRepo(repoRoot);
    const indexed = await runCli(["index", repoRoot], { dbPath });
    assert.equal(indexed.exitCode, 0);

    const db = openIndexerDatabase(dbPath);
    try {
      seedRepeatedPassiveSession(db, repoRoot, "session-cli");
    } finally {
      db.close();
    }

    // --idle-hours 0 makes every active session eligible without depending on
    // wall-clock timing, so the assertion is deterministic.
    const result = await runCli(
      ["compress-sessions", repoRoot, "--idle-hours", "0", "--json"],
      { dbPath },
    );
    assert.equal(result.exitCode, 0);
    assert.equal(result.stderr, "");

    const report = JSON.parse(result.stdout);
    assert.equal(report.dryRun, false);
    assert.equal(report.eligibleSessionCount, 1);
    assert.equal(report.processedSessionCount, 1);
    assert.equal(report.compressedSessionCount, 1);
    assert.equal(report.prunedToolCallObservationCount, 3);
    assert.deepEqual(report.compressedSessionIds, ["session-cli"]);

    const after = openIndexerDatabase(dbPath);
    try {
      const observations = listObservationsForSession(after, "session-cli");
      // The three repeated passive tool calls are gone.
      assert.equal(
        observations.filter((observation) => observation.summary.startsWith("Repeated capsule")).length,
        0,
      );
      // A consolidated insight replaced them.
      assert.equal(
        observations.some((observation) => observation.toolName === "consolidate_passive_observations"),
        true,
      );
      // The durable manual decision survived.
      assert.equal(
        observations.some((observation) => observation.summary === "Durable decision kept"),
        true,
      );
    } finally {
      after.close();
    }

    // Idempotent: the now-compressed session is no longer eligible.
    const again = await runCli(
      ["compress-sessions", repoRoot, "--idle-hours", "0", "--json"],
      { dbPath },
    );
    const againReport = JSON.parse(again.stdout);
    assert.equal(againReport.eligibleSessionCount, 0);
    assert.equal(againReport.compressedSessionCount, 0);
  });
});

test("compress-sessions --dry-run previews the effect without mutating", async () => {
  await withFixture(async ({ repoRoot, dbPath }) => {
    await writeFixtureRepo(repoRoot);
    assert.equal((await runCli(["index", repoRoot], { dbPath })).exitCode, 0);

    const db = openIndexerDatabase(dbPath);
    try {
      seedRepeatedPassiveSession(db, repoRoot, "session-cli");
    } finally {
      db.close();
    }

    const dry = await runCli(
      ["compress-sessions", repoRoot, "--idle-hours", "0", "--dry-run", "--json"],
      { dbPath },
    );
    assert.equal(dry.exitCode, 0);

    const report = JSON.parse(dry.stdout);
    assert.equal(report.dryRun, true);
    assert.equal(report.eligibleSessionCount, 1);
    assert.equal(report.processedSessionCount, 1);
    assert.equal(report.compressedSessionCount, 0);
    assert.equal(report.previews.length, 1);
    assert.equal(report.previews[0].sessionId, "session-cli");
    assert.equal(report.previews[0].prunedToolCallObservationCount, 3);

    // Nothing was mutated by the dry run.
    const after = openIndexerDatabase(dbPath);
    try {
      assert.equal(listObservationsForSession(after, "session-cli").length, 4);
    } finally {
      after.close();
    }
  });
});

test("compress-sessions skips recent active sessions under the default idle threshold", async () => {
  await withFixture(async ({ repoRoot, dbPath }) => {
    await writeFixtureRepo(repoRoot);
    assert.equal((await runCli(["index", repoRoot], { dbPath })).exitCode, 0);

    const db = openIndexerDatabase(dbPath);
    try {
      persistObservation(db, {
        repoRoot,
        sessionId: "session-recent",
        kind: ObservationKind.ToolCall,
        source: ObservationSource.McpAuto,
        toolName: "run_pipeline",
        summary: "Recent capsule call",
        body: "tool=run_pipeline\nquery=recent\npivot_count=1\nsupport_count=1\ncall=0",
        queryText: "recent",
        intent: "explain",
        sourceRunId: listIndexRuns(db).at(-1)?.id,
        createdAtMs: Date.now(),
        linkedFilePaths: ["src/service.ts"],
      });
    } finally {
      db.close();
    }

    const result = await runCli(["compress-sessions", repoRoot, "--json"], { dbPath });
    assert.equal(result.exitCode, 0);

    const report = JSON.parse(result.stdout);
    assert.equal(report.eligibleSessionCount, 0);
    assert.equal(report.compressedSessionCount, 0);
  });
});

interface FixtureContext {
  repoRoot: string;
  dbPath: string;
}

async function withFixture(run: (context: FixtureContext) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "vtrace-cli-"));
  const repoRoot = path.join(root, "repo");
  const dbPath = path.join(root, "index.sqlite");
  const previousClaudeConfigPath = process.env.VTRACE_CLAUDE_CODE_CONFIG_PATH;

  try {
    process.env.VTRACE_CLAUDE_CODE_CONFIG_PATH = path.join(root, "claude.json");
    await mkdir(repoRoot, { recursive: true });
    await mkdir(path.join(repoRoot, ".git"), { recursive: true });
    await run({ repoRoot, dbPath });
  } finally {
    if (previousClaudeConfigPath === undefined) {
      delete process.env.VTRACE_CLAUDE_CODE_CONFIG_PATH;
    } else {
      process.env.VTRACE_CLAUDE_CODE_CONFIG_PATH = previousClaudeConfigPath;
    }
    await rm(root, { recursive: true, force: true });
  }
}

async function runExternalCommand(
  command: string,
  args: readonly string[],
): Promise<{
  exitCode: number;
  stdout: string;
  stderr: string;
}> {
  return await new Promise((resolve) => {
    execFileCallback(command, [...args], { cwd: process.cwd() }, (error, stdout, stderr) => {
      if (error === null) {
        resolve({
          exitCode: 0,
          stdout,
          stderr,
        });
        return;
      }

      resolve({
        exitCode: typeof error.code === "number" ? error.code : 1,
        stdout,
        stderr,
      });
    });
  });
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
  const { stdout, stderr } = await new Promise<{
    stdout: string;
    stderr: string;
  }>((resolve, reject) => {
    execFileCallback("git", [...args], { cwd: repoRoot }, (error, stdout, stderr) => {
      if (error !== null) {
        reject(new Error(stderr || error.message));
        return;
      }

      resolve({ stdout, stderr });
    });
  });

  if (stderr.length > 0 && args[0] === "rev-parse") {
    throw new Error(stderr);
  }

  return stdout;
}

async function writeFixtureRepo(repoRoot: string): Promise<void> {
  await mkdir(path.join(repoRoot, ".git"), { recursive: true });
  await mkdir(path.join(repoRoot, "src"), { recursive: true });
  await writeFile(
    path.join(repoRoot, "src", "models.ts"),
    "export interface User { id: string }\n",
  );
  await writeFile(
    path.join(repoRoot, "src", "service.ts"),
    `
import { User } from "./models";
export function readUser(): User { throw new Error("not implemented"); }
`,
  );
  await writeFile(path.join(repoRoot, "src", "script.py"), "value = 1\n");
}

async function writeCapsuleFixtureRepo(repoRoot: string): Promise<void> {
  await mkdir(path.join(repoRoot, "src"), { recursive: true });
  await writeFile(
    path.join(repoRoot, "src", "session.ts"),
    `
export type Session = string;

export class SessionManager {
  createSession(accountId: string): Session {
    return accountId;
  }
}

export class SessionStore {
  loadSession(id: string): Session {
    return id;
  }
}

export function readSession(manager: SessionManager): Session {
  return manager.createSession("fixture");
}
`,
  );
  await writeFile(
    path.join(repoRoot, "src", "controller.ts"),
    `
import { SessionManager } from "./session";

export class SessionController {
  constructor(private readonly manager: SessionManager) {}
}
`,
  );
}

// A miniature django-shaped repo: an implementation file and a matching test
// file for each of the two micro fixtures, so target recovery can walk from a
// failing test / issue symbol to the implementation to edit.
async function writeMicroTargetFixtureRepo(repoRoot: string): Promise<void> {
  await mkdir(path.join(repoRoot, "django", "db", "models", "sql"), { recursive: true });
  await mkdir(path.join(repoRoot, "django", "contrib", "admin"), { recursive: true });
  await mkdir(path.join(repoRoot, "django", "contrib", "auth"), { recursive: true });
  await mkdir(path.join(repoRoot, "django", "contrib", "sessions"), { recursive: true });
  await mkdir(path.join(repoRoot, "django", "contrib", "contenttypes"), { recursive: true });
  await mkdir(path.join(repoRoot, "tests", "aggregation"), { recursive: true });
  await mkdir(path.join(repoRoot, "tests", "admin_inlines"), { recursive: true });

  // The base Model class: a generic framework hub that most of the ORM depends
  // on. It shares the aggregates package directory, so for an aggregate task it
  // looks "nearby", but it is never the edit target — it only wins on centrality.
  await writeFile(
    path.join(repoRoot, "django", "db", "models", "base.py"),
    `class Model:
    """Base class for all models in the ORM."""
    pk = None
`,
  );

  await writeFile(
    path.join(repoRoot, "django", "db", "models", "aggregates.py"),
    `from django.db.models.base import Model


class Aggregate(Model):
    """Base class for aggregate expressions."""
    def as_sql(self, compiler, connection):
        return "", []


class Count(Aggregate):
    """Count aggregate with optional distinct."""
    def __init__(self, expression, distinct=False):
        self.distinct = distinct
`,
  );

  // A module-level config variable in the SQL package. For an aggregate task it
  // matches on the "sql" path segment, but a string constant is not a plausible
  // micro edit target — it must rank below the actionable aggregate symbols.
  await writeFile(
    path.join(repoRoot, "django", "db", "models", "sql", "subqueries.py"),
    `compiler = "SQLAggregateCompiler"
`,
  );

  // Many ORM models subclass Model, pushing its in-degree well past the hub
  // threshold WITHOUT giving it any aggregate-specific relevance.
  await writeFile(
    path.join(repoRoot, "django", "contrib", "auth", "models.py"),
    `from django.db.models.base import Model


class User(Model):
    """An authenticated user."""


class Group(Model):
    """A named group of permissions."""


class Permission(Model):
    """A single permission."""
`,
  );
  await writeFile(
    path.join(repoRoot, "django", "contrib", "sessions", "models.py"),
    `from django.db.models.base import Model


class Session(Model):
    """A stored session."""
`,
  );
  await writeFile(
    path.join(repoRoot, "django", "contrib", "contenttypes", "models.py"),
    `from django.db.models.base import Model


class ContentType(Model):
    """A type of content."""
`,
  );
  await writeFile(
    path.join(repoRoot, "tests", "aggregation", "tests.py"),
    `from django.db.models.aggregates import Count


class AggregateTestCase:
    def test_count_distinct_expression(self):
        assert Count("field", distinct=True) is not None
`,
  );

  await writeFile(
    path.join(repoRoot, "django", "contrib", "admin", "options.py"),
    `class ModelAdmin:
    """Encapsulate all admin options for a given model."""
    inlines = []

    def get_inline_instances(self, request, obj=None):
        return [inline(self.model, self.admin_site) for inline in self.inlines]
`,
  );
  await writeFile(
    path.join(repoRoot, "tests", "admin_inlines", "tests.py"),
    `from django.contrib.admin.options import ModelAdmin


class GenericInlineModelAdminTest:
    def test_get_inline_instances_override_get_inlines(self):
        assert ModelAdmin().get_inline_instances(None) == []
`,
  );
}

async function writeIntentFixtureRepo(repoRoot: string): Promise<void> {
  await mkdir(path.join(repoRoot, "src"), { recursive: true });
  await writeFile(
    path.join(repoRoot, "src", "session.ts"),
    `
/** Session bug fix workflow and failure handling. */
export class SessionManager {
  /** Fix session bug by rebuilding state. */
  repairSessionBug(): string {
    return "ok";
  }
}
`,
  );
  await writeFile(
    path.join(repoRoot, "src", "guide.ts"),
    `
/** Session manager architecture guide. */
export class SessionGuide {
  explainSessionManager(): string {
    return "guide";
  }
}
`,
  );
}

async function writeProfileAwareCapsuleFixtureRepo(repoRoot: string): Promise<void> {
  await mkdir(path.join(repoRoot, "src"), { recursive: true });
  await writeFile(
    path.join(repoRoot, "src", "session.ts"),
    `
/** fix session bug and refactor session flow for SessionManager */
export class SessionManager {
  createSession(): string {
    return "session";
  }
}

/** fix session bug and refactor session flow for SessionStore */
export class SessionStore {
  loadSession(): string {
    return "session";
  }
}

/** fix session bug and refactor session flow for readSession */
export function readSession(): string {
  return "session";
}
`,
  );
  await writeFile(
    path.join(repoRoot, "src", "controller.ts"),
    `
/** fix session bug and refactor session flow for SessionController */
export class SessionController {
  handleSession(): string {
    return "session";
  }
}

/** fix session bug and refactor session flow for SessionCoordinator */
export function SessionCoordinator(): string {
  return "session";
}
`,
  );
  await writeFile(
    path.join(repoRoot, "src", "feature.ts"),
    `
/** fix session bug and refactor session flow for SessionFeature */
export function SessionFeature(): string {
  return "session";
}
`,
  );
}

function persistSourceBackedFixtureManifest(repoRoot: string): { manifestId: string } {
  const db = openIndexerDatabase(repoLocalDbPath(repoRoot));

  try {
    const sourceRunId = listIndexRuns(db).at(-1)?.id;
    assert.notEqual(sourceRunId, undefined);

    const readUser = findSymbol(listSymbolsForFile(db, "src/service.ts"), "readUser");
    const user = findSymbol(listSymbolsForFile(db, "src/models.ts"), "User");
    const capsule = buildCapsule(
      createSourceBackedCapsuleBuilder({ db, repoRoot }),
      {
        query: "read user",
        rerankedCandidates: [makeRerankedCandidate(readUser)],
        supportingCandidates: [makeSupportingCandidate(user, readUser.id)],
        maxBudget: createCharacterBudget(5_000),
      },
    );
    const manifest = persistCapsuleManifest(db, {
      sourceRunId: sourceRunId!,
      capsule,
      createdAtMs: 1,
    });

    return {
      manifestId: manifest.id,
    };
  } finally {
    db.close();
  }
}

function repoLocalDbPath(repoRoot: string): string {
  return resolveRepoLocalPaths(repoRoot).dbPath;
}

function findSymbol(symbols: readonly SymbolRecord[], localName: string): SymbolRecord {
  const symbol = symbols.find((candidate) => candidate.localName === localName);

  assert.notEqual(symbol, undefined);
  return symbol!;
}

function makeRerankedCandidate(symbol: SymbolRecord): GraphSearchResult {
  return {
    symbolId: symbol.id,
    filePath: symbol.filePath,
    fqName: symbol.fqName,
    localName: symbol.localName,
    kind: symbol.kind,
    matches: [
      {
        field: SymbolSearchMatchField.LocalName,
        matchType: SymbolSearchMatchType.Exact,
        scoreContribution: 100,
      },
      {
        field: SymbolSearchMatchField.FQName,
        matchType: SymbolSearchMatchType.Substring,
        scoreContribution: 20,
      },
    ],
    lexicalScore: 100,
    graphScore: 0,
    finalScore: 100,
    graphContributions: [],
  };
}

function makeSupportingCandidate(
  symbol: SymbolRecord,
  relatedSymbolId: string,
): CapsuleSupportingCandidate {
  return {
    symbolId: symbol.id,
    filePath: symbol.filePath,
    fqName: symbol.fqName,
    localName: symbol.localName,
    kind: symbol.kind,
    lexicalScore: 40,
    graphScore: 4,
    finalScore: 44,
    inclusionReasons: [
      {
        kind: CapsuleInclusionReasonKind.StructuralSupport,
        edgeType: EdgeType.Imports,
        relatedSymbolIds: [relatedSymbolId],
      },
    ],
  };
}

function buildExpectedCodexConfigToml(
  repoRoot: string,
  prefixLines: readonly string[] = [],
): string {
  const lines = [
    ...prefixLines,
    ...(prefixLines.length === 0 ? [] : [""]),
    "[mcp_servers.vtrace]",
    'command = "bash"',
    `args = [${JSON.stringify(resolveStableLauncherPath())}, "mcp-serve", "--repo", ${JSON.stringify(repoRoot)}]`,
    `cwd = ${JSON.stringify(repoRoot)}`,
    "",
  ];

  return lines.join("\n");
}

async function readClaudeCodeConfig(repoRoot: string): Promise<any> {
  return JSON.parse(await readFile(resolveClaudeCodeConfigPath(repoRoot), "utf8"));
}

function assertExpectedClaudeCodeServer(config: any, repoRoot: string): void {
  const server = config.projects[repoRoot].mcpServers.vtrace;

  assert.equal(server.type, "stdio");
  assert.equal(server.command, "bash");
  assert.equal(server.args[0].endsWith("/bin/vtrace"), true);
  assert.deepEqual(server.args.slice(1), ["mcp-serve", "--repo", repoRoot]);
  assert.deepEqual(server.env, {});
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
