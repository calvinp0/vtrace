/**
 * M220-A3 §4, §5 — prove the Claude Code harness by behaviour, record its
 * release as metadata.
 *
 * The probe runs the RESOLVED executable the cohort would spawn:
 *
 *   * the production argv shape (built by the adapter's own `buildAgentArgv`)
 *     with networking unshared (`unshare -r -n -m`, a private tmpfs over
 *     /tmp so the CLI's per-uid temp and socket directories never reach the
 *     host) and an empty private
 *     configuration directory, so there is neither a route to the provider
 *     nor a credential to present. The CLI still emits its init and result
 *     events, which is where every field the adapter depends on appears;
 *   * `auth status --json` and `--version` under the same isolation;
 *   * a whole-token scan of the executable's bytes for the stream schema the
 *     adapter parses but an offline run cannot emit (tool calls, rate-limit
 *     events, termination subtypes). JSON field names survive minification as
 *     string literals, and the token boundary is what tells
 *     `error_max_budget` from `error_max_budget_usd`.
 *
 * The probe reports `providerCalls: 0` because it cannot make one, and it
 * says so only when the network namespace was actually unshared; without it
 * the probe refuses to run the executable at all.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { M214_AGENT, M214_BUDGET, M214_MODEL, M214_NATIVE_TOOLS, canonicalize } from "./m214Preregistration";
import type { AgentRunSpec } from "./m215LaunchExecutor";
import {
  BUDGET_STOP_RESULT_SUBTYPES,
  TURN_LIMIT_RESULT_SUBTYPES,
  agentBinaryDigest,
  buildAgentArgv,
  parseAgentStream,
  resolveAgentBinary,
} from "./m216ProductionAdapters";
import {
  type HarnessCapabilityId,
  M220A3_FROZEN_HASH,
  M220A3_HARNESS_CAPABILITIES,
  M220A3_HARNESS_CONTRACT_VERSION,
} from "./m220A3Amendment";
import type { AgentHarnessGate, AgentHarnessObservation, HarnessCapabilityVerdict } from "./m220A3PairHarness";
import { CLI_AUTH_STATUS_ARGS, parseCliAuthStatus } from "./m220SubscriptionAuth";

export const M220A3_HARNESS_PROBE_VERSION = "stage5.m220-a3.harness-probe.v1" as const;
export const PROBE_MCP_SERVER = "harness_probe" as const;

/** The schema tokens a static scan must find, each tied to the capability that needs it. */
export const STATIC_SCHEMA_TOKENS: Readonly<Record<"C7_TOOL_CALL_EVENTS" | "C8_RATE_LIMIT_EVENTS", readonly string[]>> = Object.freeze({
  C7_TOOL_CALL_EVENTS: Object.freeze(["tool_use", "tool_result"]),
  C8_RATE_LIMIT_EVENTS: Object.freeze([
    "rate_limit_event", "rate_limit_info", "allowed", "allowed_warning", "rejected",
    "rateLimitType", "resetsAt", "utilization", "isUsingOverage", "overageStatus",
  ]),
});

// ── identity ────────────────────────────────────────────────────────

export interface AgentHarnessIdentity {
  readonly declaredBinary: string;
  readonly resolvedBinary: string;
  readonly versionOutput: string;
  readonly version: string;
  readonly sha256: string | null;
  readonly issues: readonly string[];
}

export function resolveAgentHarnessIdentity(declaredBinary: string = M214_AGENT.binary): AgentHarnessIdentity {
  const resolution = resolveAgentBinary(declaredBinary);
  const sha256 = resolution.issues.length === 0 ? agentBinaryDigest(resolution.binary) : null;
  const issues = [...resolution.issues];
  if (resolution.issues.length === 0 && sha256 === null) issues.push(`${resolution.binary} could not be read to compute its digest`);
  return {
    declaredBinary,
    resolvedBinary: resolution.binary,
    versionOutput: resolution.versionOutput,
    version: resolution.version,
    sha256,
    issues: Object.freeze(issues),
  };
}

// ── the isolated spawner ────────────────────────────────────────────

export interface ProbeProcessResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly error: string | null;
}

export type ProbeSpawner = (
  binary: string, args: readonly string[],
  options: { readonly env: Record<string, string>; readonly cwd: string; readonly timeoutMs: number; readonly privateRoot: string },
) => ProbeProcessResult;

/**
 * Inside the namespace: hold the probe root on /mnt, mount a fresh tmpfs over
 * /tmp (the CLI writes /tmp/claude-<uid> and /tmp/cc-socks-<uid> regardless
 * of TMPDIR), bind the probe root back at its own path, then exec. Any step
 * failing aborts before the harness runs.
 */
const PRIVATE_TMP_WRAPPER =
  'set -e; root="$1"; shift; mount --bind "$root" /mnt; mount -t tmpfs tmpfs /tmp; mkdir -p "$root"; mount --bind /mnt "$root"; exec "$@"';

/**
 * Every probe process runs with networking unshared, so a provider call is
 * impossible rather than merely unlikely, and with a private /tmp, so the
 * probe leaves nothing on the host that M218's /tmp census would have to
 * attribute.
 */
export const networkUnsharedSpawner: ProbeSpawner = (binary, args, options) => {
  const result = spawnSync("unshare", ["-r", "-n", "-m", "sh", "-c", PRIVATE_TMP_WRAPPER, "sh", options.privateRoot, binary, ...args], {
    env: options.env, cwd: options.cwd, timeout: options.timeoutMs, encoding: "utf8", maxBuffer: 16 * 1024 * 1024,
  });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    error: result.error === undefined ? null : result.error.message,
  };
};

export function networkIsolationAvailable(spawner: ProbeSpawner = networkUnsharedSpawner, scratchRoot: string = tmpdir()): boolean {
  const root = mkdtempSync(join(scratchRoot, "m220a3-isolation-check-"));
  try {
    const probe = spawner("/bin/true", [], { env: { PATH: "/usr/bin:/bin" }, cwd: "/", timeoutMs: 10_000, privateRoot: root });
    return probe.status === 0 && probe.error === null;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// ── static scan ─────────────────────────────────────────────────────

function isIdentifierByte(byte: number | undefined): boolean {
  if (byte === undefined) return false;
  return (byte >= 48 && byte <= 57) || (byte >= 65 && byte <= 90) || (byte >= 97 && byte <= 122) || byte === 95 || byte === 36;
}

/** A whole token: present with no identifier character on either side. */
export function containsWholeToken(bytes: Buffer, token: string): boolean {
  const needle = Buffer.from(token, "utf8");
  let from = 0;
  for (;;) {
    const at = bytes.indexOf(needle, from);
    if (at < 0) return false;
    if (!isIdentifierByte(bytes[at - 1]) && !isIdentifierByte(bytes[at + needle.length])) return true;
    from = at + 1;
  }
}

// ── the probe ───────────────────────────────────────────────────────

export interface HarnessCapabilityResult {
  readonly id: HarnessCapabilityId;
  readonly satisfied: boolean;
  readonly evidence: string;
}

export interface HarnessProbeReport {
  readonly schemaVersion: typeof M220A3_HARNESS_PROBE_VERSION;
  readonly contractVersion: typeof M220A3_HARNESS_CONTRACT_VERSION;
  readonly identity: AgentHarnessIdentity;
  readonly isolation: "NETWORK_UNSHARED_NO_CREDENTIAL" | "UNAVAILABLE";
  readonly capabilities: readonly HarnessCapabilityResult[];
  readonly verdict: HarnessCapabilityVerdict;
  readonly issues: readonly string[];
  readonly capabilityFingerprint: string | null;
  readonly initFieldNames: readonly string[];
  readonly probeReportedCostUsd: number | null;
  readonly providerCalls: 0;
  readonly probedAt: string;
}

export interface HarnessProbeOptions {
  readonly spawner?: ProbeSpawner;
  readonly scratchRoot?: string;
  readonly now?: () => string;
  readonly timeoutMs?: number;
  readonly isolationAvailable?: boolean;
}

/** The production argv shape, from the adapter's own builder, with a probe MCP server that can never start. */
export function probeArgv(): readonly string[] {
  const spec = {
    modelTarget: M214_MODEL.model,
    maxTurns: M214_BUDGET.maxTurns,
    nativeTools: M214_NATIVE_TOOLS,
    perRunCostCapUsd: M214_BUDGET.perRunCostCapUsd,
    agentBinary: M214_AGENT.binary,
  } as unknown as AgentRunSpec;
  const isolationArgv = ["--strict-mcp-config", "--mcp-config", JSON.stringify({ mcpServers: { [PROBE_MCP_SERVER]: { command: "/bin/false", args: [] } } })];
  return buildAgentArgv(spec, isolationArgv, "harness capability probe", "PROBE").slice(1);
}

function parseJsonLines(stdout: string): { readonly events: Record<string, unknown>[]; readonly nonJson: number; readonly lines: string[] } {
  const events: Record<string, unknown>[] = [];
  const lines = stdout.split("\n").filter((line) => line.trim().length > 0);
  let nonJson = 0;
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line) as unknown;
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) events.push(parsed as Record<string, unknown>);
      else nonJson += 1;
    } catch {
      nonJson += 1;
    }
  }
  return { events, nonJson, lines };
}

export function probeAgentHarness(identity: AgentHarnessIdentity, options: HarnessProbeOptions = {}): HarnessProbeReport {
  const spawner = options.spawner ?? networkUnsharedSpawner;
  const now = options.now ?? (() => new Date().toISOString());
  const timeoutMs = options.timeoutMs ?? 60_000;
  const results: HarnessCapabilityResult[] = [];
  const add = (id: HarnessCapabilityId, satisfied: boolean, evidence: string): void => { results.push({ id, satisfied, evidence }); };
  const base = {
    schemaVersion: M220A3_HARNESS_PROBE_VERSION, contractVersion: M220A3_HARNESS_CONTRACT_VERSION, identity,
    providerCalls: 0 as const, probedAt: now(),
  };
  const refused = (isolation: HarnessProbeReport["isolation"], issues: string[]): HarnessProbeReport => ({
    ...base, isolation, capabilities: [], verdict: "AGENT_HARNESS_CAPABILITY_MISMATCH", issues: Object.freeze(issues),
    capabilityFingerprint: null, initFieldNames: [], probeReportedCostUsd: null,
  });
  if (identity.issues.length > 0) return refused("NETWORK_UNSHARED_NO_CREDENTIAL", [...identity.issues]);
  if (!(options.isolationAvailable ?? networkIsolationAvailable(spawner, options.scratchRoot))) {
    return refused("UNAVAILABLE", ["network and mount namespace isolation (unshare -r -n -m, private /tmp) is unavailable; the harness is not executed without it, so its capabilities are unproven"]);
  }

  const root = mkdtempSync(join(options.scratchRoot ?? tmpdir(), "m220a3-harness-probe-"));
  try {
    const home = join(root, "home");
    const configDir = join(root, "config");
    mkdirSync(home, { recursive: true });
    mkdirSync(configDir, { recursive: true });
    const env = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home, CLAUDE_CONFIG_DIR: configDir, TERM: "dumb", LANG: "C.UTF-8", DISABLE_AUTOUPDATER: "1" };
    const binary = identity.resolvedBinary;

    // ── the offline production invocation ──
    const run = spawner(binary, probeArgv(), { env, cwd: home, timeoutMs, privateRoot: root });
    const stream = parseJsonLines(run.stdout);
    const init = stream.events.find((event) => event.type === "system" && event.subtype === "init");
    const result = stream.events.find((event) => event.type === "result");
    const parsed = parseAgentStream(stream.lines);
    const optionError = /unknown option|unknown argument|error: option/i.exec(run.stderr);
    add("C1_NONINTERACTIVE_PRODUCTION_ARGV", optionError === null && run.error === null && stream.events.length > 0,
      optionError !== null ? `the production argv was rejected: ${run.stderr.trim().slice(0, 200)}`
        : run.error !== null ? `the probe process failed: ${run.error}`
          : stream.events.length === 0 ? `no stream event (exit ${String(run.status)}): ${run.stderr.trim().slice(0, 200)}`
            : `${stream.events.length} stream events from the production argv shape (exit ${String(run.status)})`);
    add("C2_STRUCTURED_STREAM_OUTPUT", stream.nonJson === 0 && init !== undefined && result !== undefined,
      `${stream.lines.length} lines, ${stream.nonJson} not JSON objects; init ${init !== undefined}; result ${result !== undefined}`);
    const model = init?.model;
    add("C3_INIT_MODEL_IDENTITY", typeof model === "string" && model === M214_MODEL.model && parsed.providerModelIdentity === M214_MODEL.model,
      `init model ${typeof model === "string" ? model : "(absent)"}; --model ${M214_MODEL.model}`);
    const source = init?.apiKeySource;
    add("C4_INIT_AUTH_SOURCE", typeof source === "string" && source === "none" && parsed.apiKeySource === "none",
      `init apiKeySource ${typeof source === "string" ? source : "(absent)"} with no credential present`);
    const mcpNames = parsed.mcpServersReported;
    add("C5_INIT_TOOL_AND_MCP_REGISTRY",
      Array.isArray(init?.tools) && Array.isArray(init?.mcp_servers) && mcpNames.length === 1 && mcpNames[0] === PROBE_MCP_SERVER,
      `tools ${Array.isArray(init?.tools) ? (init?.tools as unknown[]).length : "(absent)"}; mcp_servers [${mcpNames.join(", ")}]`);
    const cost = result?.total_cost_usd;
    add("C6_RESULT_ACCOUNTING",
      typeof result?.subtype === "string" && typeof cost === "number" && typeof result?.num_turns === "number"
      && result?.usage !== null && typeof result?.usage === "object",
      `result subtype ${String(result?.subtype)}; total_cost_usd ${String(cost)}; num_turns ${String(result?.num_turns)}; usage ${typeof result?.usage}`);

    // ── the static schema scan (bytes read once) ──
    let bytes: Buffer | null = null;
    try {
      bytes = readFileSync(binary);
    } catch {
      bytes = null;
    }
    for (const id of ["C7_TOOL_CALL_EVENTS", "C8_RATE_LIMIT_EVENTS"] as const) {
      const missing = bytes === null ? ["(executable unreadable)"] : STATIC_SCHEMA_TOKENS[id].filter((token) => !containsWholeToken(bytes!, token));
      add(id, missing.length === 0, missing.length === 0 ? `tokens ${STATIC_SCHEMA_TOKENS[id].join(", ")}` : `missing tokens: ${missing.join(", ")}`);
    }
    const turn = bytes === null ? [] : TURN_LIMIT_RESULT_SUBTYPES.filter((token) => containsWholeToken(bytes!, token));
    const budget = bytes === null ? [] : BUDGET_STOP_RESULT_SUBTYPES.filter((token) => containsWholeToken(bytes!, token));
    add("C9_TERMINATION_SUBTYPES", turn.length > 0 && budget.length > 0,
      `turn-limit subtypes present [${turn.join(", ")}] of [${TURN_LIMIT_RESULT_SUBTYPES.join(", ")}]; budget-stop subtypes present [${budget.join(", ")}] of [${BUDGET_STOP_RESULT_SUBTYPES.join(", ")}]`);

    // ── auth status and the private configuration directory ──
    const status = spawner(binary, CLI_AUTH_STATUS_ARGS, { env, cwd: home, timeoutMs, privateRoot: root });
    const auth = parseCliAuthStatus("probe", status.stdout);
    add("C10_AUTH_STATUS_JSON", auth.available && auth.loggedIn !== null && auth.authMethod !== null && auth.apiProvider !== null,
      auth.available ? `fields [${auth.fieldNames.join(", ")}]` : `auth status did not print JSON (exit ${String(status.status)})`);
    const configWritten = readdirSync(configDir).length > 0;
    const homeTouched = [".claude", ".claude.json"].filter((entry) => existsSync(join(home, entry)));
    add("C11_PRIVATE_CONFIGURATION_DIRECTORY", configWritten && homeTouched.length === 0,
      `private configuration directory ${configWritten ? "written" : "untouched"}; HOME gained [${homeTouched.join(", ")}]`);

    // ── self-identification ──
    const reported = init?.claude_code_version;
    add("C12_SELF_IDENTIFICATION", identity.version.length > 0 && typeof reported === "string" && reported === identity.version,
      `--version ${identity.version || "(none)"}; init claude_code_version ${typeof reported === "string" ? reported : "(absent)"}`);

    const issues: string[] = results.filter((entry) => !entry.satisfied).map((entry) => `${entry.id}: ${entry.evidence}`);
    const probeCost = typeof cost === "number" ? cost : null;
    if (probeCost !== null && probeCost !== 0) issues.push(`the offline probe reported cost ${probeCost}; an isolated probe must cost nothing`);
    const initFieldNames = init === undefined ? [] : Object.keys(init).sort();
    const verdict: HarnessCapabilityVerdict = issues.length === 0 ? "AGENT_HARNESS_CAPABILITIES_PASS" : "AGENT_HARNESS_CAPABILITY_MISMATCH";
    return {
      ...base,
      isolation: "NETWORK_UNSHARED_NO_CREDENTIAL",
      capabilities: Object.freeze(results),
      verdict,
      issues: Object.freeze(issues.map((issue) => `AGENT_HARNESS_CAPABILITY_MISMATCH ${issue}`)),
      // Version-free by construction: the fingerprint describes behaviour, so two
      // releases with the same behaviour share it and a version bump alone does
      // not move it.
      capabilityFingerprint: createHash("sha256").update(JSON.stringify(canonicalize({
        contractVersion: M220A3_HARNESS_CONTRACT_VERSION,
        capabilities: results.map((entry) => ({ id: entry.id, satisfied: entry.satisfied })),
        requiredInitFields: ["apiKeySource", "claude_code_version", "mcp_servers", "model", "tools"].filter((field) => initFieldNames.includes(field)),
        authStatusFields: ["apiProvider", "authMethod", "loggedIn"].filter((field) => auth.fieldNames.includes(field)),
      }))).digest("hex"),
      initFieldNames: Object.freeze(initFieldNames),
      probeReportedCostUsd: probeCost,
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/** Every requirement in the frozen contract must have been evaluated; a probe that skipped one proves nothing about it. */
export function auditProbeCoverage(report: HarnessProbeReport): readonly string[] {
  if (report.capabilities.length === 0) return [];
  const seen = new Set(report.capabilities.map((entry) => entry.id));
  return M220A3_HARNESS_CAPABILITIES.filter((entry) => !seen.has(entry.id)).map((entry) => `capability ${entry.id} was not evaluated`);
}

// ── the authority the executor and launcher bind ────────────────────

export function observationFrom(report: HarnessProbeReport): AgentHarnessObservation {
  const coverage = auditProbeCoverage(report);
  return {
    contractVersion: report.contractVersion,
    declaredBinary: report.identity.declaredBinary,
    resolvedBinary: report.identity.resolvedBinary,
    versionOutput: report.identity.versionOutput,
    version: report.identity.version,
    sha256: report.identity.sha256,
    capabilityVerdict: coverage.length === 0 ? report.verdict : "AGENT_HARNESS_CAPABILITY_MISMATCH",
    capabilityFingerprint: report.capabilityFingerprint,
    issues: Object.freeze([...report.issues, ...coverage]),
  };
}

/**
 * Resolves the harness on every observation (so a moved symlink is seen at the
 * next attempt) and probes each distinct executable once (cached by digest).
 * Carries the A3 digest so P16 can require the contract it enforces to be the
 * frozen one.
 */
export class AgentHarnessAuthority implements AgentHarnessGate {
  readonly amendmentHash: string;
  private readonly cache = new Map<string, HarnessProbeReport>();
  private readonly options: HarnessProbeOptions & { readonly declaredBinary?: string; readonly resolve?: () => AgentHarnessIdentity };

  constructor(options: HarnessProbeOptions & {
    readonly declaredBinary?: string;
    readonly resolve?: () => AgentHarnessIdentity;
    readonly amendmentHash?: string;
  } = {}) {
    this.options = options;
    this.amendmentHash = options.amendmentHash ?? M220A3_FROZEN_HASH;
  }

  probe(): HarnessProbeReport {
    const identity = this.options.resolve?.() ?? resolveAgentHarnessIdentity(this.options.declaredBinary);
    const key = identity.sha256;
    if (key !== null && identity.issues.length === 0) {
      const cached = this.cache.get(key);
      // The digest proves the bytes are the ones probed; the path and version
      // are re-read so the observation names what was resolved this time.
      if (cached !== undefined && cached.identity.resolvedBinary === identity.resolvedBinary) return { ...cached, identity };
    }
    const report = probeAgentHarness(identity, this.options);
    if (key !== null && report.identity.issues.length === 0) this.cache.set(key, report);
    return report;
  }

  observe(): AgentHarnessObservation {
    return observationFrom(this.probe());
  }
}

/** A redacted, outcome-free summary for journals and session events. */
export function harnessProbeSummary(report: HarnessProbeReport): Record<string, unknown> {
  return {
    contractVersion: report.contractVersion,
    resolvedBinary: report.identity.resolvedBinary,
    version: report.identity.version,
    versionOutput: report.identity.versionOutput,
    sha256: report.identity.sha256,
    verdict: report.verdict,
    capabilityFingerprint: report.capabilityFingerprint,
    isolation: report.isolation,
    capabilities: report.capabilities.map((entry) => ({ id: entry.id, satisfied: entry.satisfied })),
    providerCalls: report.providerCalls,
  };
}
