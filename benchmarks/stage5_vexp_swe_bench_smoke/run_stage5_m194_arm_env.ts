/**
 * M194 §8 — construct one arm's treatment isolation and measure it, immediately
 * before that arm's model would be launched.
 *
 * M193A made the guarantee a property of a constructed object rather than an
 * instruction to an operator, and found that the construction alone is not
 * sufficient evidence: a private directory holding only credentials still
 * resolved three claude.ai account connectors, because they arrive with the
 * authenticated account rather than from any file. So the count is MEASURED
 * here, by asking the CLI, and the launch gate reads the measurement rather than
 * the intent.
 *
 * `claude mcp list` and `claude --version` resolve configuration and exit
 * without a provider request, which is why this may run before spending.
 *
 *   bun run_stage5_m194_arm_env.ts '<request json>'
 *
 * Emits the constructed environment, the audit, the launch record and a single
 * `mayLaunchModel` boolean on stdout.
 */

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { auditArmEnvironment, constructArmEnvironment, launchRecord } from "./m193aArmEnvironment";

interface Request {
  armId: string;
  instanceId: string;
  armRootDir: string;
  hostConfigDir: string;
  adapterSettingsPath: string;
  nonce: string;
  cliBinary: string;
  cliVersion: string;
  model: string;
  allowedTools: string[];
}

const req = JSON.parse(process.argv[2] ?? "{}") as Request;

const arm = constructArmEnvironment({
  armId: req.armId,
  instanceId: req.instanceId,
  armRootDir: req.armRootDir,
  hostConfigDir: req.hostConfigDir,
  adapterSettingsPath: req.adapterSettingsPath,
  parentEnv: process.env,
  nonce: req.nonce,
});

/**
 * How many MCP servers this arm's configuration actually resolves, read from
 * the CLI's own answer rather than from a reconstruction of its precedence
 * rules.
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

let measured = { count: -1, names: [] as string[] };
let mcpError: string | null = null;
try {
  const out = execFileSync(req.cliBinary, ["mcp", "list"], {
    env: arm.env,
    timeout: 120_000,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  measured = mcpServerCount(out);
} catch (e) {
  // A non-zero exit still carries the listing on stdout in some versions, so the
  // output is read before the failure is believed.
  const err = e as { stdout?: string | Buffer };
  const text = err.stdout ? err.stdout.toString() : "";
  if (text) measured = mcpServerCount(text);
  else mcpError = String(e).slice(0, 400);
}

let cliReported: string | null = null;
try {
  cliReported = execFileSync(req.cliBinary, ["--version"], { env: arm.env, timeout: 120_000, encoding: "utf8" })
    .trim()
    .split(" ")[0] ?? null;
} catch (e) {
  mcpError = (mcpError ?? "") + ` version probe failed: ${String(e).slice(0, 200)}`;
}

/**
 * The probes above are CLI invocations, and the CLI takes a lock on its own
 * bookkeeping file while it writes. The lock is a directory inside the arm's
 * private configuration, so auditing while it is held reports a file outside
 * the baseline allow-list — a contamination finding produced by the act of
 * measuring, not by anything in the arm.
 *
 * The audit's rules are frozen and are not relaxed to accommodate this. What
 * changes is when the sample is taken: the audit waits, briefly and boundedly,
 * for the probe's own lock to be released. A lock still held after that is
 * reported rather than waited out forever, because an audit that cannot fail is
 * not an audit.
 */
const LOCK = join(arm.configDir, ".claude.json.lock");
let lockWaitMs = 0;
while (existsSync(LOCK) && lockWaitMs < 10_000) {
  Bun.sleepSync(100);
  lockWaitMs += 100;
}

// Re-audited with the MEASURED count, because the constructor could only assume
// it. This is the audit the launch gate reads.
const audit = auditArmEnvironment(arm.configDir, arm.env, arm.argv, measured.count);
const record = launchRecord(arm, {
  cliVersion: req.cliVersion,
  cliBinary: req.cliBinary,
  model: req.model,
  allowedTools: req.allowedTools,
  effectiveMcpServerCount: measured.count,
});

const failures: string[] = [];
if (!arm.mayLaunchModel) failures.push(`construction: ${arm.errors.join("; ") || arm.status}`);
if (!audit.clean) failures.push(`audit: ${audit.findings.map((f) => f.id).join(",")}`);
if (measured.count !== 0) failures.push(`effective MCP server count is ${measured.count} (${measured.names.join(",")})`);
if (cliReported !== req.cliVersion) failures.push(`CLI reports ${cliReported}, pinned ${req.cliVersion}`);

console.log(
  JSON.stringify(
    {
      schemaVersion: "stage5.m194.arm-environment.v1",
      armId: req.armId,
      instanceId: req.instanceId,
      configDir: arm.configDir,
      env: arm.env,
      argv: arm.argv,
      construction: { status: arm.status, errors: arm.errors, baselineContentsHash: arm.baselineContentsHash },
      audit,
      measuredMcp: { ...measured, error: mcpError },
      configLockWaitMs: lockWaitMs,
      cliReportedVersion: cliReported,
      launchRecord: record,
      failures,
      status: failures.length === 0 ? "TREATMENT_ISOLATION_CONSTRUCTED" : "TREATMENT_ISOLATION_FAILED",
      mayLaunchModel: failures.length === 0,
    },
    null,
    2,
  ),
);
