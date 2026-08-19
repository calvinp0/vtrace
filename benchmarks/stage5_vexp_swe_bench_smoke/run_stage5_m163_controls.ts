/**
 * M163-B — the free controls. Offline, no live agent, no Docker, no spend.
 *
 *   bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m163_controls.ts
 *
 * Three things get proved here, and each one is a place a policy ablation can
 * silently become a different experiment:
 *
 *  1. PROTOCOL. A real `mcp-serve` process, started with each arm's ACTUAL frozen
 *     args, is asked to initialize and list tools. The two arms must differ in
 *     exactly one respect — whether the suite policy is served — and in no other.
 *     Asserting the config file's contents would only prove the harness's intent.
 *
 *  2. DELIVERY. The patched external adapter must carry the trigger block, and it
 *     must carry it AFTER every other prompt-appending block, or the trigger the
 *     transcript records is not the trigger that was frozen.
 *
 *  3. ANALYZER. The M162 defects are re-run as known-positives against the M163
 *     readers: an unexecuted arm may not enter an aggregate, may not be called
 *     AVAILABLE_UNUSED, and cache reads may not fall out of total model traffic.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { VTRACE_TOOL_SUITE_POLICY } from "../../src/mcp/startServer";
import {
  STAGE5_M163_TASK_TRIGGER_HEADING,
  STAGE5_M163_TASK_TRIGGER_MARKER,
  STAGE5_TOOL_USE_DISCIPLINE_MARKER,
  STAGE5_VTRACE_PATCH_MARKER,
} from "./run_stage5_vexp_swe_bench_smoke";
import { frozenCallableMcpToolNames } from "./m162Callable";
import {
  adoptionRate,
  aggregate,
  classifyAdoption,
  classifyTriggerCompliance,
  tokenTraffic,
} from "./m163Adoption";
import { buildArmWiring, M163_ARMS, M163_TASK_TRIGGER_TEXT, sha256, type M163Arm } from "./m163Policy";

const ROOT = path.resolve(".");
const RESULTS = path.join(ROOT, "benchmarks/stage5_vexp_swe_bench_smoke/results");
const ADAPTER = "/home/calvin/code/vexp-swe-bench/dist/agents/claude-code.js";
const TRIGGER_FILE = path.join(RESULTS, "stage5_m163_task_trigger.md");

const failures: string[] = [];
const fail = (message: string): void => { failures.push(message); };

// ---------------------------------------------------------------------------
// 1. Protocol control: a real server, per arm, over stdio
// ---------------------------------------------------------------------------

interface ServerProbe {
  readonly arm: string;
  readonly exitCode: number | null;
  readonly instructions: string;
  readonly suitePolicyServed: boolean;
  readonly toolNames: readonly string[];
  readonly instructionsSha256: string;
}

function buildFixtureRepo(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "m163-control-"));
  mkdirSync(path.join(dir, "pkg"), { recursive: true });
  writeFileSync(path.join(dir, "pkg", "__init__.py"), "");
  writeFileSync(path.join(dir, "pkg", "widget.py"), [
    "class Widget:",
    "    def render(self, value):",
    "        return self._format(value)",
    "",
    "    def _format(self, value):",
    "        return str(value)",
    "",
  ].join("\n"));
  execFileSync("bun", ["src/cli/index.ts", "init", dir], { cwd: ROOT, stdio: "pipe" });
  execFileSync("bun", ["src/cli/index.ts", "index", dir], { cwd: ROOT, stdio: "pipe" });
  return dir;
}

function probeServer(arm: M163Arm, repoRoot: string): ServerProbe {
  const wiring = buildArmWiring({
    arm,
    repoRoot,
    cliEntry: path.join(ROOT, "src/cli/index.ts"),
    runtime: "bun",
    triggerFile: TRIGGER_FILE,
  });
  const server = wiring.mcpConfig.mcpServers.vtrace!;
  const messages = [
    {
      jsonrpc: "2.0", id: 1, method: "initialize",
      params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "m163-control", version: "1" } },
    },
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
  ];
  const child = spawnSync(server.command, [...server.args], {
    cwd: ROOT,
    input: messages.map((message) => `${JSON.stringify(message)}\n`).join(""),
    encoding: "utf8",
  });
  const responses = child.stdout.split("\n").filter((line) => line.trim().length > 0).flatMap((line) => {
    try { return [JSON.parse(line) as Record<string, unknown>]; } catch { return []; }
  });
  const init = (responses.find((entry) => entry.id === 1)?.result ?? {}) as { instructions?: string };
  const list = (responses.find((entry) => entry.id === 2)?.result ?? {}) as { tools?: Array<{ name: string }> };
  const instructions = init.instructions ?? "";
  return {
    arm,
    exitCode: child.status,
    instructions,
    suitePolicyServed: instructions.includes(VTRACE_TOOL_SUITE_POLICY),
    toolNames: (list.tools ?? []).map((tool) => tool.name),
    instructionsSha256: sha256(instructions),
  };
}

let fixture: string | null = null;
let probes: ServerProbe[] = [];
try {
  fixture = buildFixtureRepo();
  probes = M163_ARMS.map((arm) => probeServer(arm, fixture!));
} catch (error) {
  fail(`protocol control could not run: ${error instanceof Error ? error.message : String(error)}`);
} finally {
  if (fixture !== null) rmSync(fixture, { recursive: true, force: true });
}

const expectedTools = frozenCallableMcpToolNames().map((name) => name.replace(/^mcp__vtrace__/, ""));
for (const probe of probes) {
  if (probe.exitCode !== 0) fail(`${probe.arm}: server exited ${probe.exitCode}`);
  if (probe.toolNames.join(",") !== expectedTools.join(",")) {
    fail(`${probe.arm}: served tools [${probe.toolNames.join(",")}], expected [${expectedTools.join(",")}]`);
  }
  const shouldServe = probe.arm !== "tools_only";
  if (probe.suitePolicyServed !== shouldServe) {
    fail(`${probe.arm}: suite policy served=${probe.suitePolicyServed}, expected ${shouldServe}`);
  }
}
// The two policy-carrying arms must be byte-identical at the protocol layer:
// their only difference lives in the prompt, not in what the server says.
const neutral = probes.find((probe) => probe.arm === "tools_neutral_policy");
const trigger = probes.find((probe) => probe.arm === "tools_task_trigger");
if (neutral && trigger && neutral.instructionsSha256 !== trigger.instructionsSha256) {
  fail("NEUTRAL and TRIGGER serve different instructions; their difference must be prompt-only");
}
const only = probes.find((probe) => probe.arm === "tools_only");
if (only && neutral && only.instructionsSha256 === neutral.instructionsSha256) {
  fail("TOOLS_ONLY and NEUTRAL serve identical instructions; the policy ablation has no A/B contrast");
}
// Arm A must still be told WHICH repository answers — that is identification,
// not policy, and removing it would make A differ by more than policy.
if (only && fixture !== null && !only.instructions.includes("Repo-bound vtrace MCP server")) {
  fail("TOOLS_ONLY lost the server identification along with the policy");
}

// ---------------------------------------------------------------------------
// 2. Delivery control: the patched adapter
// ---------------------------------------------------------------------------

let adapter = "";
try { adapter = readFileSync(ADAPTER, "utf8"); } catch { fail(`could not read patched adapter at ${ADAPTER}`); }

const triggerIndex = adapter.indexOf(`${STAGE5_M163_TASK_TRIGGER_MARKER} begin`);
const instructionsIndex = adapter.indexOf(`${STAGE5_VTRACE_PATCH_MARKER} begin`);
const disciplineIndex = adapter.indexOf(`${STAGE5_TOOL_USE_DISCIPLINE_MARKER} begin`);
if (triggerIndex === -1) fail("the patched adapter does not carry the M163 trigger block");
if (triggerIndex !== -1 && triggerIndex < instructionsIndex) {
  fail("the trigger block runs BEFORE the instructions block; it would not be the last prompt section");
}
if (triggerIndex !== -1 && triggerIndex < disciplineIndex) {
  fail("the trigger block runs BEFORE the discipline block; it would not be the last prompt section");
}
if (adapter.includes(STAGE5_M163_TASK_TRIGGER_HEADING) === false) {
  fail("the patched adapter does not carry the frozen trigger heading");
}

// The frozen file the trigger arm actually points at must match the frozen text.
let triggerFileText = "";
try { triggerFileText = readFileSync(TRIGGER_FILE, "utf8"); } catch { fail(`missing ${TRIGGER_FILE}`); }
if (triggerFileText.trim() !== M163_TASK_TRIGGER_TEXT.trim()) {
  fail("the on-disk trigger file does not match the frozen trigger text");
}

// ---------------------------------------------------------------------------
// 3. Analyzer known-positives (the three M162 defects, as executable probes)
// ---------------------------------------------------------------------------

const analyzerProbes = [
  {
    id: "missing_arm_not_zero",
    defect: "M162 counted arms that had not run as 0 turns / 0 cost, pulling every median toward zero.",
    pass: aggregate([30, 31, null, null]).median === 30.5 && aggregate([30, 31, null, null]).missing === 2,
  },
  {
    id: "not_run_is_not_available_unused",
    defect: "M162 labelled an arm that never executed AVAILABLE_UNUSED — the exact claim the milestone makes.",
    pass: classifyAdoption({ executed: false, toolsAvailable: true, vtraceCallCount: 0 }) === "NOT_RUN",
  },
  {
    id: "unproven_availability_is_invalid",
    defect: "Zero calls without runtime evidence is unfalsifiable, so it may not be scored as non-adoption.",
    pass: classifyAdoption({ executed: true, toolsAvailable: null, vtraceCallCount: 0 }) === "INVALID",
  },
  {
    id: "adoption_denominator_excludes_non_runs",
    defect: "An adoption rate over all 12 tasks rather than over available runs understates adoption.",
    pass: adoptionRate(["AVAILABLE_USED", "NOT_RUN", "NOT_RUN"]).denominator === 1,
  },
  {
    id: "empty_denominator_is_null_not_zero",
    defect: "A 0/0 adoption rate rendered as 0% reads as 'nobody adopted' when nothing was measured.",
    pass: adoptionRate(["NOT_RUN"]).rate === null,
  },
  {
    id: "cache_reads_inside_total_traffic",
    defect: "M162 found uncached tokens in the hundreds against ~1e6 cache reads; omitting them hides the term.",
    pass: tokenTraffic({ inputTokens: 300, cacheReadTokens: 1_000_000, outputTokens: 4_000 })
      .totalModelTraffic === 1_004_300,
  },
  {
    id: "trigger_noncompliance_is_measured_not_erased",
    defect: "A trigger-arm run that investigated first must be recorded, not treated as an unusable run.",
    pass: classifyTriggerCompliance(
      [{ tool: "Grep" } as never, { tool: "mcp__vtrace__get_code_context" } as never],
      { isTriggerArm: true, adoption: "AVAILABLE_USED" },
    ).state === "TRIGGER_NOT_COMPLIED",
  },
  {
    id: "compliance_undefined_without_a_run",
    defect: "Compliance computed over an arm that did not run would invent a denominator.",
    pass: classifyTriggerCompliance([], { isTriggerArm: true, adoption: "NOT_RUN" }).state === "NOT_MEASURABLE",
  },
];
for (const probe of analyzerProbes) {
  if (!probe.pass) fail(`analyzer control FAILED: ${probe.id}`);
}

// ---------------------------------------------------------------------------
// Emit
// ---------------------------------------------------------------------------

const artifact = {
  schemaVersion: 1,
  milestone: "M163",
  workstream: "B",
  title: "M163 free controls: protocol, delivery, analyzer",
  spend: "none — no live agent, no Docker",
  protocolControl: {
    fixture: "temporary two-symbol Python repo, initialized and indexed, removed afterwards",
    probes: probes.map((probe) => ({
      arm: probe.arm,
      exitCode: probe.exitCode,
      toolNames: probe.toolNames,
      suitePolicyServed: probe.suitePolicyServed,
      instructionsChars: probe.instructions.length,
      instructionsSha256: probe.instructionsSha256,
    })),
    neutralAndTriggerServeIdenticalInstructions:
      neutral !== undefined && trigger !== undefined && neutral.instructionsSha256 === trigger.instructionsSha256,
    toolsOnlyDiffersFromNeutral:
      only !== undefined && neutral !== undefined && only.instructionsSha256 !== neutral.instructionsSha256,
  },
  deliveryControl: {
    adapter: ADAPTER,
    triggerBlockPresent: triggerIndex !== -1,
    triggerBlockIsLastPromptSection: triggerIndex > instructionsIndex && triggerIndex > disciplineIndex,
    blockOrder: [
      { marker: STAGE5_TOOL_USE_DISCIPLINE_MARKER, index: disciplineIndex },
      { marker: STAGE5_VTRACE_PATCH_MARKER, index: instructionsIndex },
      { marker: STAGE5_M163_TASK_TRIGGER_MARKER, index: triggerIndex },
    ].sort((a, b) => a.index - b.index).map((entry) => entry.marker),
    triggerFileMatchesFrozenText: triggerFileText.trim() === M163_TASK_TRIGGER_TEXT.trim(),
    triggerFileSha256: sha256(M163_TASK_TRIGGER_TEXT),
  },
  analyzerControls: analyzerProbes.map((probe) => ({ id: probe.id, defect: probe.defect, pass: probe.pass })),
  failures,
  status: failures.length === 0 ? "PASS" : "FAIL",
};

writeFileSync(path.join(RESULTS, "stage5_m163_analyzer_controls.json"), `${JSON.stringify(artifact, null, 2)}\n`);
process.stdout.write(`${JSON.stringify({ status: artifact.status, failures }, null, 2)}\n`);
if (failures.length > 0) process.exitCode = 1;
