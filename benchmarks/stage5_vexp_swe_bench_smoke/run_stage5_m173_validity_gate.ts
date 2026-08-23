/**
 * M173-B — the first-pair validity gate (§58), and the standing stop conditions
 * (§59) re-evaluated after every task.
 *
 *   bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m173_validity_gate.ts
 *   bun ... run_stage5_m173_validity_gate.ts --instance astropy__astropy-14369
 *
 * The distinction this file exists to enforce is §60's: an APPARATUS defect
 * stops the sweep, an EXPERIMENTAL outcome does not. VTRACE losing a task,
 * costing more, being ignored, picking a wrong pivot or watching the agent
 * re-search everything are results and are explicitly not checked here.
 *
 * What is checked is whether the run measured what it claims to measure. Each
 * gate names the artifact it reads, and a gate whose evidence is missing
 * reports UNOBSERVABLE rather than passing — M167's rule, which this repository
 * has broken four times and caught four times by a number that looked too good.
 *
 * Offline. Reads captured artifacts only.
 */

import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { parseRun, checkBillingIdentity, censoringOf, Censoring } from "./m169Economics";
import { Disclosure, classifyDisclosure } from "./m173Treatment";

const RESULTS = path.resolve("benchmarks/stage5_vexp_swe_bench_smoke/results");
const RUNS = path.join(RESULTS, "runs");

const argv = process.argv.slice(2);
const instanceFlag = argv.indexOf("--instance");
const requestedInstance = instanceFlag === -1 ? null : argv[instanceFlag + 1]!;

type Verdict = "PASS" | "FAIL" | "UNOBSERVABLE";

interface Gate {
  readonly id: string;
  readonly scope: "baseline" | "vtrace_compact" | "pair";
  readonly question: string;
  readonly verdict: Verdict;
  readonly evidence: unknown;
}

const labelFor = (arm: string, instanceId: string): string =>
  `m173_${arm}_${instanceId.replace(/-/g, "_")}`;

function rawDir(label: string): string | null {
  const parent = path.join(RUNS, label, "raw");
  if (!existsSync(parent)) return null;
  for (const child of readdirSync(parent)) {
    const dir = path.join(parent, child);
    if (readdirSync(dir).some((f) => f.startsWith("swebench-") && f.endsWith(".jsonl"))) return dir;
  }
  return null;
}

interface Run {
  readonly label: string;
  readonly raw: string;
  readonly lines: readonly string[];
  readonly meta: Record<string, unknown>;
}

function loadRun(arm: string, instanceId: string): Run | null {
  const label = labelFor(arm, instanceId);
  const raw = rawDir(label);
  if (raw === null) return null;
  const stream = path.join(raw, "_agent_stream.first_pass.jsonl");
  if (!existsSync(stream)) return null;
  const metaPath = path.join(raw, "_run.meta.json");
  return {
    label,
    raw,
    lines: readFileSync(stream, "utf-8").split("\n"),
    meta: existsSync(metaPath) ? JSON.parse(readFileSync(metaPath, "utf-8")) as Record<string, unknown> : {},
  };
}

function initEvent(lines: readonly string[]): Record<string, unknown> | null {
  for (const line of lines) {
    if (line.trim() === "") continue;
    try {
      const row = JSON.parse(line) as Record<string, unknown>;
      if (row.type === "system" && row.subtype === "init") return row;
    } catch { /* not a protocol frame */ }
  }
  return null;
}

/** Every tool_result text in order, so disclosure can be classified on all of them. */
function toolResultTexts(lines: readonly string[]): readonly string[] {
  const texts: string[] = [];
  for (const line of lines) {
    if (line.trim() === "") continue;
    let row: Record<string, unknown>;
    try { row = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
    if (row.type !== "user") continue;
    const message = row.message as Record<string, unknown> | undefined;
    const blocks = (Array.isArray(message?.content) ? message?.content : []) as Record<string, unknown>[];
    for (const block of blocks) {
      if (block.type !== "tool_result") continue;
      const content = block.content;
      texts.push(typeof content === "string" ? content : JSON.stringify(content ?? ""));
    }
  }
  return Object.freeze(texts);
}

function gatesFor(instanceId: string): { instanceId: string; gates: Gate[] } {
  const gates: Gate[] = [];
  const baseline = loadRun("baseline", instanceId);
  const compact = loadRun("vtrace_compact", instanceId);

  // ── baseline isolation ────────────────────────────────────────────
  const baselineInit = baseline === null ? null : initEvent(baseline.lines);
  gates.push({
    id: "BASELINE_SESSION_CARRIES_NO_VTRACE",
    scope: "baseline",
    question: "does the baseline session list zero vtrace tools and zero MCP servers?",
    verdict: baselineInit === null
      ? "UNOBSERVABLE"
      : (() => {
        const tools = (Array.isArray(baselineInit.tools) ? baselineInit.tools : []).map(String);
        const servers = Array.isArray(baselineInit.mcp_servers) ? baselineInit.mcp_servers : [];
        return tools.every((t) => !t.toLowerCase().includes("vtrace")) && servers.length === 0
          ? "PASS" : "FAIL";
      })(),
    evidence: baselineInit === null ? { reason: "no system/init event" } : {
      vtraceTools: (Array.isArray(baselineInit.tools) ? baselineInit.tools : [])
        .map(String).filter((t) => t.toLowerCase().includes("vtrace")),
      mcpServers: baselineInit.mcp_servers ?? [],
    },
  });

  gates.push({
    id: "BASELINE_RECEIVED_NO_POLICY",
    scope: "baseline",
    question: "was any policy trigger file injected into the baseline prompt?",
    verdict: baseline === null
      ? "UNOBSERVABLE"
      : baseline.meta.stage5M163TriggerInjected === true ? "FAIL" : "PASS",
    evidence: baseline === null ? null : {
      triggerInjected: baseline.meta.stage5M163TriggerInjected ?? null,
      contextInjected: baseline.meta.vtraceContextInjected ?? null,
    },
  });

  // ── treatment delivery ────────────────────────────────────────────
  const compactInit = compact === null ? null : initEvent(compact.lines);
  gates.push({
    id: "TREATMENT_SESSION_HAS_EXACTLY_THE_FROZEN_TWO",
    scope: "vtrace_compact",
    question: "does the treatment session expose exactly run_pipeline and get_impact_graph?",
    verdict: compactInit === null
      ? "UNOBSERVABLE"
      : (() => {
        const vtraceTools = (Array.isArray(compactInit.tools) ? compactInit.tools : [])
          .map(String).filter((t) => t.toLowerCase().includes("vtrace")).sort();
        return JSON.stringify(vtraceTools)
          === JSON.stringify(["mcp__vtrace__get_impact_graph", "mcp__vtrace__run_pipeline"])
          ? "PASS" : "FAIL";
      })(),
    evidence: compactInit === null ? { reason: "no system/init event" } : {
      vtraceTools: (Array.isArray(compactInit.tools) ? compactInit.tools : [])
        .map(String).filter((t) => t.toLowerCase().includes("vtrace")).sort(),
      mcpServers: compactInit.mcp_servers ?? [],
    },
  });

  gates.push({
    id: "TREATMENT_POLICY_WAS_INJECTED",
    scope: "vtrace_compact",
    question: "did the mandate actually reach the prompt?",
    verdict: compact === null
      ? "UNOBSERVABLE"
      : compact.meta.stage5M163TriggerInjected === true && compact.meta.stage5M163TriggerMissing !== true
        ? "PASS" : "FAIL",
    evidence: compact === null ? null : {
      triggerInjected: compact.meta.stage5M163TriggerInjected ?? null,
      triggerMissing: compact.meta.stage5M163TriggerMissing ?? null,
      triggerFile: compact.meta.stage5M163TriggerFile ?? null,
    },
  });

  // ── the disclosure the model saw ──────────────────────────────────
  const compactResults = compact === null ? [] : toolResultTexts(compact.lines);
  const disclosures = compactResults.map(classifyDisclosure);
  const compactSeen = disclosures.filter((d) => d === Disclosure.CompactOrientation).length;
  const debugSeen = disclosures.filter((d) => d === Disclosure.AuthoritativeDebug).length;

  gates.push({
    id: "MODEL_SAW_A_COMPACT_ORIENTATION",
    scope: "vtrace_compact",
    question: "did at least one tool_result classify as the M172 orientation packet?",
    verdict: compact === null ? "UNOBSERVABLE" : compactSeen > 0 ? "PASS" : "FAIL",
    evidence: { compactOrientationResults: compactSeen, toolResults: compactResults.length },
  });

  gates.push({
    id: "MODEL_SAW_NO_AUTHORITATIVE_DEBUG",
    scope: "vtrace_compact",
    question: "did any tool_result hand the model the authoritative orchestration result?",
    verdict: compact === null ? "UNOBSERVABLE" : debugSeen === 0 ? "PASS" : "FAIL",
    evidence: {
      authoritativeDebugResults: debugSeen,
      note:
        "`detail` is agent-reachable and blocking it would be a product change. A failure here "
        + "is a measured product behaviour to classify, not necessarily an apparatus fault — but "
        + "it does invalidate the compact-treatment reading of that run.",
    },
  });

  // ── index validity ────────────────────────────────────────────────
  const notReady = compactResults.filter((t) => t.includes("repo_not_ready") || t.includes("index_corrupt")).length;
  gates.push({
    id: "INDEX_ANSWERED_RATHER_THAN_REFUSED",
    scope: "vtrace_compact",
    question: "did the pipeline return a readiness or corruption envelope? (§18 — apparatus, not treatment)",
    verdict: compact === null ? "UNOBSERVABLE" : notReady === 0 ? "PASS" : "FAIL",
    evidence: { notReadyResults: notReady },
  });

  // ── runtime accounting ────────────────────────────────────────────
  for (const [scope, run] of [["baseline", baseline], ["vtrace_compact", compact]] as const) {
    const parsed = run === null ? null : parseRun(run.lines);
    const censoring = parsed === null ? null : censoringOf(parsed);
    const identity = parsed?.result == null
      ? null
      : checkBillingIdentity(parsed.result.usage, parsed.result.costUsd, undefined, 1e-9);
    gates.push({
      id: `ACCOUNTING_IDENTITY_HOLDS_${scope.toUpperCase()}`,
      scope,
      question: "does the corrected reconstruction reproduce the provider's own cost for this run?",
      verdict: parsed === null
        ? "UNOBSERVABLE"
        : censoring === Censoring.CostCensored
          ? "UNOBSERVABLE"
          : identity?.holds === true ? "PASS" : "FAIL",
      evidence: {
        censoring,
        reportedUsd: parsed?.result?.costUsd ?? null,
        deltaUsd: identity?.deltaUsd ?? null,
      },
    });
  }

  // ── session isolation (§15) ───────────────────────────────────────
  const sessionIds = [baseline, compact]
    .map((run) => (run === null ? null : initEvent(run.lines)?.session_id ?? null))
    .filter((s): s is string => typeof s === "string");
  gates.push({
    id: "ARMS_RAN_IN_SEPARATE_SESSIONS",
    scope: "pair",
    question: "did the two arms share a model session?",
    verdict: sessionIds.length < 2
      ? "UNOBSERVABLE"
      : new Set(sessionIds).size === sessionIds.length ? "PASS" : "FAIL",
    evidence: { sessionIds },
  });

  return { instanceId, gates };
}

// ── which instances to evaluate ─────────────────────────────────────

const schedule = JSON.parse(
  readFileSync(path.join(RESULTS, "stage5_m173_schedule.json"), "utf-8"),
) as { schedule: { order: number; instanceId: string }[] };

const ordered = schedule.schedule.sort((a, b) => a.order - b.order).map((r) => r.instanceId);
const instances = requestedInstance === null
  ? ordered.filter((id) => loadRun("baseline", id) !== null || loadRun("vtrace_compact", id) !== null)
  : [requestedInstance];

if (instances.length === 0) {
  console.log("no M173 runs to evaluate yet");
  process.exit(0);
}

const evaluated = instances.map(gatesFor);
const allGates = evaluated.flatMap((e) => e.gates);
const failures = allGates.filter((g) => g.verdict === "FAIL");
const unobservable = allGates.filter((g) => g.verdict === "UNOBSERVABLE");

const report = {
  schemaVersion: "stage5.m173.validity-gate.v1",
  milestone: "M173",
  workstream: "M173-B",
  rule:
    "§59/§60 — apparatus defects stop the sweep; experimental outcomes do not. A losing, "
    + "expensive, ignored or wrongly-pivoted treatment run is a RESULT and is not checked here.",
  firstPairGate: {
    instanceId: ordered[0],
    evaluated: instances.includes(ordered[0]!),
  },
  counts: {
    instances: evaluated.length,
    gates: allGates.length,
    pass: allGates.filter((g) => g.verdict === "PASS").length,
    fail: failures.length,
    unobservable: unobservable.length,
  },
  proceed: failures.length === 0,
  failures: failures.map((f) => ({ id: f.id, scope: f.scope, evidence: f.evidence })),
  perInstance: evaluated,
};

writeFileSync(path.join(RESULTS, "stage5_m173_validity_gate.json"), `${JSON.stringify(report, null, 2)}\n`);

console.log(`M173 validity gate over ${evaluated.length} instance(s)`);
console.log(`  ${report.counts.pass} pass, ${report.counts.fail} fail, ${report.counts.unobservable} unobservable`);
for (const e of evaluated) {
  const bad = e.gates.filter((g) => g.verdict !== "PASS");
  console.log(`  ${e.instanceId.padEnd(34)} ${bad.length === 0 ? "clean" : bad.map((g) => `${g.verdict}:${g.id}`).join(" ")}`);
}
console.log(report.proceed ? "\nPROCEED" : "\nSTOP — apparatus defect");
process.exit(report.proceed ? 0 : 1);
