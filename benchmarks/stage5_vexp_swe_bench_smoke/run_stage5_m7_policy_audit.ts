// Stage 5 — M7 conservative-localization policy audit (OFFLINE).
//
// WHY THIS EXISTS
// ----------------
// M6's bounded 20-case live validation found that Capsule v2 retrieval helps when
// context is genuinely useful, but the auto-policy INJECTS TOO OFTEN: a 47%
// useful-injection rate, a 24% inject-without-benefit rate, and a 25% resolution-
// regression rate. M7 adds a conservative localization gate that SKIPS injection
// when the issue text already localizes the edit site (a traceback frame, an
// explicit file, or a symbol that resolves in the index), while still injecting
// when vtrace has a real advantage (a generated/co-edit actionability obligation,
// a hidden pivot the issue never names, edit-risk/anchor/subsystem evidence).
//
// This script runs the OLD and NEW policy OFFLINE over the same 20 M6 cases and
// reports, per case, whether the new gate would have skipped the inject-without-
// benefit / regression cases WITHOUT skipping the known-useful / actionability /
// safe-no_context cases.
//
//   * NO Claude. NO Docker. NO vexp agent execution. NO API calls.
//   * Capsule v2 is built in-process from the SAME task text the LIVE harness
//     feeds it (`buildCapsuleV2Task` = full problem statement + failing tests +
//     hints, truncated to the live query cap) so the policy sees what it sees live.
//   * The gold patch is NEVER read. The detector uses only issue text + the index.
//   * "old policy action" = the M7 gate with its localization inputs DISABLED,
//     which is provably identical to the pre-M7 gate — so the OLD→NEW delta is
//     exactly the M7 logic, not any unrelated drift.
//
// M6 per-case outcomes (classification / live action / resolution delta) are
// carried as constants transcribed from `stage5_bounded_20_case_validation.md`
// so the audit can judge whether the right cases flip. They are LABELS for
// scoring only — never fed into retrieval or the policy.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { openIndexerDatabase } from "../../src/db/sqlite";
import { buildCapsuleV2 } from "../../src/capsuleV2/buildCapsuleV2";
import { CapsuleIntent, parseCapsuleIntent } from "../../src/capsuleV2/types";
import { pathIsUserLocalized } from "../../src/capsuleV2/localizationSignals";
import {
  buildCapsuleV2Task,
  decideCapsuleV2ContextPolicy,
  deriveContextPolicySignals,
  toSweBenchInstance,
  type CapsuleV2PolicyDiagnostics,
  type ContextPolicyDecision,
  type ContextPolicySignals,
} from "./run_stage5_vexp_swe_bench_smoke";

// --- M6 ground-truth labels (from stage5_bounded_20_case_validation.md) --------

type M6Class =
  | "strict_efficiency_pass"
  | "actionability_success"
  | "no_context_safety_pass"
  | "inject_without_benefit"
  | "resolution_improvement_with_cost"
  | "resolution_regression"
  | "patch_synthesis_bound";

type ResolutionDelta = "improved" | "regressed" | "unchanged";

interface M6Case {
  readonly id: string;
  readonly m6Class: M6Class;
  readonly m6LiveAction: "inject" | "skip";
  readonly m6Resolution: ResolutionDelta;
  // Should a conservative policy ideally SKIP this case? True for cases where M6
  // showed injection did not help (inject-without-benefit) or hurt (resolution
  // regression). False for known-useful / actionability / safe-skip cases that
  // MUST keep their behaviour.
  readonly skipDesired: boolean;
}

const M6_CASES: readonly M6Case[] = [
  // Known-useful injected wins — must STAY inject.
  { id: "matplotlib__matplotlib-24627", m6Class: "strict_efficiency_pass", m6LiveAction: "inject", m6Resolution: "unchanged", skipDesired: false },
  { id: "sphinx-doc__sphinx-7748", m6Class: "strict_efficiency_pass", m6LiveAction: "inject", m6Resolution: "unchanged", skipDesired: false },
  { id: "psf__requests-1142", m6Class: "strict_efficiency_pass", m6LiveAction: "inject", m6Resolution: "unchanged", skipDesired: false },
  { id: "matplotlib__matplotlib-25960", m6Class: "strict_efficiency_pass", m6LiveAction: "inject", m6Resolution: "improved", skipDesired: false },
  { id: "django__django-11728", m6Class: "strict_efficiency_pass", m6LiveAction: "inject", m6Resolution: "improved", skipDesired: false },
  // Actionability win — must STAY inject (generated-artifact obligation helped).
  { id: "astropy__astropy-14369", m6Class: "actionability_success", m6LiveAction: "inject", m6Resolution: "improved", skipDesired: false },
  // Resolution improvement with cost — useful, keep inject.
  { id: "astropy__astropy-14365", m6Class: "resolution_improvement_with_cost", m6LiveAction: "inject", m6Resolution: "improved", skipDesired: false },
  // Safe no_context — must STAY skip.
  { id: "pallets__flask-5014", m6Class: "no_context_safety_pass", m6LiveAction: "skip", m6Resolution: "unchanged", skipDesired: true },
  { id: "django__django-11095", m6Class: "no_context_safety_pass", m6LiveAction: "skip", m6Resolution: "unchanged", skipDesired: true },
  { id: "sympy__sympy-12481", m6Class: "no_context_safety_pass", m6LiveAction: "skip", m6Resolution: "unchanged", skipDesired: true },
  // Inject-without-benefit — should ideally SKIP.
  { id: "sphinx-doc__sphinx-7462", m6Class: "inject_without_benefit", m6LiveAction: "inject", m6Resolution: "unchanged", skipDesired: true },
  { id: "sympy__sympy-16766", m6Class: "inject_without_benefit", m6LiveAction: "inject", m6Resolution: "unchanged", skipDesired: true },
  { id: "psf__requests-5414", m6Class: "inject_without_benefit", m6LiveAction: "inject", m6Resolution: "unchanged", skipDesired: true },
  // Resolution regression — should ideally SKIP (injection paired with a loss).
  { id: "sympy__sympy-12419", m6Class: "resolution_regression", m6LiveAction: "inject", m6Resolution: "regressed", skipDesired: true },
  { id: "astropy__astropy-14539", m6Class: "resolution_regression", m6LiveAction: "inject", m6Resolution: "regressed", skipDesired: true },
  { id: "pylint-dev__pylint-8898", m6Class: "resolution_regression", m6LiveAction: "inject", m6Resolution: "regressed", skipDesired: true },
  { id: "sympy__sympy-13372", m6Class: "resolution_regression", m6LiveAction: "inject", m6Resolution: "regressed", skipDesired: true },
  { id: "pydata__xarray-3677", m6Class: "resolution_regression", m6LiveAction: "inject", m6Resolution: "regressed", skipDesired: true },
  // Patch-synthesis bound — injection neither helped nor hurt resolution; co-edit
  // follow-through is the real gap. Treated as "no strong preference" (skipDesired
  // false: these were not flagged inject-without-benefit, and keeping context for a
  // genuinely multi-file task is defensible).
  { id: "mwaskom__seaborn-3187", m6Class: "patch_synthesis_bound", m6LiveAction: "inject", m6Resolution: "unchanged", skipDesired: false },
  { id: "django__django-13195", m6Class: "patch_synthesis_bound", m6LiveAction: "inject", m6Resolution: "unchanged", skipDesired: false },
];

// --- fixtures + dataset --------------------------------------------------------

const FIXTURES = [
  "benchmarks/stage5_vexp_swe_bench_smoke/retrieval_eval.cross_repo.30.json",
  "benchmarks/stage5_vexp_swe_bench_smoke/retrieval_eval.django.expanded.json",
];
const DEFAULT_DATASET = "/home/calvin/code/vexp-swe-bench/data/swe-bench-100.jsonl";
const DEFAULT_OUT = "benchmarks/stage5_vexp_swe_bench_smoke/results/stage5_m7_policy_audit_on_m6_cases.md";

interface FixtureEntry {
  readonly instance_id: string;
  readonly workspace: string;
  readonly intent: string;
  readonly budget: number;
}

async function loadFixtures(): Promise<Map<string, FixtureEntry>> {
  const map = new Map<string, FixtureEntry>();
  for (const fixture of FIXTURES) {
    const entries = JSON.parse(await readFile(fixture, "utf8")) as FixtureEntry[];
    for (const entry of entries) map.set(entry.instance_id, entry);
  }
  return map;
}

async function loadDataset(datasetPath: string): Promise<Map<string, Record<string, unknown>>> {
  const map = new Map<string, Record<string, unknown>>();
  const content = await readFile(datasetPath, "utf8");
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    const row = JSON.parse(trimmed) as Record<string, unknown>;
    const id = (row.instance_id ?? row.instanceId) as string | undefined;
    if (typeof id === "string") map.set(id, row);
  }
  return map;
}

// --- audit core ----------------------------------------------------------------

type Action = ContextPolicyDecision["action"];

interface CaseAudit {
  readonly id: string;
  readonly m6Class: M6Class;
  readonly m6LiveAction: "inject" | "skip";
  readonly m6Resolution: ResolutionDelta;
  readonly skipDesired: boolean;
  readonly localizationConfidence: string;
  readonly localizationKind: string;
  readonly topPivot: string | null;
  readonly topPivotUserLocalized: boolean;
  readonly actionabilityHintCount: number;
  readonly advantageSignals: readonly string[];
  readonly oldAction: Action;
  readonly newAction: Action;
  readonly newReason: string;
  readonly newSkipSignal: string | null;
  readonly flipped: "skip→inject" | "inject→skip" | "unchanged";
}

// Build the v2 policy diagnostics from a built capsule result — the exact mapping
// the live harness performs from its classification, but in-process.
function policyDiagnostics(
  result: ReturnType<typeof buildCapsuleV2>,
  withM7: boolean,
): CapsuleV2PolicyDiagnostics {
  const topPivot = result.pivots[0] ?? null;
  const topSource = topPivot && typeof topPivot.source === "string" ? topPivot.source : null;
  const diagnostics = result.diagnostics;
  const base: CapsuleV2PolicyDiagnostics = {
    capsuleAction: result.actual_mode === "no_context" ? "skip" : "inject",
    hasContext: result.actual_mode !== "no_context",
    actualMode: result.actual_mode,
    pivotCount: result.pivots.length,
    supportCount: result.support.length,
    topPivotHasSource: topSource !== null && topSource.length > 0,
    topPivotSourceChars: topSource ? topSource.length : null,
    editRiskDirectiveCount: diagnostics.edit_risk_directives?.length ?? 0,
    lineAnchorResolutionUsed: diagnostics.line_anchor_resolution_used ?? false,
    sqlRenderingBackfillUsed: diagnostics.sql_rendering_backfill_used ?? false,
  };
  if (!withM7) return base;
  return {
    ...base,
    actionabilityHintCount: result.actionability_hints?.length ?? 0,
    topPivotPath: topPivot?.path ?? null,
    localization: diagnostics.localization_signals,
  };
}

function auditCase(
  m6: M6Case,
  signals: ContextPolicySignals,
  result: ReturnType<typeof buildCapsuleV2>,
): CaseAudit {
  const oldDecision = decideCapsuleV2ContextPolicy(signals, policyDiagnostics(result, false));
  const newDecision = decideCapsuleV2ContextPolicy(signals, policyDiagnostics(result, true));
  const loc = result.diagnostics.localization_signals;
  const topPivot = result.pivots[0] ?? null;
  const topPivotUserLocalized =
    loc !== undefined && pathIsUserLocalized(topPivot?.path ?? null, loc.resolvedFiles);
  const skipSignal =
    newDecision.decisionSignals.find((s) => s.startsWith("skip_")) ?? null;
  const flipped: CaseAudit["flipped"] =
    oldDecision.action === newDecision.action
      ? "unchanged"
      : oldDecision.action === "inject"
        ? "inject→skip"
        : "skip→inject";
  return {
    id: m6.id,
    m6Class: m6.m6Class,
    m6LiveAction: m6.m6LiveAction,
    m6Resolution: m6.m6Resolution,
    skipDesired: m6.skipDesired,
    localizationConfidence: loc?.confidence ?? "n/a",
    localizationKind: loc?.kind ?? "n/a",
    topPivot: topPivot ? `${topPivot.path}::${topPivot.symbol}` : null,
    topPivotUserLocalized,
    actionabilityHintCount: result.actionability_hints?.length ?? 0,
    advantageSignals: newDecision.vtraceAdvantageSignals ?? [],
    oldAction: oldDecision.action,
    newAction: newDecision.action,
    newReason: newDecision.reason,
    newSkipSignal: skipSignal,
    flipped,
  };
}

// --- report --------------------------------------------------------------------

function shortId(id: string): string {
  return id.includes("__") ? id.split("__")[1]! : id;
}

function renderMarkdown(audits: readonly CaseAudit[], datasetPath: string): string {
  const lines: string[] = [];
  const inj2skip = audits.filter((a) => a.flipped === "inject→skip");
  const skip2inj = audits.filter((a) => a.flipped === "skip→inject");
  const desiredSkips = audits.filter((a) => a.skipDesired);
  const usefulOrSafe = audits.filter((a) => !a.skipDesired);
  const correctlyFlipped = inj2skip.filter((a) => a.skipDesired);
  const safePreserved = usefulOrSafe.filter((a) => a.newAction === a.oldAction);
  const harmfulFlips = usefulOrSafe.filter((a) => a.flipped === "inject→skip");

  lines.push("# Stage 5 — M7 conservative-localization policy audit (offline)", "");
  lines.push("## Scope", "");
  lines.push(
    "**Deterministic, offline policy audit — no Claude, no Docker, no agent run, no API calls.**",
    "",
    "Runs the OLD and NEW Capsule v2 cost-aware context policy over the 20 M6",
    "bounded-validation cases. Capsule v2 is built in-process from the SAME task",
    "text the live harness feeds it (`buildCapsuleV2Task` = full problem statement +",
    "failing tests + hints). The localization detector reads ONLY issue text + the",
    "repo index — never the gold patch. `old action` is the M7 gate with its",
    "localization inputs disabled (provably identical to the pre-M7 gate), so the",
    "OLD→NEW delta is exactly the M7 conservative-skip logic.",
    "",
    `- dataset (full issue text): \`${datasetPath}\``,
    "- M6 outcome labels transcribed from `stage5_bounded_20_case_validation.md` (scoring only).",
    "",
  );

  lines.push("## Headline", "");
  lines.push(
    `- cases audited: **${audits.length}**`,
    `- inject→skip flips: **${inj2skip.length}** — ${inj2skip.map((a) => shortId(a.id)).join(", ") || "none"}`,
    `- skip→inject flips: **${skip2inj.length}** — ${skip2inj.map((a) => shortId(a.id)).join(", ") || "none"}`,
    `- desired-skip cases (inject-without-benefit + regression) now skipped: **${correctlyFlipped.length}/${desiredSkips.filter((a) => a.m6LiveAction === "inject").length}**`,
    `- known useful / safe cases preserved: **${safePreserved.length}/${usefulOrSafe.length}**`,
    `- harmful flips (useful/safe case wrongly skipped): **${harmfulFlips.length}** — ${harmfulFlips.map((a) => shortId(a.id)).join(", ") || "none"}`,
    "",
  );

  lines.push("## Success criteria", "");
  const useful = audits.filter((a) => a.m6Class === "strict_efficiency_pass");
  const astropy = audits.find((a) => a.id === "astropy__astropy-14369");
  const safeSkips = audits.filter((a) => a.m6Class === "no_context_safety_pass");
  const crit = (ok: boolean): string => (ok ? "✅" : "❌");
  const usefulOk = useful.every((a) => a.newAction === "inject");
  const astropyOk = astropy?.newAction === "inject";
  const safeOk = safeSkips.every((a) => a.newAction === "no_context");
  const someFlipped = correctlyFlipped.length > 0;
  lines.push(
    `1. ${crit(usefulOk)} known useful injected wins remain **inject** (${useful.filter((a) => a.newAction === "inject").length}/${useful.length})`,
    `2. ${crit(Boolean(astropyOk))} astropy actionability remains **inject**`,
    `3. ${crit(safeOk)} safe no_context remains **skip** (${safeSkips.filter((a) => a.newAction === "no_context").length}/${safeSkips.length})`,
    `4. ${crit(someFlipped)} at least some inject-without-benefit / regression cases become **skip** (${correctlyFlipped.length})`,
    `5. ✅ policy reasons are explicit and inspectable (see per-case table)`,
    "",
  );

  lines.push("## Per-case decisions", "");
  lines.push(
    "| case | M6 class | M6 res. | loc conf | kind | top pivot localized? | actionability | old → new | flip | new skip signal |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
  );
  for (const a of audits) {
    lines.push(
      `| ${shortId(a.id)} | ${a.m6Class} | ${a.m6Resolution} | ${a.localizationConfidence} | ${a.localizationKind} | `
      + `${a.topPivotUserLocalized ? "yes" : "no"} | ${a.actionabilityHintCount > 0 ? `${a.actionabilityHintCount}` : "—"} | `
      + `${a.oldAction} → ${a.newAction} | ${a.flipped === "unchanged" ? "—" : a.flipped} | ${a.newSkipSignal ?? "—"} |`,
    );
  }
  lines.push("");

  lines.push("## Per-case detail", "");
  for (const a of audits) {
    lines.push(`### ${shortId(a.id)} — ${a.m6Class}`, "");
    lines.push(
      `- M6: live=${a.m6LiveAction}, resolution=${a.m6Resolution}, skip-desired=${a.skipDesired}`,
      `- top pivot: ${a.topPivot ?? "—"} (user-localized: ${a.topPivotUserLocalized})`,
      `- localization: confidence=${a.localizationConfidence}, kind=${a.localizationKind}`,
      `- actionability hints: ${a.actionabilityHintCount}`,
      `- advantage signals: ${a.advantageSignals.join(", ") || "none"}`,
      `- policy: **${a.oldAction} → ${a.newAction}** (${a.flipped})`,
      `- new reason: ${a.newReason}`,
      "",
    );
  }

  lines.push("## Notes", "");
  lines.push(
    "- The localization detector resolves file/symbol mentions against the indexed",
    "  repo only; non-resolving prose and common words never count as localization.",
    "- A regression case that does NOT flip is reported honestly — the policy could",
    "  not distinguish it from a useful injection on localization signal alone.",
    "- This audit measures the POLICY DECISION change only; it does not re-run agents,",
    "  so it does not by itself prove the resolution regressions disappear. It proves",
    "  which cases the new gate would stop injecting on.",
    "",
  );
  return lines.join("\n");
}

// --- main ----------------------------------------------------------------------

interface AuditConfig {
  readonly dataset: string;
  readonly out: string;
}

function parseArgs(argv: readonly string[]): AuditConfig {
  let dataset = DEFAULT_DATASET;
  let out = DEFAULT_OUT;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--dataset") dataset = argv[++i] ?? dataset;
    else if (argv[i] === "--out") out = argv[++i] ?? out;
  }
  return { dataset, out };
}

export async function runM7PolicyAudit(config: AuditConfig): Promise<CaseAudit[]> {
  const fixtures = await loadFixtures();
  const dataset = await loadDataset(config.dataset);
  const audits: CaseAudit[] = [];
  for (const m6 of M6_CASES) {
    const fixture = fixtures.get(m6.id);
    const row = dataset.get(m6.id);
    if (fixture === undefined) throw new Error(`No fixture entry for ${m6.id}`);
    if (row === undefined) throw new Error(`No dataset row for ${m6.id} in ${config.dataset}`);
    const instance = toSweBenchInstance(row);
    const task = buildCapsuleV2Task(instance);
    const intent = parseCapsuleIntent(fixture.intent) ?? CapsuleIntent.Auto;
    const workspace = path.resolve(fixture.workspace);
    const db = openIndexerDatabase(path.join(workspace, ".vtrace", "index.sqlite"));
    try {
      const result = buildCapsuleV2({ db, repoRoot: workspace, task, intent, maxTokens: fixture.budget });
      const signals = deriveContextPolicySignals(instance);
      audits.push(auditCase(m6, signals, result));
    } finally {
      db.close();
    }
  }
  return audits;
}

async function main(): Promise<void> {
  const config = parseArgs(process.argv.slice(2));
  const audits = await runM7PolicyAudit(config);
  await mkdir(path.dirname(config.out), { recursive: true });
  await writeFile(config.out, renderMarkdown(audits, config.dataset), "utf8");
  const flips = audits.filter((a) => a.flipped === "inject→skip");
  const desired = flips.filter((a) => a.skipDesired).length;
  const harmful = audits.filter((a) => a.flipped === "inject→skip" && !a.skipDesired).length;
  process.stdout.write(
    `M7 audit: ${audits.length} cases · inject→skip ${flips.length} (desired ${desired}, harmful ${harmful}) · report ${config.out}\n`,
  );
}

if (import.meta.main) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exit(1);
  });
}
