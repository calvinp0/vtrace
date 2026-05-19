import { execFile as execFileCallback, spawn as spawnCallback } from "node:child_process";
import { access } from "node:fs/promises";
import path from "node:path";

export const AGENT_IDS = Object.freeze({
  ClaudeCode: "claude-code",
  Codex: "codex",
});

export const EXECUTABLE_SOURCES = Object.freeze({
  Configured: "configured",
  Bundled: "bundled",
  BundledDev: "bundled_dev",
  Path: "path",
  Missing: "missing",
});

const DEFAULT_MAX_BUFFER = 16 * 1024 * 1024;

export function buildStatusArgs(repoRoot, agentId = AGENT_IDS.ClaudeCode) {
  return [
    "status",
    repoRoot,
    ...(agentId === AGENT_IDS.Codex ? ["--agent", AGENT_IDS.Codex] : []),
    "--json",
  ];
}

export function buildDoctorArgs(repoRoot, agentId = AGENT_IDS.ClaudeCode) {
  return [
    "doctor",
    repoRoot,
    ...(agentId === AGENT_IDS.Codex ? ["--agent", AGENT_IDS.Codex] : []),
    "--json",
  ];
}

export function buildSetupArgs(repoRoot, agentId = AGENT_IDS.ClaudeCode) {
  return [
    "setup",
    repoRoot,
    ...(agentId === AGENT_IDS.Codex ? ["--agent", AGENT_IDS.Codex] : []),
  ];
}

export function buildCapsuleArgs(repoRoot, query) {
  return ["capsule", repoRoot, query];
}

export function buildIndexArgs(repoRoot) {
  return ["index", repoRoot];
}

export function buildSkeletonArgs(repoRoot, filePath) {
  return ["skeleton", repoRoot, filePath, "--detail", "standard"];
}

export function buildInspectFileArgs(filePath) {
  return ["inspect-file", filePath];
}

export function buildImpactGraphArgs(repoRoot, symbolFqn) {
  return ["impact-graph", repoRoot, symbolFqn, "--depth", "2", "--format", "tree"];
}

export function buildRunPipelineArgs(repoRoot, query, options = {}) {
  const args = ["run-pipeline", repoRoot, query];
  if (options.intent !== undefined && options.intent !== null) {
    args.push("--intent", String(options.intent));
  }
  if (options.sessionId !== undefined && options.sessionId !== null) {
    args.push("--session-id", String(options.sessionId));
  }
  if (options.maxBudgetCharacters !== undefined && options.maxBudgetCharacters !== null) {
    args.push("--max-budget-characters", String(options.maxBudgetCharacters));
  }
  if (options.includeMemory === true) {
    args.push("--include-memory");
  }
  return args;
}

export function buildExpandVexpRefArgs(repoRoot, hash, options = {}) {
  const args = ["expand-vexp-ref", repoRoot, hash];
  if (options.query !== undefined && options.query !== null && options.query !== "") {
    args.push("--query", String(options.query));
  }
  if (options.sessionId !== undefined && options.sessionId !== null) {
    args.push("--session-id", String(options.sessionId));
  }
  if (options.intent !== undefined && options.intent !== null) {
    args.push("--intent", String(options.intent));
  }
  if (options.maxBudgetCharacters !== undefined && options.maxBudgetCharacters !== null) {
    args.push("--max-budget-characters", String(options.maxBudgetCharacters));
  }
  if (options.includeMemory === true) {
    args.push("--include-memory");
  }
  return args;
}

export async function resolveCliCommand(options) {
  const resolution = await resolveCliCommandWithSource(options);
  return resolution.command;
}

export async function resolveCliCommandWithSource(options) {
  const attempted = [];
  const configuredPath = options.getConfiguredCliPath?.()?.trim();

  if (configuredPath) {
    attempted.push({ source: EXECUTABLE_SOURCES.Configured, path: configuredPath });
    return {
      command: configuredPath,
      source: EXECUTABLE_SOURCES.Configured,
      attempted,
    };
  }

  const bundledCandidates = [
    { source: EXECUTABLE_SOURCES.Bundled, path: path.join(options.extensionPath, "bin", "vtrace") },
    { source: EXECUTABLE_SOURCES.BundledDev, path: path.join(options.extensionPath, "..", "bin", "vtrace") },
  ];

  for (const candidate of bundledCandidates) {
    attempted.push(candidate);
    if (await options.fileExists(candidate.path)) {
      return {
        command: candidate.path,
        source: candidate.source,
        attempted,
      };
    }
  }

  attempted.push({ source: EXECUTABLE_SOURCES.Path, path: "vtrace" });
  return {
    command: "vtrace",
    source: EXECUTABLE_SOURCES.Path,
    attempted,
  };
}

export function describeExecutableSource(source) {
  switch (source) {
    case EXECUTABLE_SOURCES.Configured:
      return "From vtrace.cliPath setting";
    case EXECUTABLE_SOURCES.Bundled:
      return "Bundled launcher";
    case EXECUTABLE_SOURCES.BundledDev:
      return "Bundled launcher (dev repo layout)";
    case EXECUTABLE_SOURCES.Path:
      return "Resolved from PATH";
    case EXECUTABLE_SOURCES.Missing:
      return "Not found";
    default:
      return "Unknown";
  }
}

export function createCliBridge(options) {
  const deps = {
    execFile: options.execFile ?? execFilePromise,
    spawn: options.spawn ?? spawnChildProcess,
    fileExists: options.fileExists ?? fileExists,
  };

  let cachedResolution = null;

  async function resolve() {
    cachedResolution = await resolveCliCommandWithSource({
      extensionPath: options.extensionPath,
      getConfiguredCliPath: options.getConfiguredCliPath,
      fileExists: deps.fileExists,
    });
    return cachedResolution;
  }

  return {
    async getExecutableInfo() {
      return await resolve();
    },

    getLastExecutableInfo() {
      return cachedResolution;
    },

    async runJson(args, cwd) {
      const result = await runCommand({
        ...options,
        ...deps,
        args,
        cwd,
        onResolved: (info) => {
          cachedResolution = info;
        },
      });

      const trimmed = result.stdout.trim();

      if (trimmed.length === 0) {
        throw buildCommandError(args, result);
      }

      try {
        return {
          command: result.command,
          stdout: result.stdout,
          data: JSON.parse(trimmed),
          exitCode: result.exitCode,
        };
      } catch {
        throw buildCommandError(args, result, `vtrace returned invalid JSON for \`${args.join(" ")}\`.`);
      }
    },

    async runText(args, cwd) {
      const result = await runCommand({
        ...options,
        ...deps,
        args,
        cwd,
        onResolved: (info) => {
          cachedResolution = info;
        },
      });

      if (result.exitCode !== 0) {
        throw buildCommandError(args, result);
      }

      return {
        command: result.command,
        stdout: result.stdout,
      };
    },

    async runTextStreaming(args, cwd, handlers = {}) {
      const result = await runCommandStreaming({
        ...options,
        ...deps,
        args,
        cwd,
        env: handlers.env,
        onStderrLine: handlers.onStderrLine,
        onResolved: (info) => {
          cachedResolution = info;
        },
      });

      if (result.exitCode !== 0) {
        throw buildCommandError(args, result);
      }

      return {
        command: result.command,
        stdout: result.stdout,
      };
    },
  };
}

async function runCommand(options) {
  const resolution = await resolveCliCommandWithSource({
    extensionPath: options.extensionPath,
    getConfiguredCliPath: options.getConfiguredCliPath,
    fileExists: options.fileExists,
  });

  options.onResolved?.(resolution);

  try {
    const output = await options.execFile(resolution.command, options.args, {
      cwd: options.cwd,
      maxBuffer: DEFAULT_MAX_BUFFER,
    });

    return {
      command: resolution.command,
      source: resolution.source,
      exitCode: 0,
      stdout: output.stdout,
      stderr: output.stderr,
    };
  } catch (error) {
    if (isCliMissingError(error)) {
      const missingError = new Error(formatMissingCliMessage(resolution));
      missingError.code = "VTRACE_CLI_NOT_FOUND";
      missingError.resolution = resolution;
      throw missingError;
    }

    if (isBundledCliRuntimeMissingError(error)) {
      const bunMissingError = new Error(
        "The bundled vtrace launcher could not start because Bun is missing. Install Bun (https://bun.sh) or set `vtrace.cliPath` to a working vtrace executable.",
      );
      bunMissingError.code = "VTRACE_BUN_NOT_FOUND";
      bunMissingError.resolution = resolution;
      throw bunMissingError;
    }

    if (typeof error?.code === "number") {
      return {
        command: resolution.command,
        source: resolution.source,
        exitCode: error.code,
        stdout: error.stdout ?? "",
        stderr: error.stderr ?? "",
      };
    }

    throw new Error(error instanceof Error ? error.message : String(error));
  }
}

async function runCommandStreaming(options) {
  const resolution = await resolveCliCommandWithSource({
    extensionPath: options.extensionPath,
    getConfiguredCliPath: options.getConfiguredCliPath,
    fileExists: options.fileExists,
  });

  options.onResolved?.(resolution);

  const spawnOptions = { cwd: options.cwd };
  if (options.env !== undefined && options.env !== null) {
    spawnOptions.env = options.env;
  }

  return await new Promise((resolve, reject) => {
    let child;
    try {
      child = options.spawn(resolution.command, options.args, spawnOptions);
    } catch (error) {
      reject(wrapSpawnError(error, resolution, ""));
      return;
    }

    const stdoutChunks = [];
    const stderrChunks = [];
    let stderrBuffer = "";
    let settled = false;

    const settleReject = (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };

    const settleResolve = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    if (child.stdout !== undefined && child.stdout !== null) {
      child.stdout.setEncoding?.("utf8");
      child.stdout.on?.("data", (chunk) => {
        stdoutChunks.push(chunk);
      });
    }

    if (child.stderr !== undefined && child.stderr !== null) {
      child.stderr.setEncoding?.("utf8");
      child.stderr.on?.("data", (chunk) => {
        stderrChunks.push(chunk);
        stderrBuffer += chunk;
        let newlineIdx = stderrBuffer.indexOf("\n");
        while (newlineIdx !== -1) {
          const line = stripTrailingCarriageReturn(stderrBuffer.slice(0, newlineIdx));
          stderrBuffer = stderrBuffer.slice(newlineIdx + 1);
          options.onStderrLine?.(line);
          newlineIdx = stderrBuffer.indexOf("\n");
        }
      });
    }

    child.on?.("error", (error) => {
      settleReject(wrapSpawnError(error, resolution, stderrChunks.join("")));
    });

    child.on?.("close", (code) => {
      // Flush any trailing partial stderr line.
      if (stderrBuffer.length > 0) {
        options.onStderrLine?.(stripTrailingCarriageReturn(stderrBuffer));
        stderrBuffer = "";
      }

      const stderr = stderrChunks.join("");
      const exitCode = typeof code === "number" ? code : 0;

      if (exitCode !== 0 && isBundledCliRuntimeMissingError({ stderr, message: "" })) {
        const bunMissingError = new Error(
          "The bundled vtrace launcher could not start because Bun is missing. Install Bun (https://bun.sh) or set `vtrace.cliPath` to a working vtrace executable.",
        );
        bunMissingError.code = "VTRACE_BUN_NOT_FOUND";
        bunMissingError.resolution = resolution;
        settleReject(bunMissingError);
        return;
      }

      settleResolve({
        command: resolution.command,
        source: resolution.source,
        exitCode,
        stdout: stdoutChunks.join(""),
        stderr,
      });
    });
  });
}

function wrapSpawnError(error, resolution, stderrSoFar) {
  if (isCliMissingError(error)) {
    const missingError = new Error(formatMissingCliMessage(resolution));
    missingError.code = "VTRACE_CLI_NOT_FOUND";
    missingError.resolution = resolution;
    return missingError;
  }

  if (isBundledCliRuntimeMissingError({ stderr: stderrSoFar, message: error?.message ?? "" })) {
    const bunMissingError = new Error(
      "The bundled vtrace launcher could not start because Bun is missing. Install Bun (https://bun.sh) or set `vtrace.cliPath` to a working vtrace executable.",
    );
    bunMissingError.code = "VTRACE_BUN_NOT_FOUND";
    bunMissingError.resolution = resolution;
    return bunMissingError;
  }

  return error instanceof Error ? error : new Error(String(error));
}

function spawnChildProcess(command, args, options) {
  const mergedEnv = options?.env === undefined ? process.env : { ...process.env, ...options.env };
  return spawnCallback(command, args, {
    ...options,
    env: mergedEnv,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function stripTrailingCarriageReturn(line) {
  return line.endsWith("\r") ? line.slice(0, -1) : line;
}

async function execFilePromise(command, args, options) {
  return await new Promise((resolve, reject) => {
    execFileCallback(command, args, options, (error, stdout, stderr) => {
      if (error !== null) {
        reject({
          code: error.code,
          message: error.message,
          stdout,
          stderr,
        });
        return;
      }

      resolve({
        stdout,
        stderr,
      });
    });
  });
}

async function fileExists(targetPath) {
  try {
    await access(targetPath);
    return true;
  } catch {
    return false;
  }
}

function buildCommandError(args, result, prefix = null) {
  const detail = result.stderr.trim().length > 0
    ? result.stderr.trim()
    : result.stdout.trim().length > 0
      ? result.stdout.trim()
      : `Command exited with code ${result.exitCode}.`;

  const headline = prefix ?? `vtrace command failed: \`${args.join(" ")}\``;
  const error = new Error([headline, detail].join("\n"));
  error.code = "VTRACE_COMMAND_FAILED";
  error.stdout = result.stdout;
  error.stderr = result.stderr;
  error.exitCode = result.exitCode;
  return error;
}

function formatMissingCliMessage(resolution) {
  const attempted = resolution.attempted
    .map((entry) => `  - ${describeExecutableSource(entry.source)}: ${entry.path}`)
    .join("\n");

  return [
    "vtrace CLI was not found.",
    "Attempted:",
    attempted,
    "Set `vtrace.cliPath` in Settings to an absolute path, or make `vtrace` available on PATH.",
  ].join("\n");
}

function isCliMissingError(error) {
  return error?.code === "ENOENT";
}

function isBundledCliRuntimeMissingError(error) {
  const detail = `${error?.stderr ?? ""}\n${error?.message ?? ""}`;
  return /\bbun\b.*(not found|No such file or directory)/i.test(detail);
}
