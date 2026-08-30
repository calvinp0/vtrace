/**
 * M193A §22–§28 — treatment isolation, measured on this host.
 *
 * M193's audit asserted that `--strict-mcp-config` closes the MCP route and
 * flagged one file, `~/.claude/CLAUDE.md`, as the blocking exposure. Neither
 * claim was measured against a running CLI. This script measures both, and it
 * does so without a provider request: `claude mcp list` and `claude --version`
 * resolve configuration and exit (§28).
 *
 *   bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m193a_isolation_evidence.ts
 */

import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { auditArmEnvironment, constructArmEnvironment, launchRecord } from "./m193aArmEnvironment";

const RESULTS = join(import.meta.dir, "results");
const OUT = join(RESULTS, "stage5_m193a_isolation_evidence.json");
const HOME = process.env.HOME ?? "/home/calvin";
const HOST_CONFIG = join(HOME, ".claude");
const CLI = join(HOME, ".local", "bin", "claude");
const PINNED_CLI_VERSION = "2.1.251";
const PINNED_MODEL = "claude-opus-4-5-20251101";
const ALLOWED_TOOLS = ["Edit", "Write", "Bash", "Read", "Glob", "Grep", "TodoWrite"];

function run(cmd: string, args: string[], env: Record<string, string>, timeoutMs = 120_000): { ok: boolean; out: string } {
  try {
    return {
      ok: true,
      out: execFileSync(cmd, args, { env, timeout: timeoutMs, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }),
    };
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; message?: string };
    return { ok: false, out: `${err.stdout ?? ""}${err.stderr ?? ""}${err.message ?? ""}` };
  }
}

/**
 * How many MCP servers a configuration resolves.
 *
 * Read from `claude mcp list`, which is the CLI's own answer rather than our
 * reconstruction of its precedence rules. The header line and the trailing
 * blank lines are dropped; every remaining `name: …` line is one server.
 */
function mcpServerCount(out: string): { count: number; names: string[] } {
  if (/No MCP servers configured/i.test(out)) return { count: 0, names: [] };
  const names = out
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => /^[^:\s][^:]*:\s/.test(l) && !/^Checking MCP server health/i.test(l))
    .map((l) => l.slice(0, l.indexOf(":")).trim());
  return { count: names.length, names };
}

/** What the host configuration would hand an arm, read statically. */
function hostConfigExposure(): Record<string, unknown> {
  const entries = existsSync(HOST_CONFIG) ? readdirSync(HOST_CONFIG).sort() : [];
  const globalConfig = join(HOME, ".claude.json");
  let registeredMcp: string[] = [];
  try {
    registeredMcp = Object.keys((JSON.parse(readFileSync(globalConfig, "utf8")) as { mcpServers?: object }).mcpServers ?? {});
  } catch {
    /* absent or unreadable */
  }
  let settingsKeys: string[] = [];
  try {
    settingsKeys = Object.keys(JSON.parse(readFileSync(join(HOST_CONFIG, "settings.json"), "utf8")) as object).sort();
  } catch {
    /* absent */
  }
  const memory = join(HOST_CONFIG, "CLAUDE.md");
  return {
    configDir: HOST_CONFIG,
    entryCount: entries.length,
    userMemoryPresent: existsSync(memory),
    userMemoryBytes: existsSync(memory) ? statSync(memory).size : 0,
    settingsKeys,
    globalConfigPath: globalConfig,
    registeredMcpServers: registeredMcp,
    pluginsDirPresent: existsSync(join(HOST_CONFIG, "plugins")),
    commandsDirPresent: existsSync(join(HOST_CONFIG, "commands")),
  };
}

const cliVersionRaw = run(CLI, ["--version"], { PATH: process.env.PATH ?? "" }).out.trim();
const cliVersion = (/(\d+\.\d+\.\d+)/.exec(cliVersionRaw) ?? [])[1] ?? "unknown";

// ── arm A: the inherited configuration, as an unguarded launch would see it ──
const inheritedEnv: Record<string, string> = {};
for (const [k, v] of Object.entries(process.env)) if (typeof v === "string") inheritedEnv[k] = v;
delete inheritedEnv.CLAUDE_CONFIG_DIR;
const inherited = run(CLI, ["mcp", "list"], inheritedEnv);
const inheritedMcp = mcpServerCount(inherited.out);

// ── arm A2: a private directory holding ONLY the credential ──────────
//
// M193's manifest treats `--strict-mcp-config` plus an empty config as a
// guarantee. This arm is what that guarantee is actually worth: the account's
// claude.ai connectors follow the credential rather than any file, so a
// "credentials only" private directory is NOT an untreated tool surface.
const credsOnlyRoot = mkdtempSync(join(tmpdir(), "m193a-credsonly-"));
const credsOnlyDir = join(credsOnlyRoot, "cfg");
mkdirSync(credsOnlyDir, { recursive: true, mode: 0o700 });
let credsOnly = { count: -1, names: [] as string[] };
let credsOnlyStrict = { count: -1, names: [] as string[] };
if (existsSync(join(HOST_CONFIG, ".credentials.json"))) {
  copyFileSync(join(HOST_CONFIG, ".credentials.json"), join(credsOnlyDir, ".credentials.json"));
  chmodSync(join(credsOnlyDir, ".credentials.json"), 0o600);
  const credsEnv = { PATH: process.env.PATH ?? "", HOME: HOME, CLAUDE_CONFIG_DIR: credsOnlyDir };
  credsOnly = mcpServerCount(run(CLI, ["mcp", "list"], credsEnv).out);
  // `--mcp-config` is variadic, so the flags must precede the subcommand in an
  // order where a following option terminates the list.
  const emptyCfg = join(credsOnlyDir, "empty-mcp.json");
  writeFileSync(emptyCfg, '{"mcpServers":{}}\n');
  credsOnlyStrict = mcpServerCount(
    run(CLI, ["--mcp-config", emptyCfg, "--strict-mcp-config", "mcp", "list"], credsEnv).out,
  );
}

// ── arm B: the constructed private configuration ─────────────────────
const armRoot = mkdtempSync(join(tmpdir(), "m193a-arms-"));
const arm = constructArmEnvironment({
  armId: "isolation-evidence",
  instanceId: "n/a",
  armRootDir: armRoot,
  hostConfigDir: HOST_CONFIG,
  adapterSettingsPath: null,
  parentEnv: process.env,
  nonce: "evidence",
});
const privateRun = run(CLI, ["mcp", "list"], arm.env);
const privateMcp = mcpServerCount(privateRun.out);
const preLaunchAudit = auditArmEnvironment(arm.configDir, arm.env, arm.argv, privateMcp.count);
const record = launchRecord(arm, {
  cliVersion,
  cliBinary: CLI,
  model: PINNED_MODEL,
  allowedTools: ALLOWED_TOOLS,
  effectiveMcpServerCount: privateMcp.count,
});
const privateEntriesAfterCliUse = existsSync(arm.configDir) ? readdirSync(arm.configDir).sort() : [];
rmSync(armRoot, { recursive: true, force: true });
rmSync(credsOnlyRoot, { recursive: true, force: true });

const gates = {
  G8_private_config_constructed_automatically: arm.configDirFreshlyCreated && arm.allowedFilesCopied.length === 1,
  G9_contaminated_parent_cannot_leak:
    privateMcp.count === 0 &&
    !arm.audit.filesPresent.includes("plugins/") &&
    arm.env.CLAUDE_CONFIG_DIR === arm.configDir &&
    arm.audit.forbiddenEnvKeys.length === 0 &&
    !arm.audit.filesPresent.includes("CLAUDE.md"),
  G10_isolation_failure_blocks_launch: preLaunchAudit.clean === arm.mayLaunchModel,
  cli_version_matches_pin: cliVersion === PINNED_CLI_VERSION,
};

const doc = {
  schemaVersion: "stage5.m193a.isolation-evidence.v1",
  milestone: "M193A",
  liveModelCalls: 0,
  liveModelSpendUsd: 0,
  method:
    "`claude mcp list` and `claude --version` resolve configuration and exit without a provider request, so the CLI's own answer is used rather than a reconstruction of its precedence rules (§28).",
  cli: { binary: CLI, versionRaw: cliVersionRaw, version: cliVersion, pinnedVersion: PINNED_CLI_VERSION },
  hostConfigExposure: hostConfigExposure(),
  inheritedConfiguration: {
    description: "what an arm launched without a private configuration directory resolves",
    mcpServerCount: inheritedMcp.count,
    mcpServerNames: inheritedMcp.names,
    commandSucceeded: inherited.ok,
  },
  credentialsOnlyConfiguration: {
    description:
      "M193's stated precondition, implemented literally: a private directory containing credentials only. This is the arm that shows the precondition was insufficient.",
    mcpServerCount: credsOnly.count,
    mcpServerNames: credsOnly.names,
    withStrictMcpConfig: {
      description:
        "the same directory with an empty --mcp-config and --strict-mcp-config, which M193's manifest describes as a guarantee that no MCP server can reach the agent",
      mcpServerCount: credsOnlyStrict.count,
      mcpServerNames: credsOnlyStrict.names,
    },
    finding:
      credsOnlyStrict.count > 0
        ? "FALSIFIED: --strict-mcp-config closes file-based registrations only. The claude.ai account connectors arrive with the authenticated account and survive it."
        : "no connectors resolved on this host at this moment",
  },
  constructedArm: {
    configDir: arm.configDir,
    configDirFreshlyCreated: arm.configDirFreshlyCreated,
    allowedFilesCopied: arm.allowedFilesCopied,
    filesPresentAtConstruction: arm.audit.filesPresent,
    filesPresentAfterCliUse: privateEntriesAfterCliUse,
    mcpServerCount: privateMcp.count,
    mcpServerNames: privateMcp.names,
    envKeys: Object.keys(arm.env).sort(),
    argv: arm.argv,
    status: arm.status,
    mayLaunchModel: arm.mayLaunchModel,
    baselineContentsHash: arm.baselineContentsHash,
  },
  preLaunchAudit,
  launchRecord: record,
  gates,
  verdict:
    Object.values(gates).every(Boolean) && arm.status === "TREATMENT_ISOLATION_CONSTRUCTED"
      ? "TREATMENT_ISOLATION_GUARANTEED_BY_CONSTRUCTION"
      : "TREATMENT_ISOLATION_NOT_GUARANTEED",
  notes: [
    "The CLI writes its own .claude.json into the private directory on first use. That file appearing there rather than at $HOME is what makes the relocation total; it is tolerated by name and by location only.",
    "The inherited-configuration arm is reported as a measurement of this host at this moment, not as a stable property. Its value is that it is not zero.",
    "No credential bytes are hashed or recorded. The baseline contents hash covers file names and sizes only (§23).",
  ],
};

writeFileSync(OUT, `${JSON.stringify(doc, null, 2)}\n`);
console.log(`wrote ${OUT}`);
console.log(`verdict: ${doc.verdict}`);
console.log(`  inherited MCP servers:            ${inheritedMcp.count} (${inheritedMcp.names.join(", ") || "none"})`);
console.log(`  credentials-only MCP servers:    ${credsOnly.count} (${credsOnly.names.join(", ") || "none"})`);
console.log(`  credentials-only + strict flags: ${credsOnlyStrict.count} (${credsOnlyStrict.names.join(", ") || "none"})`);
console.log(`  constructed arm MCP servers:     ${privateMcp.count}`);
console.log(`  CLI ${cliVersion} (pinned ${PINNED_CLI_VERSION})`);
for (const [k, v] of Object.entries(gates)) console.log(`  ${v ? "PASS" : "FAIL"}  ${k}`);
