/**
 * M173-A — out-of-denominator smoke controls, before any spend.
 *
 *   bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m173_smoke.ts
 *
 * Everything here is free: no agent is spawned, no model token is billed.
 * Controls that genuinely need a live agent are named `AWAITING_FIRST_PAIR` and
 * carried into the authorisation request rather than quietly skipped. M168's
 * rule stands: NOT_RUN is not a pass, and the §58 first-pair validity gate is
 * where those five are actually resolved.
 *
 * The workspace probed for the compact-disclosure control is
 * `astropy__astropy-13977` — a Broad100-B case, in neither the frozen twelve
 * nor the eighty-eight-task holdout, so the smoke touches neither denominator.
 */

import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import {
  Disclosure,
  M173_ARMS,
  M173_PIPELINE_TOOL_NAME,
  M173_VISIBLE_TOOL_IDS,
  ORIENTATION_SCHEMA_VERSION,
  claudeMdForArm,
  classifyDisclosure,
  findLeakage,
  type M173Arm,
} from "./m173Treatment";

const ROOT = path.resolve(".");
const RESULTS = path.join(ROOT, "benchmarks/stage5_vexp_swe_bench_smoke/results");
const SMOKE_DIR = path.join(RESULTS, "_m173_smoke");
const WIRING = path.join(ROOT, "benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m173_arm_wiring.ts");
const SMOKE_INSTANCE = "astropy__astropy-13977";
const SMOKE_WORKSPACE = path.join(
  RESULTS, "workspaces", `m164_tools_neutral_policy_${SMOKE_INSTANCE.replace(/-/g, "_")}`, SMOKE_INSTANCE,
);

mkdirSync(SMOKE_DIR, { recursive: true });

type Status = "PASS" | "FAIL" | "AWAITING_FIRST_PAIR";

interface Control {
  readonly id: string;
  readonly arm: M173Arm | "all";
  readonly question: string;
  readonly status: Status;
  readonly detail: unknown;
}

const controls: Control[] = [];
const record = (c: Control) => { controls.push(c); return c; };

// ── 1. wiring emits exactly what each arm should have ───────────────

function wiringEnv(arm: M173Arm, label: string): Record<string, string> {
  const out = execFileSync("bun", [WIRING, arm, label, SMOKE_INSTANCE], {
    cwd: ROOT, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"],
  });
  const env: Record<string, string> = {};
  for (const line of out.split("\n")) {
    const at = line.indexOf("=");
    if (at > 0) env[line.slice(0, at)] = line.slice(at + 1);
  }
  return env;
}

const envByArm = Object.fromEntries(
  M173_ARMS.map((arm) => [arm, wiringEnv(arm, `m173_smoke_${arm}`)]),
) as Record<M173Arm, Record<string, string>>;

record({
  id: "BASELINE_EMITS_NOTHING",
  arm: "baseline",
  question: "does the baseline arm emit any wiring at all?",
  status: Object.keys(envByArm.baseline).length === 0 ? "PASS" : "FAIL",
  detail: { keys: Object.keys(envByArm.baseline) },
});

record({
  id: "TREATMENT_EMITS_CONFIG_AND_POLICY_AND_NOTHING_ELSE",
  arm: "vtrace_compact",
  question: "does the treatment arm emit exactly the MCP config, the allowed-tools list and the policy file?",
  status:
    JSON.stringify(Object.keys(envByArm.vtrace_compact).sort())
      === JSON.stringify(["VTRACE_MCP_ALLOWED_TOOLS", "VTRACE_MCP_CONFIG", "VTRACE_TASK_TRIGGER_FILE"])
      ? "PASS" : "FAIL",
  detail: { keys: Object.keys(envByArm.vtrace_compact).sort() },
});

record({
  id: "NO_HOOK_SETTINGS_ANYWHERE",
  arm: "all",
  question: "does any arm register a PreToolUse hook? (M168-E's coercion is not part of this treatment)",
  status: M173_ARMS.every((arm) => envByArm[arm].VTRACE_TOOL_LOOP_GUARD_HOOK_SETTINGS === undefined)
    ? "PASS" : "FAIL",
  detail: { hookKeysFound: M173_ARMS.filter((a) => envByArm[a].VTRACE_TOOL_LOOP_GUARD_HOOK_SETTINGS !== undefined) },
});

// ── 2. baseline leakage, checked against the bytes not the intent ───

const baselineLeakage = (() => {
  const surfaces: { surface: string; leaked: readonly string[] }[] = [];
  for (const [key, value] of Object.entries(envByArm.baseline)) {
    surfaces.push({ surface: `env:${key}`, leaked: findLeakage(`${key}=${value}`) });
  }
  const policy = claudeMdForArm("baseline");
  surfaces.push({ surface: "policy", leaked: policy === null ? [] : findLeakage(policy) });
  return surfaces;
})();

record({
  id: "BASELINE_CARRIES_NO_VTRACE_BYTES",
  arm: "baseline",
  question: "does anything the baseline arm carries mention VTRACE?",
  status: baselineLeakage.every((s) => s.leaked.length === 0) ? "PASS" : "FAIL",
  detail: { surfaces: baselineLeakage },
});

// ── 3. the treatment policy is the mandate and only the mandate ─────

const treatmentPolicy = readFileSync(envByArm.vtrace_compact.VTRACE_TASK_TRIGGER_FILE!, "utf-8");

record({
  id: "TREATMENT_POLICY_IS_THE_MANDATE_ONLY",
  arm: "vtrace_compact",
  question: "does the delivered policy file contain the mandate, no prohibition and no detail argument?",
  status:
    treatmentPolicy === claudeMdForArm("vtrace_compact")
    && treatmentPolicy.includes(M173_PIPELINE_TOOL_NAME)
    && !treatmentPolicy.toLowerCase().includes("do not use grep")
    && !treatmentPolicy.includes("detail")
      ? "PASS" : "FAIL",
  detail: { characters: treatmentPolicy.length, namesPipelineTool: treatmentPolicy.includes(M173_PIPELINE_TOOL_NAME) },
});

const mcpConfig = JSON.parse(readFileSync(envByArm.vtrace_compact.VTRACE_MCP_CONFIG!, "utf-8")) as {
  mcpServers: { vtrace?: { args?: string[] } };
};

record({
  id: "TOOL_INVENTORY_IS_THE_FROZEN_TWO",
  arm: "vtrace_compact",
  question: "does the MCP config expose exactly the M168-frozen inventory?",
  status: (mcpConfig.mcpServers.vtrace?.args ?? []).includes(M173_VISIBLE_TOOL_IDS.join(","))
    && envByArm.vtrace_compact.VTRACE_MCP_ALLOWED_TOOLS
      === M173_VISIBLE_TOOL_IDS.map((t) => `mcp__vtrace__${t}`).join(",")
    ? "PASS" : "FAIL",
  detail: {
    tools: M173_VISIBLE_TOOL_IDS,
    allowed: envByArm.vtrace_compact.VTRACE_MCP_ALLOWED_TOOLS,
  },
});

// ── 4. the shipped default really is compact, and debug really is not ─

interface Probe {
  readonly toolsListed: readonly string[];
  readonly defaultDisclosure: Disclosure | null;
  readonly defaultCharacters: number;
  readonly debugDisclosure: Disclosure | null;
  readonly debugCharacters: number;
  readonly error: string | null;
}

async function probe(): Promise<Probe> {
  if (!existsSync(path.join(SMOKE_WORKSPACE, ".vtrace", "index.sqlite"))) {
    return {
      toolsListed: [], defaultDisclosure: null, defaultCharacters: 0,
      debugDisclosure: null, debugCharacters: 0,
      error: `no index at ${SMOKE_WORKSPACE}`,
    };
  }
  const messages: unknown[] = [
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "m173-smoke", version: "1" } } },
    { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
    { jsonrpc: "2.0", id: 100, method: "tools/call", params: { name: "run_pipeline", arguments: { task: "fix the unit conversion bug", repo_root: SMOKE_WORKSPACE } } },
    { jsonrpc: "2.0", id: 101, method: "tools/call", params: { name: "run_pipeline", arguments: { task: "fix the unit conversion bug", repo_root: SMOKE_WORKSPACE, detail: "debug" } } },
  ];
  return await new Promise((resolve) => {
    const child = spawn(
      "bun",
      ["src/cli/index.ts", "mcp-serve", "--repo", SMOKE_WORKSPACE, "--tools", M173_VISIBLE_TOOL_IDS.join(",")],
      { cwd: ROOT, stdio: ["pipe", "pipe", "pipe"] },
    );
    let stdout = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), 600_000);
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.on("close", () => {
      clearTimeout(timer);
      const byId = new Map<number, Record<string, unknown>>();
      for (const line of stdout.split("\n")) {
        if (!line.trim().startsWith("{")) continue;
        try {
          const row = JSON.parse(line) as Record<string, unknown>;
          if (typeof row.id === "number") byId.set(row.id, row);
        } catch { /* not a protocol frame */ }
      }
      const listed = ((byId.get(2) as { result?: { tools?: { name?: string }[] } } | undefined)?.result?.tools ?? [])
        .map((t) => String(t.name ?? "")).sort();
      const serialize = (id: number): string => {
        const structured = (byId.get(id) as { result?: { structuredContent?: unknown } } | undefined)?.result?.structuredContent;
        return structured === undefined || structured === null ? "" : JSON.stringify(structured);
      };
      const defaultText = serialize(100);
      const debugText = serialize(101);
      resolve({
        toolsListed: Object.freeze(listed),
        defaultDisclosure: defaultText === "" ? null : classifyDisclosure(defaultText),
        defaultCharacters: defaultText.length,
        debugDisclosure: debugText === "" ? null : classifyDisclosure(debugText),
        debugCharacters: debugText.length,
        error: null,
      });
    });
    for (const message of messages) child.stdin.write(`${JSON.stringify(message)}\n`);
    child.stdin.end();
  });
}

const probed = await probe();
writeFileSync(path.join(SMOKE_DIR, "probe.json"), `${JSON.stringify(probed, null, 2)}\n`);

record({
  id: "SERVER_LISTS_EXACTLY_THE_FROZEN_TWO",
  arm: "vtrace_compact",
  question: "does a live tools/list return exactly the two frozen tools?",
  status: JSON.stringify(probed.toolsListed) === JSON.stringify([...M173_VISIBLE_TOOL_IDS].sort())
    ? "PASS" : "FAIL",
  detail: { listed: probed.toolsListed, expected: [...M173_VISIBLE_TOOL_IDS].sort() },
});

record({
  id: "DEFAULT_DISCLOSURE_IS_THE_COMPACT_ORIENTATION",
  arm: "vtrace_compact",
  question: "does an unqualified run_pipeline call return the M172 orientation packet?",
  status: probed.defaultDisclosure === Disclosure.CompactOrientation ? "PASS" : "FAIL",
  detail: {
    disclosure: probed.defaultDisclosure,
    characters: probed.defaultCharacters,
    schemaVersion: ORIENTATION_SCHEMA_VERSION,
    error: probed.error,
  },
});

record({
  id: "DEBUG_IS_A_DIFFERENT_AND_LARGER_PAYLOAD",
  arm: "vtrace_compact",
  question:
    "is detail=debug distinguishable from the default? A control that cannot tell them apart "
    + "could not detect debug contamination in a live transcript either.",
  status:
    probed.debugDisclosure === Disclosure.AuthoritativeDebug
    && probed.debugCharacters > probed.defaultCharacters
      ? "PASS" : "FAIL",
  detail: {
    defaultCharacters: probed.defaultCharacters,
    debugCharacters: probed.debugCharacters,
    ratio: probed.defaultCharacters === 0 ? null : Number((probed.debugCharacters / probed.defaultCharacters).toFixed(2)),
    debugDisclosure: probed.debugDisclosure,
  },
});

// ── 5. the grader path ──────────────────────────────────────────────

const docker = spawnSync("docker", ["info", "--format", "{{.ServerVersion}}"], { encoding: "utf-8", timeout: 60_000 });
record({
  id: "GRADER_PATH_AVAILABLE",
  arm: "all",
  question: "is the Docker daemon that grades SWE-bench resolution reachable?",
  status: docker.status === 0 ? "PASS" : "FAIL",
  detail: { serverVersion: (docker.stdout ?? "").trim(), error: (docker.stderr ?? "").trim().slice(0, 200) },
});

// ── 6. what only a live agent can settle ────────────────────────────

const awaiting: readonly (readonly [string, M173Arm | "all", string])[] = Object.freeze([
  ["BASELINE_TRANSCRIPT_MENTIONS_NO_VTRACE", "baseline",
    "does the baseline transcript's system/init event list zero vtrace tools and zero MCP servers?"],
  ["FIRST_REPOSITORY_ACTION_IS_THE_PIPELINE", "vtrace_compact",
    "is run_pipeline the treatment arm's first repository-intelligence action, with zero ordinary repo actions before it?"],
  ["MODEL_SEES_THE_COMPACT_PACKET", "vtrace_compact",
    "does the tool_result the model received classify as COMPACT_ORIENTATION?"],
  ["MODEL_NEVER_SEES_THE_AUTHORITATIVE_RESULT", "vtrace_compact",
    "does any tool_result in the treatment transcript classify as AUTHORITATIVE_DEBUG?"],
  ["LIVE_ORIENTATION_SIZE_MATCHES_THE_OFFLINE_PROJECTION", "vtrace_compact",
    "is the live model-facing orientation within an order of magnitude of M172's ~621-token projection?"],
]);

for (const [id, arm, question] of awaiting) {
  record({ id, arm, question, status: "AWAITING_FIRST_PAIR", detail: { resolvedBy: "the §58 first-pair validity gate" } });
}

// ── report ──────────────────────────────────────────────────────────

const pass = controls.filter((c) => c.status === "PASS").length;
const fail = controls.filter((c) => c.status === "FAIL").length;
const pending = controls.filter((c) => c.status === "AWAITING_FIRST_PAIR").length;

writeFileSync(path.join(RESULTS, "stage5_m173_smoke.json"), `${JSON.stringify({
  schemaVersion: "stage5.m173.smoke.v1",
  milestone: "M173",
  workstream: "M173-A",
  smokeInstance: SMOKE_INSTANCE,
  outOfDenominator: "astropy__astropy-13977 is in Broad100-B, in neither the frozen twelve nor the holdout",
  rule: "AWAITING_FIRST_PAIR is not a pass; those five are resolved by the §58 validity gate and never assumed",
  counts: { pass, fail, awaitingFirstPair: pending },
  offlinePasses: fail === 0,
  controls,
}, null, 2)}\n`);

console.log(`M173 smoke: ${pass} pass, ${fail} fail, ${pending} awaiting the first live pair`);
for (const c of controls) console.log(`  ${c.status.padEnd(20)} ${c.id}`);
process.exit(fail === 0 ? 0 : 1);
