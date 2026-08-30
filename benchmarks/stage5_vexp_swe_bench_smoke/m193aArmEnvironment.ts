/**
 * M193A §22–§27 — treatment isolation as a property of construction.
 *
 * M193 closed nine contamination routes by construction and left the tenth as a
 * *precondition*: "launch each arm with a private CLAUDE_CONFIG_DIR containing
 * credentials only". A precondition is an instruction to an operator, and this
 * programme has now twice recorded what happens when correctness depends on
 * someone remembering something.
 *
 * The measured cost of forgetting, on this host, is not one file. Running the
 * CLI against the inherited configuration resolves six MCP servers — two of them
 * remote network services — plus a user-level `CLAUDE.md`, an `enabledPlugins`
 * set, a `statusLine`, a `model` override and an `effortLevel`. Running it
 * against a freshly created empty directory resolves none of them, and the CLI
 * writes its own `.claude.json` *inside* that directory, which is what makes the
 * relocation total rather than partial.
 *
 * So the arm is constructed, not configured:
 *
 *     constructArmEnvironment()
 *       -> a fresh private directory that did not exist a moment ago
 *       -> exactly one file copied into it, from a literal allow-list
 *       -> an environment built from an allow-list, never inherited
 *       -> an audit that must pass before the caller is permitted to spawn
 *
 * Nothing here spawns a model. `mayLaunchModel` is the whole interface between
 * this module and anything that costs money (§24).
 */

import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const M193A_ISOLATION_SCHEMA_VERSION = "stage5.m193a.arm-environment.v1";

/**
 * The complete list of things allowed to exist in an arm's configuration
 * directory at construction time. It is a list of one.
 *
 * Credentials are the only host state an untreated baseline arm needs: without
 * them the CLI cannot authenticate, and with anything else it is no longer the
 * baseline condition. Everything Claude Code otherwise reads from this
 * directory — memory, settings, plugins, commands, MCP registrations — is
 * experimental injection for the purposes of this acquisition, whether or not
 * it was put there for this experiment.
 */
export const BASELINE_CONFIG_ALLOWLIST: readonly string[] = Object.freeze([".credentials.json"]);

/**
 * The one file the constructor WRITES rather than copies, and the reason it has
 * to exist.
 *
 * M193's manifest states that an empty `--mcp-config` with `--strict-mcp-config`
 * "guarantees no MCP server, VTRACE's included, can reach the agent". M193A
 * measured that claim and it is true only of *file-based* registrations. The
 * claude.ai account connectors do not come from any file on this host: they
 * arrive with the authenticated account, so they follow `.credentials.json`
 * into the private directory. On this host `claude mcp list` in a freshly
 * constructed arm resolved three of them — Zoom, Slack and Google Drive — with
 * `--strict-mcp-config` and an empty config supplied, and only
 * `disableClaudeAiConnectors` reduced that to zero.
 *
 * Writing this file is isolation, not treatment. It adds no instruction, no
 * tool and no context; it removes a tool surface the untreated baseline
 * condition never described. It is written by the constructor rather than
 * copied so it cannot inherit anything, and the audit requires it to be exactly
 * this object and nothing more.
 */
export const BASELINE_ISOLATION_SETTINGS: Readonly<Record<string, unknown>> = Object.freeze({
  disableClaudeAiConnectors: true,
});

export const CONSTRUCTED_CONFIG_FILES: readonly string[] = Object.freeze(["settings.json"]);

/**
 * Files whose presence means the directory is not a baseline configuration.
 * Listed explicitly so the audit reports *what* it found rather than only that
 * something was wrong.
 */
export const CONTAMINATING_CONFIG_ENTRIES: readonly string[] = Object.freeze([
  "CLAUDE.md",
  "AGENTS.md",
  "settings.local.json",
  "plugins",
  "commands",
  "agents",
  "skills",
  "hooks",
  "output-styles",
  "mcp.json",
]);

/** Environment keys that may cross into an arm. Anything else is dropped. */
export const ENV_ALLOWLIST: readonly string[] = Object.freeze([
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "LANG",
  "LC_ALL",
  "TERM",
  "TMPDIR",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
]);

/**
 * Environment prefixes that must not survive into an arm.
 *
 * `ANTHROPIC_` is included even though it is not a VTRACE concept: an inherited
 * `ANTHROPIC_API_KEY` or base-URL override would silently change which service
 * the pinned model is bought from, and the manifest pins the provider path
 * through the CLI's own credentials.
 */
export const FORBIDDEN_ENV_PREFIXES: readonly string[] = Object.freeze(["VTRACE", "VEXP", "ANTHROPIC", "CLAUDE_"]);

export interface IsolationFinding {
  id: string;
  what: string;
  evidence: string;
}

export interface IsolationAudit {
  configDirExists: boolean;
  filesPresent: string[];
  unexpectedFiles: string[];
  contaminatingEntries: string[];
  forbiddenEnvKeys: string[];
  configDirRedirected: boolean;
  strictMcpConfig: boolean;
  effectiveMcpServerCount: number;
  findings: IsolationFinding[];
  clean: boolean;
}

export interface ArmEnvironmentRequest {
  armId: string;
  instanceId: string;
  /** The per-arm scratch root. The configuration directory is created beneath it. */
  armRootDir: string;
  /** Where this host really keeps credentials. Read from; never written to. */
  hostConfigDir: string;
  /** The declared execution-adapter settings file, passed explicitly via --settings. */
  adapterSettingsPath?: string | null;
  /** The environment the launcher happens to be running in. Deliberately an
   *  input rather than a global read, so a test can hand it a contaminated one. */
  parentEnv: Record<string, string | undefined>;
  /** Injected for determinism in tests. */
  nonce: string;
}

export interface ArmEnvironment {
  schemaVersion: string;
  armId: string;
  instanceId: string;
  configDir: string;
  /** True when this directory did not exist before the constructor made it. */
  configDirFreshlyCreated: boolean;
  allowedFilesCopied: string[];
  /** Written by the constructor, never inherited. See BASELINE_ISOLATION_SETTINGS. */
  constructedFiles: string[];
  /**
   * sha256 over `name:size` pairs. Deliberately not over file CONTENT: the one
   * file in here is a credential (§23).
   */
  baselineContentsHash: string;
  env: Record<string, string>;
  argv: string[];
  audit: IsolationAudit;
  status: "TREATMENT_ISOLATION_CONSTRUCTED" | "TREATMENT_ISOLATION_FAILED";
  /** §24 — the single gate. A launcher that ignores this is not M194. */
  mayLaunchModel: boolean;
  errors: string[];
}

function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

/** Recursive listing, relative and sorted, so the audit is order-stable. */
function listRelative(dir: string, prefix = ""): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    const abs = join(dir, name);
    const rel = prefix ? `${prefix}/${name}` : name;
    let st;
    try {
      st = statSync(abs);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      out.push(`${rel}/`);
      out.push(...listRelative(abs, rel));
    } else {
      out.push(rel);
    }
  }
  return out;
}

/**
 * The audit §24 requires: run against a *constructed* directory and environment,
 * immediately before a launch would happen.
 *
 * `effectiveMcpServerCount` is supplied by the caller rather than discovered
 * here, because discovering it means asking the CLI, and asking the CLI is a
 * process spawn. The launcher performs that spawn (`claude mcp list`, which
 * terminates before any provider request) and passes the count in.
 */
export function auditArmEnvironment(
  configDir: string,
  env: Record<string, string>,
  argv: string[],
  effectiveMcpServerCount: number,
): IsolationAudit {
  const findings: IsolationFinding[] = [];
  const exists = existsSync(configDir);
  const files = exists ? listRelative(configDir) : [];

  // The CLI writes its own .claude.json into the private directory on first
  // use. That file is the PROOF of relocation, not a contaminant, so it is
  // tolerated by name — but only by name, and only there.
  const tolerated = new Set([
    ...BASELINE_CONFIG_ALLOWLIST,
    ...CONSTRUCTED_CONFIG_FILES,
    ".claude.json",
    // The CLI's own bookkeeping, written into the private directory on first
    // use. Their presence THERE rather than at $HOME is the proof of relocation.
    "mcp-needs-auth-cache.json",
    "backups/",
    "statsig/",
    "shell-snapshots/",
  ]);
  const unexpected = files.filter((f) => !tolerated.has(f) && !f.startsWith("backups/") && !f.startsWith("statsig/") && !f.startsWith("shell-snapshots/"));
  const contaminating = files.filter((f) => CONTAMINATING_CONFIG_ENTRIES.includes(f.replace(/\/$/, "")));

  if (!exists) findings.push({ id: "I1_no_config_dir", what: "the private configuration directory does not exist", evidence: configDir });
  if (unexpected.length) {
    findings.push({ id: "I2_unexpected_config_files", what: "files outside the baseline allow-list", evidence: unexpected.join(", ") });
  }
  if (contaminating.length) {
    findings.push({ id: "I3_experimental_config", what: "experimental configuration in the arm's own directory", evidence: contaminating.join(", ") });
  }

  // A settings.json is permitted only when it is EXACTLY the isolation object.
  // Anything else — a copied host file, an added hook, an extra key — is the
  // contamination this whole module exists to prevent.
  const settingsPath = join(configDir, "settings.json");
  if (existsSync(settingsPath)) {
    let parsed: unknown = null;
    let readable = true;
    try {
      parsed = JSON.parse(readFileSync(settingsPath, "utf8"));
    } catch {
      readable = false;
    }
    const expected = JSON.stringify(BASELINE_ISOLATION_SETTINGS, Object.keys(BASELINE_ISOLATION_SETTINGS).sort());
    const actual = readable && parsed && typeof parsed === "object"
      ? JSON.stringify(parsed, Object.keys(parsed as object).sort())
      : null;
    if (actual !== expected) {
      findings.push({
        id: "I8_settings_not_baseline",
        what: "settings.json is not exactly the constructed isolation settings",
        evidence: readable ? `keys=${parsed && typeof parsed === "object" ? Object.keys(parsed as object).sort().join(",") : "<none>"}` : "unparseable",
      });
    }
  } else {
    findings.push({
      id: "I9_isolation_settings_absent",
      what: "the isolation settings are missing, so the account's claude.ai connectors would reach the agent",
      evidence: settingsPath,
    });
  }

  const forbidden = Object.keys(env).filter(
    (k) => k !== "CLAUDE_CONFIG_DIR" && FORBIDDEN_ENV_PREFIXES.some((p) => k.startsWith(p)),
  );
  if (forbidden.length) {
    findings.push({ id: "I4_forbidden_env", what: "environment keys that could redirect or instruct the agent", evidence: forbidden.join(", ") });
  }

  const redirected = env.CLAUDE_CONFIG_DIR === configDir;
  if (!redirected) {
    findings.push({
      id: "I5_config_not_redirected",
      what: "CLAUDE_CONFIG_DIR does not point at the private directory, so the host configuration would be read",
      evidence: `CLAUDE_CONFIG_DIR=${env.CLAUDE_CONFIG_DIR ?? "<unset>"}`,
    });
  }

  const strict = argv.includes("--strict-mcp-config");
  if (!strict) {
    findings.push({
      id: "I6_mcp_not_strict",
      what: "without --strict-mcp-config the CLI still consults user- and project-level MCP registrations",
      evidence: argv.join(" "),
    });
  }
  if (effectiveMcpServerCount !== 0) {
    findings.push({
      id: "I7_mcp_servers_reachable",
      what: "the constructed environment still resolves MCP servers",
      evidence: `${effectiveMcpServerCount} server(s)`,
    });
  }

  return {
    configDirExists: exists,
    filesPresent: files,
    unexpectedFiles: unexpected,
    contaminatingEntries: contaminating,
    forbiddenEnvKeys: forbidden,
    configDirRedirected: redirected,
    strictMcpConfig: strict,
    effectiveMcpServerCount,
    findings,
    clean: findings.length === 0,
  };
}

/**
 * Build the environment an arm runs in from an allow-list.
 *
 * Inheritance is the defect. `{...process.env}` with a few keys deleted is a
 * denylist, and a denylist is only ever as complete as the last person to think
 * about it; this programme has been surprised by ambient state four times.
 */
export function buildArmEnv(parentEnv: Record<string, string | undefined>, configDir: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of ENV_ALLOWLIST) {
    const v = parentEnv[key];
    if (typeof v === "string" && v.length > 0) env[key] = v;
  }
  env.CLAUDE_CONFIG_DIR = configDir;
  return env;
}

/**
 * Create the arm's private configuration and report whether a model may be
 * launched into it.
 *
 * Fails closed at every step. A missing credential file, a directory that
 * already existed, a file the allow-list does not name, or a surviving
 * `VTRACE_*` key all produce `TREATMENT_ISOLATION_FAILED` and
 * `mayLaunchModel: false` — never a launch with the contamination recorded
 * alongside it (§24).
 */
export function constructArmEnvironment(req: ArmEnvironmentRequest): ArmEnvironment {
  const errors: string[] = [];
  const configDir = join(req.armRootDir, `claude-config-${req.armId}-${req.nonce}`);

  let freshlyCreated = false;
  if (existsSync(configDir)) {
    errors.push(`configuration directory already exists, so its contents are not accounted for: ${configDir}`);
  } else {
    try {
      mkdirSync(configDir, { recursive: true, mode: 0o700 });
      chmodSync(configDir, 0o700);
      freshlyCreated = true;
    } catch (e) {
      errors.push(`could not create configuration directory: ${String(e)}`);
    }
  }

  const copied: string[] = [];
  if (freshlyCreated) {
    for (const name of BASELINE_CONFIG_ALLOWLIST) {
      const src = join(req.hostConfigDir, name);
      if (!existsSync(src)) {
        errors.push(`baseline configuration is incomplete: ${src} is absent`);
        continue;
      }
      try {
        copyFileSync(src, join(configDir, name));
        chmodSync(join(configDir, name), 0o600);
        copied.push(name);
      } catch (e) {
        errors.push(`could not copy ${name}: ${String(e)}`);
      }
    }
  }

  const constructed: string[] = [];
  if (freshlyCreated) {
    try {
      writeFileSync(join(configDir, "settings.json"), `${JSON.stringify(BASELINE_ISOLATION_SETTINGS, null, 2)}\n`);
      chmodSync(join(configDir, "settings.json"), 0o600);
      constructed.push("settings.json");
    } catch (e) {
      errors.push(`could not write the isolation settings: ${String(e)}`);
    }
  }

  const env = buildArmEnv(req.parentEnv, configDir);
  const argv = [
    "--strict-mcp-config",
    "--mcp-config",
    '{"mcpServers":{}}',
    ...(req.adapterSettingsPath ? ["--settings", req.adapterSettingsPath] : []),
  ];

  // The MCP count is 0 by construction here; the launcher replaces this with a
  // measured value from `claude mcp list` before spending anything.
  const audit = auditArmEnvironment(configDir, env, argv, 0);

  const manifestLines = (existsSync(configDir) ? listRelative(configDir) : []).map((rel) => {
    const abs = join(configDir, rel.replace(/\/$/, ""));
    let size = 0;
    try {
      size = statSync(abs).size;
    } catch {
      size = -1;
    }
    return `${rel}:${size}`;
  });

  const ok =
    errors.length === 0 &&
    audit.clean &&
    freshlyCreated &&
    copied.length === BASELINE_CONFIG_ALLOWLIST.length &&
    constructed.length === CONSTRUCTED_CONFIG_FILES.length;
  return {
    schemaVersion: M193A_ISOLATION_SCHEMA_VERSION,
    armId: req.armId,
    instanceId: req.instanceId,
    configDir,
    configDirFreshlyCreated: freshlyCreated,
    allowedFilesCopied: copied,
    constructedFiles: constructed,
    baselineContentsHash: sha256(manifestLines.join("\n")),
    env,
    argv,
    audit,
    status: ok ? "TREATMENT_ISOLATION_CONSTRUCTED" : "TREATMENT_ISOLATION_FAILED",
    mayLaunchModel: ok,
    errors,
  };
}

/**
 * The non-secret record §27 requires: enough to reconstruct what was launched,
 * and nothing that could authenticate as the user.
 */
export interface ArmLaunchRecord {
  armId: string;
  instanceId: string;
  cliVersion: string;
  cliBinary: string;
  model: string;
  configDir: string;
  configDirFreshlyCreated: boolean;
  baselineContentsHash: string;
  allowedFilesCopied: string[];
  strictMcpConfig: boolean;
  claudeAiConnectorsDisabled: boolean;
  effectiveMcpServerCount: number;
  experimentalHooksPresent: boolean;
  experimentalInstructionFilePresent: boolean;
  allowedTools: string[];
  envKeys: string[];
  treatmentIsolationStatus: ArmEnvironment["status"];
}

export function launchRecord(
  arm: ArmEnvironment,
  meta: { cliVersion: string; cliBinary: string; model: string; allowedTools: string[]; effectiveMcpServerCount: number },
): ArmLaunchRecord {
  return {
    armId: arm.armId,
    instanceId: arm.instanceId,
    cliVersion: meta.cliVersion,
    cliBinary: meta.cliBinary,
    model: meta.model,
    configDir: arm.configDir,
    configDirFreshlyCreated: arm.configDirFreshlyCreated,
    baselineContentsHash: arm.baselineContentsHash,
    allowedFilesCopied: arm.allowedFilesCopied,
    strictMcpConfig: arm.audit.strictMcpConfig,
    claudeAiConnectorsDisabled: arm.constructedFiles.includes("settings.json"),
    effectiveMcpServerCount: meta.effectiveMcpServerCount,
    experimentalHooksPresent:
      arm.audit.contaminatingEntries.some((f) => f.startsWith("settings") || f === "hooks") ||
      arm.audit.findings.some((f) => f.id === "I8_settings_not_baseline"),
    experimentalInstructionFilePresent: arm.audit.contaminatingEntries.includes("CLAUDE.md"),
    allowedTools: meta.allowedTools,
    // Keys only. A value could be a token.
    envKeys: Object.keys(arm.env).sort(),
    treatmentIsolationStatus: arm.status,
  };
}
