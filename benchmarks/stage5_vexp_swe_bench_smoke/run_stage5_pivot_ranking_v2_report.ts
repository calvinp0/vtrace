// Stage 5 pivot-ranking v2 report (read-only).
//
// Compares legacy vs v2 pivot ordering and documents the rule changes shipped in
// `src/capsuleV2/pivotRankingV2.ts`. It does NOT re-run agents or Docker. Two kinds
// of evidence are produced:
//
//   1. Astropy comparison — a two-candidate case modeled from the COMMITTED Stage 5
//      Astropy diagnostic (vounit.py broad class vs cds.py specific impl). It runs
//      the real `scorePivotLegacy` / `scorePivotV2` scorers and shows the ordering
//      flip. The candidate signal strengths are modeled from the diagnostic, not
//      read from live scorecards (committed snapshots do not carry scorecards).
//
//   2. Controlled-set structural sanity scan — over the committed strict 10-task
//      snapshots, a STRUCTURAL proxy (top-pivot kind + snippet size) for which tasks
//      have a broad/large top pivot that v2 would scrutinize. Because the snapshots
//      carry no scorecards / evidence strengths, a faithful per-task legacy-vs-v2
//      re-rank is NOT possible from artifacts alone; that is stated explicitly and a
//      fresh v2 run is the recommended way to get aggregate numbers.
//
// No outcome (edited files / resolved / Docker result) is used as a ranking input
// anywhere — the scorer is fed only pre-outcome signals.

import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { SymbolKind } from "../../src/domain/types";
import {
  scorePivotLegacy,
  scorePivotV2,
  type PivotRankInput,
  type PivotRankResult,
} from "../../src/capsuleV2/pivotRankingV2";
import type { CapsuleV2Scorecard } from "../../src/capsuleV2/types";

const DEFAULT_RESULTS_DIR = "benchmarks/stage5_vexp_swe_bench_smoke/results";
export const PIVOT_RANKING_V2_JSON_FILENAME = "stage5_pivot_ranking_v2_report.json";
export const PIVOT_RANKING_V2_MD_FILENAME = "stage5_pivot_ranking_v2_report.md";

// Chars→token divisor for the structural snapshot snippet-size proxy (heuristic).
const CHARS_PER_TOKEN = 4;
// Structural "broad/large top pivot" proxy threshold (token-heuristic).
const LARGE_SNIPPET_TOKENS = 350;

function fullScorecard(over: Partial<CapsuleV2Scorecard>): CapsuleV2Scorecard {
  return {
    lexical: 0,
    symbol: 0,
    path: 0,
    test_to_impl: 0,
    body_literal: 0,
    graph_proximity: 0,
    centrality: 0,
    actionability: 1,
    hub_penalty: 0,
    final: 0,
    ...over,
  };
}

// --- Astropy comparison (modeled from the committed diagnostic evidence) ---------

export interface AstropyRankCandidate {
  label: string;
  input: PivotRankInput;
}

// Modeled from stage5_astropy_pivot_diagnostic: the strict run's top pivot was the
// broad `vounit.py::VOUnit` class (large snippet, weak/single evidence, demoting
// the cds.py implementation); the resolved sibling ranked the cds.py implementation
// first. NOT astropy-specific logic — just a representative two-candidate fixture.
export const ASTROPY_VOUNIT: AstropyRankCandidate = {
  label: "vounit.py::VOUnit (broad class, large snippet, weak evidence)",
  input: {
    path: "astropy/units/format/vounit.py",
    kind: SymbolKind.Class,
    snippetTokens: 900,
    evidenceSources: ["symbol"],
    scorecard: fullScorecard({ symbol: 0.6, test_to_impl: 0.1, final: 0.7 }),
  },
};

export const ASTROPY_CDS: AstropyRankCandidate = {
  label: "cds.py::p_division_of_units (specific impl, small snippet, multi-evidence)",
  input: {
    path: "astropy/units/format/cds.py",
    kind: SymbolKind.Method,
    snippetTokens: 120,
    evidenceSources: ["lexical", "path", "symbol"],
    scorecard: fullScorecard({ lexical: 0.5, path: 0.6, symbol: 0.5, final: 0.6 }),
  },
};

export interface RankedCandidate {
  label: string;
  path: string;
  kind: string;
  legacyScore: number;
  v2: PivotRankResult;
}

export interface AstropyComparison {
  candidates: RankedCandidate[];
  legacyTop: string;
  v2Top: string;
  // True when v2's top differs from legacy's top (the desired flip).
  flipped: boolean;
}

export function compareAstropyRanking(
  candidates: readonly AstropyRankCandidate[] = [ASTROPY_VOUNIT, ASTROPY_CDS],
): AstropyComparison {
  const ranked: RankedCandidate[] = candidates.map((c) => ({
    label: c.label,
    path: c.input.path,
    kind: c.input.kind,
    legacyScore: scorePivotLegacy(c.input).score,
    v2: scorePivotV2(c.input),
  }));
  const legacyTop = [...ranked].sort((a, b) => b.legacyScore - a.legacyScore)[0]!;
  const v2Top = [...ranked].sort((a, b) => b.v2.score - a.v2.score)[0]!;
  return {
    candidates: ranked,
    legacyTop: legacyTop.path,
    v2Top: v2Top.path,
    flipped: legacyTop.path !== v2Top.path,
  };
}

// --- Controlled-set structural sanity scan --------------------------------------

export interface SnapshotPivot {
  path: string;
  symbol: string | null;
  kind: "class" | "function-or-method" | "unknown";
  snippetChars: number;
  snippetTokenEstimate: number;
}

// Parse pivots + their source first-line (for a kind proxy) + snippet size from a
// committed `_vtrace_instructions.snapshot.md`. Structural only.
export function scanSnapshotPivots(md: string): SnapshotPivot[] {
  const lines = md.split(/\r?\n/);
  const pivotRe = /^●\s*pivot\s+(\S+?)(?:::(\S+))?\s*$/;
  const boundary = (line: string): boolean =>
    line.startsWith("●") || line.startsWith("○") || line.startsWith("## ") || /^\s*hidden candidate:/.test(line);
  const pivots: SnapshotPivot[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const m = lines[i]!.match(pivotRe);
    if (!m) continue;
    let snippetChars = 0;
    let kind: SnapshotPivot["kind"] = "unknown";
    let inSource = false;
    for (let j = i + 1; j < lines.length; j += 1) {
      const inner = lines[j]!;
      if (boundary(inner)) break;
      if (/^\s*source:\s*$/.test(inner)) {
        inSource = true;
        continue;
      }
      if (inSource) {
        snippetChars += inner.length + 1;
        if (kind === "unknown") {
          const trimmed = inner.trim();
          if (trimmed.startsWith("class ")) kind = "class";
          else if (trimmed.startsWith("def ") || trimmed.startsWith("async def ")) kind = "function-or-method";
        }
      }
    }
    pivots.push({
      path: m[1]!,
      symbol: m[2] ?? null,
      kind,
      snippetChars,
      snippetTokenEstimate: Math.round(snippetChars / CHARS_PER_TOKEN),
    });
  }
  return pivots;
}

export interface ControlledTaskScan {
  instanceId: string;
  pivotCount: number;
  topPivotPath: string | null;
  topPivotKind: SnapshotPivot["kind"] | null;
  topPivotSnippetTokens: number | null;
  // Structural proxy: top pivot is a broad class AND/OR a large snippet — the shape
  // v2's broad-snippet penalty targets when evidence is weak.
  topPivotLooksBroad: boolean;
}

export interface ControlledSetScan {
  taskCount: number;
  tasks: ControlledTaskScan[];
  tasksWithBroadTopPivot: number;
  // Honest limitation: faithful legacy-vs-v2 re-rank needs scorecards the snapshots
  // do not carry.
  faithfulRerankPossible: boolean;
}

async function readText(file: string): Promise<string | null> {
  return readFile(file, "utf8").then(
    (t) => t,
    () => null,
  );
}

async function listSubdirs(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  return entries.filter((e) => e.isDirectory()).map((e) => e.name);
}

export async function scanControlledSet(resultsDir: string): Promise<ControlledSetScan> {
  const runsRoot = path.join(resultsDir, "runs");
  const labels = (await listSubdirs(runsRoot)).filter((l) => l.startsWith("eval-strictgated-vtrace-")).sort();
  const tasks: ControlledTaskScan[] = [];
  for (const label of labels) {
    const md = await readText(path.join(runsRoot, label, "_vtrace_instructions.snapshot.md"));
    if (md === null) continue;
    const pivots = scanSnapshotPivots(md);
    const top = pivots[0] ?? null;
    const looksBroad =
      top !== null && (top.kind === "class" || top.snippetTokenEstimate >= LARGE_SNIPPET_TOKENS);
    tasks.push({
      instanceId: label.replace("eval-strictgated-vtrace-", ""),
      pivotCount: pivots.length,
      topPivotPath: top?.path ?? null,
      topPivotKind: top?.kind ?? null,
      topPivotSnippetTokens: top?.snippetTokenEstimate ?? null,
      topPivotLooksBroad: looksBroad,
    });
  }
  return {
    taskCount: tasks.length,
    tasks,
    tasksWithBroadTopPivot: tasks.filter((t) => t.topPivotLooksBroad).length,
    faithfulRerankPossible: false,
  };
}

// --- Report assembly ------------------------------------------------------------

export const RANKING_RULE_CHANGES: readonly string[] = [
  "Multi-evidence boost: a candidate supported by 2+ independent evidence types gains a small additive boost (capped).",
  "Specificity boost: function/method gains a small boost; module-level symbols a small penalty; classes stay neutral.",
  "Broad-snippet penalty: a large snippet OR a broad class/module is penalized ONLY when its support is weak (≤1 evidence type and no strong-exact match).",
  "Strong-exact shield: a strong symbol/body-literal match earns a boost AND shields a large/broad candidate from the broad penalty.",
  "Implementation-path preference: docs/tests/config/generated/vendored paths (or pre-classified non-source examples) get a small penalty.",
];

export const METADATA_ADDED: readonly string[] = [
  "pivot_ranking_version",
  "pivot_rank_score",
  "pivot_rank_signals",
  "pivot_rank_penalties",
  "pivot_rank_reason",
];

export const PIVOT_RANKING_V2_NON_CLAIMS: readonly string[] = [
  "This report does not re-run agents or Docker.",
  "This report does not use edited files or resolved status as ranking inputs.",
  "This report does not prove aggregate improvement until fresh agent runs are executed.",
  "Ranking v2 is not a Capsule budget change.",
];

export interface PivotRankingV2Report {
  resultsDir: string;
  defaultPivotRankingVersion: "v2";
  rankingRuleChanges: readonly string[];
  astropyComparison: AstropyComparison;
  controlledSet: ControlledSetScan;
  metadataAdded: readonly string[];
  risks: readonly string[];
  recommendedNextStep: string;
  missingArtifacts: string[];
  nonClaims: readonly string[];
}

export async function buildPivotRankingV2Report(resultsDir: string): Promise<PivotRankingV2Report> {
  const astropyComparison = compareAstropyRanking();
  const controlledSet = await scanControlledSet(resultsDir);
  const missingArtifacts: string[] = [];
  if (controlledSet.taskCount === 0) {
    missingArtifacts.push("runs/eval-strictgated-vtrace-* (no strict snapshots to scan)");
  }
  const risks = [
    "v2 only re-orders pivots in the ambiguous multi-pivot, no-strong-anchor case; anchored/title/literal/SQL cases are untouched, so its blast radius is bounded.",
    "Better pivot ranking is necessary-but-not-sufficient: the controlled Astropy run already ranked cds.py first yet still failed, so a top-pivot fix alone may not flip outcomes.",
    "The Astropy comparison uses modeled signal strengths; committed snapshots carry no scorecards, so it is a documented-pattern demonstration, not a live re-derivation.",
  ];
  const recommendedNextStep =
    "Run one fresh Astropy strict run (and, budget permitting, the strict 10-task set) under pivotRankingVersion=v2 with universal telemetry, then compare top-pivot ordering and resolution against the legacy baseline. Do not claim aggregate improvement before that run.";
  return {
    resultsDir,
    defaultPivotRankingVersion: "v2",
    rankingRuleChanges: RANKING_RULE_CHANGES,
    astropyComparison,
    controlledSet,
    metadataAdded: METADATA_ADDED,
    risks,
    recommendedNextStep,
    missingArtifacts,
    nonClaims: PIVOT_RANKING_V2_NON_CLAIMS,
  };
}

// --- Markdown -------------------------------------------------------------------

function fmt(value: number | null): string {
  return value === null ? "—" : String(value);
}

export function renderPivotRankingV2Markdown(report: PivotRankingV2Report): string {
  const lines: string[] = [];
  lines.push("# Stage 5 pivot ranking v2 report", "");

  lines.push("## Summary", "");
  lines.push(`- Results dir: \`${report.resultsDir}\``);
  lines.push(`- Default pivot ranking version: **${report.defaultPivotRankingVersion}**`);
  lines.push(
    `- Astropy modeled comparison: legacy top \`${report.astropyComparison.legacyTop}\` → v2 top \`${report.astropyComparison.v2Top}\` (${report.astropyComparison.flipped ? "flipped ✅" : "unchanged"}).`,
  );
  lines.push(
    `- Controlled strict snapshots scanned: ${report.controlledSet.taskCount}; with a broad/large top pivot: ${report.controlledSet.tasksWithBroadTopPivot}.`,
  );
  if (report.missingArtifacts.length > 0) lines.push(`- Missing artifacts: ${report.missingArtifacts.join("; ")}`);
  lines.push("");

  lines.push("## Ranking rule changes", "");
  for (const rule of report.rankingRuleChanges) lines.push(`- ${rule}`);
  lines.push("");
  lines.push(
    "Scoring is additive over the legacy `final` (conservative refinement, not a re-score) and uses ONLY pre-outcome signals (scorecard strengths, kind, path, snippet size). Production re-ordering is gated to the ambiguous multi-pivot, no-strong-anchor case.",
    "",
  );

  lines.push("## Astropy comparison", "");
  lines.push(
    "Two-candidate case modeled from the committed Stage 5 Astropy diagnostic (broad `vounit.py::VOUnit` class vs specific `cds.py` implementation). Scores from the real `scorePivotLegacy`/`scorePivotV2`:",
    "",
  );
  lines.push("| candidate | kind | legacy score | v2 score | v2 signals | v2 penalties |");
  lines.push("| --- | --- | --- | --- | --- | --- |");
  for (const c of report.astropyComparison.candidates) {
    lines.push(
      `| \`${c.path}\` | ${c.kind} | ${c.legacyScore} | ${c.v2.score} | ${c.v2.signals.join("; ") || "—"} | ${c.v2.penalties.join("; ") || "—"} |`,
    );
  }
  lines.push("");
  lines.push(
    `Legacy ranks \`${report.astropyComparison.legacyTop}\` first; v2 ranks \`${report.astropyComparison.v2Top}\` first. ` +
      (report.astropyComparison.flipped
        ? "v2 promotes the specific implementation pivot over the broad class — the intended fix."
        : "No flip."),
    "",
  );

  lines.push("## Controlled-set sanity checks", "");
  if (report.controlledSet.taskCount === 0) {
    lines.push("_No strict snapshots found to scan._", "");
  } else {
    lines.push(
      "Structural proxy over the committed strict snapshots (kind from the source first-line; snippet size from the source block). Because snapshots carry no scorecards/evidence strengths, a faithful per-task legacy-vs-v2 re-rank is NOT possible from artifacts alone — these are shape indicators, not a re-rank.",
      "",
    );
    lines.push("| task | pivots | top pivot | top kind | top snippet (tok≈) | looks broad |");
    lines.push("| --- | --- | --- | --- | --- | --- |");
    for (const t of report.controlledSet.tasks) {
      lines.push(
        `| ${t.instanceId} | ${t.pivotCount} | ${t.topPivotPath ?? "—"} | ${t.topPivotKind ?? "—"} | ${fmt(t.topPivotSnippetTokens)} | ${t.topPivotLooksBroad ? "yes" : "no"} |`,
      );
    }
    lines.push("");
    lines.push("Requested controlled-set metrics, to the extent artifacts permit:", "");
    lines.push("- Number of tasks with changed top pivot: **not computable from artifacts** (no scorecards in snapshots).");
    lines.push("- Number where top pivot moves broad→specific: **not computable from artifacts**; structural proxy below.");
    lines.push("- Number where implementation path moves upward: **not computable from artifacts**.");
    lines.push(
      `- Structural proxy — tasks whose top pivot is a broad class or large snippet (the shape v2 scrutinizes): **${report.controlledSet.tasksWithBroadTopPivot}/${report.controlledSet.taskCount}**.`,
    );
    lines.push("- Obvious risky demotions: none introduced — v2 leaves anchored/title/literal/SQL orderings untouched.");
    lines.push("");
  }

  lines.push("## Metadata added", "");
  lines.push("Compact, debug/report-only fields attached to each pivot item (NOT rendered into the prompt):", "");
  for (const field of report.metadataAdded) lines.push(`- \`${field}\``);
  lines.push("");

  lines.push("## Risks", "");
  for (const risk of report.risks) lines.push(`- ${risk}`);
  lines.push("");

  lines.push("## Recommended next step", "");
  lines.push(report.recommendedNextStep, "");

  lines.push("## Non-claims", "");
  for (const claim of report.nonClaims) lines.push(`- ${claim}`);
  lines.push("");

  return lines.join("\n");
}

export async function runPivotRankingV2Report(resultsDir: string): Promise<PivotRankingV2Report> {
  const report = await buildPivotRankingV2Report(resultsDir);
  await writeFile(path.join(resultsDir, PIVOT_RANKING_V2_JSON_FILENAME), `${JSON.stringify(report, null, 2)}\n`);
  await writeFile(path.join(resultsDir, PIVOT_RANKING_V2_MD_FILENAME), renderPivotRankingV2Markdown(report));
  return report;
}

export function parseResultsDir(argv: readonly string[]): string {
  for (const flag of ["--results", "--out"]) {
    const index = argv.indexOf(flag);
    if (index >= 0 && argv[index + 1] !== undefined) return path.resolve(argv[index + 1] as string);
  }
  return path.resolve(DEFAULT_RESULTS_DIR);
}

if (import.meta.main) {
  const resultsDir = parseResultsDir(process.argv.slice(2));
  runPivotRankingV2Report(resultsDir)
    .then((report) => {
      process.stdout.write(
        `Stage 5 pivot ranking v2 report: Astropy flip=${report.astropyComparison.flipped}; ` +
          `${report.controlledSet.tasksWithBroadTopPivot}/${report.controlledSet.taskCount} strict tasks have a broad top pivot.\n`,
      );
    })
    .catch((error) => {
      process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
      process.exit(1);
    });
}
