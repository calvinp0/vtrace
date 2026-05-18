import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "bun:test";

import {
  AGENT_IDS,
  EXECUTABLE_SOURCES,
  buildCapsuleArgs,
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

test("resolveCliCommand prefers configured path, then bundled, then dev-layout bundled, then PATH", async () => {
  assert.equal(await resolveCliCommand({
    extensionPath: "/ext",
    getConfiguredCliPath: () => "/custom/vexb",
    fileExists: async () => false,
  }), "/custom/vexb");

  assert.equal(await resolveCliCommand({
    extensionPath: "/ext",
    getConfiguredCliPath: () => "",
    fileExists: async (targetPath: string) => targetPath === "/ext/bin/vexb",
  }), "/ext/bin/vexb");

  assert.equal(await resolveCliCommand({
    extensionPath: "/repo/vscode-extension",
    getConfiguredCliPath: () => "",
    fileExists: async (targetPath: string) => targetPath === "/repo/bin/vexb",
  }), "/repo/bin/vexb");

  assert.equal(await resolveCliCommand({
    extensionPath: "/ext",
    getConfiguredCliPath: () => "",
    fileExists: async () => false,
  }), "vexb");
});

test("resolveCliCommandWithSource reports which path was used and records attempted paths", async () => {
  const configured = await resolveCliCommandWithSource({
    extensionPath: "/ext",
    getConfiguredCliPath: () => "/custom/vexb",
    fileExists: async () => false,
  });
  assert.equal(configured.source, EXECUTABLE_SOURCES.Configured);
  assert.deepEqual(configured.attempted.map((entry) => entry.source), [EXECUTABLE_SOURCES.Configured]);

  const bundledDev = await resolveCliCommandWithSource({
    extensionPath: "/repo/vscode-extension",
    getConfiguredCliPath: () => "",
    fileExists: async (targetPath: string) => targetPath === "/repo/bin/vexb",
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
    getConfiguredCliPath: () => "/custom/vexb",
    fileExists: async () => false,
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
    command: "/custom/vexb",
    args: ["status", "/repo", "--agent", "codex", "--json"],
    cwd: "/repo",
  }]);

  const cached = cli.getLastExecutableInfo();
  assert.equal(cached?.command, "/custom/vexb");
  assert.equal(cached?.source, EXECUTABLE_SOURCES.Configured);
});

test("createCliBridge accepts JSON failure payloads emitted on non-zero exit codes", async () => {
  const cli = createCliBridge({
    extensionPath: "/ext",
    getConfiguredCliPath: () => "/custom/vexb",
    fileExists: async () => false,
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

test("createCliBridge raises VEXB_CLI_NOT_FOUND with attempted paths when ENOENT", async () => {
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
  assert.equal(error?.code, "VEXB_CLI_NOT_FOUND");
  assert.match(error?.message ?? "", /vexb CLI was not found/);
  assert.match(error?.message ?? "", /cliPath/);
  assert.match(error?.message ?? "", /PATH/);
  assert.deepEqual(
    error?.resolution?.attempted.map((entry) => entry.source),
    [EXECUTABLE_SOURCES.Bundled, EXECUTABLE_SOURCES.BundledDev, EXECUTABLE_SOURCES.Path],
  );
});

test("createCliBridge detects missing Bun runtime and marks error as VEXB_BUN_NOT_FOUND", async () => {
  const cli = createCliBridge({
    extensionPath: "/ext",
    getConfiguredCliPath: () => "",
    fileExists: async () => true,
    execFile: async () => {
      throw {
        code: 127,
        stdout: "",
        stderr: "bun: not found",
        message: "exec failed",
      };
    },
  });

  const error = await cli.runText(["status", "/repo"], "/repo").then(
    () => null,
    (err) => err as Error & { code?: string },
  );

  assert.equal(error?.code, "VEXB_BUN_NOT_FOUND");
  assert.match(error?.message ?? "", /Bun/);
});

test("getExecutableInfo exposes resolution details without running the CLI", async () => {
  const cli = createCliBridge({
    extensionPath: "/ext",
    getConfiguredCliPath: () => "",
    fileExists: async (targetPath: string) => targetPath === "/ext/bin/vexb",
    execFile: async () => ({ stdout: "", stderr: "" }),
  });

  const info = await cli.getExecutableInfo();
  assert.equal(info.command, "/ext/bin/vexb");
  assert.equal(info.source, EXECUTABLE_SOURCES.Bundled);
});

test("runTextStreaming line-buffers stderr and invokes onStderrLine for each complete line", async () => {
  const emittedLines: string[] = [];
  const gate = makeSpawnGate();
  const cli = createCliBridge({
    extensionPath: "/ext",
    getConfiguredCliPath: () => "/custom/vexb",
    fileExists: async () => false,
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

test("runTextStreaming surfaces non-zero exits as VEXB_COMMAND_FAILED with the streamed stderr attached", async () => {
  const gate = makeSpawnGate();
  const cli = createCliBridge({
    extensionPath: "/ext",
    getConfiguredCliPath: () => "/custom/vexb",
    fileExists: async () => false,
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

  assert.equal(error?.code, "VEXB_COMMAND_FAILED");
  assert.equal(error?.exitCode, 2);
  assert.match(error?.stderr ?? "", /something broke/);
});

test("runTextStreaming forwards env option to spawn so the CLI can opt into non-TTY progress streaming", async () => {
  let capturedSpawnOptions: { cwd?: string; env?: Record<string, string | undefined> } | undefined;
  const gate = makeSpawnGate();
  const cli = createCliBridge({
    extensionPath: "/ext",
    getConfiguredCliPath: () => "/custom/vexb",
    fileExists: async () => false,
    spawn: (command, args, spawnOptions) => {
      capturedSpawnOptions = spawnOptions;
      return gate.spawn(command, args, spawnOptions);
    },
  });

  const pending = cli.runTextStreaming(["index", "/repo"], "/repo", {
    env: { VEXB_PROGRESS_STREAM: "1" },
  });
  const fakeChild = await gate.awaitSpawn();
  fakeChild.emit("close", 0);
  await pending;

  assert.equal(capturedSpawnOptions?.env?.VEXB_PROGRESS_STREAM, "1");
});

test("runTextStreaming raises VEXB_CLI_NOT_FOUND when spawn reports ENOENT via error event", async () => {
  const gate = makeSpawnGate();
  const cli = createCliBridge({
    extensionPath: "/ext",
    getConfiguredCliPath: () => "",
    fileExists: async () => false,
    spawn: gate.spawn,
  });

  const pending = cli.runTextStreaming(["status", "/repo"], "/repo", {});
  const fakeChild = await gate.awaitSpawn();
  const enoent = Object.assign(new Error("spawn vexb ENOENT"), { code: "ENOENT" });
  fakeChild.emit("error", enoent);

  const error = await pending.then(
    () => null,
    (err) => err as Error & { code?: string },
  );

  assert.equal(error?.code, "VEXB_CLI_NOT_FOUND");
  assert.match(error?.message ?? "", /vexb CLI was not found/);
});

test("command builders stay thin and map directly to vexb CLI subcommands", () => {
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
