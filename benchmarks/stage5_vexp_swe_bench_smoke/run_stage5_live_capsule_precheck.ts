// Stage 5 live Capsule v2 pre-check for edit-relevant hidden-pivot candidates.
//
// SCOPE: reporting / validation ONLY. The edit-relevant hidden-pivot discovery
// report (run_stage5_edit_relevant_hidden_pivot_discovery.ts) ranks candidates
// from DETERMINISTIC retrieval + prior live metadata. Its central caveat is that a
// deterministic rank/pivot signal is NOT proof that the suspected gold file is a
// HIDDEN pivot in the actual live injected capsule — a deterministic-only candidate
// can invert reality (the suspected "hidden" gold file may actually be the
// traceback/source-anchored pivot once the live failing-test signal is in play).
//
// This pre-check closes that gap cheaply, BEFORE any expensive live agent run:
//   1. It builds the EXACT same Capsule v2 context a Stage 5 force-inject vtrace run
//      would inject, by calling the very same `prepareIndexedContext` orchestration
//      (checkout → vtrace index → `capsule --intent <i> --budget <n>` query). There
//      is no separate approximation.
//   2. It reads the live capsule's selected pivots (`capsulePivots`, carrying the
//      role-reason the agent would see) and asks: does the suspected edit-relevant
//      hidden/gold file actually appear as a live, non-source-anchored pivot?
//   3. It promotes / demotes / marks-ambiguous each candidate from that live
//      evidence, and emits the controlled before/after run commands ONLY for the
//      candidates the live capsule confirms.
//
// It does NOT call Claude, does NOT run the external vexp-swe-bench agent, does NOT
// patch files, and does NOT run Docker. It changes no retrieval / Capsule scoring /
// PIVOT_CHECK / telemetry logic. The live capsule build is written to an isolated
// `<results>/precheck/` workspace+context dir so the real live `_vtrace_instructions.md`
// and run workspaces are never touched.
//
// Evidence lanes are kept explicit throughout (see the report's "Method" section):
//   - DETERMINISTIC: the discovery report's input tier + its deterministic/telemetry
//     suspicion of which file is the hidden pivot.
//   - LIVE CAPSULE v2: the pivots the live force-inject capsule actually selected,
//     and each pivot's source-anchored vs hidden role from its live role-reason.
//   - GOLD-DERIVED: gold `expected_files` and the hidden∩gold overlap. EVALUATION
//     labels only — never agent input, never fabricated (reported `unknown` absent).
//   - CURATED INTERPRETATION: the promote/demote/ambiguous decision + its reason.

import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";

import {
  prepareIndexedContext,
  type CapsuleEngine,
  type CapsuleV2Intent,
  type CliConfig,
  type IndexedContextResult,
  type RunDeps,
} from "./run_stage5_vexp_swe_bench_smoke";
import { buildCommands, VEXP_DIR, RESULTS_REL } from "./run_stage5_edit_relevant_hidden_pivot_discovery";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type PromotionDecision = "promote" | "demote" | "ambiguous";
export type YesNoUnknown = "yes" | "no" | "unknown";

// One live Capsule v2 pivot, reduced to the role-relevant fields. `roleReason` is
// exactly the live role-reason the agent would see — the only trustworthy source of
// the source-anchored vs hidden split.
export interface LivePivot {
  readonly path: string;
  readonly symbol: string | null;
  readonly roleReason: string | null;
}

// The outcome of actually building the live Capsule v2 for one instance.
export interface LiveCapsuleOutcome {
  // false when the build threw (clone/index/query failure) or did not run the v2 engine.
  readonly built: boolean;
  readonly pivots: readonly LivePivot[];
  // The capsule's realised actual_mode (e.g. "full", "no_context"), when known.
  readonly actualMode: string | null;
  // A human error string when the build failed; null on success.
  readonly error: string | null;
}

// The assembled, pre-evaluation view of one candidate: the deterministic/gold
// suspicion from the discovery report + the freshly-built live capsule evidence.
export interface CandidateCheckInput {
  readonly instanceId: string;
  readonly repo: string;
  // DETERMINISTIC: the discovery report's tier for this candidate.
  readonly inputTier: string;
  // GOLD-DERIVED edit relevance: the suspected hidden pivot files that overlap the
  // gold patch (hidden∩gold). Empty when gold is unknown OR there is no overlap.
  readonly suspectedHiddenGoldFiles: readonly string[];
  // DETERMINISTIC/telemetry suspicion: every hidden pivot file the discovery report
  // named (whether or not gold-confirmed). Reported for transparency.
  readonly suspectedHiddenFiles: readonly string[];
  readonly suspectedHiddenSymbols: readonly string[];
  // GOLD-DERIVED. null => gold metadata absent (never invented).
  readonly goldPatchFiles: readonly string[] | null;
  // LIVE CAPSULE v2 evidence.
  readonly live: LiveCapsuleOutcome;
}

// The fully-evaluated candidate written to the report.
export interface CheckedCandidate {
  readonly instanceId: string;
  readonly repo: string;
  readonly inputTier: string;
  readonly suspectedHiddenGoldFiles: readonly string[];
  readonly suspectedHiddenSymbols: readonly string[];
  // LIVE CAPSULE v2 facts.
  readonly liveCapsuleBuilt: boolean;
  readonly livePivotCount: number;
  readonly livePivots: readonly string[];
  readonly sourceAnchoredPivots: readonly string[];
  readonly hiddenOrNonSourcePivots: readonly string[];
  readonly suspectedFilePresentAsPivot: YesNoUnknown;
  readonly suspectedFileHiddenInLiveCapsule: YesNoUnknown;
  // GOLD-DERIVED.
  readonly pivotsOverlapGoldPatch: YesNoUnknown;
  // CURATED INTERPRETATION.
  readonly promotionDecision: PromotionDecision;
  readonly reason: string;
  // Controlled before/after run labels + commands — populated ONLY when promoted.
  readonly recommendedBeforeLabel: string | null;
  readonly recommendedAfterLabel: string | null;
  readonly commands: readonly string[] | null;
  // The live build error (null on success); surfaced so a demote-by-build-failure
  // is never mistaken for a demote-by-evidence.
  readonly liveBuildError: string | null;
}

export interface PrecheckReport {
  readonly generatedAt: string | null;
  readonly sourceDiscoveryReport: string;
  readonly capsule: {
    readonly engine: CapsuleEngine;
    readonly intent: CapsuleV2Intent;
    readonly budget: number;
    readonly contextPolicy: "force-inject";
  };
  readonly summary: {
    readonly checked: number;
    readonly promoted: number;
    readonly demoted: number;
    readonly ambiguous: number;
  };
  readonly checkedCandidates: readonly CheckedCandidate[];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const DEFAULT_DISCOVERY_REPORT = "stage5_edit_relevant_hidden_pivot_candidates.json";
export const DEFAULT_OUT_NAME = "stage5_live_capsule_precheck_tier2";

// The four evidence lanes the report keeps separate. Rendered verbatim in Method.
export const EVIDENCE_LANES: readonly { lane: string; fields: string }[] = [
  { lane: "DETERMINISTIC (discovery)", fields: "input_tier, suspected_hidden_file(s) named by the discovery report" },
  {
    lane: "LIVE CAPSULE v2",
    fields:
      "live_pivots, source_anchored_pivots, hidden_or_non_source_pivots, suspected_file_present_as_pivot, suspected_file_hidden_in_live_capsule",
  },
  { lane: "GOLD-DERIVED", fields: "suspected_hidden_gold_file(s), pivots_overlap_gold_patch (evaluation labels only)" },
  { lane: "CURATED INTERPRETATION", fields: "promotion_decision, reason" },
];

export const NON_CLAIMS: readonly string[] = [
  "This pre-check does not call Claude.",
  "This pre-check does not run the external vexp-swe-bench agent.",
  "This pre-check does not patch files or run Docker.",
  "This pre-check does not prove PIVOT_CHECK improves patch quality — it only confirms whether the suspected hidden pivot is real in the live capsule.",
  "A promotion means the live capsule confirms the hidden pivot is present; it does not guarantee the agent will edit it.",
  "Gold overlap is an evaluation label; it means the file is in the gold patch, not that the specific symbol must change.",
];

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

export function uniq(values: readonly string[]): string[] {
  return [...new Set(values)];
}

// A live capsule pivot is source-anchored when its role-reason cites the issue's
// source line anchor. Mirrors run_stage5_vexp_swe_bench_smoke.ts `pivotIsHidden`
// and renderHuman.isSourceAnchoredPivot — the SAME predicate PIVOT_CHECK uses.
export function isSourceAnchored(roleReason: string | null): boolean {
  return (roleReason ?? "").includes("source line anchor");
}

// A pivot carries a usable role only when its role-reason is non-empty. A null/blank
// role-reason is "indeterminate": the live capsule built, but the hidden vs anchored
// role cannot be read cleanly from it (→ ambiguous, never a silent promote).
export function hasRole(roleReason: string | null): boolean {
  return roleReason !== null && roleReason.trim().length > 0;
}

// Two repo-relative paths refer to the same file when they are equal or one is a
// path-suffix of the other. The discovery report sometimes carries a repo-trimmed
// path ("db/models/base.py") while the live capsule carries the full one
// ("django/db/models/base.py"); suffix matching reconciles them without inventing
// matches across different files.
export function filesMatch(a: string, b: string): boolean {
  if (a === b) return true;
  return a.endsWith(`/${b}`) || b.endsWith(`/${a}`);
}

function anyFileMatches(file: string, candidates: readonly string[]): boolean {
  return candidates.some((c) => filesMatch(file, c));
}

// The role of a suspected file as the LIVE capsule reports it: "hidden" (present and
// cleanly non-source-anchored), "anchored" (present and source-anchored),
// "indeterminate" (present but role-reason blank), or "absent".
type SuspectedRole = "hidden" | "anchored" | "indeterminate" | "absent";

function suspectedFileRole(suspected: readonly string[], pivots: readonly LivePivot[]): SuspectedRole {
  const matched = pivots.filter((p) => anyFileMatches(p.path, suspected));
  if (matched.length === 0) return "absent";
  if (matched.some((p) => hasRole(p.roleReason) && !isSourceAnchored(p.roleReason))) return "hidden";
  if (matched.some((p) => isSourceAnchored(p.roleReason))) return "anchored";
  return "indeterminate";
}

// The transparent promote/demote/ambiguous decision from the live evidence.
//
// Promote: a suspected edit-relevant hidden/gold file appears as a live Capsule v2
//   pivot, it is NOT source-anchored, and there are >= 2 live pivots.
// Demote: the suspected file is missing from the live pivots, OR is actually
//   source-anchored, OR the capsule has < 2 pivots, OR the build failed / produced
//   no pivots (a retrieval failure, not a hidden-pivot case).
// Ambiguous: the capsule builds with >= 2 pivots, but the suspected file's hidden vs
//   source role cannot be read cleanly, OR gold overlap is unknown so there is no
//   gold-confirmed suspected file to look for.
export function decidePromotion(input: CandidateCheckInput): { decision: PromotionDecision; reason: string } {
  const { live } = input;
  if (!live.built) {
    return { decision: "demote", reason: `live Capsule v2 did not build (${live.error ?? "unknown error"}) — cannot confirm` };
  }
  const pivotCount = live.pivots.length;
  if (pivotCount === 0) {
    return { decision: "demote", reason: "live capsule produced no pivots — retrieval failure, not a hidden-pivot case" };
  }
  if (pivotCount < 2) {
    return { decision: "demote", reason: "live capsule has a single pivot — no multi-pivot localization to validate" };
  }

  const goldKnown = input.goldPatchFiles !== null;
  if (input.suspectedHiddenGoldFiles.length === 0) {
    if (!goldKnown) {
      return {
        decision: "ambiguous",
        reason: "no gold metadata — gold overlap is unknown, so there is no gold-confirmed hidden file to look for in the live capsule",
      };
    }
    return {
      decision: "demote",
      reason: "no hidden pivot overlaps the gold patch — the suspected file is not gold-relevant",
    };
  }

  const role = suspectedFileRole(input.suspectedHiddenGoldFiles, live.pivots);
  switch (role) {
    case "hidden":
      return {
        decision: "promote",
        reason:
          "suspected edit-relevant gold file appears as a non-source-anchored live Capsule v2 pivot among >= 2 pivots — hidden pivot confirmed live",
      };
    case "anchored":
      return {
        decision: "demote",
        reason:
          "suspected file IS present in the live capsule but is source-anchored (traceback/issue-named) — not a hidden pivot; the deterministic signal inverted",
      };
    case "indeterminate":
      return {
        decision: "ambiguous",
        reason:
          "suspected file is present in the live capsule but its pivot role-reason is empty — hidden vs source role cannot be determined cleanly",
      };
    case "absent":
    default:
      return {
        decision: "demote",
        reason:
          "suspected edit-relevant file is absent from the live Capsule v2 pivots — the deterministic suspicion is not confirmed by the live build",
      };
  }
}

// Assemble the fully-evaluated candidate (live facts + decision + commands).
export function evaluateCandidate(input: CandidateCheckInput): CheckedCandidate {
  const { live } = input;
  const pivotFiles = uniq(live.pivots.map((p) => p.path));
  const sourceAnchored = uniq(live.pivots.filter((p) => isSourceAnchored(p.roleReason)).map((p) => p.path));
  // Mirror the live capsule's own pivotIsHidden grouping: every non-source-anchored
  // pivot (including a blank role-reason) is reported as hidden/non-source here.
  const hiddenOrNonSource = uniq(live.pivots.filter((p) => !isSourceAnchored(p.roleReason)).map((p) => p.path));

  const goldKnown = input.goldPatchFiles !== null;
  const haveSuspected = input.suspectedHiddenGoldFiles.length > 0;
  const role = haveSuspected ? suspectedFileRole(input.suspectedHiddenGoldFiles, live.pivots) : "absent";

  let presentAsPivot: YesNoUnknown;
  if (!live.built) presentAsPivot = "unknown";
  else if (!haveSuspected) presentAsPivot = "unknown";
  else presentAsPivot = role === "absent" ? "no" : "yes";

  let hiddenInLive: YesNoUnknown;
  if (!live.built || !haveSuspected) hiddenInLive = "unknown";
  else if (role === "hidden") hiddenInLive = "yes";
  else if (role === "anchored") hiddenInLive = "no";
  else hiddenInLive = "unknown"; // absent or indeterminate

  let overlapGold: YesNoUnknown;
  if (!goldKnown || !live.built) overlapGold = "unknown";
  else overlapGold = pivotFiles.some((f) => anyFileMatches(f, input.goldPatchFiles ?? [])) ? "yes" : "no";

  const { decision, reason } = decidePromotion(input);
  const commands = decision === "promote" ? buildCommands(input.instanceId) : null;

  return {
    instanceId: input.instanceId,
    repo: input.repo,
    inputTier: input.inputTier,
    suspectedHiddenGoldFiles: [...input.suspectedHiddenGoldFiles],
    suspectedHiddenSymbols: [...input.suspectedHiddenSymbols],
    liveCapsuleBuilt: live.built,
    livePivotCount: live.pivots.length,
    livePivots: pivotFiles,
    sourceAnchoredPivots: sourceAnchored,
    hiddenOrNonSourcePivots: hiddenOrNonSource,
    suspectedFilePresentAsPivot: presentAsPivot,
    suspectedFileHiddenInLiveCapsule: hiddenInLive,
    pivotsOverlapGoldPatch: overlapGold,
    promotionDecision: decision,
    reason,
    recommendedBeforeLabel: commands?.beforeLabel ?? null,
    recommendedAfterLabel: commands?.afterLabel ?? null,
    commands: commands?.commands ?? null,
    liveBuildError: live.error,
  };
}

const DECISION_RANK: Record<PromotionDecision, number> = { promote: 0, ambiguous: 1, demote: 2 };

export function buildReport(
  checked: readonly CheckedCandidate[],
  sourceDiscoveryReport: string,
  capsule: PrecheckReport["capsule"],
  generatedAt: string | null,
): PrecheckReport {
  const sorted = [...checked].sort((a, b) => {
    if (DECISION_RANK[a.promotionDecision] !== DECISION_RANK[b.promotionDecision]) {
      return DECISION_RANK[a.promotionDecision] - DECISION_RANK[b.promotionDecision];
    }
    return a.instanceId.localeCompare(b.instanceId);
  });
  const count = (d: PromotionDecision): number => sorted.filter((c) => c.promotionDecision === d).length;
  return {
    generatedAt,
    sourceDiscoveryReport,
    capsule,
    summary: {
      checked: sorted.length,
      promoted: count("promote"),
      demoted: count("demote"),
      ambiguous: count("ambiguous"),
    },
    checkedCandidates: sorted,
  };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function fmtList(values: readonly string[]): string {
  return values.length === 0 ? "—" : values.join(", ");
}

export function renderJson(report: PrecheckReport): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}

function renderCandidateDetail(lines: string[], c: CheckedCandidate): void {
  lines.push(`### ${c.instanceId}`);
  lines.push("");
  lines.push(`- **repo:** ${c.repo}`);
  lines.push(`- **input tier** _(deterministic / discovery)_: ${c.inputTier}`);
  lines.push(`- **suspected hidden gold file(s)** _(gold-derived)_: ${fmtList(c.suspectedHiddenGoldFiles)}`);
  lines.push(`- **suspected hidden symbol(s)** _(deterministic)_: ${fmtList(c.suspectedHiddenSymbols)}`);
  lines.push(`- **live capsule built** _(live)_: ${c.liveCapsuleBuilt ? "yes" : "no"}` + (c.liveBuildError ? ` (${c.liveBuildError})` : ""));
  lines.push(`- **live pivot count** _(live)_: ${c.livePivotCount}`);
  lines.push(`- **live pivots** _(live)_: ${fmtList(c.livePivots)}`);
  lines.push(`- **source-anchored pivots** _(live)_: ${fmtList(c.sourceAnchoredPivots)}`);
  lines.push(`- **hidden / non-source pivots** _(live)_: ${fmtList(c.hiddenOrNonSourcePivots)}`);
  lines.push(`- **suspected file present as pivot** _(live)_: ${c.suspectedFilePresentAsPivot}`);
  lines.push(`- **suspected file hidden in live capsule** _(live)_: ${c.suspectedFileHiddenInLiveCapsule}`);
  lines.push(`- **pivots overlap gold patch** _(gold-derived)_: ${c.pivotsOverlapGoldPatch}`);
  lines.push(`- **promotion decision** _(curated)_: **${c.promotionDecision}**`);
  lines.push(`- **reason** _(curated)_: ${c.reason}`);
  if (c.recommendedBeforeLabel && c.recommendedAfterLabel) {
    lines.push(
      `- **recommended run labels:** \`${c.recommendedBeforeLabel}\` (before) → \`${c.recommendedAfterLabel}\` (after)`,
    );
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

export function renderMarkdown(report: PrecheckReport): string {
  const lines: string[] = [];
  lines.push("# Stage 5 live Capsule v2 pre-check");
  lines.push("");
  if (report.generatedAt) lines.push(`_Generated: ${report.generatedAt}_`, "");
  lines.push(
    "_Reporting / validation only. No Claude, no vexp-swe-bench agent, no patching, no Docker. " +
      "Builds the actual Capsule v2 a force-inject run would inject and checks whether each suspected " +
      "hidden pivot is real in the live capsule._",
  );
  lines.push("");

  // --- Summary -------------------------------------------------------------
  const s = report.summary;
  lines.push("## Summary");
  lines.push("");
  lines.push(`- Candidates checked: ${s.checked}`);
  lines.push(`- Promoted (hidden pivot confirmed live): ${s.promoted}`);
  lines.push(`- Demoted (not confirmed / inverted / retrieval miss): ${s.demoted}`);
  lines.push(`- Ambiguous (role or gold overlap undetermined): ${s.ambiguous}`);
  lines.push("");
  lines.push(
    `Capsule build: engine \`${report.capsule.engine}\`, intent \`${report.capsule.intent}\`, ` +
      `budget \`${report.capsule.budget}\`, context-policy \`${report.capsule.contextPolicy}\`.`,
  );
  lines.push("");
  lines.push(`Source discovery report: \`${report.sourceDiscoveryReport}\``);
  lines.push("");

  // --- Method --------------------------------------------------------------
  lines.push("## Method");
  lines.push("");
  lines.push(
    "For each candidate, this pre-check builds the SAME Capsule v2 context a live Stage 5 " +
      "force-inject vtrace run injects — it calls the identical `prepareIndexedContext` " +
      "orchestration (workspace checkout → vtrace index → `capsule --intent <i> --budget <n>` " +
      "query) used by `run_stage5_vexp_swe_bench_smoke.ts`, into an isolated `precheck/` " +
      "workspace+context dir. It then reads the live capsule's selected pivots and their " +
      "role-reasons and checks whether the suspected edit-relevant gold file appears as a live, " +
      "non-source-anchored pivot. No agent runs; the build is cheap relative to a full live run.",
  );
  lines.push("");
  lines.push("### Evidence lanes");
  lines.push("");
  lines.push("Each major field comes from exactly one evidence lane, kept explicit so a deterministic suspicion is never confused with live or gold evidence:");
  lines.push("");
  for (const l of EVIDENCE_LANES) lines.push(`- **${l.lane}:** ${l.fields}`);
  lines.push("");
  lines.push(
    "A pivot is source-anchored iff its live role-reason names the issue's `source line anchor`; " +
      "every other pivot is hidden/non-source. A blank role-reason is treated as indeterminate " +
      "(→ ambiguous), never silently promoted.",
  );
  lines.push("");

  // --- Candidates checked (compact table) ---------------------------------
  lines.push("## Candidates checked");
  lines.push("");
  if (report.checkedCandidates.length === 0) {
    lines.push("_None selected._");
    lines.push("");
  } else {
    lines.push("| instance | tier | built | pivots | suspected present | suspected hidden | gold overlap | decision |");
    lines.push("| --- | --- | :---: | ---: | :---: | :---: | :---: | --- |");
    for (const c of report.checkedCandidates) {
      lines.push(
        `| ${c.instanceId} | ${c.inputTier} | ${c.liveCapsuleBuilt ? "yes" : "no"} | ${c.livePivotCount} | ` +
          `${c.suspectedFilePresentAsPivot} | ${c.suspectedFileHiddenInLiveCapsule} | ${c.pivotsOverlapGoldPatch} | ${c.promotionDecision} |`,
      );
    }
    lines.push("");
  }

  const byDecision = (d: PromotionDecision): CheckedCandidate[] =>
    report.checkedCandidates.filter((c) => c.promotionDecision === d);
  const detailSection = (title: string, d: PromotionDecision, emptyNote: string): void => {
    lines.push(title);
    lines.push("");
    const cands = byDecision(d);
    if (cands.length === 0) {
      lines.push(emptyNote);
      lines.push("");
      return;
    }
    for (const c of cands) renderCandidateDetail(lines, c);
  };

  detailSection("## Promoted candidates", "promote", "_None — no suspected hidden pivot was confirmed in a live capsule._");
  detailSection("## Demoted candidates", "demote", "_None._");
  detailSection("## Ambiguous candidates", "ambiguous", "_None._");

  // --- Recommended next live runs -----------------------------------------
  lines.push("## Recommended next live runs");
  lines.push("");
  const promoted = byDecision("promote");
  if (promoted.length === 0) {
    lines.push(
      "_No candidate was promoted by the live capsule — do NOT spend live agent runs on these. " +
        "Re-examine the demoted/ambiguous candidates or gather more multi-pivot live capsules first._",
    );
  } else {
    lines.push("Run the controlled before/after pair (the exact commands are in each promoted candidate above):");
    lines.push("");
    for (const c of promoted) {
      lines.push(`1. **${c.instanceId}** — ${c.reason}`);
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
// Discovery-report loading (impure)
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

// The discovery-report fields the pre-check consumes for one candidate. Kept narrow:
// only the deterministic suspicion + gold metadata, never the discovery report's own
// tiering decision (the live capsule overrides it).
export interface DiscoveryCandidateLite {
  readonly instanceId: string;
  readonly repo: string;
  readonly tier: string;
  readonly hiddenPivotFiles: string[];
  readonly hiddenPivotSymbols: string[];
  readonly goldPatchFiles: string[] | null;
}

// Parse the discovery JSON into the narrow per-candidate view. `goldPatchFiles` is
// kept null (not []) when the discovery report had no gold metadata, so the
// pre-check reports edit relevance as `unknown` instead of fabricating it.
export function parseDiscoveryCandidates(raw: unknown): DiscoveryCandidateLite[] {
  if (raw === null || typeof raw !== "object") return [];
  const candidates = (raw as { candidates?: unknown }).candidates;
  if (!Array.isArray(candidates)) return [];
  const out: DiscoveryCandidateLite[] = [];
  for (const entry of candidates) {
    if (entry === null || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    const instanceId = asString(e.instanceId);
    if (instanceId === null) continue;
    out.push({
      instanceId,
      repo: asString(e.repo) ?? "",
      tier: asString(e.tier) ?? "unknown",
      hiddenPivotFiles: asStringArray(e.hiddenPivotFiles),
      hiddenPivotSymbols: asStringArray(e.hiddenPivotSymbols),
      goldPatchFiles: Array.isArray(e.goldPatchFiles) ? asStringArray(e.goldPatchFiles) : null,
    });
  }
  return out;
}

// hidden∩gold (gold-derived edit relevance). Empty when gold is absent (→ the
// candidate's suspected-gold set is empty and the decision degrades to ambiguous,
// never fabricating an edit-relevant file).
export function suspectedHiddenGold(c: DiscoveryCandidateLite): string[] {
  if (c.goldPatchFiles === null) return [];
  return c.hiddenPivotFiles.filter((f) => c.goldPatchFiles!.some((g) => filesMatch(f, g)));
}

// Map the discovery tier strings to the CLI `--tiers` tokens (Tier1/Tier2/...).
export function tierMatches(candidateTier: string, requested: readonly string[]): boolean {
  const norm = (t: string): string => t.toLowerCase().replace(/[^a-z0-9]/g, "");
  const want = requested.map(norm);
  return want.length === 0 || want.includes(norm(candidateTier));
}

// ---------------------------------------------------------------------------
// Live Capsule v2 build (impure) — reuses the real prepareIndexedContext path
// ---------------------------------------------------------------------------

// Build the live Capsule v2 config for ONE instance. It mirrors the live force-inject
// run's knobs exactly (engine v2 + intent + budget + force-inject) but writes the
// context file and workspace into an isolated `<results>/precheck` dir so the real
// `_vtrace_instructions.md` and run workspaces are never touched.
export function buildPrecheckConfig(opts: {
  instanceId: string;
  vexpSweBenchDir: string;
  resultsDir: string;
  capsuleEngine: CapsuleEngine;
  capsuleIntent: CapsuleV2Intent;
  capsuleBudget: number;
  reuseWorkspace: boolean;
}): CliConfig {
  return {
    mode: "run-protocol",
    vexpSweBenchDir: opts.vexpSweBenchDir,
    instances: [opts.instanceId],
    instancesFile: "benchmarks/stage5_vexp_swe_bench_smoke/smoke_instances.json",
    out: path.join(opts.resultsDir, "precheck"),
    nodeCommand: "node",
    cliEntry: "dist/cli.js",
    vtraceMethod: "indexed-context",
    yes: true,
    vtraceCommand: "bun src/cli/index.ts",
    vtraceIndexArgs: "--quiet",
    vtraceQueryArgs: "",
    skipVtraceIndexIfPresent: false,
    reuseWorkspace: opts.reuseWorkspace,
    indexPolicy: "auto",
    showVtraceIndexLog: false,
    vtraceContextMaxChars: 12000,
    vtraceContextMaxItems: 8,
    capsuleEngine: opts.capsuleEngine,
    capsuleIntent: opts.capsuleIntent,
    capsuleBudget: opts.capsuleBudget,
    captureProductV2Accounting: false,
    contextPolicyOverride: "force-inject",
    pivotCheckPolicy: "risk_gated",
    pivotCheckGate: "off",
    pivotCheckGatePhase1Only: false,
    disablePivotCheck: false,
    pivotInspectionEnforcement: false,
    ruleoutSufficiencyCheck: false,
    ruleoutSufficiencyCorrectivePass: false,
    pivotRevisionPass: false,
    revisionVerificationPolicy: "none",
    patchSource: "pivot_revision_revised",
    commandSource: "pivot_revision_test_commands",
    allowDockerVerify: false,
    disableEditGuard: false,
    disablePatchVerify: false,
    disableToolUseDiscipline: false,
    disableTokenDiscipline: false,
    sweBenchDataFile: null,
    runLabel: null,
    runLabels: null,
    protocol: "vtrace-indexed",
    allowVexp: false,
    evalMode: "docker",
    evalDataset: null,
    evalTimeout: 1800,
  };
}

// Reduce an IndexedContextResult to the pre-check's live evidence. A v2 result with
// real pivots is `built: true`; a no-context/empty result still counts as "built"
// (the capsule ran) but with zero pivots → the decision demotes it as a retrieval
// failure.
export function liveOutcomeFromResult(result: IndexedContextResult): LiveCapsuleOutcome {
  const built = result.capsuleEngine === "v2";
  return {
    built,
    pivots: result.capsulePivots.map((p) => ({ path: p.path, symbol: p.symbol || null, roleReason: p.roleReason })),
    actualMode: result.capsuleActualMode,
    error: result.contextError,
  };
}

// How a live capsule is built for the orchestrator. Injectable so tests never run a
// subprocess (the default calls the real prepareIndexedContext path).
export type LiveCapsuleBuilder = (instanceId: string) => Promise<LiveCapsuleOutcome>;

export interface PrecheckOrchestrationConfig {
  readonly resultsDir: string;
  readonly vexpSweBenchDir: string | null;
  readonly discoveryReport: string;
  readonly instances: readonly string[];
  readonly tiers: readonly string[];
  readonly capsuleEngine: CapsuleEngine;
  readonly capsuleIntent: CapsuleV2Intent;
  readonly capsuleBudget: number;
  readonly reuseWorkspace: boolean;
  readonly outName: string;
}

export interface PrecheckDeps {
  readonly buildLiveCapsule?: LiveCapsuleBuilder;
  readonly runDeps?: RunDeps;
}

// Select which discovery candidates to check: an explicit --instances subset wins;
// otherwise every candidate whose tier is in --tiers.
export function selectCandidates(
  discovery: readonly DiscoveryCandidateLite[],
  instances: readonly string[],
  tiers: readonly string[],
): DiscoveryCandidateLite[] {
  if (instances.length > 0) {
    const want = new Set(instances);
    return discovery.filter((c) => want.has(c.instanceId));
  }
  return discovery.filter((c) => tierMatches(c.tier, tiers));
}

// The default live builder: construct the per-instance config and run the real
// Capsule v2 orchestration. Catches build failures into a `built: false` outcome so
// one broken checkout never aborts the whole pre-check.
function defaultLiveBuilder(config: PrecheckOrchestrationConfig, deps: PrecheckDeps): LiveCapsuleBuilder {
  return async (instanceId: string): Promise<LiveCapsuleOutcome> => {
    if (config.vexpSweBenchDir === null) {
      return { built: false, pivots: [], actualMode: null, error: "missing --vexp-swe-bench-dir" };
    }
    const cliConfig = buildPrecheckConfig({
      instanceId,
      vexpSweBenchDir: config.vexpSweBenchDir,
      resultsDir: config.resultsDir,
      capsuleEngine: config.capsuleEngine,
      capsuleIntent: config.capsuleIntent,
      capsuleBudget: config.capsuleBudget,
      reuseWorkspace: config.reuseWorkspace,
    });
    try {
      const result = await prepareIndexedContext(cliConfig, deps.runDeps ?? {});
      return liveOutcomeFromResult(result);
    } catch (error) {
      return { built: false, pivots: [], actualMode: null, error: error instanceof Error ? error.message : String(error) };
    }
  };
}

// Run the full pre-check: load discovery → select candidates → build each live
// capsule → evaluate → assemble the report. Pure-ish (no file writes); the caller
// renders + writes the artifacts.
export async function runPrecheck(
  config: PrecheckOrchestrationConfig,
  deps: PrecheckDeps = {},
  generatedAt: string | null = null,
): Promise<PrecheckReport> {
  const discoveryRaw = await readJson(config.discoveryReport);
  const discovery = parseDiscoveryCandidates(discoveryRaw);
  const selected = selectCandidates(discovery, config.instances, config.tiers);
  const build = deps.buildLiveCapsule ?? defaultLiveBuilder(config, deps);

  const checked: CheckedCandidate[] = [];
  for (const cand of selected) {
    const live = await build(cand.instanceId);
    const input: CandidateCheckInput = {
      instanceId: cand.instanceId,
      repo: cand.repo,
      inputTier: cand.tier,
      suspectedHiddenGoldFiles: suspectedHiddenGold(cand),
      suspectedHiddenFiles: cand.hiddenPivotFiles,
      suspectedHiddenSymbols: cand.hiddenPivotSymbols,
      goldPatchFiles: cand.goldPatchFiles,
      live,
    };
    checked.push(evaluateCandidate(input));
  }

  return buildReport(checked, path.basename(config.discoveryReport), {
    engine: config.capsuleEngine,
    intent: config.capsuleIntent,
    budget: config.capsuleBudget,
    contextPolicy: "force-inject",
  }, generatedAt);
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export interface CliConfigParsed {
  readonly resultsDir: string;
  readonly vexpSweBenchDir: string | null;
  readonly discoveryReport: string;
  readonly instances: readonly string[];
  readonly tiers: readonly string[];
  readonly capsuleEngine: CapsuleEngine;
  readonly capsuleIntent: CapsuleV2Intent;
  readonly capsuleBudget: number;
  readonly reuseWorkspace: boolean;
  readonly outName: string;
}

function splitCsv(value: string): string[] {
  return value.split(",").map((v) => v.trim()).filter((v) => v.length > 0);
}

export function parseArgs(argv: readonly string[]): CliConfigParsed {
  let resultsDir = RESULTS_REL;
  let vexpSweBenchDir: string | null = null;
  let discoveryReport: string | null = null;
  let instances: string[] = [];
  let tiers: string[] = ["Tier2"];
  let capsuleEngine: CapsuleEngine = "v2";
  let capsuleIntent: CapsuleV2Intent = "debug";
  let capsuleBudget = 8000;
  let reuseWorkspace = false;
  let outName = DEFAULT_OUT_NAME;

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
      case "--vexp-swe-bench-dir":
        vexpSweBenchDir = next();
        break;
      case "--from-discovery":
        discoveryReport = next();
        break;
      case "--instances":
        instances = splitCsv(next());
        break;
      case "--tiers":
        tiers = splitCsv(next());
        break;
      case "--capsule-engine": {
        const v = next();
        if (v !== "v2") throw new Error(`--capsule-engine must be v2 for the live capsule pre-check (got "${v}").`);
        capsuleEngine = v;
        break;
      }
      case "--capsule-intent":
        capsuleIntent = next() as CapsuleV2Intent;
        break;
      case "--capsule-budget": {
        const v = Number(next());
        if (!Number.isFinite(v) || v <= 0) throw new Error("--capsule-budget must be a positive number.");
        capsuleBudget = v;
        break;
      }
      case "--reuse-workspace":
        reuseWorkspace = true;
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

  const resolvedDiscovery = discoveryReport ?? path.join(resultsDir, DEFAULT_DISCOVERY_REPORT);
  return {
    resultsDir,
    vexpSweBenchDir,
    discoveryReport: resolvedDiscovery,
    instances,
    tiers,
    capsuleEngine,
    capsuleIntent,
    capsuleBudget,
    reuseWorkspace,
    outName,
  };
}

async function main(config: CliConfigParsed): Promise<void> {
  if (config.vexpSweBenchDir === null) {
    throw new Error(
      "The live Capsule v2 pre-check requires --vexp-swe-bench-dir to locate instance data and build the capsule.",
    );
  }
  const generatedAt = new Date().toISOString();
  const report = await runPrecheck(
    {
      resultsDir: config.resultsDir,
      vexpSweBenchDir: config.vexpSweBenchDir,
      discoveryReport: config.discoveryReport,
      instances: config.instances,
      tiers: config.tiers,
      capsuleEngine: config.capsuleEngine,
      capsuleIntent: config.capsuleIntent,
      capsuleBudget: config.capsuleBudget,
      reuseWorkspace: config.reuseWorkspace,
      outName: config.outName,
    },
    {},
    generatedAt,
  );

  await mkdir(config.resultsDir, { recursive: true });
  const mdPath = path.join(config.resultsDir, `${config.outName}.md`);
  const jsonPath = path.join(config.resultsDir, `${config.outName}.json`);
  await writeFile(mdPath, renderMarkdown(report));
  await writeFile(jsonPath, renderJson(report));

  const s = report.summary;
  process.stdout.write(
    [
      "Stage 5 live Capsule v2 pre-check written:",
      `  ${mdPath}`,
      `  ${jsonPath}`,
      "",
      `Checked: ${s.checked}   Promoted: ${s.promoted}   Demoted: ${s.demoted}   Ambiguous: ${s.ambiguous}`,
      "",
    ].join("\n"),
  );
}

// Re-export so downstream tooling can reach the canonical vexp dir constant.
export { VEXP_DIR };

if (import.meta.main) {
  try {
    await main(parseArgs(process.argv.slice(2)));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}
