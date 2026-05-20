import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "bun:test";

import {
  AGENT_IDS,
  EXECUTABLE_SOURCES,
  buildCapsuleArgs,
  buildCliEnvironment,
  buildImpactGraphArgs,
  buildInspectFileArgs,
  buildSetupArgs,
  buildSkeletonArgs,
  buildStatusArgs,
  createCliBridge,
  describeExecutableSource,
  resolveCliCommand,
  resolveCliCommandWithSource,
} from "./cli.js";

test("resolveCliCommand prefers configured path, then runnable bundled/dev launchers, then PATH", async () => {
  assert.equal(await resolveCliCommand({
    extensionPath: "/ext",
    getConfiguredCliPath: () => "/custom/vtrace",
    fileExists: async (targetPath: string) => targetPath === "/custom/vtrace",
    fileExecutable: async (targetPath: string) => targetPath === "/custom/vtrace",
  }), "/custom/vtrace");

  assert.equal(await resolveCliCommand({
    extensionPath: "/ext",
    getConfiguredCliPath: () => "",
    fileExists: async (targetPath: string) =>
      targetPath === "/ext/bin/vtrace" || targetPath === "/ext/src/cli/index.ts",
    fileExecutable: async (targetPath: string) => targetPath === "/ext/bin/vtrace",
  }), "/ext/bin/vtrace");

  assert.equal(await resolveCliCommand({
    extensionPath: "/repo/vscode-extension",
    getConfiguredCliPath: () => "",
    fileExists: async (targetPath: string) =>
      targetPath === "/repo/bin/vtrace" || targetPath === "/repo/src/cli/index.ts",
    fileExecutable: async (targetPath: string) => targetPath === "/repo/bin/vtrace",
  }), "/repo/bin/vtrace");

  assert.equal(await resolveCliCommand({
    extensionPath: "/packaged-ext",
    getConfiguredCliPath: () => "",
    fileExists: async (targetPath: string) => targetPath === "/packaged-ext/bin/vtrace",
    fileExecutable: async (targetPath: string) => targetPath === "/packaged-ext/bin/vtrace",
  }), "vtrace");

  assert.equal(await resolveCliCommand({
    extensionPath: "/ext",
    getConfiguredCliPath: () => "",
    fileExists: async () => false,
  }), "vtrace");
});

test("resolveCliCommandWithSource reports which path was used and records attempted paths", async () => {
  const configured = await resolveCliCommandWithSource({
    extensionPath: "/ext",
    getConfiguredCliPath: () => "/custom/vtrace",
    fileExists: async (targetPath: string) => targetPath === "/custom/vtrace",
    fileExecutable: async (targetPath: string) => targetPath === "/custom/vtrace",
  });
  assert.equal(configured.source, EXECUTABLE_SOURCES.Configured);
  assert.deepEqual(configured.attempted.map((entry) => entry.source), [EXECUTABLE_SOURCES.Configured]);

  const bundledDev = await resolveCliCommandWithSource({
    extensionPath: "/repo/vscode-extension",
    getConfiguredCliPath: () => "",
    fileExists: async (targetPath: string) =>
      targetPath === "/repo/bin/vtrace" || targetPath === "/repo/src/cli/index.ts",
    fileExecutable: async (targetPath: string) => targetPath === "/repo/bin/vtrace",
  });
  assert.equal(bundledDev.source, EXECUTABLE_SOURCES.BundledDev);
  assert.deepEqual(bundledDev.attempted.map((entry) => entry.source), [
    EXECUTABLE_SOURCES.Bundled,
    EXECUTABLE_SOURCES.BundledDev,
  ]);

  const pathFallback = await resolveCliCommandWithSource({
    extensionPath: "/ext",
    getConfiguredCliPath: () => "",
    fileExists: async () => false,
  });
  assert.equal(pathFallback.source, EXECUTABLE_SOURCES.Path);
  assert.deepEqual(pathFallback.attempted.map((entry) => entry.source), [
    EXECUTABLE_SOURCES.Bundled,
    EXECUTABLE_SOURCES.BundledDev,
    EXECUTABLE_SOURCES.Path,
  ]);
});

test("resolveCliCommand reports configured path validation failures explicitly", async () => {
  const missing = await resolveCliCommandWithSource({
    extensionPath: "/ext",
    getConfiguredCliPath: () => "/missing/vtrace",
    fileExists: async () => false,
    fileExecutable: async () => false,
  }).then(
    () => null,
    (err) => err as Error & { code?: string },
  );

  assert.equal(missing?.code, "VTRACE_CONFIGURED_CLI_MISSING");
  assert.match(missing?.message ?? "", /Configured vtrace\.cliPath does not exist: \/missing\/vtrace/);

  const notExecutable = await resolveCliCommandWithSource({
    extensionPath: "/ext",
    getConfiguredCliPath: () => "/custom/vtrace",
    fileExists: async () => true,
    fileExecutable: async () => false,
  }).then(
    () => null,
    (err) => err as Error & { code?: string },
  );

  assert.equal(notExecutable?.code, "VTRACE_CONFIGURED_CLI_NOT_EXECUTABLE");
  assert.match(notExecutable?.message ?? "", /Configured vtrace\.cliPath is not executable: \/custom\/vtrace/);
});

test("describeExecutableSource returns human-readable labels for every source", () => {
  assert.match(describeExecutableSource(EXECUTABLE_SOURCES.Configured), /cliPath/);
  assert.match(describeExecutableSource(EXECUTABLE_SOURCES.Bundled), /Bundled/);
  assert.match(describeExecutableSource(EXECUTABLE_SOURCES.BundledDev), /dev/);
  assert.match(describeExecutableSource(EXECUTABLE_SOURCES.Path), /PATH/);
});

test("createCliBridge parses JSON responses and caches the executable resolution", async () => {
  const invocations: Array<{ command: string; args: string[]; cwd: string }> = [];
  const cli = createCliBridge({
    extensionPath: "/ext",
    getConfiguredCliPath: () => "/custom/vtrace",
    fileExists: async (targetPath: string) => targetPath === "/custom/vtrace",
    fileExecutable: async (targetPath: string) => targetPath === "/custom/vtrace",
    execFile: async (command: string, args: string[], options: { cwd: string }) => {
      invocations.push({ command, args, cwd: options.cwd });
      return {
        stdout: `${JSON.stringify({ ok: true, command: "status", result: { ready: true } })}\n`,
        stderr: "",
      };
    },
  });

  const result = await cli.runJson(buildStatusArgs("/repo", AGENT_IDS.Codex), "/repo");

  assert.equal(result.data.ok, true);
  assert.deepEqual(invocations, [{
    command: "/custom/vtrace",
    args: ["status", "/repo", "--agent", "codex", "--json"],
    cwd: "/repo",
  }]);

  const cached = cli.getLastExecutableInfo();
  assert.equal(cached?.command, "/custom/vtrace");
  assert.equal(cached?.source, EXECUTABLE_SOURCES.Configured);
});

test("createCliBridge accepts JSON failure payloads emitted on non-zero exit codes", async () => {
  const cli = createCliBridge({
    extensionPath: "/ext",
    getConfiguredCliPath: () => "/custom/vtrace",
    fileExists: async (targetPath: string) => targetPath === "/custom/vtrace",
    fileExecutable: async (targetPath: string) => targetPath === "/custom/vtrace",
    execFile: async () => {
      throw {
        code: 1,
        stdout: `${JSON.stringify({
          ok: false,
          command: "doctor",
          result: null,
          error: { message: "repo not found" },
          warnings: [],
          nextSteps: [],
          repoRoot: null,
        })}\n`,
        stderr: "",
      };
    },
  });

  const result = await cli.runJson(["doctor", "/repo", "--json"], "/repo");

  assert.equal(result.exitCode, 1);
  assert.equal(result.data.ok, false);
  assert.equal(result.data.error.message, "repo not found");
});

test("createCliBridge raises VTRACE_CLI_NOT_FOUND with attempted paths when ENOENT", async () => {
  const cli = createCliBridge({
    extensionPath: "/ext",
    getConfiguredCliPath: () => "",
    fileExists: async () => false,
    execFile: async () => {
      throw {
        code: "ENOENT",
        stdout: "",
        stderr: "",
      };
    },
  });

  const error = await cli.runText(["status", "/repo"], "/repo").then(
    () => null,
    (err) => err as Error & { code?: string; resolution?: { attempted: Array<{ source: string }> } },
  );

  assert.ok(error, "expected an error to be thrown");
  assert.equal(error?.code, "VTRACE_CLI_NOT_FOUND");
  assert.match(error?.message ?? "", /vtrace executable not found/);
  assert.match(error?.message ?? "", /cliPath/);
  assert.match(error?.message ?? "", /PATH/);
  assert.deepEqual(
    error?.resolution?.attempted.map((entry) => entry.source),
    [EXECUTABLE_SOURCES.Bundled, EXECUTABLE_SOURCES.BundledDev, EXECUTABLE_SOURCES.Path],
  );
});

test("createCliBridge surfaces child dependency failures as CLI execution failures", async () => {
  const cli = createCliBridge({
    extensionPath: "/ext",
    getConfiguredCliPath: () => "/custom/vtrace",
    fileExists: async (targetPath: string) => targetPath === "/custom/vtrace",
    fileExecutable: async (targetPath: string) => targetPath === "/custom/vtrace",
    execFile: async () => {
      throw {
        code: 127,
        stdout: "",
        stderr: "bun: command not found",
        message: "exec failed",
      };
    },
  });

  const error = await cli.runText(["status", "/repo"], "/repo").then(
    () => null,
    (err) => err as Error & { code?: string },
  );

  assert.equal(error?.code, "VTRACE_COMMAND_FAILED");
  assert.match(error?.message ?? "", /vtrace CLI failed/);
  assert.match(error?.message ?? "", /bun: command not found/);
});

test("getExecutableInfo exposes resolution details without running the CLI", async () => {
  const cli = createCliBridge({
    extensionPath: "/ext",
    getConfiguredCliPath: () => "",
    fileExists: async (targetPath: string) =>
      targetPath === "/ext/bin/vtrace" || targetPath === "/ext/src/cli/index.ts",
    fileExecutable: async (targetPath: string) => targetPath === "/ext/bin/vtrace",
    execFile: async () => ({ stdout: "", stderr: "" }),
  });

  const info = await cli.getExecutableInfo();
  assert.equal(info.command, "/ext/bin/vtrace");
  assert.equal(info.source, EXECUTABLE_SOURCES.Bundled);
});

test("runTextStreaming line-buffers stderr and invokes onStderrLine for each complete line", async () => {
  const emittedLines: string[] = [];
  const gate = makeSpawnGate();
  const cli = createCliBridge({
    extensionPath: "/ext",
    getConfiguredCliPath: () => "/custom/vtrace",
    fileExists: async (targetPath: string) => targetPath === "/custom/vtrace",
    fileExecutable: async (targetPath: string) => targetPath === "/custom/vtrace",
    spawn: gate.spawn,
  });

  const pending = cli.runTextStreaming(["index", "/repo"], "/repo", {
    onStderrLine: (line) => emittedLines.push(line),
  });

  const fakeChild = await gate.awaitSpawn();

  // Emit stderr in arbitrary chunks that split across line boundaries —
  // the bridge must reassemble them and emit clean whole lines, without the CRs.
  fakeChild.stderr.emit("data", "parsing src/a.ts\r\nparsing src/b");
  fakeChild.stderr.emit("data", ".ts\nparsing src/c.ts\r\n");
  fakeChild.stderr.emit("data", "parsing src/d.ts"); // no trailing newline — should still flush on close
  fakeChild.stdout.emit("data", "ok\n");
  fakeChild.emit("close", 0);

  const result = await pending;

  assert.deepEqual(emittedLines, [
    "parsing src/a.ts",
    "parsing src/b.ts",
    "parsing src/c.ts",
    "parsing src/d.ts",
  ]);
  assert.equal(result.stdout, "ok\n");
});

test("runTextStreaming surfaces non-zero exits as VTRACE_COMMAND_FAILED with the streamed stderr attached", async () => {
  const gate = makeSpawnGate();
  const cli = createCliBridge({
    extensionPath: "/ext",
    getConfiguredCliPath: () => "/custom/vtrace",
    fileExists: async (targetPath: string) => targetPath === "/custom/vtrace",
    fileExecutable: async (targetPath: string) => targetPath === "/custom/vtrace",
    spawn: gate.spawn,
  });

  const pending = cli.runTextStreaming(["setup", "/repo"], "/repo", {});
  const fakeChild = await gate.awaitSpawn();
  fakeChild.stderr.emit("data", "error: something broke\n");
  fakeChild.emit("close", 2);

  const error = await pending.then(
    () => null,
    (err) => err as Error & { code?: string; stderr?: string; exitCode?: number },
  );

  assert.equal(error?.code, "VTRACE_COMMAND_FAILED");
  assert.equal(error?.exitCode, 2);
  assert.match(error?.stderr ?? "", /something broke/);
});

test("runTextStreaming forwards env option to spawn so the CLI can opt into non-TTY progress streaming", async () => {
  let capturedSpawnOptions: { cwd?: string; env?: Record<string, string | undefined> } | undefined;
  const gate = makeSpawnGate();
  const cli = createCliBridge({
    extensionPath: "/ext",
    getConfiguredCliPath: () => "/custom/vtrace",
    fileExists: async (targetPath: string) => targetPath === "/custom/vtrace",
    fileExecutable: async (targetPath: string) => targetPath === "/custom/vtrace",
    spawn: (command, args, spawnOptions) => {
      capturedSpawnOptions = spawnOptions;
      return gate.spawn(command, args, spawnOptions);
    },
  });

  const pending = cli.runTextStreaming(["index", "/repo"], "/repo", {
    env: { VTRACE_PROGRESS_STREAM: "1" },
  });
  const fakeChild = await gate.awaitSpawn();
  fakeChild.emit("close", 0);
  await pending;

  assert.equal(capturedSpawnOptions?.env?.VTRACE_PROGRESS_STREAM, "1");
  assert.match(capturedSpawnOptions?.env?.PATH ?? "", /\/\.bun\/bin/);
  assert.match(capturedSpawnOptions?.env?.PATH ?? "", /\/\.local\/bin/);
});

test("buildCliEnvironment prepends common Bun and user-bin locations ahead of PATH", () => {
  const env = buildCliEnvironment(
    { VTRACE_PROGRESS_STREAM: "1" },
    { HOME: "/home/user", PATH: "/usr/bin" },
  );

  assert.equal(env.VTRACE_PROGRESS_STREAM, "1");
  assert.equal(
    env.PATH,
    ["/home/user/.bun/bin", "/home/user/.local/bin", "/usr/bin"].join(pathDelimiter()),
  );
});

test("runTextStreaming raises VTRACE_CLI_NOT_FOUND when spawn reports ENOENT via error event", async () => {
  const gate = makeSpawnGate();
  const cli = createCliBridge({
    extensionPath: "/ext",
    getConfiguredCliPath: () => "",
    fileExists: async () => false,
    spawn: gate.spawn,
  });

  const pending = cli.runTextStreaming(["status", "/repo"], "/repo", {});
  const fakeChild = await gate.awaitSpawn();
  const enoent = Object.assign(new Error("spawn vtrace ENOENT"), { code: "ENOENT" });
  fakeChild.emit("error", enoent);

  const error = await pending.then(
    () => null,
    (err) => err as Error & { code?: string },
  );

  assert.equal(error?.code, "VTRACE_CLI_NOT_FOUND");
  assert.match(error?.message ?? "", /vtrace executable not found/);
});

test("runTextStreaming reports configured path spawn ENOENT separately", async () => {
  const gate = makeSpawnGate();
  const cli = createCliBridge({
    extensionPath: "/ext",
    getConfiguredCliPath: () => "/custom/vtrace",
    fileExists: async (targetPath: string) => targetPath === "/custom/vtrace",
    fileExecutable: async (targetPath: string) => targetPath === "/custom/vtrace",
    spawn: gate.spawn,
  });

  const pending = cli.runTextStreaming(["status", "/repo"], "/repo", {});
  const fakeChild = await gate.awaitSpawn();
  const enoent = Object.assign(new Error("spawn /custom/vtrace ENOENT"), { code: "ENOENT" });
  fakeChild.emit("error", enoent);

  const error = await pending.then(
    () => null,
    (err) => err as Error & { code?: string },
  );

  assert.equal(error?.code, "VTRACE_CONFIGURED_CLI_SPAWN_FAILED");
  assert.match(error?.message ?? "", /Could not execute configured vtrace\.cliPath: \/custom\/vtrace/);
});

test("command builders stay thin and map directly to vtrace CLI subcommands", () => {
  assert.deepEqual(buildSetupArgs("/repo", AGENT_IDS.ClaudeCode), ["setup", "/repo"]);
  assert.deepEqual(buildStatusArgs("/repo", AGENT_IDS.Codex), ["status", "/repo", "--agent", "codex", "--json"]);
  assert.deepEqual(buildCapsuleArgs("/repo", "trace auth flow"), ["capsule", "/repo", "trace auth flow"]);
  assert.deepEqual(buildSkeletonArgs("/repo", "src/app.ts"), ["skeleton", "/repo", "src/app.ts", "--detail", "standard"]);
  assert.deepEqual(buildInspectFileArgs("src/app.ts"), ["inspect-file", "src/app.ts"]);
  assert.deepEqual(buildImpactGraphArgs("/repo", "src/app.ts::App"), [
    "impact-graph",
    "/repo",
    "src/app.ts::App",
    "--depth",
    "2",
    "--format",
    "tree",
  ]);
});

type FakeChildProcess = EventEmitter & {
  stdout: EventEmitter & { setEncoding(encoding: string): void };
  stderr: EventEmitter & { setEncoding(encoding: string): void };
};

function makeFakeChildProcess(): FakeChildProcess {
  const child = new EventEmitter() as FakeChildProcess;
  const stdout = new EventEmitter() as FakeChildProcess["stdout"];
  const stderr = new EventEmitter() as FakeChildProcess["stderr"];
  stdout.setEncoding = () => {};
  stderr.setEncoding = () => {};
  child.stdout = stdout;
  child.stderr = stderr;
  return child;
}

function pathDelimiter() {
  return process.platform === "win32" ? ";" : ":";
}

// The bridge does `await resolveCliCommandWithSource(...)` before calling spawn,
// so we return the fake child synchronously from spawn() and a promise that
// resolves only AFTER the bridge has attached its listeners (i.e. next microtask).
function makeSpawnGate() {
  const child = makeFakeChildProcess();
  let spawned = false;
  let onSpawn: ((value: FakeChildProcess) => void) | null = null;
  const spawnedPromise = new Promise<FakeChildProcess>((resolve) => { onSpawn = resolve; });

  return {
    spawn: (_command: string, _args: string[], _options: { cwd?: string; env?: Record<string, string | undefined> }) => {
      spawned = true;
      // Defer to next microtask so the bridge has a chance to attach .on(...) handlers
      // before the test emits fake events.
      queueMicrotask(() => onSpawn?.(child));
      return child;
    },
    async awaitSpawn() {
      const resolved = await spawnedPromise;
      // One more tick for the listener attachments to settle.
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(spawned, true, "spawn must have been called");
      return resolved;
    },
  };
}
