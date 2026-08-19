/**
 * M163-C — emit one arm's live wiring.
 *
 * The driver shells out to this instead of rebuilding the MCP config in bash, so
 * the configuration that actually reaches the agent comes from the same frozen
 * `buildArmWiring` the offline parity tests assert against. A shell-side copy
 * would be free to drift from the thing under test.
 *
 *   bun run_stage5_m163_arm_wiring.ts <arm> <label> <instanceId>
 *
 * Writes results/_m163_mcp_configs/<label>.json and prints `KEY=value` lines for
 * the driver to pass through `env`.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { buildArmWiring, M163_ARMS, type M163Arm } from "./m163Policy";

const RESULTS = path.resolve("benchmarks/stage5_vexp_swe_bench_smoke/results");
const CONFIG_DIR = path.join(RESULTS, "_m163_mcp_configs");
const TRIGGER_FILE = path.join(RESULTS, "stage5_m163_task_trigger.md");
const CLI_ENTRY = path.resolve("src/cli/index.ts");

const [armArg, label, instanceId] = process.argv.slice(2);
if (armArg === undefined || label === undefined || instanceId === undefined) {
  process.stderr.write("usage: run_stage5_m163_arm_wiring.ts <arm> <label> <instanceId>\n");
  process.exit(2);
}
if (!M163_ARMS.includes(armArg as M163Arm)) {
  process.stderr.write(`unknown arm: ${armArg} (expected one of ${M163_ARMS.join(", ")})\n`);
  process.exit(2);
}

// The workspace the runner will create for this label. A pure function of the
// label and instance id, so the server can be bound before the run starts and
// cannot answer about a shared clone.
const repoRoot = path.join(RESULTS, "workspaces", label, instanceId);

const wiring = buildArmWiring({
  arm: armArg as M163Arm,
  repoRoot,
  cliEntry: CLI_ENTRY,
  runtime: "bun",
  triggerFile: TRIGGER_FILE,
});

mkdirSync(CONFIG_DIR, { recursive: true });
const configPath = path.join(CONFIG_DIR, `${label}.json`);
writeFileSync(configPath, `${JSON.stringify(wiring.mcpConfig, null, 2)}\n`);

const lines = [`VTRACE_MCP_CONFIG=${configPath}`];
for (const [key, value] of Object.entries(wiring.env)) lines.push(`${key}=${value}`);
process.stdout.write(`${lines.join("\n")}\n`);
