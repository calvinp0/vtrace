import { execFile as execFileCallback, spawn as spawnCallback } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access } from "node:fs/promises";
import os from "node:os";
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
  const fileExists = options.fileExists ?? fileExistsOnDisk;
  const fileExecutable = options.fileExecutable ?? fileExecutableOnDisk;

  if (configuredPath) {
    attempted.push({ source: EXECUTABLE_SOURCES.Configured, path: configuredPath });
    if (!(await fileExists(configuredPath))) {
      throw buildResolutionError(
        `Configured vtrace.cliPath does not exist: ${configuredPath}`,
        "VTRACE_CONFIGURED_CLI_MISSING",
        configuredPath,
        EXECUTABLE_SOURCES.Configured,
        attempted,
      );
    }
    if (!(await fileExecutable(configuredPath))) {
      throw buildResolutionError(
        `Configured vtrace.cliPath is not executable: ${configuredPath}`,
        "VTRACE_CONFIGURED_CLI_NOT_EXECUTABLE",
        configuredPath,
        EXECUTABLE_SOURCES.Configured,
        attempted,
      );
    }
    return {
      command: configuredPath,
      source: EXECUTABLE_SOURCES.Configured,
      attempted,
    };
  }

  const bundledCandidates = [
    {
      source: EXECUTABLE_SOURCES.Bundled,
      path: path.join(options.extensionPath, "bin", "vtrace"),
      root: options.extensionPath,
    },
    {
      source: EXECUTABLE_SOURCES.BundledDev,
      path: path.join(options.extensionPath, "..", "bin", "vtrace"),
      root: path.join(options.extensionPath, ".."),
    },
  ];

  for (const candidate of bundledCandidates) {
    attempted.push({ source: candidate.source, path: candidate.path });
    if (await isRunnableSourceCheckoutLauncher(candidate, fileExists, fileExecutable)) {
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
    fileExists: options.fileExists ?? fileExistsOnDisk,
    fileExecutable: options.fileExecutable ?? fileExecutableOnDisk,
  };

  let cachedResolution = null;

  async function resolve() {
    cachedResolution = await resolveCliCommandWithSource({
      extensionPath: options.extensionPath,
      getConfiguredCliPath: options.getConfiguredCliPath,
      fileExists: deps.fileExists,
      fileExecutable: deps.fileExecutable,
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
    fileExecutable: options.fileExecutable,
  });

  options.onResolved?.(resolution);

  try {
    const output = await options.execFile(resolution.command, options.args, {
      cwd: options.cwd,
      maxBuffer: DEFAULT_MAX_BUFFER,
      env: buildCliEnvironment(options.env),
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
      if (resolution.source === EXECUTABLE_SOURCES.Configured) {
        const configuredSpawnError = new Error(`Could not execute configured vtrace.cliPath: ${resolution.command}`);
        configuredSpawnError.code = "VTRACE_CONFIGURED_CLI_SPAWN_FAILED";
        configuredSpawnError.resolution = resolution;
        throw configuredSpawnError;
      }
      const missingError = new Error(formatMissingCliMessage(resolution));
      missingError.code = "VTRACE_CLI_NOT_FOUND";
      missingError.resolution = resolution;
      throw missingError;
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
    fileExecutable: options.fileExecutable,
  });

  options.onResolved?.(resolution);

  const spawnOptions = {
    cwd: options.cwd,
    env: buildCliEnvironment(options.env),
  };

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
    if (resolution.source === EXECUTABLE_SOURCES.Configured) {
      const configuredSpawnError = new Error(`Could not execute configured vtrace.cliPath: ${resolution.command}`);
      configuredSpawnError.code = "VTRACE_CONFIGURED_CLI_SPAWN_FAILED";
      configuredSpawnError.resolution = resolution;
      return configuredSpawnError;
    }
    const missingError = new Error(formatMissingCliMessage(resolution));
    missingError.code = "VTRACE_CLI_NOT_FOUND";
    missingError.resolution = resolution;
    return missingError;
  }

  return error instanceof Error ? error : new Error(String(error));
}

function spawnChildProcess(command, args, options) {
  return spawnCallback(command, args, {
    ...options,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

export function buildCliEnvironment(extraEnv = undefined, baseEnv = process.env) {
  const merged = {
    ...baseEnv,
    ...(extraEnv ?? {}),
  };
  const pathKey = findPathEnvKey(merged);
  const home = merged.HOME ?? merged.USERPROFILE ?? os.homedir();
  const existingPath = merged[pathKey] ?? "";
  const additions = home
    ? [
      path.join(home, ".bun", "bin"),
      path.join(home, ".local", "bin"),
    ]
    : [];

  merged[pathKey] = [...additions, existingPath].filter((part) => part !== "").join(path.delimiter);
  return merged;
}

function findPathEnvKey(env) {
  if (process.platform === "win32") {
    return Object.keys(env).find((key) => key.toLowerCase() === "path") ?? "Path";
  }
  return "PATH";
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

async function fileExistsOnDisk(targetPath) {
  try {
    await access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function fileExecutableOnDisk(targetPath) {
  if (process.platform === "win32") {
    return await fileExistsOnDisk(targetPath);
  }

  try {
    await access(targetPath, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function isRunnableSourceCheckoutLauncher(candidate, fileExists, fileExecutable) {
  return (await fileExists(candidate.path))
    && (await fileExecutable(candidate.path))
    && (await fileExists(path.join(candidate.root, "src", "cli", "index.ts")));
}

function buildResolutionError(message, code, command, source, attempted) {
  const error = new Error(message);
  error.code = code;
  error.resolution = {
    command,
    source,
    attempted: [...attempted],
  };
  return error;
}

function buildCommandError(args, result, prefix = null) {
  const detail = result.stderr.trim().length > 0
    ? result.stderr.trim()
    : result.stdout.trim().length > 0
      ? result.stdout.trim()
      : `Command exited with code ${result.exitCode}.`;

  const headline = prefix ?? `vtrace CLI failed: \`${args.join(" ")}\``;
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
    "vtrace executable not found. Set `vtrace.cliPath` or install vtrace on PATH.",
    "Attempted:",
    attempted,
  ].join("\n");
}

function isCliMissingError(error) {
  return error?.code === "ENOENT";
}
