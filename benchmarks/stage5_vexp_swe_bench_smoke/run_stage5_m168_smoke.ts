/**
 * M168-D — same-path smoke controls for all three arms, before any spend.
 *
 *   bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m168_smoke.ts
 *
 * Everything here is free: no agent is spawned, no model token is billed. The
 * controls that genuinely need a live agent are named as NOT RUN and carried
 * into the authorisation request rather than quietly skipped — M168's own rule
 * is that NOT_RUN is not a pass.
 *
 * The workspace probed is astropy__astropy-13977, which is in Broad100-B and
 * therefore OUT of this experiment's denominator: it is in neither the frozen
 * twelve nor the eighty-eight-task holdout, so the smoke touches neither.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import {
  M168_ARMS,
  M168_PIPELINE_TOOL_NAME,
  M168_PROHIBITION_TEXT,
  M168_VISIBLE_TOOL_IDS,
  claudeMdForArm,
  guardScript,
  type M168Arm,
} from "./m168Treatment";

const ROOT = path.resolve(".");
const RESULTS = path.join(ROOT, "benchmarks/stage5_vexp_swe_bench_smoke/results");
const SMOKE_DIR = path.join(RESULTS, "_m168_smoke");
const WIRING = path.join(ROOT, "benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m168_arm_wiring.ts");
const SMOKE_INSTANCE = "astropy__astropy-13977";
const SMOKE_WORKSPACE = path.join(
  RESULTS, "workspaces", `m164_tools_neutral_policy_${SMOKE_INSTANCE.replace(/-/g, "_")}`, SMOKE_INSTANCE,
);

mkdirSync(SMOKE_DIR, { recursive: true });

interface Control {
  readonly id: string;
  readonly arm: M168Arm | "all";
  readonly question: string;
  status: "PASS" | "FAIL" | "NOT_RUN";
  detail: unknown;
}

const controls: Control[] = [];
const record = (c: Control) => { controls.push(c); return c; };

// ── 1. wiring emits exactly what each arm should have ───────────────

function wiringEnv(arm: M168Arm, label: string): Record<string, string> {
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
  M168_ARMS.map((arm) => [arm, wiringEnv(arm, `m168_smoke_${arm}`)]),
) as Record<M168Arm, Record<string, string>>;

record({
  id: "baseline-leakage",
  arm: "baseline",
  question: "does the baseline carry any VTRACE server, policy, hook or tool?",
  status: Object.keys(envByArm.baseline).length === 0 ? "PASS" : "FAIL",
  detail: { emittedEnvKeys: Object.keys(envByArm.baseline) },
});

record({
  id: "strict-has-guard",
  arm: "vtrace_strict",
  question: "does only the strict arm register a PreToolUse hook?",
  status:
    envByArm.vtrace_strict.VTRACE_TOOL_LOOP_GUARD_HOOK_SETTINGS !== undefined
    && envByArm.vtrace_clean.VTRACE_TOOL_LOOP_GUARD_HOOK_SETTINGS === undefined
      ? "PASS" : "FAIL",
  detail: {
    strict: envByArm.vtrace_strict.VTRACE_TOOL_LOOP_GUARD_HOOK_SETTINGS ?? null,
    clean: envByArm.vtrace_clean.VTRACE_TOOL_LOOP_GUARD_HOOK_SETTINGS ?? null,
  },
});

const strictMcp = readFileSync(envByArm.vtrace_strict.VTRACE_MCP_CONFIG!, "utf-8")
  .replace(/m168_smoke_vtrace_strict/g, "LABEL");
const cleanMcp = readFileSync(envByArm.vtrace_clean.VTRACE_MCP_CONFIG!, "utf-8")
  .replace(/m168_smoke_vtrace_clean/g, "LABEL");

record({
  id: "identical-engine-config",
  arm: "all",
  question: "do B and C get the identical MCP config and tool inventory?",
  status: strictMcp === cleanMcp
    && envByArm.vtrace_strict.VTRACE_MCP_ALLOWED_TOOLS === envByArm.vtrace_clean.VTRACE_MCP_ALLOWED_TOOLS
    ? "PASS" : "FAIL",
  detail: {
    configsIdenticalModuloLabel: strictMcp === cleanMcp,
    allowedTools: envByArm.vtrace_strict.VTRACE_MCP_ALLOWED_TOOLS,
  },
});

const strictPolicy = readFileSync(envByArm.vtrace_strict.VTRACE_TASK_TRIGGER_FILE!, "utf-8");
const cleanPolicy = readFileSync(envByArm.vtrace_clean.VTRACE_TASK_TRIGGER_FILE!, "utf-8");

record({
  id: "policy-differs-by-exactly-the-prohibition",
  arm: "all",
  question: "is the coercive policy the ONLY textual difference between B and C?",
  status: strictPolicy.replace(M168_PROHIBITION_TEXT, "") === cleanPolicy ? "PASS" : "FAIL",
  detail: {
    strictChars: strictPolicy.length,
    cleanChars: cleanPolicy.length,
    differenceChars: strictPolicy.length - cleanPolicy.length,
    prohibitionChars: M168_PROHIBITION_TEXT.length,
    bothChannels: "VTRACE_TASK_TRIGGER_FILE, appended as the last prompt section",
  },
});

// ── 2. the guard actually denies, and actually stops denying ────────

const guardPath = envByArm.vtrace_strict.VTRACE_TOOL_LOOP_GUARD_HOOK_SETTINGS!;
const settings = JSON.parse(readFileSync(guardPath, "utf-8")) as {
  hooks: { PreToolUse: { matcher: string; hooks: { command: string }[] }[] };
};
const hookCmd = settings.hooks.PreToolUse[0]!.hooks[0]!.command;

record({
  id: "guard-matcher-scope",
  arm: "vtrace_strict",
  question: "does the hook match exactly Grep|Glob and nothing more?",
  status: settings.hooks.PreToolUse[0]!.matcher === "Grep|Glob" ? "PASS" : "FAIL",
  detail: { matcher: settings.hooks.PreToolUse[0]!.matcher },
});

// Fire the real script against a real workspace, both ways.
const readyRepo = path.join(SMOKE_DIR, "ready-repo");
const unreadyRepo = path.join(SMOKE_DIR, "unready-repo");
mkdirSync(path.join(readyRepo, ".vtrace"), { recursive: true });
mkdirSync(unreadyRepo, { recursive: true });
writeFileSync(path.join(readyRepo, ".vtrace", "index.sqlite"), "");

function fireGuard(repo: string): { code: number | null; stdout: string; events: string } {
  const events = path.join(SMOKE_DIR, `guard-events-${path.basename(repo)}.jsonl`);
  const script = path.join(SMOKE_DIR, `guard-${path.basename(repo)}.sh`);
  writeFileSync(script, guardScript(repo, events), { mode: 0o755 });
  const proc = spawnSync("bash", [script], { encoding: "utf-8" });
  return {
    code: proc.status,
    stdout: proc.stdout.trim(),
    events: existsSync(events) ? readFileSync(events, "utf-8").trim() : "",
  };
}

const denied = fireGuard(readyRepo);
const allowed = fireGuard(unreadyRepo);

record({
  id: "guard-denies-when-engine-ready",
  arm: "vtrace_strict",
  question: "does the guard deny with exit 2 when the index exists?",
  status: denied.code === 2 && denied.stdout.startsWith("DENY:") ? "PASS" : "FAIL",
  detail: { exitCode: denied.code, message: denied.stdout, eventLogged: denied.events !== "" },
});

record({
  id: "guard-allows-when-engine-absent",
  arm: "vtrace_strict",
  question: "does the guard allow — as VEXP's does — when the engine is not ready?",
  status: allowed.code === 0 && allowed.stdout === "" ? "PASS" : "FAIL",
  detail: {
    exitCode: allowed.code,
    eventLogged: allowed.events !== "",
    note: "this failure mode is inherited from the published policy on purpose; "
      + "the event log makes a silently-unguarded run visible in the telemetry",
  },
});

record({
  id: "guard-denial-reason-visibility",
  arm: "vtrace_strict",
  question: "does the model see WHY a search was denied?",
  status: "NOT_RUN",
  detail: {
    reasonStream: "stdout, exit 2 — reproducing the published script exactly",
    modelVisibility: "UNKNOWN",
    why: "requires a live agent; if the reason does not reach the model it may retry "
      + "blindly, which changes the economics the experiment measures. Measured in the "
      + "live smoke, not assumed here.",
  },
});

// ── 3. the engine answers, over the real MCP transport ──────────────

function mcpProbe(repo: string): {
  serverInfo: unknown;
  tools: { name: string; descriptionChars: number }[];
  pipeline: { status: string; chars: number; preview: string };
} {
  const requests = [
    { jsonrpc: "2.0", id: 1, method: "initialize", params: {
      protocolVersion: "2024-11-05", capabilities: {},
      clientInfo: { name: "m168-smoke", version: "0" } } },
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { jsonrpc: "2.0", id: 2, method: "tools/list" },
    { jsonrpc: "2.0", id: 3, method: "tools/call", params: {
      name: "run_pipeline",
      arguments: { task: "Quantity.__array_ufunc__ returns a plain ndarray instead of raising" } } },
  ];
  const proc = spawnSync("bun", [
    path.join(ROOT, "src/cli/index.ts"), "mcp-serve",
    "--repo", repo, "--tools", M168_VISIBLE_TOOL_IDS.join(","),
  ], {
    input: requests.map((r) => JSON.stringify(r)).join("\n") + "\n",
    encoding: "utf-8", maxBuffer: 128 * 1024 * 1024, timeout: 300_000,
  });

  let serverInfo: unknown = null;
  let tools: { name: string; descriptionChars: number }[] = [];
  let pipeline = { status: "CALL_NOT_MADE", chars: 0, preview: "" };

  for (const line of proc.stdout.split("\n")) {
    if (!line.trim()) continue;
    let msg: any;
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg.id === 1) serverInfo = msg.result?.serverInfo ?? null;
    if (msg.id === 2) {
      tools = (msg.result?.tools ?? []).map((t: any) => ({
        name: t.name, descriptionChars: (t.description ?? "").length,
      }));
    }
    if (msg.id === 3) {
      if (msg.error) {
        pipeline = { status: "TOOL_ERROR", chars: 0, preview: JSON.stringify(msg.error).slice(0, 300) };
      } else {
        const text = msg.result?.content?.[0]?.text ?? "";
        const structured = msg.result?.structuredContent;
        const payload = structured !== undefined ? JSON.stringify(structured) : text;
        pipeline = {
          status: payload.length > 0 ? "VALID_NONEMPTY" : "VALID_EMPTY",
          chars: payload.length,
          preview: payload.slice(0, 300),
        };
      }
    }
  }
  return { serverInfo, tools, pipeline };
}

if (existsSync(path.join(SMOKE_WORKSPACE, ".vtrace", "index.sqlite"))) {
  const probe = mcpProbe(SMOKE_WORKSPACE);
  const names = probe.tools.map((t) => t.name).sort();
  const expected = [...M168_VISIBLE_TOOL_IDS].sort();

  record({
    id: "tool-inventory-served",
    arm: "all",
    question: "does the server serve exactly the frozen inventory, under the frozen names?",
    status: JSON.stringify(names) === JSON.stringify(expected) ? "PASS" : "FAIL",
    detail: { served: probe.tools, expected, serverInfo: probe.serverInfo,
      agentVisibleName: M168_PIPELINE_TOOL_NAME },
  });

  record({
    id: "pipeline-returns-evidence",
    arm: "all",
    question: "does the mandated first call return repository evidence?",
    status: probe.pipeline.status === "VALID_NONEMPTY" ? "PASS" : "FAIL",
    detail: { ...probe.pipeline, workspace: SMOKE_WORKSPACE,
      outOfDenominator: "astropy__astropy-13977 is in Broad100-B, not in the 12 or the 88" },
  });
} else {
  record({
    id: "tool-inventory-served",
    arm: "all",
    question: "does the server serve exactly the frozen inventory?",
    status: "NOT_RUN",
    detail: { reason: `no indexed workspace at ${SMOKE_WORKSPACE}` },
  });
  record({
    id: "pipeline-returns-evidence",
    arm: "all",
    question: "does the mandated first call return repository evidence?",
    status: "NOT_RUN",
    detail: { reason: `no indexed workspace at ${SMOKE_WORKSPACE}` },
  });
}

// ── 4. controls that genuinely need a live agent ────────────────────

for (const [id, question] of [
  ["first-action-compliance", "does the agent actually call the mandated tool first, on each VTRACE arm?"],
  ["guard-fires-in-anger", "does the hook deny a Grep the agent actually attempted?"],
  ["baseline-sees-no-vtrace", "does the baseline transcript contain zero VTRACE schemas or calls?"],
  ["cost-per-run", "what does one run of each arm actually cost?"],
] as const) {
  record({
    id, arm: "all", question, status: "NOT_RUN",
    detail: { reason: "requires a live agent spawn; carried into the authorisation request" },
  });
}

// ── report ──────────────────────────────────────────────────────────

const pass = controls.filter((c) => c.status === "PASS").length;
const fail = controls.filter((c) => c.status === "FAIL").length;
const notRun = controls.filter((c) => c.status === "NOT_RUN").length;

const report = {
  milestone: "M168-D",
  spend: "$0.00 — no agent spawned",
  smokeInstance: SMOKE_INSTANCE,
  smokeInstanceDenominatorStatus: "OUT — Broad100-B, disjoint from the VEXP 100",
  workspacePreparation: {
    reProvenHere: false,
    note: "the runner's own workspace/index path is unchanged from M164, where it ran 24 times; "
      + "per-run readiness is asserted again inside the live sweep rather than mocked here",
  },
  offlineControls: { pass, fail },
  liveControlsOutstanding: notRun,
  controls,
  verdict: fail === 0 ? "OFFLINE_CONTROLS_PASS" : "OFFLINE_CONTROLS_FAIL",
};

writeFileSync(
  path.join(RESULTS, "stage5_m168_smoke_controls.json"),
  `${JSON.stringify(report, null, 2)}\n`,
);

console.log(`offline controls: ${pass} pass, ${fail} fail, ${notRun} awaiting a live agent`);
for (const c of controls) console.log(`  [${c.status.padEnd(7)}] ${c.id} — ${c.question}`);
if (fail > 0) process.exit(1);
