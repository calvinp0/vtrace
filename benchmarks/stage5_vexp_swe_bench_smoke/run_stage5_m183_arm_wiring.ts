/**
 * M183 — emit one arm's live wiring.
 *
 *   bun run_stage5_m183_arm_wiring.ts <arm> <label> <instanceId>
 *
 * The driver shells out to this rather than assembling configuration in bash, so
 * what reaches the agent comes from the same frozen builder the offline tests and
 * the protocol freeze assert against.
 *
 * ONE CHANNEL, AND ONE LINE OF OUTPUT AT MOST.
 *
 *   baseline             emits nothing. The absence IS the treatment, and it is
 *                        produced by emitting no environment at all rather than
 *                        by an empty file, so a wiring bug cannot disguise itself
 *                        as a correctly-empty arm.
 *   vtrace_orientation   emits VTRACE_TASK_TRIGGER_FILE and nothing else.
 *
 * NO MCP CONFIG. NO ALLOWED-TOOLS LIST. NO SETTINGS FILE. NO HOOK.
 *
 * M168 and M173 emitted three variables here; M183 emits one, and the two it
 * dropped are the two §6 and §7 forbid — the tool inventory is held identical
 * across arms, and there is no policy text to point at.
 *
 * The trigger file is NOT written by this script. It is written by
 * run_stage5_m183_orientation.ts from a real MCP reply, and this script only
 * refuses to name one that does not exist. A wiring step that could author the
 * treatment could author a treatment the product never produced.
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import {
  M183_ARMS,
  M183_ORIENTATION_PREAMBLE,
  armDefinition,
  findLeakage,
  sha256,
  type M183Arm,
} from "./m183Treatment";

const RESULTS = path.resolve("benchmarks/stage5_vexp_swe_bench_smoke/results");
const ORIENTATION_DIR = path.join(RESULTS, "_m183_orientation");

const [armArg, label, instanceId] = process.argv.slice(2);
if (armArg === undefined || label === undefined || instanceId === undefined) {
  process.stderr.write("usage: run_stage5_m183_arm_wiring.ts <arm> <label> <instanceId>\n");
  process.exit(2);
}
if (!M183_ARMS.includes(armArg as M183Arm)) {
  process.stderr.write(`unknown arm: ${armArg} (expected one of ${M183_ARMS.join(", ")})\n`);
  process.exit(2);
}
const arm = armArg as M183Arm;

if (arm === "baseline") {
  process.stdout.write("\n");
  process.exit(0);
}

const triggerPath = path.join(ORIENTATION_DIR, `${instanceId}.trigger.md`);
if (!existsSync(triggerPath)) {
  process.stderr.write(`m183 wiring: no orientation trigger for ${instanceId} at ${triggerPath}\n`);
  process.stderr.write("run run_stage5_m183_orientation.ts for this instance before spawning the treatment arm\n");
  process.exit(3);
}
const trigger = readFileSync(triggerPath, "utf8");

// The treatment must be the packet, not an accident. Three refusals, all cheap:
// an empty file, a file that is only the preamble, and a file whose leakage
// markers are absent (which would mean it carries no orientation at all).
if (trigger.trim() === "") {
  process.stderr.write(`m183 wiring: orientation trigger for ${instanceId} is empty\n`);
  process.exit(3);
}
if (!trigger.startsWith(M183_ORIENTATION_PREAMBLE)) {
  process.stderr.write(`m183 wiring: orientation trigger for ${instanceId} does not begin with the frozen preamble\n`);
  process.exit(3);
}
if (findLeakage(trigger).length === 0) {
  process.stderr.write(`m183 wiring: orientation trigger for ${instanceId} carries no orientation payload\n`);
  process.exit(3);
}

process.stderr.write(
  `m183 wiring: arm=${arm} label=${label} disclosure=${armDefinition(arm).disclosure} `
  + `trigger=${path.relative(process.cwd(), triggerPath)} sha256=${sha256(trigger).slice(0, 16)} chars=${trigger.length}\n`,
);
process.stdout.write(`VTRACE_TASK_TRIGGER_FILE=${triggerPath}\n`);
