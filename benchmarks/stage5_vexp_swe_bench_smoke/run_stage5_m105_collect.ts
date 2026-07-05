// Stage 5 M105 — collect live-run artifacts into the per-case detail +
// aggregate JSON/CSV. Reads CAPTURED artifacts only (no agents, no Docker, no
// API): runs/<label>/raw/vtrace/{_run.meta.json, swebench-*.jsonl,
// _eval.meta.json, _tool_calls.json} and the injected-context snapshot
// runs/<label>/_vtrace_instructions.snapshot.md, which is post-run leak-scanned
// with base-commit provenance against the M103 clean workspace snapshot.
//
//   bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m105_collect.ts \
//     [--data /home/calvin/code/vexp-swe-bench/data/swe-bench-100.jsonl] \
//     [--out benchmarks/stage5_vexp_swe_bench_smoke/results]

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import path from "node:path";

import { loadSweBenchData, toSweBenchInstance } from "./run_stage5_vexp_swe_bench_smoke";
import {
  SMOKE_CASE_IDS,
  derivableFromWorkspace,
  presentInWorkspace,
  scanLeakage,
  type AnnotatedLeakHit,
} from "./run_stage5_m104_live_context_smoke";
import {
  aggregateM105,
  assessRunValidity,
  extractResultRowMetrics,
  joinHistorical,
  type M105CaseRow,
  type ResultRowMetrics,
  type RunMeta,
  type RunValidity,
} from "./run_stage5_m105_report_lib";

const VEXP = "/home/calvin/code/vexp-swe-bench";
const DEFAULT_DATA = path.join(VEXP, "data", "swe-bench-100.jsonl");
const RESULTS_ROOT = path.join("benchmarks", "stage5_vexp_swe_bench_smoke", "results");
const WS_ROOT = path.join(RESULTS_ROOT, "workspaces");
const CLEAN_WS_ROOTS = ["expanded", "cross_repo"] as const;
const M103_DETAIL = path.join(RESULTS_ROOT, "stage5_m103_deterministic_scoreboard.detail.json");
const M104_DETAIL = path.join(RESULTS_ROOT, "stage5_m104_live_context_smoke.detail.json");
const M73_DETAIL = path.join(RESULTS_ROOT, "stage5_m73_final_100_paired.detail.json");
const M92_REPORT = path.join(RESULTS_ROOT, "stage5_m92_core_reduction50_validation.md");
const PREFLIGHT = path.join(RESULTS_ROOT, "stage5_m105_live_preflight.detail.json");

function safeLabel(instanceId: string): string {
  // Mirrors the driver's `tr -c 'a-zA-Z0-9' '_'` over `echo` output (the trailing
  // newline becomes a trailing underscore, exactly as in the M92 label scheme).
  return `m105_small_live_${`${instanceId}\n`.replace(/[^a-zA-Z0-9]/g, "_")}`;
}

function resolveCleanWorkspace(instanceId: string): string | null {
  for (const root of CLEAN_WS_ROOTS) {
    const ws = path.join(WS_ROOT, root, instanceId);
    if (existsSync(path.join(ws, ".vtrace", "index.sqlite"))) return ws;
  }
  return null;
}

function readJson(file: string): unknown | null {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

// Parse the M92 run-matrix markdown table into instance_id -> resolved.
export function parseM92RunMatrix(markdown: string): Map<string, boolean> {
  const out = new Map<string, boolean>();
  for (const line of markdown.split("\n")) {
    const m = /^\| (\S+) \| \w+ \| . \| . \| . \| (.) \| [\d.]+ \| \d+ \| \d+/.exec(line);
    if (m) out.set(m[1]!, m[2] === "✓");
  }
  return out;
}

interface RunArtifacts {
  readonly label: string | null;
  readonly runDir: string | null;
  readonly meta: RunMeta | null;
  readonly row: Record<string, unknown> | null;
  readonly evalMeta: Record<string, unknown> | null;
  readonly toolCallCount: number | null;
  readonly snapshot: string | null;
  readonly revisionArtifacts: string[];
}

function findRunArtifacts(outDir: string, instanceId: string): RunArtifacts {
  const base = safeLabel(instanceId);
  const labels = [base, ...[1, 2, 3, 4].map((n) => `${base}_retry${n}`)];
  for (const label of labels.reverse()) {
    const runDir = path.join(outDir, "runs", label);
    const rawDir = path.join(runDir, "raw", "vtrace");
    if (!existsSync(rawDir)) continue;
    const rowFile = readdirSync(rawDir).find((f) => f.startsWith("swebench-") && f.endsWith(".jsonl"));
    if (rowFile === undefined) continue;
    const rowText = readFileSync(path.join(rawDir, rowFile), "utf8").trim().split("\n")[0] ?? "";
    let row: Record<string, unknown> | null = null;
    try {
      row = JSON.parse(rowText) as Record<string, unknown>;
    } catch {
      row = null;
    }
    const toolCalls = readJson(path.join(rawDir, "_tool_calls.json"));
    const snapshotFile = path.join(runDir, "_vtrace_instructions.snapshot.md");
    return {
      label,
      runDir,
      meta: (readJson(path.join(rawDir, "_run.meta.json")) as RunMeta | null) ?? null,
      row,
      evalMeta: (readJson(path.join(rawDir, "_eval.meta.json")) as Record<string, unknown> | null) ?? null,
      toolCallCount: Array.isArray(toolCalls) ? toolCalls.length : null,
      snapshot: existsSync(snapshotFile) ? readFileSync(snapshotFile, "utf8") : null,
      revisionArtifacts: readdirSync(rawDir).filter(
        (f) => f.startsWith("_pivot_revision") || f.startsWith("_ruleout_sufficiency"),
      ),
    };
  }
  return { label: null, runDir: null, meta: null, row: null, evalMeta: null, toolCallCount: null, snapshot: null, revisionArtifacts: [] };
}

interface DetailCase {
  readonly instance_id: string;
  readonly run_label: string | null;
  readonly preflight_status: "pass" | "fail" | "missing";
  readonly task_hash_match: boolean | null;
  readonly leakage_status: "clean" | "unexplained_hits" | "snapshot_missing" | "not_started";
  readonly leak_unexplained: AnnotatedLeakHit[];
  readonly leak_base_commit_content_count: number | null;
  readonly fallback_status: "none" | "fired" | "unknown";
  readonly live_status: "valid" | "invalid" | "not_attempted";
  readonly eval_status: "evaluated" | "pending" | "not_applicable";
  readonly resolved: boolean | null;
  readonly validity: RunValidity | null;
  readonly metrics: ResultRowMetrics | null;
  readonly historical: ReturnType<typeof joinHistorical>;
  readonly notes: string[];
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const flag = (name: string, fallback: string): string => {
    const idx = argv.indexOf(name);
    return idx >= 0 && argv[idx + 1] !== undefined ? argv[idx + 1]! : fallback;
  };
  const dataPath = flag("--data", DEFAULT_DATA);
  const outDir = flag("--out", RESULTS_ROOT);

  const records = await loadSweBenchData(dataPath);
  const preflight = readJson(path.join(outDir, "stage5_m105_live_preflight.detail.json")) as {
    summary: { gate_pass: boolean };
    cases: Array<{ instance_id: string; preflight_pass: boolean; m104_hash_match: boolean | null }>;
  } | null;
  const m103Rows = new Map(
    ((readJson(M103_DETAIL) as { rows: Array<{ instance_id: string; outcome: string | null }> })?.rows ?? []).map(
      (r) => [r.instance_id, r] as const,
    ),
  );
  const m104Rows = new Map(
    (
      (readJson(M104_DETAIL) as {
        cases: Array<{ instance_id: string; context_leak: { unexplained_count: number } | null }>;
      })?.cases ?? []
    ).map((r) => [r.instance_id, r] as const),
  );
  const m73Rows = new Map(
    ((readJson(M73_DETAIL) as Array<{ instance_id: string; treatment_resolved?: unknown; baseline_resolved?: unknown }>) ?? []).map(
      (r) => [r.instance_id, r] as const,
    ),
  );
  const m92Resolved = parseM92RunMatrix(readFileSync(M92_REPORT, "utf8"));

  const details: DetailCase[] = [];
  const caseRows: M105CaseRow[] = [];
  for (const id of SMOKE_CASE_IDS) {
    const pf = preflight?.cases.find((c) => c.instance_id === id);
    const preflightStatus: "pass" | "fail" | "missing" = pf === undefined ? "missing" : pf.preflight_pass ? "pass" : "fail";
    const artifacts = findRunArtifacts(outDir, id);
    const record = records.find((r) => r.instance_id === id || r.instanceId === id);
    const notes: string[] = [];

    // Post-run leak scan of the ACTUAL injected instructions snapshot.
    let leakStatus: DetailCase["leakage_status"] = "not_started";
    let unexplained: AnnotatedLeakHit[] = [];
    let explainedCount: number | null = null;
    if (artifacts.runDir !== null) {
      if (artifacts.snapshot === null || record === undefined) {
        leakStatus = "snapshot_missing";
      } else {
        const instance = toSweBenchInstance(record);
        const goldPatch = typeof record.patch === "string" ? record.patch : "";
        const passToPass = ((): string[] => {
          const v = record.PASS_TO_PASS ?? record.pass_to_pass;
          if (Array.isArray(v)) return v.filter((x): x is string => typeof x === "string");
          if (typeof v === "string") {
            try {
              const p = JSON.parse(v) as unknown;
              return Array.isArray(p) ? p.filter((x): x is string => typeof x === "string") : [];
            } catch {
              return [];
            }
          }
          return [];
        })();
        const scan = scanLeakage(artifacts.snapshot, { failToPass: instance.failToPass, passToPass, goldPatch });
        const ws = resolveCleanWorkspace(id);
        const annotated: AnnotatedLeakHit[] = scan.hits.map((h) => ({
          ...h,
          in_base_commit_repo: ws !== null && derivableFromWorkspace(ws, h.needle),
        }));
        const annotatedGold = scan.goldAddedLineMatches.map((line) => ({
          kind: "gold_added_line",
          needle: line,
          snippet: "",
          in_base_commit_repo: ws !== null && presentInWorkspace(ws, line),
        }));
        unexplained = [...annotated, ...annotatedGold].filter((h) => !h.in_base_commit_repo);
        explainedCount = annotated.length + annotatedGold.length - unexplained.length;
        leakStatus = unexplained.length === 0 ? "clean" : "unexplained_hits";
        const fullProblem = instance.problemStatement.trim();
        if (fullProblem.length > 200 && artifacts.snapshot.includes(fullProblem)) {
          leakStatus = "unexplained_hits";
          unexplained.push({ kind: "full_problem_statement", needle: "(full problem statement)", snippet: "", in_base_commit_repo: false });
        }
      }
    }

    const validity =
      artifacts.runDir === null
        ? null
        : assessRunValidity({
            meta: artifacts.meta,
            hasResultRow: artifacts.row !== null,
            resultRowParses: artifacts.row !== null,
            unexplainedLeakCount: leakStatus === "snapshot_missing" ? null : unexplained.length,
            revisionArtifactNames: artifacts.revisionArtifacts,
            preflightPassed: preflightStatus === "pass",
          });
    let metrics = artifacts.row === null ? null : extractResultRowMetrics(artifacts.row, artifacts.toolCallCount);
    const evalRan = artifacts.evalMeta?.evaluationRan === true && artifacts.evalMeta?.dockerUsed === true;
    const liveStatus: DetailCase["live_status"] =
      artifacts.runDir === null ? "not_attempted" : validity?.valid === true ? "valid" : "invalid";
    let evalStatus: DetailCase["eval_status"] =
      liveStatus === "valid" ? (evalRan ? "evaluated" : "pending") : "not_applicable";
    // A valid no-patch run cannot be Docker-evaluated but IS a definitive
    // unresolved outcome (SWE-bench semantics: no patch never resolves).
    if (liveStatus === "valid" && metrics !== null && !metrics.patch_produced && !evalRan) {
      metrics = { ...metrics, resolved: false };
      evalStatus = "evaluated";
      notes.push("no patch produced: counted unresolved without Docker evaluation");
    }
    if (artifacts.label !== null && artifacts.label !== safeLabel(id)) notes.push(`operational retry label: ${artifacts.label}`);

    const m104Row = m104Rows.get(id);
    details.push({
      instance_id: id,
      run_label: artifacts.label,
      preflight_status: preflightStatus,
      task_hash_match: pf?.m104_hash_match ?? null,
      leakage_status: leakStatus,
      leak_unexplained: unexplained,
      leak_base_commit_content_count: explainedCount,
      fallback_status: artifacts.meta === null ? "unknown" : validity?.fallback_fired ? "fired" : "none",
      live_status: liveStatus,
      eval_status: evalStatus,
      resolved: evalStatus === "evaluated" ? (metrics?.resolved ?? null) : null,
      validity,
      metrics,
      historical: joinHistorical(
        id,
        m73Rows.get(id),
        m92Resolved.get(id),
        m103Rows.get(id)?.outcome ?? undefined,
        m104Row === undefined ? undefined : (m104Row.context_leak?.unexplained_count ?? 1) === 0,
      ),
      notes,
    });
    caseRows.push({
      instance_id: id,
      preflight_status: preflightStatus,
      live_status: liveStatus,
      eval_status: evalStatus,
      validity,
      metrics,
    });
  }

  const leakageFireCount = details.filter((d) => d.leakage_status === "unexplained_hits").length;
  const aggregate = aggregateM105(caseRows, leakageFireCount);

  const detailPath = path.join(outDir, "stage5_m105_live_runs.detail.json");
  await writeFile(detailPath, `${JSON.stringify({ aggregate, cases: details }, null, 2)}\n`);

  const csvPath = path.join(outDir, "stage5_m105_small_live_confirmation.csv");
  const csvHead =
    "instance_id,preflight_status,task_hash_match,leakage_status,fallback_status,live_status,eval_status,resolved,total_tokens,cache_read_tokens,cost_usd,tool_calls,changed_files,m103_outcome,m73_treatment_resolved,m73_baseline_resolved,m92_resolved";
  const csvRows = details.map((d) =>
    [
      d.instance_id,
      d.preflight_status,
      d.task_hash_match,
      d.leakage_status,
      d.fallback_status,
      d.live_status,
      d.eval_status,
      d.resolved,
      d.metrics?.total_tokens ?? "",
      d.metrics?.cache_read_tokens ?? "",
      d.metrics?.cost_usd?.toFixed(4) ?? "",
      d.metrics?.tool_calls ?? "",
      (d.metrics?.changed_files ?? []).join(";"),
      d.historical.m103_outcome ?? "",
      d.historical.m73_treatment_resolved ?? "",
      d.historical.m73_baseline_resolved ?? "",
      d.historical.m92_resolved ?? "",
    ].join(","),
  );
  await writeFile(csvPath, `${[csvHead, ...csvRows].join("\n")}\n`);

  process.stderr.write(`[m105-collect] wrote ${detailPath} and ${csvPath}\n`);
  console.log(JSON.stringify(aggregate, null, 2));
}

if (import.meta.main) {
  await main();
}
