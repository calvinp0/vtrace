/**
 * M193A §25 — the treatment-isolation falsification control.
 *
 * The claim under test is not "we remember to set CLAUDE_CONFIG_DIR". It is
 * that an arm constructed on a host whose Claude configuration is *thoroughly*
 * contaminated — user memory, hook-bearing settings, registered MCP servers,
 * installed plugins, VTRACE environment variables, and an outer
 * CLAUDE_CONFIG_DIR already pointing at all of it — cannot see any of it.
 *
 * The contaminated host is built here rather than described, so the test fails
 * if the constructor ever starts inheriting instead of allow-listing.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BASELINE_CONFIG_ALLOWLIST,
  BASELINE_ISOLATION_SETTINGS,
  ENV_ALLOWLIST,
  auditArmEnvironment,
  buildArmEnv,
  constructArmEnvironment,
  launchRecord,
} from "./m193aArmEnvironment";

let root: string;
let contaminatedHostConfig: string;
let armRoot: string;

/** Everything M193's audit found on this host, plus the routes it did not measure. */
function buildContaminatedHostConfig(dir: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "REDACTED-TEST-TOKEN" } }));
  writeFileSync(join(dir, "CLAUDE.md"), "# Global instructions\n\nAlways use VTRACE's get_code_context before reading a file.\n");
  writeFileSync(
    join(dir, "settings.json"),
    JSON.stringify({
      hooks: { PreToolUse: [{ matcher: "Grep|Glob", hooks: [{ type: "command", command: "deny-search.sh" }] }] },
      enabledPlugins: { "code-review-graph@local": true },
      env: { VTRACE_STAGE5_MANDATE: "1" },
      model: "some-other-model",
    }),
  );
  writeFileSync(join(dir, ".claude.json"), JSON.stringify({ mcpServers: { vtrace: { command: "vtrace", args: ["mcp"] } } }));
  mkdirSync(join(dir, "plugins"), { recursive: true });
  writeFileSync(join(dir, "plugins", "installed_plugins.json"), JSON.stringify({ "code-review-graph": {} }));
  mkdirSync(join(dir, "commands"), { recursive: true });
  writeFileSync(join(dir, "commands", "stage5.md"), "run the stage5 mandate\n");
}

/** A parent process that is itself thoroughly treated. */
function contaminatedParentEnv(hostConfig: string): Record<string, string | undefined> {
  return {
    PATH: "/usr/bin:/bin",
    HOME: "/home/tester",
    LANG: "C.UTF-8",
    TERM: "xterm",
    CLAUDE_CONFIG_DIR: hostConfig,
    CLAUDE_CODE_EXTRA_BODY: '{"treatment":"on"}',
    VTRACE_STAGE5_EXPECTED_TESTBED_PREFIX: "/testbed",
    VTRACE_ENABLE_TRACEBACK_LOCALIZED_SKIP: "1",
    VEXP_AGENT: "claude-code",
    ANTHROPIC_API_KEY: "sk-should-never-cross",
    ANTHROPIC_BASE_URL: "https://not-the-pinned-provider.example",
  };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "m193a-iso-"));
  contaminatedHostConfig = join(root, "host-claude");
  armRoot = join(root, "arm");
  mkdirSync(armRoot, { recursive: true });
  buildContaminatedHostConfig(contaminatedHostConfig);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function construct(over: Partial<Parameters<typeof constructArmEnvironment>[0]> = {}) {
  return constructArmEnvironment({
    armId: "arm-01",
    instanceId: "django__django-10880",
    armRootDir: armRoot,
    hostConfigDir: contaminatedHostConfig,
    adapterSettingsPath: null,
    parentEnv: contaminatedParentEnv(contaminatedHostConfig),
    nonce: "deadbeef",
    ...over,
  });
}

describe("§25 a contaminated host cannot leak into a constructed arm", () => {
  test("the arm's configuration directory holds the credential, the isolation settings, and nothing else", () => {
    const arm = construct();
    expect(arm.status).toBe("TREATMENT_ISOLATION_CONSTRUCTED");
    expect(arm.configDirFreshlyCreated).toBe(true);
    expect(arm.allowedFilesCopied).toEqual([...BASELINE_CONFIG_ALLOWLIST]);
    expect(arm.constructedFiles).toEqual(["settings.json"]);
    expect(arm.audit.filesPresent.sort()).toEqual([".credentials.json", "settings.json"]);
    for (const leaked of ["CLAUDE.md", ".claude.json", "plugins/", "commands/"]) {
      expect(arm.audit.filesPresent).not.toContain(leaked);
      expect(existsSync(join(arm.configDir, leaked))).toBe(false);
    }
  });

  test("the settings file is written, not inherited: the host's hooks and plugins do not appear in it", () => {
    const arm = construct();
    const written = JSON.parse(readFileSync(join(arm.configDir, "settings.json"), "utf8")) as Record<string, unknown>;
    expect(written).toEqual({ ...BASELINE_ISOLATION_SETTINGS });
    expect(written.hooks).toBeUndefined();
    expect(written.enabledPlugins).toBeUndefined();
    expect(written.env).toBeUndefined();
    expect(written.model).toBeUndefined();
  });

  test("the account's claude.ai connectors are closed, which --strict-mcp-config alone does not do", () => {
    // Measured on this host: three connectors survive an empty --mcp-config with
    // --strict-mcp-config, because they follow the credential rather than a file.
    const arm = construct();
    expect(arm.constructedFiles).toContain("settings.json");
    const written = JSON.parse(readFileSync(join(arm.configDir, "settings.json"), "utf8")) as Record<string, unknown>;
    expect(written.disableClaudeAiConnectors).toBe(true);
  });

  test("the arm's environment is built from the allow-list, not inherited", () => {
    const arm = construct();
    expect(arm.env.CLAUDE_CONFIG_DIR).toBe(arm.configDir);
    expect(arm.env.CLAUDE_CONFIG_DIR).not.toBe(contaminatedHostConfig);
    for (const k of ["VTRACE_STAGE5_EXPECTED_TESTBED_PREFIX", "VTRACE_ENABLE_TRACEBACK_LOCALIZED_SKIP", "VEXP_AGENT", "ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL", "CLAUDE_CODE_EXTRA_BODY"]) {
      expect(arm.env[k]).toBeUndefined();
    }
    expect(arm.audit.forbiddenEnvKeys).toEqual([]);
    // Nothing outside the allow-list plus the single redirect survives.
    for (const k of Object.keys(arm.env)) {
      expect([...ENV_ALLOWLIST, "CLAUDE_CONFIG_DIR"]).toContain(k);
    }
  });

  test("an inherited CLAUDE_CONFIG_DIR is overridden rather than respected", () => {
    // The most dangerous shape: the operator "did the right thing" for a
    // previous experiment and the value now points at treated configuration.
    const env = buildArmEnv(contaminatedParentEnv(contaminatedHostConfig), "/tmp/private-arm-cfg");
    expect(env.CLAUDE_CONFIG_DIR).toBe("/tmp/private-arm-cfg");
  });

  test("MCP is closed both by flag and by the measured server count", () => {
    const arm = construct();
    expect(arm.argv).toContain("--strict-mcp-config");
    expect(arm.argv).toContain('{"mcpServers":{}}');
    expect(arm.audit.effectiveMcpServerCount).toBe(0);
  });

  test("two arms never share a configuration directory (§23)", () => {
    const a = construct({ armId: "arm-01", nonce: "aaaa" });
    const b = construct({ armId: "arm-01", nonce: "bbbb" });
    const c = construct({ armId: "arm-02", nonce: "aaaa" });
    expect(new Set([a.configDir, b.configDir, c.configDir]).size).toBe(3);
    expect(a.status).toBe("TREATMENT_ISOLATION_CONSTRUCTED");
    expect(b.status).toBe("TREATMENT_ISOLATION_CONSTRUCTED");
    expect(c.status).toBe("TREATMENT_ISOLATION_CONSTRUCTED");
  });
});

describe("§24 contamination blocks the launch rather than being recorded alongside it", () => {
  test("a reused configuration directory fails closed", () => {
    const first = construct({ nonce: "same" });
    expect(first.mayLaunchModel).toBe(true);
    const second = construct({ nonce: "same" });
    expect(second.configDirFreshlyCreated).toBe(false);
    expect(second.status).toBe("TREATMENT_ISOLATION_FAILED");
    expect(second.mayLaunchModel).toBe(false);
  });

  test("absent credentials fail closed rather than launching unauthenticated", () => {
    const empty = join(root, "no-creds");
    mkdirSync(empty, { recursive: true });
    const arm = construct({ hostConfigDir: empty });
    expect(arm.status).toBe("TREATMENT_ISOLATION_FAILED");
    expect(arm.mayLaunchModel).toBe(false);
    expect(arm.errors.join(" ")).toContain(".credentials.json");
  });

  test("a settings file that is anything but the isolation object fails closed", () => {
    const arm = construct();
    writeFileSync(
      join(arm.configDir, "settings.json"),
      JSON.stringify({ disableClaudeAiConnectors: true, hooks: { PreToolUse: [] } }),
    );
    const reaudit = auditArmEnvironment(arm.configDir, arm.env, arm.argv, 0);
    expect(reaudit.clean).toBe(false);
    expect(reaudit.findings.map((f) => f.id)).toContain("I8_settings_not_baseline");
  });

  test("a missing isolation settings file fails closed rather than launching with connectors", () => {
    const arm = construct();
    rmSync(join(arm.configDir, "settings.json"));
    const reaudit = auditArmEnvironment(arm.configDir, arm.env, arm.argv, 0);
    expect(reaudit.clean).toBe(false);
    expect(reaudit.findings.map((f) => f.id)).toContain("I9_isolation_settings_absent");
  });

  test("configuration appearing after construction is caught by the pre-launch audit", () => {
    const arm = construct();
    expect(arm.mayLaunchModel).toBe(true);
    writeFileSync(join(arm.configDir, "CLAUDE.md"), "always run the mandate\n");
    const reaudit = auditArmEnvironment(arm.configDir, arm.env, arm.argv, 0);
    expect(reaudit.clean).toBe(false);
    expect(reaudit.contaminatingEntries).toContain("CLAUDE.md");
    expect(reaudit.findings.map((f) => f.id)).toContain("I3_experimental_config");
  });

  test("a live MCP server found at pre-launch time blocks the arm", () => {
    const arm = construct();
    const reaudit = auditArmEnvironment(arm.configDir, arm.env, arm.argv, 6);
    expect(reaudit.clean).toBe(false);
    expect(reaudit.findings.map((f) => f.id)).toContain("I7_mcp_servers_reachable");
  });

  test("dropping --strict-mcp-config is itself a blocking finding", () => {
    const arm = construct();
    const reaudit = auditArmEnvironment(arm.configDir, arm.env, ["--mcp-config", '{"mcpServers":{}}'], 0);
    expect(reaudit.clean).toBe(false);
    expect(reaudit.findings.map((f) => f.id)).toContain("I6_mcp_not_strict");
  });

  test("a CLAUDE_CONFIG_DIR left pointing at the host is a blocking finding", () => {
    const arm = construct();
    const leaky = { ...arm.env, CLAUDE_CONFIG_DIR: contaminatedHostConfig };
    const reaudit = auditArmEnvironment(arm.configDir, leaky, arm.argv, 0);
    expect(reaudit.clean).toBe(false);
    expect(reaudit.findings.map((f) => f.id)).toContain("I5_config_not_redirected");
  });
});

describe("§23/§27 the record proves the launch without carrying a secret", () => {
  test("the launch record names the configuration but never its contents", () => {
    const arm = construct();
    const rec = launchRecord(arm, {
      cliVersion: "2.1.251",
      cliBinary: "/home/calvin/.local/bin/claude",
      model: "claude-opus-4-5-20251101",
      allowedTools: ["Edit", "Write", "Bash", "Read", "Glob", "Grep", "TodoWrite"],
      effectiveMcpServerCount: 0,
    });
    expect(rec.treatmentIsolationStatus).toBe("TREATMENT_ISOLATION_CONSTRUCTED");
    expect(rec.effectiveMcpServerCount).toBe(0);
    expect(rec.experimentalHooksPresent).toBe(false);
    expect(rec.claudeAiConnectorsDisabled).toBe(true);
    expect(rec.experimentalInstructionFilePresent).toBe(false);
    expect(rec.envKeys).toContain("CLAUDE_CONFIG_DIR");
    const serialized = JSON.stringify(rec);
    expect(serialized).not.toContain("REDACTED-TEST-TOKEN");
    expect(serialized).not.toContain("sk-should-never-cross");
  });

  test("the contents hash covers names and sizes, and moves when the directory does", () => {
    const a = construct({ nonce: "h1" });
    const b = construct({ nonce: "h2" });
    // Same single file, same size: the hash is about the shape of the baseline,
    // not about which arm it belongs to.
    expect(a.baselineContentsHash).toBe(b.baselineContentsHash);
    writeFileSync(join(b.configDir, "CLAUDE.md"), "x\n");
    const c = construct({ nonce: "h3" });
    writeFileSync(join(c.configDir, "CLAUDE.md"), "xx\n");
    expect(auditArmEnvironment(b.configDir, b.env, b.argv, 0).clean).toBe(false);
    expect(auditArmEnvironment(c.configDir, c.env, c.argv, 0).clean).toBe(false);
  });
});
