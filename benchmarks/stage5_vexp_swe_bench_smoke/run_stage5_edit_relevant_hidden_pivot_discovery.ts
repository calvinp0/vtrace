// Stage 5 edit-relevant hidden-pivot candidate discovery.
//
// SCOPE: reporting / analysis ONLY. This scans EXISTING deterministic retrieval
// evaluations + live Stage 5 run metadata + the curated edit-relevance file, and
// ranks instances by how likely they are to be the next useful PIVOT_CHECK /
// edit-plan validation case — i.e. a case shaped like sphinx-7462:
//
//   a hidden (non-source-anchored) pivot is retrieved, that pivot is gold/edit-
//   relevant, the issue anchors the agent at a DIFFERENT obvious file, and the
//   failure (if any) is context-to-action, not retrieval.
//
// It runs NO agents, NO Docker, changes NO retrieval/PIVOT_CHECK/telemetry, and
// writes only a Markdown + JSON report. It NEVER fabricates edit-relevance: when
// gold metadata is absent the candidate is reported as `unknown`.
//
// Provenance is kept explicit throughout (see the report's telemetry-vs-curated
// note):
//   - TELEMETRY / DERIVED: retrieved pivots, retrieval success, prior run labels,
//     prior edited files. The anchored/hidden split is reliable only from LIVE
//     capsule role-reasons ("source line anchor …"); for deterministic-only
//     instances it falls back to a rank proxy (top-1 = obvious anchor) that is
//     labelled as such.
//   - GOLD-DERIVED: gold patch files (`expected_files` in the retrieval eval) and
//     hidden∩gold overlap. EVALUATION labels only — never agent input.
//   - CURATED: the post-inspection edit-relevance judgements.

import { readFile, readdir, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";

import { editedFilesFromPatch } from "../../src/capsule/finalEditDiagnostics";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type Tier = "tier1" | "tier2" | "ruleout" | "reject";

// One retrieved pivot, as carried by either the deterministic retrieval eval
// (`diagnostics.top_pivots`) or a live run meta (`vtraceCapsulePivots`).
export interface PivotInfo {
  path: string;
  symbol: string | null;
  roleReason: string | null;
}

// Where the anchored/hidden split came from. `live_role_reason` is trustworthy;
// `deterministic_rank_proxy` is a heuristic (top-1 pivot = obvious anchor) used
// when no live capsule exists for the instance.
export type AnchorSource = "live_role_reason" | "deterministic_rank_proxy" | "none";

// The assembled, pre-scoring view of one instance.
export interface CandidateInput {
  instanceId: string;
  repo: string;
  // GOLD-DERIVED. null/empty => unknown (never invented).
  goldFiles: string[] | null;
  // TELEMETRY/DERIVED retrieved pivots (live preferred, else deterministic).
  pivots: PivotInfo[];
  pivotSource: "live" | "deterministic" | "none";
  anchorSource: AnchorSource;
  // Was the gold file retrieved anywhere by the deterministic capsule? null when
  // there is no deterministic retrieval row for the instance.
  retrievedGoldAnywhere: boolean | null;
  // TELEMETRY: every live run label seen for this instance.
  priorLiveLabels: string[];
  // TELEMETRY: edited files from a representative live run's modelPatch. null when
  // no live patch was available.
  priorEditedFiles: string[] | null;
  // CURATED post-inspection judgements (from stage5_pivot_check_edit_relevance.json).
  curatedEditRelevant: boolean | null;
  curatedClassification: string | null;
}

export interface ScoreFactor {
  label: string;
  points: number;
}

export interface Candidate {
  instanceId: string;
  repo: string;
  score: number;
  factors: ScoreFactor[];
  tier: Tier;
  classificationReason: string;
  // anchored/hidden views (files).
  sourceAnchorFiles: string[];
  hiddenPivotFiles: string[];
  hiddenPivotSymbols: string[];
  anchorSource: AnchorSource;
  pivotSource: "live" | "deterministic" | "none";
  // GOLD-DERIVED.
  goldPatchFiles: string[] | null;
  hiddenGoldOverlap: boolean | "unknown";
  // CURATED.
  curatedEditRelevant: boolean | null;
  curatedClassification: string | null;
  // TELEMETRY prior-run context.
  priorLiveStatus: string | null;
  priorHiddenPivotEngagement: string | null;
  priorEditedFiles: string[] | null;
  risks: string[];
  recommendedBeforeLabel: string | null;
  recommendedAfterLabel: string | null;
  commands: string[] | null;
}

export interface DiscoveryReport {
  generatedAt: string | null;
  sourceArtifacts: string[];
  summary: {
    instancesConsidered: number;
    tier1: number;
    tier2: number;
    ruleout: number;
    reject: number;
  };
  candidates: Candidate[];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const VEXP_DIR = "/home/calvin/code/vexp-swe-bench";
export const RESULTS_REL = "benchmarks/stage5_vexp_swe_bench_smoke/results";

// The scoring rubric, documented and rendered verbatim so the weights are never a
// hidden constant. Order is the order applied in `scoreCandidate`.
export const SCORING_RUBRIC: readonly { label: string; points: number; note: string }[] = [
  { label: "hidden pivot overlaps gold patch file", points: +3, note: "a retrieved hidden pivot's file is in the gold patch (gold-derived)" },
  { label: "hidden pivot is not issue/source anchored", points: +2, note: "at least one retrieved pivot is non-source-anchored" },
  { label: "capsule has >= 2 pivots", points: +2, note: "multi-pivot capsule (>= 2 distinct pivot files)" },
  { label: "obvious source-anchored pivot differs from hidden pivot", points: +2, note: "an anchored file and a DISTINCT hidden file both exist (the sphinx-7462 shape)" },
  { label: "prior live run ignored/discovered-only hidden pivot", points: +1, note: "curated/live evidence the hidden pivot was not inspected→edited" },
  { label: "prior live edited only source-anchored file", points: +1, note: "a prior live patch touched the anchored file but not the hidden pivot" },
  { label: "no gold/edit-relevance evidence", points: -3, note: "no gold patch metadata AND no curated edit-relevance" },
  { label: "hidden pivot is example/test-only or reproduction-only", points: -3, note: "the only hidden pivots are tests/examples/docs, or curated as reproduction-only" },
  { label: "retrieval missing hidden/gold file", points: -4, note: "gold is known but was not retrieved anywhere by the deterministic capsule" },
  { label: "no hidden pivot", points: -5, note: "no non-source-anchored pivot at all" },
];

export const NON_CLAIMS: readonly string[] = [
  "This report does not run agents.",
  "This report does not evaluate Docker resolution.",
  "This report does not prove PIVOT_CHECK improves patch quality.",
  "This report does not claim candidates are guaranteed edit-relevant.",
  "This report only ranks candidates for targeted future validation.",
];

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

// A live capsule pivot is source-anchored when its role-reason cites the issue's
// source line anchor. Mirrors the report generator's `pivotIsHidden`. (Only the
// live capsule emits this reason; deterministic rows almost never do.)
export function roleReasonIsAnchored(roleReason: string | null): boolean {
  return (roleReason ?? "").includes("source line anchor");
}

// Path heuristics for "not a real edit target": tests, examples, docs, repro
// scripts. Conservative — only used for the −3 penalty.
export function isExampleOrTestPath(p: string): boolean {
  const lower = p.toLowerCase();
  return (
    /(^|\/)tests?\//.test(lower) ||
    /(^|\/)test_[^/]*$/.test(lower) ||
    /_test\.py$/.test(lower) ||
    /(^|\/)examples?\//.test(lower) ||
    /(^|\/)doc(s)?\//.test(lower) ||
    /(^|\/)conftest\.py$/.test(lower)
  );
}

export function uniq(values: readonly string[]): string[] {
  return [...new Set(values)];
}

// Split pivots into anchored vs hidden. With `live_role_reason`, the role-reason
// decides. With `deterministic_rank_proxy`, the first pivot file is treated as the
// obvious anchor and every other distinct pivot file is a hidden-by-rank proxy.
export function splitPivots(
  pivots: readonly PivotInfo[],
  anchorSource: AnchorSource,
): { anchored: PivotInfo[]; hidden: PivotInfo[] } {
  if (pivots.length === 0) return { anchored: [], hidden: [] };
  if (anchorSource === "live_role_reason") {
    const anchored = pivots.filter((p) => roleReasonIsAnchored(p.roleReason));
    const hidden = pivots.filter((p) => !roleReasonIsAnchored(p.roleReason));
    return { anchored, hidden };
  }
  // deterministic_rank_proxy: top-1 file = obvious anchor; the rest are hidden proxies.
  const firstFile = pivots[0]!.path;
  const anchored = pivots.filter((p) => p.path === firstFile);
  const hidden = pivots.filter((p) => p.path !== firstFile);
  return { anchored, hidden };
}

// hidden∩gold overlap (gold-derived). "unknown" when gold is not available.
export function computeHiddenGoldOverlap(
  hiddenFiles: readonly string[],
  goldFiles: readonly string[] | null,
): boolean | "unknown" {
  if (goldFiles === null || goldFiles.length === 0) return "unknown";
  return hiddenFiles.some((f) => goldFiles.includes(f));
}

// Curated/live signal that a prior live run inspected-but-did-not-edit the hidden
// pivot (the failed_to_connect pattern), used for the +1 prior-ignored factor.
function priorIgnoredHiddenPivot(c: CandidateInput): boolean {
  if (c.curatedClassification === "failed_to_connect_to_edit") return true;
  return false;
}

// A prior live patch touched an anchored file but none of the hidden pivot files.
function priorEditedOnlyAnchored(
  c: CandidateInput,
  anchoredFiles: readonly string[],
  hiddenFiles: readonly string[],
): boolean {
  if (c.priorEditedFiles === null || c.priorEditedFiles.length === 0) return false;
  const edited = new Set(c.priorEditedFiles);
  const touchedAnchor = anchoredFiles.some((f) => edited.has(f));
  const touchedHidden = hiddenFiles.some((f) => edited.has(f));
  return touchedAnchor && !touchedHidden;
}

// Compute the transparent score + the factors that fired (for the report).
export function scoreCandidate(c: CandidateInput): { score: number; factors: ScoreFactor[] } {
  const { anchored, hidden } = splitPivots(c.pivots, c.anchorSource);
  const hiddenFiles = uniq(hidden.map((p) => p.path));
  const anchoredFiles = uniq(anchored.map((p) => p.path));
  const distinctPivotFiles = uniq(c.pivots.map((p) => p.path));
  const goldKnown = c.goldFiles !== null && c.goldFiles.length > 0;
  const overlap = computeHiddenGoldOverlap(hiddenFiles, c.goldFiles);
  const anchoredDiffersFromHidden =
    anchoredFiles.length >= 1 && hiddenFiles.some((f) => !anchoredFiles.includes(f));
  const hiddenAllExampleOrTest = hidden.length >= 1 && hidden.every((p) => isExampleOrTestPath(p.path));
  const reproductionOnly = c.curatedEditRelevant === false;

  const factors: ScoreFactor[] = [];
  const add = (label: string, points: number, cond: boolean): void => {
    if (cond) factors.push({ label, points });
  };

  add("hidden pivot overlaps gold patch file", +3, overlap === true);
  add("hidden pivot is not issue/source anchored", +2, hidden.length >= 1);
  add("capsule has >= 2 pivots", +2, distinctPivotFiles.length >= 2);
  add("obvious source-anchored pivot differs from hidden pivot", +2, anchoredDiffersFromHidden);
  add("prior live run ignored/discovered-only hidden pivot", +1, priorIgnoredHiddenPivot(c));
  add("prior live edited only source-anchored file", +1, priorEditedOnlyAnchored(c, anchoredFiles, hiddenFiles));
  add("no gold/edit-relevance evidence", -3, !goldKnown && c.curatedEditRelevant === null);
  add("hidden pivot is example/test-only or reproduction-only", -3, hiddenAllExampleOrTest || reproductionOnly);
  add("retrieval missing hidden/gold file", -4, goldKnown && c.retrievedGoldAnywhere === false);
  add("no hidden pivot", -5, hidden.length === 0);

  const score = factors.reduce((sum, f) => sum + f.points, 0);
  return { score, factors };
}

// Deterministic tier + human reason from the assembled facts.
export function classifyCandidate(c: CandidateInput): { tier: Tier; reason: string } {
  const { anchored, hidden } = splitPivots(c.pivots, c.anchorSource);
  const hiddenFiles = uniq(hidden.map((p) => p.path));
  const anchoredFiles = uniq(anchored.map((p) => p.path));
  const distinctPivotFiles = uniq(c.pivots.map((p) => p.path));
  const goldKnown = c.goldFiles !== null && c.goldFiles.length > 0;
  const overlap = computeHiddenGoldOverlap(hiddenFiles, c.goldFiles);
  const anchoredDiffersFromHidden =
    anchoredFiles.length >= 1 && hiddenFiles.some((f) => !anchoredFiles.includes(f));

  // Reject gates (in order).
  if (hidden.length === 0) return { tier: "reject", reason: "no hidden (non-source-anchored) pivot" };
  if (distinctPivotFiles.length < 2) return { tier: "reject", reason: "single-pivot capsule (no multi-pivot localization)" };
  if (goldKnown && c.retrievedGoldAnywhere === false) {
    return { tier: "reject", reason: "retrieval failure — gold file not surfaced by the capsule" };
  }

  // Curated/known not-edit-relevant => control, not an edit-conversion candidate.
  if (c.curatedEditRelevant === false) {
    return { tier: "ruleout", reason: "curated as not edit-relevant (reproduction/context only) — overhead/rule-out control" };
  }
  if (overlap === false) {
    return {
      tier: "ruleout",
      reason: "hidden pivot is not in the gold patch — useful as a correct-rule-out / overhead control, not edit conversion",
    };
  }

  // overlap === true beyond here (or unknown).
  // Tier 1 ("strong") requires BOTH gold overlap AND a hidden pivot distinct from
  // the anchor AND a LIVE-confirmed anchored/hidden split. A deterministic rank
  // proxy can invert reality (e.g. the gold file is actually the traceback-named
  // anchor, not hidden), so proxy candidates are capped at Tier 2 pending a live
  // capsule build.
  if (overlap === true && anchoredDiffersFromHidden && c.anchorSource === "live_role_reason") {
    return { tier: "tier1", reason: "hidden pivot is gold-relevant and distinct from the source-anchored file, split confirmed by the live capsule (sphinx-7462 shape)" };
  }
  if (overlap === true && anchoredDiffersFromHidden) {
    return { tier: "tier2", reason: "hidden pivot overlaps gold and looks distinct from the anchor, but the split is a deterministic rank proxy — confirm with a live capsule build before promoting" };
  }
  if (overlap === true) {
    return { tier: "tier2", reason: "hidden pivot overlaps gold but is not clearly distinct from the anchored file — edit relevance plausible" };
  }
  // overlap unknown (no gold): plausible but unverified.
  return { tier: "tier2", reason: "multi-pivot capsule with a hidden pivot, but edit relevance is unknown (no gold metadata)" };
}

// Short id used in run labels: the part after `__`.
export function shortId(instanceId: string): string {
  const idx = instanceId.indexOf("__");
  return idx >= 0 ? instanceId.slice(idx + 2) : instanceId;
}

// Build the controlled before/after commands. The before run carries
// --disable-pivot-check; the after run never does.
export function buildCommands(instanceId: string): {
  beforeLabel: string;
  afterLabel: string;
  commands: string[];
} {
  const short = shortId(instanceId);
  const beforeLabel = `eval-pivot-telemetry-vtrace-${short}-no-pivot-check`;
  const afterLabel = `eval-pivot-check-vtrace-${short}`;
  const common = (label: string, disable: boolean): string =>
    [
      "rm -f benchmarks/stage5_vexp_swe_bench_smoke/results/_agent_stream.jsonl",
      "",
      "bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_vexp_swe_bench_smoke.ts \\",
      "  --mode run-protocol \\",
      "  --protocol vtrace-indexed \\",
      `  --vexp-swe-bench-dir ${VEXP_DIR} \\`,
      `  --instances ${instanceId} \\`,
      `  --run-label ${label} \\`,
      "  --show-vtrace-index-log \\",
      "  --context-policy force-inject \\",
      "  --capsule-engine v2 \\",
      "  --capsule-intent debug \\",
      "  --capsule-budget 8000 \\",
      ...(disable ? ["  --disable-pivot-check \\"] : []),
      "  --out benchmarks/stage5_vexp_swe_bench_smoke/results",
    ].join("\n");
  return {
    beforeLabel,
    afterLabel,
    commands: [
      `# before: PIVOT_CHECK disabled\n${common(beforeLabel, true)}`,
      `# after: PIVOT_CHECK enabled\n${common(afterLabel, false)}`,
    ],
  };
}

// Assemble the final Candidate (score + tier + commands + provenance) from input.
export function buildCandidate(c: CandidateInput): Candidate {
  const { score, factors } = scoreCandidate(c);
  const { tier, reason } = classifyCandidate(c);
  const { anchored, hidden } = splitPivots(c.pivots, c.anchorSource);
  const hiddenFiles = uniq(hidden.map((p) => p.path));
  const sourceAnchorFiles = uniq(anchored.map((p) => p.path));
  const hiddenSymbols = uniq(hidden.map((p) => p.symbol).filter((s): s is string => Boolean(s)));
  const overlap = computeHiddenGoldOverlap(hiddenFiles, c.goldFiles);

  const risks: string[] = [];
  if (c.anchorSource === "deterministic_rank_proxy") {
    risks.push(
      "anchored/hidden split is a deterministic rank proxy (top-1 = obvious anchor), not a live capsule role-reason — confirm with a live capsule build",
    );
  }
  if (c.pivotSource === "deterministic") {
    risks.push("pivots are from the deterministic retrieval eval; the live force-inject capsule (failing-test signal) may surface different pivots");
  }
  if (overlap === "unknown") risks.push("no gold patch metadata — edit relevance is unverified");
  if (c.curatedEditRelevant === null && overlap !== true) {
    risks.push("edit relevance not curated; treat as a hypothesis until a live run confirms inspection→edit behavior");
  }

  const withCommands = tier === "tier1" || tier === "tier2" || tier === "ruleout";
  const cmd = withCommands ? buildCommands(c.instanceId) : null;

  const priorLiveStatus =
    c.priorLiveLabels.length > 0 ? `live run(s): ${c.priorLiveLabels.join(", ")}` : null;
  const priorHiddenPivotEngagement =
    c.curatedClassification !== null
      ? `curated: ${c.curatedClassification}`
      : c.priorEditedFiles !== null
        ? `prior edited files: ${c.priorEditedFiles.join(", ") || "(none)"}`
        : null;

  return {
    instanceId: c.instanceId,
    repo: c.repo,
    score,
    factors,
    tier,
    classificationReason: reason,
    sourceAnchorFiles,
    hiddenPivotFiles: hiddenFiles,
    hiddenPivotSymbols: hiddenSymbols,
    anchorSource: c.anchorSource,
    pivotSource: c.pivotSource,
    goldPatchFiles: c.goldFiles,
    hiddenGoldOverlap: overlap,
    curatedEditRelevant: c.curatedEditRelevant,
    curatedClassification: c.curatedClassification,
    priorLiveStatus,
    priorHiddenPivotEngagement,
    priorEditedFiles: c.priorEditedFiles,
    risks,
    recommendedBeforeLabel: cmd?.beforeLabel ?? null,
    recommendedAfterLabel: cmd?.afterLabel ?? null,
    commands: cmd?.commands ?? null,
  };
}

// Sort candidates: tier rank first, then score desc, then instanceId for stability.
const TIER_RANK: Record<Tier, number> = { tier1: 0, tier2: 1, ruleout: 2, reject: 3 };
export function sortCandidates(candidates: readonly Candidate[]): Candidate[] {
  return [...candidates].sort((a, b) => {
    if (TIER_RANK[a.tier] !== TIER_RANK[b.tier]) return TIER_RANK[a.tier] - TIER_RANK[b.tier];
    if (b.score !== a.score) return b.score - a.score;
    return a.instanceId.localeCompare(b.instanceId);
  });
}

export function buildReport(
  inputs: readonly CandidateInput[],
  sourceArtifacts: readonly string[],
  generatedAt: string | null,
): DiscoveryReport {
  const candidates = sortCandidates(inputs.map(buildCandidate));
  const count = (t: Tier): number => candidates.filter((c) => c.tier === t).length;
  return {
    generatedAt,
    sourceArtifacts: [...sourceArtifacts],
    summary: {
      instancesConsidered: candidates.length,
      tier1: count("tier1"),
      tier2: count("tier2"),
      ruleout: count("ruleout"),
      reject: count("reject"),
    },
    candidates,
  };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function fmtList(values: readonly string[] | null): string {
  if (values === null) return "unknown";
  return values.length === 0 ? "—" : values.join(", ");
}

function fmtOverlap(v: boolean | "unknown"): string {
  if (v === "unknown") return "unknown";
  return v ? "yes" : "no";
}

function fmtBoolOrUnknown(v: boolean | null): string {
  if (v === null) return "unknown";
  return v ? "yes" : "no";
}

export function renderJson(report: DiscoveryReport): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}

function renderCandidateDetail(lines: string[], c: Candidate): void {
  lines.push(`### ${c.instanceId}`);
  lines.push("");
  lines.push(`- **repo:** ${c.repo}`);
  lines.push(`- **score:** ${c.score}  ·  **tier:** ${c.tier}`);
  lines.push(`- **classification reason:** ${c.classificationReason}`);
  lines.push(`- **source-anchored file(s)** _(derived: ${c.anchorSource})_: ${fmtList(c.sourceAnchorFiles)}`);
  lines.push(`- **hidden pivot file(s)** _(telemetry/${c.pivotSource})_: ${fmtList(c.hiddenPivotFiles)}`);
  lines.push(`- **hidden pivot symbol(s):** ${fmtList(c.hiddenPivotSymbols)}`);
  lines.push(`- **gold patch file(s)** _(gold-derived)_: ${fmtList(c.goldPatchFiles)}`);
  lines.push(`- **hidden∩gold overlap** _(gold-derived)_: ${fmtOverlap(c.hiddenGoldOverlap)}`);
  lines.push(`- **curated edit-relevant** _(curated)_: ${fmtBoolOrUnknown(c.curatedEditRelevant)}` +
    (c.curatedClassification ? ` (${c.curatedClassification})` : ""));
  lines.push(`- **prior live status** _(telemetry)_: ${c.priorLiveStatus ?? "none"}`);
  lines.push(`- **prior hidden-pivot engagement:** ${c.priorHiddenPivotEngagement ?? "unknown"}`);
  lines.push(`- **scoring factors:** ${c.factors.map((f) => `${f.label} (${f.points >= 0 ? "+" : ""}${f.points})`).join("; ") || "—"}`);
  lines.push(`- **risk / uncertainty:** ${c.risks.length > 0 ? c.risks.join("; ") : "—"}`);
  if (c.recommendedBeforeLabel && c.recommendedAfterLabel) {
    lines.push(`- **recommended run labels:** \`${c.recommendedBeforeLabel}\` (before) → \`${c.recommendedAfterLabel}\` (after)`);
  }
  if (c.commands) {
    lines.push("");
    lines.push("Exact commands to run later (not executed here):");
    for (const block of c.commands) {
      lines.push("");
      lines.push("```bash");
      lines.push(block);
      lines.push("```");
    }
  }
  lines.push("");
}

function renderCandidateTableRow(c: Candidate): string {
  return (
    `| ${c.instanceId} | ${c.repo} | ${c.score} | ${fmtList(c.hiddenPivotFiles)} | ` +
    `${fmtOverlap(c.hiddenGoldOverlap)} | ${fmtBoolOrUnknown(c.curatedEditRelevant)} |`
  );
}

export function renderMarkdown(report: DiscoveryReport): string {
  const lines: string[] = [];
  lines.push("# Stage 5 edit-relevant hidden-pivot candidate discovery");
  lines.push("");
  if (report.generatedAt) lines.push(`_Generated: ${report.generatedAt}_`, "");
  lines.push(
    "_Reporting only. No agents, no Docker, no retrieval / PIVOT_CHECK / telemetry / " +
      "benchmark changes. Ranks existing artifacts for targeted future validation._",
  );
  lines.push("");

  const s = report.summary;
  lines.push("## Summary");
  lines.push("");
  lines.push(`- Instances considered: ${s.instancesConsidered}`);
  lines.push(`- Tier 1 (strong edit-relevant hidden-pivot): ${s.tier1}`);
  lines.push(`- Tier 2 (plausible, edit relevance uncertain): ${s.tier2}`);
  lines.push(`- Rule-out / control: ${s.ruleout}`);
  lines.push(`- Rejected: ${s.reject}`);
  lines.push("");
  lines.push("Source artifacts scanned:");
  lines.push("");
  for (const a of report.sourceArtifacts) lines.push(`- \`${a}\``);
  lines.push("");

  // --- Method --------------------------------------------------------------
  lines.push("## Method");
  lines.push("");
  lines.push(
    "Each instance is assembled from up to three sources: the deterministic Capsule v2 " +
      "retrieval evaluation (retrieved pivots + gold `expected_files`), any live Stage 5 run " +
      "metadata (the actual injected `vtraceCapsulePivots` + the run's edited files), and the " +
      "curated post-inspection edit-relevance file. Live pivots are preferred when present " +
      "because the live force-inject capsule (with a failing-test signal) is what PIVOT_CHECK " +
      "actually acts on; the deterministic capsule frequently differs.",
  );
  lines.push("");
  lines.push("### Telemetry-derived vs curated/gold-derived");
  lines.push("");
  lines.push(
    "- **Telemetry / derived:** retrieved pivots, retrieval success, prior run labels, prior " +
      "edited files. The anchored/hidden split is reliable only from a LIVE capsule role-reason " +
      "(`source line anchor …`); deterministic-only instances fall back to a rank proxy (top-1 " +
      "pivot = obvious anchor), labelled `deterministic_rank_proxy` per candidate.",
  );
  lines.push(
    "- **Gold-derived:** gold patch files (`expected_files`) and hidden∩gold overlap — EVALUATION " +
      "labels only, never agent input.",
  );
  lines.push("- **Curated:** the post-inspection edit-relevance judgements.");
  lines.push("");
  lines.push("Edit relevance is reported as `unknown` whenever gold metadata is absent — never invented.");
  lines.push("");

  // --- Scoring rubric ------------------------------------------------------
  lines.push("## Scoring rubric");
  lines.push("");
  lines.push("Transparent additive score (weights fixed in code, listed here):");
  lines.push("");
  lines.push("| factor | points | note |");
  lines.push("| --- | ---: | --- |");
  for (const r of SCORING_RUBRIC) {
    lines.push(`| ${r.label} | ${r.points >= 0 ? "+" : ""}${r.points} | ${r.note} |`);
  }
  lines.push("");
  lines.push(
    "Tiering: **Tier 1** = hidden pivot overlaps gold AND is distinct from the source-anchored " +
      "file AND the anchored/hidden split is confirmed by a LIVE capsule role-reason. " +
      "**Tier 2** = multi-pivot + hidden pivot that is gold-overlapping-but-proxy-split or whose " +
      "edit relevance is unverified. **Rule-out / control** = hidden pivot known NOT edit-relevant " +
      "(useful for overhead / correct-rule-out). **Reject** = no hidden pivot, single-pivot " +
      "capsule, or retrieval miss. Deterministic rank-proxy candidates are capped at Tier 2 until " +
      "a live capsule confirms the split.",
  );
  lines.push("");

  const byTier = (t: Tier): Candidate[] => report.candidates.filter((c) => c.tier === t);
  const detailSection = (title: string, t: Tier, emptyNote: string): void => {
    lines.push(title);
    lines.push("");
    const cands = byTier(t);
    if (cands.length === 0) {
      lines.push(emptyNote);
      lines.push("");
      return;
    }
    for (const c of cands) renderCandidateDetail(lines, c);
  };

  detailSection("## Tier 1 candidates", "tier1", "_None found in the scanned artifacts._");
  detailSection("## Tier 2 candidates", "tier2", "_None found in the scanned artifacts._");
  detailSection("## Rule-out / control candidates", "ruleout", "_None found._");

  // --- Rejected (compact table) -------------------------------------------
  lines.push("## Rejected candidates");
  lines.push("");
  const rejected = byTier("reject");
  if (rejected.length === 0) {
    lines.push("_None._");
    lines.push("");
  } else {
    lines.push("| instance | repo | score | reason |");
    lines.push("| --- | --- | ---: | --- |");
    for (const c of rejected) {
      lines.push(`| ${c.instanceId} | ${c.repo} | ${c.score} | ${c.classificationReason} |`);
    }
    lines.push("");
  }

  // --- Known limitations ---------------------------------------------------
  lines.push("## Known limitations");
  lines.push("");
  lines.push(
    "- The deterministic retrieval capsule and the live injected capsule differ (the live build " +
      "uses a failing-test signal). Deterministic-only candidates therefore carry an " +
      "anchored/hidden RANK PROXY, not a confirmed split — a cheap live capsule build should " +
      "confirm the hidden pivot before any agent run.",
  );
  lines.push("- Gold `expected_files` is an evaluation label; a hidden∩gold overlap means the file is in the gold patch, not that the specific symbol must change.");
  lines.push("- Prior-engagement signals are coarse (curated classification or prior edited-file set), not a re-derivation of every prior run's tool log.");
  lines.push("");

  // --- Recommended next live runs -----------------------------------------
  lines.push("## Recommended next live runs");
  lines.push("");
  const recommended = [...byTier("tier1"), ...byTier("tier2")];
  if (recommended.length === 0) {
    lines.push("_No Tier 1/Tier 2 candidates surfaced; gather more multi-pivot live runs first._");
  } else {
    lines.push("In priority order (Tier 1 first, then by score). Run the before/after pair per candidate:");
    lines.push("");
    for (const c of recommended) {
      lines.push(`1. **${c.instanceId}** (${c.tier}, score ${c.score}) — ${c.classificationReason}`);
    }
  }
  lines.push("");

  // --- Non-claims ----------------------------------------------------------
  lines.push("## Non-claims");
  lines.push("");
  for (const claim of NON_CLAIMS) lines.push(`- ${claim}`);
  lines.push("");

  return `${lines.join("\n")}\n`;
}

// ---------------------------------------------------------------------------
// Loading (impure)
// ---------------------------------------------------------------------------

async function readJson(filePath: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch {
    return null;
  }
}

function asString(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

function asStringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

// One retrieval row → { repo, goldFiles, deterministic pivots, retrievedGoldAnywhere }.
interface RetrievalRow {
  repo: string;
  goldFiles: string[];
  pivots: PivotInfo[];
  retrievedGoldAnywhere: boolean | null;
}

function parseRetrievalRows(raw: unknown): Map<string, RetrievalRow> {
  const map = new Map<string, RetrievalRow>();
  const rows = raw !== null && typeof raw === "object" && "rows" in raw ? (raw as { rows: unknown }).rows : null;
  if (!Array.isArray(rows)) return map;
  for (const row of rows) {
    if (row === null || typeof row !== "object") continue;
    const r = row as Record<string, unknown>;
    const instanceId = asString(r.instance_id);
    if (instanceId === null || map.has(instanceId)) continue;
    const diag = r.diagnostics as Record<string, unknown> | undefined;
    const topPivots = Array.isArray(diag?.top_pivots) ? (diag!.top_pivots as unknown[]) : [];
    const pivots: PivotInfo[] = topPivots
      .filter((p): p is Record<string, unknown> => p !== null && typeof p === "object")
      .map((p) => ({
        path: asString(p.path) ?? "",
        symbol: asString(p.symbol),
        roleReason: asString(p.role_reason),
      }))
      .filter((p) => p.path !== "");
    map.set(instanceId, {
      repo: asString(r.repo) ?? "",
      goldFiles: asStringArray(r.expected_files),
      pivots,
      retrievedGoldAnywhere:
        typeof r.contains_expected_file_anywhere === "boolean" ? r.contains_expected_file_anywhere : null,
    });
  }
  return map;
}

interface LiveMeta {
  label: string;
  pivots: PivotInfo[];
  editedFiles: string[] | null;
}

// Scan results/runs/<label>/raw/vtrace/ for capsule pivots + edited files.
async function loadLiveMetas(runsDir: string): Promise<Map<string, LiveMeta[]>> {
  const byInstance = new Map<string, LiveMeta[]>();
  let labels: string[];
  try {
    labels = (await readdir(runsDir, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return byInstance;
  }
  for (const label of labels.sort()) {
    const condDir = path.join(runsDir, label, "raw", "vtrace");
    const meta = (await readJson(path.join(condDir, "_run.meta.json"))) as Record<string, unknown> | null;
    if (meta === null) continue;
    const instances = Array.isArray(meta.instances) ? (meta.instances as unknown[]) : [];
    const instanceId = asString(instances[0]);
    if (instanceId === null) continue;
    const rawPivots = Array.isArray(meta.vtraceCapsulePivots) ? (meta.vtraceCapsulePivots as unknown[]) : [];
    const pivots: PivotInfo[] = rawPivots
      .filter((p): p is Record<string, unknown> => p !== null && typeof p === "object")
      .map((p) => ({
        path: asString(p.path) ?? "",
        symbol: asString(p.symbol),
        roleReason: asString(p.roleReason),
      }))
      .filter((p) => p.path !== "");

    // Edited files from the sibling swebench jsonl modelPatch (best-effort).
    let editedFiles: string[] | null = null;
    try {
      const entries = await readdir(condDir);
      const jsonl = entries.filter((e) => e.endsWith(".jsonl")).sort()[0];
      if (jsonl) {
        const firstLine = (await readFile(path.join(condDir, jsonl), "utf8")).split("\n").find((l) => l.trim() !== "");
        if (firstLine) {
          const rec = JSON.parse(firstLine) as Record<string, unknown>;
          const patch = asString(rec.modelPatch) ?? asString(rec.patch) ?? "";
          editedFiles = editedFilesFromPatch(patch);
        }
      }
    } catch {
      editedFiles = null;
    }

    const list = byInstance.get(instanceId) ?? [];
    list.push({ label, pivots, editedFiles });
    byInstance.set(instanceId, list);
  }
  return byInstance;
}

// Choose a representative live meta (prefer a pivot-check after run, then force,
// then any with pivots) for the anchored/hidden split + edited files.
function chooseLiveMeta(metas: readonly LiveMeta[]): LiveMeta | null {
  const withPivots = metas.filter((m) => m.pivots.length > 0);
  if (withPivots.length === 0) return null;
  const prefer = (pred: (m: LiveMeta) => boolean): LiveMeta | undefined => withPivots.find(pred);
  return (
    prefer((m) => m.label.startsWith("eval-pivot-check-")) ??
    prefer((m) => m.label.includes("force")) ??
    prefer((m) => m.label.startsWith("eval-pivot-telemetry-")) ??
    withPivots[0]!
  );
}

function parseCurated(raw: unknown): Map<string, { editRelevant: boolean | null; classification: string | null }> {
  const map = new Map<string, { editRelevant: boolean | null; classification: string | null }>();
  if (!Array.isArray(raw)) return map;
  for (const entry of raw) {
    if (entry === null || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    const instanceId = asString(e.instanceId);
    if (instanceId === null) continue;
    map.set(instanceId, {
      editRelevant: typeof e.editRelevant === "boolean" ? e.editRelevant : null,
      classification: asString(e.classification),
    });
  }
  return map;
}

function repoFromInstanceId(instanceId: string): string {
  const idx = instanceId.indexOf("__");
  return idx >= 0 ? instanceId.slice(0, idx) : instanceId;
}

// Assemble CandidateInputs from all sources (union of retrieval + live keys).
export async function assembleInputs(resultsDir: string): Promise<{ inputs: CandidateInput[]; sources: string[] }> {
  const sources: string[] = [];
  const retrieval = new Map<string, RetrievalRow>();
  for (const name of ["stage5_retrieval_eval_cross_repo_30.json", "stage5_retrieval_eval_expanded.json"]) {
    const raw = await readJson(path.join(resultsDir, name));
    if (raw !== null) {
      sources.push(name);
      for (const [id, row] of parseRetrievalRows(raw)) if (!retrieval.has(id)) retrieval.set(id, row);
    }
  }
  const runsDir = path.join(resultsDir, "runs");
  const live = await loadLiveMetas(runsDir);
  if (live.size > 0) sources.push("runs/*/raw/vtrace/_run.meta.json (+ modelPatch)");
  const curatedRaw = await readJson(path.join(resultsDir, "stage5_pivot_check_edit_relevance.json"));
  const curated = parseCurated(curatedRaw);
  if (curated.size > 0) sources.push("stage5_pivot_check_edit_relevance.json");

  const allIds = uniq([...retrieval.keys(), ...live.keys()]);
  const inputs: CandidateInput[] = allIds.map((instanceId) => {
    const row = retrieval.get(instanceId) ?? null;
    const liveMeta = chooseLiveMeta(live.get(instanceId) ?? []);
    const cur = curated.get(instanceId) ?? null;

    // Prefer live pivots (what PIVOT_CHECK actually acts on) when available.
    const usingLive = liveMeta !== null;
    const pivots = usingLive ? liveMeta!.pivots : row?.pivots ?? [];
    const anchorSource: AnchorSource =
      pivots.length === 0 ? "none" : usingLive ? "live_role_reason" : "deterministic_rank_proxy";

    return {
      instanceId,
      repo: row?.repo ?? repoFromInstanceId(instanceId),
      goldFiles: row !== null ? row.goldFiles : null,
      pivots,
      pivotSource: pivots.length === 0 ? "none" : usingLive ? "live" : "deterministic",
      anchorSource,
      retrievedGoldAnywhere: row?.retrievedGoldAnywhere ?? null,
      priorLiveLabels: (live.get(instanceId) ?? []).map((m) => m.label),
      priorEditedFiles: liveMeta?.editedFiles ?? null,
      curatedEditRelevant: cur?.editRelevant ?? null,
      curatedClassification: cur?.classification ?? null,
    };
  });
  return { inputs, sources };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export interface CliConfig {
  resultsDir: string;
  outName: string;
}

export function parseArgs(argv: readonly string[]): CliConfig {
  let resultsDir = RESULTS_REL;
  let outName = "stage5_edit_relevant_hidden_pivot_candidates";
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    const next = (): string => {
      const v = argv[i + 1];
      if (v === undefined) throw new Error(`Missing value for ${arg}.`);
      i += 1;
      return v;
    };
    switch (arg) {
      case "--results":
        resultsDir = next();
        break;
      case "--out-name":
        outName = next();
        break;
      case "--help":
      case "-h":
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return { resultsDir, outName };
}

async function main(config: CliConfig): Promise<void> {
  const generatedAt = new Date().toISOString();
  const { inputs, sources } = await assembleInputs(config.resultsDir);
  const report = buildReport(inputs, sources, generatedAt);

  await mkdir(config.resultsDir, { recursive: true });
  const mdPath = path.join(config.resultsDir, `${config.outName}.md`);
  const jsonPath = path.join(config.resultsDir, `${config.outName}.json`);
  await writeFile(mdPath, renderMarkdown(report));
  await writeFile(jsonPath, renderJson(report));

  const s = report.summary;
  process.stdout.write(
    [
      "Stage 5 edit-relevant hidden-pivot candidate discovery written:",
      `  ${mdPath}`,
      `  ${jsonPath}`,
      "",
      `Instances considered: ${s.instancesConsidered}`,
      `Tier 1: ${s.tier1}   Tier 2: ${s.tier2}   Rule-out: ${s.ruleout}   Reject: ${s.reject}`,
      "",
    ].join("\n"),
  );
}

if (import.meta.main) {
  try {
    await main(parseArgs(process.argv.slice(2)));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}
