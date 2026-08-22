/**
 * M168-E — emit one arm's live wiring.
 *
 *   bun run_stage5_m168_arm_wiring.ts <arm> <label> <instanceId>
 *
 * The driver shells out to this rather than rebuilding configuration in bash,
 * so what reaches the agent comes from the same frozen builders the offline
 * tests assert against. Writes the arm's files under results/_m168_wiring/ and
 * prints `KEY=value` lines for the driver to pass through `env`.
 *
 * Delivery channels, chosen for arm isolation over byte-fidelity to VEXP:
 *
 *   policy text   VTRACE_TASK_TRIGGER_FILE — appended as the LAST prompt
 *                 section, the channel M163 built and M164 qualified for a
 *                 required-first-action mandate. B and C use the SAME channel
 *                 at the SAME position; their files differ by exactly the
 *                 prohibition paragraph.
 *   hook          --settings, via VTRACE_TOOL_LOOP_GUARD_HOOK_SETTINGS. VEXP
 *                 writes .claude/settings.json into the repository instead;
 *                 --settings is the path this harness has actually run hooks
 *                 through (M76/M82/M85), and a proven apparatus beats a
 *                 byte-faithful untested one. Recorded as a deviation.
 */

import { mkdirSync, writeFileSync, chmodSync } from "node:fs";
import path from "node:path";

import {
  M168_ARMS,
  M168_VISIBLE_TOOL_IDS,
  armDefinition,
  claudeMdForArm,
  guardScript,
  mcpConfigForArm,
  settingsJsonForArm,
  type M168Arm,
} from "./m168Treatment";

const RESULTS = path.resolve("benchmarks/stage5_vexp_swe_bench_smoke/results");
const WIRING_DIR = path.join(RESULTS, "_m168_wiring");
const GUARD_EVENT_DIR = path.join(RESULTS, "_m168_guard_events");
const CLI_ENTRY = path.resolve("src/cli/index.ts");

const [armArg, label, instanceId] = process.argv.slice(2);
if (armArg === undefined || label === undefined || instanceId === undefined) {
  process.stderr.write("usage: run_stage5_m168_arm_wiring.ts <arm> <label> <instanceId>\n");
  process.exit(2);
}
if (!M168_ARMS.includes(armArg as M168Arm)) {
  process.stderr.write(`unknown arm: ${armArg} (expected one of ${M168_ARMS.join(", ")})\n`);
  process.exit(2);
}

const arm = armArg as M168Arm;

// The workspace the runner will create for this label — a pure function of the
// label and instance id, so the server is bound to this run's own clone and
// cannot answer about a shared one.
const repoRoot = path.join(RESULTS, "workspaces", label, instanceId);

mkdirSync(WIRING_DIR, { recursive: true });
mkdirSync(GUARD_EVENT_DIR, { recursive: true });

const lines: string[] = [];

if (arm === "baseline") {
  // Nothing. No config, no policy, no hook, no marker of any kind — the
  // absence is the treatment, and it is produced by emitting no env at all.
  process.stdout.write("\n");
  process.exit(0);
}

// MCP config — byte-identical for both VTRACE arms at the same workspace.
const mcpConfig = mcpConfigForArm(arm, repoRoot, CLI_ENTRY);
const mcpPath = path.join(WIRING_DIR, `${label}.mcp.json`);
writeFileSync(mcpPath, `${JSON.stringify(mcpConfig, null, 2)}\n`);
lines.push(`VTRACE_MCP_CONFIG=${mcpPath}`);
lines.push(
  `VTRACE_MCP_ALLOWED_TOOLS=${M168_VISIBLE_TOOL_IDS.map((t) => `mcp__vtrace__${t}`).join(",")}`,
);

// Policy text — same channel and position for both arms.
const policyText = claudeMdForArm(arm)!;
const policyPath = path.join(WIRING_DIR, `${label}.policy.md`);
writeFileSync(policyPath, policyText);
lines.push(`VTRACE_TASK_TRIGGER_FILE=${policyPath}`);

// Guard — strict arm only.
if (arm === "vtrace_strict") {
  const eventLog = path.join(GUARD_EVENT_DIR, `${label}.jsonl`);
  const guardPath = path.join(WIRING_DIR, `${label}.guard.sh`);
  writeFileSync(guardPath, guardScript(repoRoot, eventLog));
  chmodSync(guardPath, 0o755);

  const settings = settingsJsonForArm(arm, guardPath)!;
  const settingsPath = path.join(WIRING_DIR, `${label}.settings.json`);
  writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
  lines.push(`VTRACE_TOOL_LOOP_GUARD_HOOK_SETTINGS=${settingsPath}`);
}

process.stderr.write(
  `m168 wiring: arm=${arm} label=${label} guard=${armDefinition(arm).searchGuard}\n`,
);
process.stdout.write(`${lines.join("\n")}\n`);
