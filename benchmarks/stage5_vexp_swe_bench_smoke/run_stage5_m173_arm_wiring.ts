/**
 * M173 — emit one arm's live wiring.
 *
 *   bun run_stage5_m173_arm_wiring.ts <arm> <label> <instanceId>
 *
 * The driver shells out to this rather than rebuilding configuration in bash,
 * so what reaches the agent comes from the same frozen builders the offline
 * tests and the protocol freeze assert against.
 *
 * Two channels, both inherited from M163/M164 and used unchanged by M168:
 *
 *   policy text   VTRACE_TASK_TRIGGER_FILE — appended as the LAST prompt
 *                 section. The mandate is byte-identical to M168's clean arm.
 *   MCP config    the frozen two-tool inventory at this run's own workspace.
 *
 * No hook. No settings file. No prohibition. Arm B differs from M168's arm C
 * in exactly one way, and that way is not in this file: it is which bytes
 * `run_pipeline` returns, which changed in the product at b173df2d.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import {
  M173_ARMS,
  M173_VISIBLE_TOOL_IDS,
  armDefinition,
  claudeMdForArm,
  mcpConfigForArm,
  type M173Arm,
} from "./m173Treatment";

const RESULTS = path.resolve("benchmarks/stage5_vexp_swe_bench_smoke/results");
const WIRING_DIR = path.join(RESULTS, "_m173_wiring");
const CLI_ENTRY = path.resolve("src/cli/index.ts");

const [armArg, label, instanceId] = process.argv.slice(2);
if (armArg === undefined || label === undefined || instanceId === undefined) {
  process.stderr.write("usage: run_stage5_m173_arm_wiring.ts <arm> <label> <instanceId>\n");
  process.exit(2);
}
if (!M173_ARMS.includes(armArg as M173Arm)) {
  process.stderr.write(`unknown arm: ${armArg} (expected one of ${M173_ARMS.join(", ")})\n`);
  process.exit(2);
}

const arm = armArg as M173Arm;

// The workspace the runner will create for this label — a pure function of the
// label and instance id, so the server is bound to this run's own clone.
const repoRoot = path.join(RESULTS, "workspaces", label, instanceId);

mkdirSync(WIRING_DIR, { recursive: true });

if (arm === "baseline") {
  // Nothing. No config, no policy, no marker of any kind — the absence IS the
  // treatment, and it is produced by emitting no environment at all.
  process.stdout.write("\n");
  process.exit(0);
}

const lines: string[] = [];

const mcpPath = path.join(WIRING_DIR, `${label}.mcp.json`);
writeFileSync(mcpPath, `${JSON.stringify(mcpConfigForArm(arm, repoRoot, CLI_ENTRY), null, 2)}\n`);
lines.push(`VTRACE_MCP_CONFIG=${mcpPath}`);
lines.push(
  `VTRACE_MCP_ALLOWED_TOOLS=${M173_VISIBLE_TOOL_IDS.map((t) => `mcp__vtrace__${t}`).join(",")}`,
);

const policyPath = path.join(WIRING_DIR, `${label}.policy.md`);
writeFileSync(policyPath, claudeMdForArm(arm)!);
lines.push(`VTRACE_TASK_TRIGGER_FILE=${policyPath}`);

process.stderr.write(
  `m173 wiring: arm=${arm} label=${label} disclosure=${armDefinition(arm).disclosure}\n`,
);
process.stdout.write(`${lines.join("\n")}\n`);
