// Stage 5 M106 — collect the 10 extension live-run artifacts, REUSE the 14
// committed M105 case rows (stage5_m105_live_runs.detail.json — never
// recomputed, never rerun), and aggregate the combined 24-case result. Reads
// CAPTURED artifacts only (no agents, no Docker, no API): per M106 label
// runs/<label>/raw/vtrace/{_run.meta.json, swebench-*.jsonl, _eval.meta.json,
// _tool_calls.json} and the injected-context snapshot
// runs/<label>/_vtrace_instructions.snapshot.md (post-run leak-scanned with
// base-commit provenance against the M103 clean workspace snapshot).
//
//   bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m106_collect.ts \
//     [--data /home/calvin/code/vexp-swe-bench/data/swe-bench-100.jsonl] \
//     [--out benchmarks/stage5_vexp_swe_bench_smoke/results]

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import path from "node:path";

import { loadSweBenchData, toSweBenchInstance } from "./run_stage5_vexp_swe_bench_smoke";
import {
  derivableFromWorkspace,
  presentInWorkspace,
  scanLeakage,
  type AnnotatedLeakHit,
} from "./run_stage5_m104_live_context_smoke";
import { parseM92RunMatrix } from "./run_stage5_m105_collect";
import {
  assessRunValidity,
  extractResultRowMetrics,
  joinHistorical,
  type M105Aggregate,
  type M105CaseRow,
  type ResultRowMetrics,
  type RunMeta,
  type RunValidity,
} from "./run_stage5_m105_report_lib";
import { aggregateCombined, toM105CaseRow } from "./run_stage5_m106_lib";

const VEXP = "/home/calvin/code/vexp-swe-bench";
const DEFAULT_DATA = path.join(VEXP, "data", "swe-bench-100.jsonl");
const RESULTS_ROOT = path.join("benchmarks", "stage5_vexp_swe_bench_smoke", "results");
const WS_ROOT = path.join(RESULTS_ROOT, "workspaces");
const CLEAN_WS_ROOTS = ["expanded", "cross_repo"] as const;
const M103_DETAIL = path.join(RESULTS_ROOT, "stage5_m103_deterministic_scoreboard.detail.json");
const M73_DETAIL = path.join(RESULTS_ROOT, "stage5_m73_final_100_paired.detail.json");
const M92_REPORT = path.join(RESULTS_ROOT, "stage5_m92_core_reduction50_validation.md");
const M105_RUNS = path.join(RESULTS_ROOT, "stage5_m105_live_runs.detail.json");
const SELECTION = path.join(RESULTS_ROOT, "stage5_m106_case_selection.json");
const PREFLIGHT = path.join(RESULTS_ROOT, "stage5_m106_live_preflight.detail.json");

function safeLabel(instanceId: string): string {
  // Mirrors the driver's `tr -c 'a-zA-Z0-9' '_'` over `echo` output (trailing
  // newline -> trailing underscore, exactly as in the M92/M105 label scheme).
  return `m106_live_ext_${`${instanceId}\n`.replace(/[^a-zA-Z0-9]/g, "_")}`;
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
  readonly selection_stratum: string;
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
  const selection = readJson(SELECTION) as {
    selected: Array<{ instance_id: string; selection_stratum: string }>;
  };
  const preflight = readJson(PREFLIGHT) as {
    summary: { gate_pass: boolean };
    cases: Array<{
      instance_id: string;
      preflight_pass: boolean;
      m103_task_text_exact_match: boolean | null;
      structured_task_hash: string;
    }>;
  } | null;
  const m103Rows = new Map(
    ((readJson(M103_DETAIL) as { rows: Array<{ instance_id: string; outcome: string | null }> })?.rows ?? []).map(
      (r) => [r.instance_id, r] as const,
    ),
  );
  const m73Rows = new Map(
    ((readJson(M73_DETAIL) as Array<{ instance_id: string; treatment_resolved?: unknown; baseline_resolved?: unknown }>) ?? []).map(
      (r) => [r.instance_id, r] as const,
    ),
  );
  const m92Resolved = parseM92RunMatrix(readFileSync(M92_REPORT, "utf8"));

  const details: DetailCase[] = [];
  const caseRows: M105CaseRow[] = [];
  for (const { instance_id: id, selection_stratum } of selection.selected) {
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

    details.push({
      instance_id: id,
      selection_stratum,
      run_label: artifacts.label,
      preflight_status: preflightStatus,
      // The M106 cases have no frozen M104 hash (not in the M104 smoke); the
      // binding parity anchor is the frozen M103 detail row.
      task_hash_match: pf?.m103_task_text_exact_match ?? null,
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
        undefined, // not in the M104 smoke
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

  // --- Reuse (never recompute) the committed M105 case rows -----------------
  const m105Detail = readJson(M105_RUNS) as {
    aggregate: M105Aggregate;
    cases: Array<Record<string, unknown>>;
  } | null;
  if (m105Detail === null) throw new Error(`committed M105 detail missing/unparseable: ${M105_RUNS}`);
  const m105Rows: M105CaseRow[] = m105Detail.cases.map((c) => {
    const row = toM105CaseRow(c);
    if (row === null) throw new Error(`committed M105 case row failed shape validation: ${JSON.stringify(c).slice(0, 200)}`);
    return row;
  });

  const m106LeakageFireCount = details.filter((d) => d.leakage_status === "unexplained_hits").length;
  const m105LeakageFireCount = m105Detail.aggregate.leakage_fire_count;
  const aggregates = aggregateCombined(m105Rows, caseRows, m105LeakageFireCount, m106LeakageFireCount);
  const m105ReaggregationMatches = JSON.stringify(aggregates.m105) === JSON.stringify(m105Detail.aggregate);

  const detailPath = path.join(outDir, "stage5_m106_live_runs.detail.json");
  await writeFile(
    detailPath,
    `${JSON.stringify(
      {
        m105_reused_not_rerun: true,
        m105_source: "stage5_m105_live_runs.detail.json (committed fb791b0)",
        m105_reaggregation_matches: m105ReaggregationMatches,
        aggregates,
        cases: details,
      },
      null,
      2,
    )}\n`,
  );

  // Combined 24-row CSV: the 14 committed M105 rows (set=m105, from the
  // committed detail) + the 10 M106 extension rows (set=m106).
  const csvPath = path.join(outDir, "stage5_m106_24_case_live_confirmation.csv");
  const csvHead =
    "set,instance_id,selection_stratum,preflight_status,task_hash_match,leakage_status,fallback_status,live_status,eval_status,resolved,total_tokens,cache_read_tokens,cost_usd,tool_calls,changed_files,m103_outcome,m73_treatment_resolved,m73_baseline_resolved,m92_resolved";
  const asCsv = (set: string, d: Record<string, unknown>, stratum: string): string => {
    const metrics = d.metrics as ResultRowMetrics | null;
    const hist = d.historical as Record<string, unknown> | undefined;
    return [
      set,
      d.instance_id,
      stratum,
      d.preflight_status,
      d.task_hash_match,
      d.leakage_status,
      d.fallback_status,
      d.live_status,
      d.eval_status,
      d.resolved,
      metrics?.total_tokens ?? "",
      metrics?.cache_read_tokens ?? "",
      metrics?.cost_usd?.toFixed(4) ?? "",
      metrics?.tool_calls ?? "",
      (metrics?.changed_files ?? []).join(";"),
      hist?.m103_outcome ?? "",
      hist?.m73_treatment_resolved ?? "",
      hist?.m73_baseline_resolved ?? "",
      hist?.m92_resolved ?? "",
    ].join(",");
  };
  const csvRows = [
    ...m105Detail.cases.map((c) => asCsv("m105", c, "")),
    ...details.map((d) => asCsv("m106", d as unknown as Record<string, unknown>, d.selection_stratum)),
  ];
  await writeFile(csvPath, `${[csvHead, ...csvRows].join("\n")}\n`);

  process.stderr.write(`[m106-collect] wrote ${detailPath} and ${csvPath}\n`);
  console.log(
    JSON.stringify(
      { m105_reaggregation_matches: m105ReaggregationMatches, m106: aggregates.m106, combined: aggregates.combined },
      null,
      2,
    ),
  );
}

if (import.meta.main) {
  await main();
}
