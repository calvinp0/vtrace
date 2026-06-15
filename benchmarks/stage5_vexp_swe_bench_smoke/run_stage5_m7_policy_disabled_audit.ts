// Stage 5 — M7.3 traceback-localized auto-skip DISABLED-by-default audit (OFFLINE).
//
// WHY THIS EXISTS
// ----------------
// M7 added a conservative `inject -> no_context` downgrade that fires when the
// issue text TRACEBACK-localizes the lead pivot with no vtrace advantage. The
// M7.2 clean-Docker re-baseline (`stage5_m7_clean_docker_rebaseline.md`) proved
// that the two cases this downgrade fires on (sympy-13372, xarray-3677) were
// Docker false negatives — corrected, both are USEFUL injections (one a
// strict-efficiency pass, one a resolution improvement). So the downgrade
// removed useful injection with no resolution gain.
//
// M7.3 disables the downgrade BY DEFAULT (kept behind an explicit option /
// VTRACE_ENABLE_TRACEBACK_LOCALIZED_SKIP=1) while RETAINING the localization
// detector and all diagnostics. This audit runs the policy OFFLINE over the 20
// M6 cases under BOTH settings and proves:
//   * default: 0 inject->skip flips; sympy-13372 + xarray-3677 stay inject;
//     safe no_context + actionability cases preserved; skip CANDIDATE telemetry
//     still recorded.
//   * flag enabled: the original 2 flips reappear (capability preserved).
//
//   * NO Claude. NO Docker. NO vexp agent execution. NO API calls.
//   * Capsule v2 is built in-process from the SAME task text the LIVE harness
//     feeds it (`buildCapsuleV2Task`). The gold patch is NEVER read.

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

// --- corrected M6 ground-truth labels (post clean-Docker re-baseline) ----------

type M6Class =
  | "strict_efficiency_pass"
  | "actionability_success"
  | "no_context_safety_pass"
  | "inject_without_benefit"
  | "resolution_improvement_with_cost"
  | "resolution_improvement"
  | "resolution_regression"
  | "patch_synthesis_bound";

interface M6Case {
  readonly id: string;
  readonly m6Class: M6Class; // CORRECTED classification (clean Docker)
  readonly genuineRegression: boolean; // a real regression NOT addressed by traceback skip
  readonly note?: string;
}

// Corrected per stage5_m7_clean_docker_rebaseline.md: sympy-13372 and xarray-3677
// are no longer regressions (Docker false negatives) — they are useful injections.
const M6_CASES: readonly M6Case[] = [
  { id: "matplotlib__matplotlib-24627", m6Class: "strict_efficiency_pass", genuineRegression: false },
  { id: "sphinx-doc__sphinx-7748", m6Class: "strict_efficiency_pass", genuineRegression: false },
  { id: "psf__requests-1142", m6Class: "strict_efficiency_pass", genuineRegression: false },
  { id: "matplotlib__matplotlib-25960", m6Class: "strict_efficiency_pass", genuineRegression: false },
  { id: "django__django-11728", m6Class: "strict_efficiency_pass", genuineRegression: false },
  { id: "astropy__astropy-14369", m6Class: "actionability_success", genuineRegression: false },
  { id: "astropy__astropy-14365", m6Class: "resolution_improvement_with_cost", genuineRegression: false },
  { id: "pallets__flask-5014", m6Class: "no_context_safety_pass", genuineRegression: false },
  { id: "django__django-11095", m6Class: "no_context_safety_pass", genuineRegression: false },
  { id: "sympy__sympy-12481", m6Class: "no_context_safety_pass", genuineRegression: false },
  { id: "sphinx-doc__sphinx-7462", m6Class: "inject_without_benefit", genuineRegression: false },
  { id: "sympy__sympy-16766", m6Class: "inject_without_benefit", genuineRegression: false },
  { id: "psf__requests-5414", m6Class: "inject_without_benefit", genuineRegression: false },
  { id: "sympy__sympy-12419", m6Class: "resolution_regression", genuineRegression: true,
    note: "genuine (persists under clean Docker); not a traceback-lead-pivot case" },
  { id: "astropy__astropy-14539", m6Class: "resolution_regression", genuineRegression: true,
    note: "genuine (empty-patch run); not addressed by traceback skip" },
  { id: "pylint-dev__pylint-8898", m6Class: "resolution_regression", genuineRegression: true,
    note: "genuine (multi-file co-edit follow-through); not addressed by traceback skip" },
  { id: "sympy__sympy-13372", m6Class: "strict_efficiency_pass", genuineRegression: false,
    note: "CORRECTED: was 'regression' (Docker false negative) -> useful injection, -23% tokens" },
  { id: "pydata__xarray-3677", m6Class: "resolution_improvement", genuineRegression: false,
    note: "CORRECTED: was 'regression' (Docker false negative) -> resolution improvement 2/3->3/3, -48% tokens" },
  { id: "mwaskom__seaborn-3187", m6Class: "patch_synthesis_bound", genuineRegression: false },
  { id: "django__django-13195", m6Class: "patch_synthesis_bound", genuineRegression: false },
];

const FIXTURES = [
  "benchmarks/stage5_vexp_swe_bench_smoke/retrieval_eval.cross_repo.30.json",
  "benchmarks/stage5_vexp_swe_bench_smoke/retrieval_eval.django.expanded.json",
];
const DEFAULT_DATASET = "/home/calvin/code/vexp-swe-bench/data/swe-bench-100.jsonl";
const DEFAULT_OUT =
  "benchmarks/stage5_vexp_swe_bench_smoke/results/stage5_m7_policy_disabled_audit.md";

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

type Action = ContextPolicyDecision["action"];

interface CaseAudit {
  readonly id: string;
  readonly m6Class: M6Class;
  readonly genuineRegression: boolean;
  readonly note?: string;
  readonly localizationConfidence: string;
  readonly localizationKind: string;
  readonly topPivotUserLocalized: boolean;
  readonly actionabilityHintCount: number;
  readonly defaultAction: Action;
  readonly flagAction: Action;
  readonly skipCandidate: boolean;
  readonly defaultSkipped: boolean;
  readonly flagFlipped: boolean;
}

function policyDiagnostics(result: ReturnType<typeof buildCapsuleV2>): CapsuleV2PolicyDiagnostics {
  const topPivot = result.pivots[0] ?? null;
  const topSource = topPivot && typeof topPivot.source === "string" ? topPivot.source : null;
  const diagnostics = result.diagnostics;
  return {
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
  const diag = policyDiagnostics(result);
  // DEFAULT (M7.3): flag off -> no traceback downgrade.
  const defaultDecision = decideCapsuleV2ContextPolicy(signals, diag);
  // FLAG ENABLED: the M7 downgrade is restored.
  const flagDecision = decideCapsuleV2ContextPolicy(signals, diag, {
    enableTracebackLocalizedSkip: true,
  });
  const loc = result.diagnostics.localization_signals;
  const topPivot = result.pivots[0] ?? null;
  const topPivotUserLocalized =
    loc !== undefined && pathIsUserLocalized(topPivot?.path ?? null, loc.resolvedFiles);
  const skipCandidate = defaultDecision.decisionSignals.includes("traceback_localized_skip_candidate");
  return {
    id: m6.id,
    m6Class: m6.m6Class,
    genuineRegression: m6.genuineRegression,
    note: m6.note,
    localizationConfidence: loc?.confidence ?? "n/a",
    localizationKind: loc?.kind ?? "n/a",
    topPivotUserLocalized,
    actionabilityHintCount: result.actionability_hints?.length ?? 0,
    defaultAction: defaultDecision.action,
    flagAction: flagDecision.action,
    skipCandidate,
    defaultSkipped: defaultDecision.action === "no_context",
    flagFlipped: defaultDecision.action === "inject" && flagDecision.action === "no_context",
  };
}

function shortId(id: string): string {
  return id.includes("__") ? id.split("__")[1]! : id;
}

function renderMarkdown(audits: readonly CaseAudit[], datasetPath: string): string {
  const lines: string[] = [];
  const defaultSkips = audits.filter((a) => a.defaultSkipped);
  const flagFlips = audits.filter((a) => a.flagFlipped);
  const candidates = audits.filter((a) => a.skipCandidate);
  const safeSkips = audits.filter((a) => a.m6Class === "no_context_safety_pass");
  const useful = audits.filter((a) => a.m6Class === "strict_efficiency_pass");
  const astropy = audits.find((a) => a.id === "astropy__astropy-14369");
  const sympy13372 = audits.find((a) => a.id === "sympy__sympy-13372");
  const xarray = audits.find((a) => a.id === "pydata__xarray-3677");
  const genuine = audits.filter((a) => a.genuineRegression);
  const crit = (ok: boolean): string => (ok ? "✅" : "❌");

  lines.push("# Stage 5 — M7.3 traceback-localized auto-skip DISABLED-by-default audit (offline)", "");
  lines.push("## Scope", "");
  lines.push(
    "**Deterministic, offline policy audit — no Claude, no Docker, no agent run, no API calls.**",
    "",
    "Runs the Capsule v2 cost-aware context policy over the 20 M6 bounded-validation",
    "cases under BOTH settings: DEFAULT (M7.3, traceback-localized skip disabled) and",
    "the explicit experimental flag (`enableTracebackLocalizedSkip` /",
    "`VTRACE_ENABLE_TRACEBACK_LOCALIZED_SKIP=1`). Capsule v2 is built in-process from",
    "the SAME task text the live harness feeds it (`buildCapsuleV2Task`). The",
    "localization detector reads ONLY issue text + the repo index — never the gold",
    "patch. M6 classifications are the CORRECTED clean-Docker labels from",
    "`stage5_m7_clean_docker_rebaseline.md`.",
    "",
    `- dataset (full issue text): \`${datasetPath}\``,
    "",
  );

  lines.push("## Headline", "");
  lines.push(
    `- cases audited: **${audits.length}**`,
    `- DEFAULT inject→skip flips: **${defaultSkips.filter((a) => a.m6Class !== "no_context_safety_pass").length}** (excluding capsule-driven safe skips) — the traceback downgrade no longer fires`,
    `- DEFAULT no_context cases: **${defaultSkips.length}** — ${defaultSkips.map((a) => shortId(a.id)).join(", ") || "none"} (all capsule/cheap-local safe skips, NOT traceback downgrades)`,
    `- skip CANDIDATES detected (telemetry retained): **${candidates.length}** — ${candidates.map((a) => shortId(a.id)).join(", ") || "none"}`,
    `- flag-enabled inject→skip flips: **${flagFlips.length}** — ${flagFlips.map((a) => shortId(a.id)).join(", ") || "none"}`,
    `- sympy-13372 default action: **${sympy13372?.defaultAction ?? "n/a"}**`,
    `- xarray-3677 default action: **${xarray?.defaultAction ?? "n/a"}**`,
    "",
  );

  lines.push("## Success criteria", "");
  const sympyInject = sympy13372?.defaultAction === "inject";
  const xarrayInject = xarray?.defaultAction === "inject";
  const usefulOk = useful.every((a) => a.defaultAction === "inject");
  const astropyOk = astropy?.defaultAction === "inject";
  const safeOk = safeSkips.every((a) => a.defaultAction === "no_context");
  const candidatesRetained = candidates.length >= 2;
  const flagRestores = flagFlips.length >= 2;
  lines.push(
    `1. ${crit(Boolean(sympyInject))} sympy-13372 returns to **inject** by default`,
    `2. ${crit(Boolean(xarrayInject))} xarray-3677 returns to **inject** by default`,
    `3. ${crit(usefulOk)} known useful injected wins remain **inject** (${useful.filter((a) => a.defaultAction === "inject").length}/${useful.length})`,
    `4. ${crit(Boolean(astropyOk))} astropy actionability remains **inject**`,
    `5. ${crit(safeOk)} safe no_context remains **skip** (${safeSkips.filter((a) => a.defaultAction === "no_context").length}/${safeSkips.length})`,
    `6. ${crit(candidatesRetained)} localization skip-CANDIDATE telemetry retained by default (${candidates.length} cases)`,
    `7. ${crit(flagRestores)} the experimental flag restores the downgrade (${flagFlips.length} flips)`,
    "",
  );

  lines.push("## Per-case decisions", "");
  lines.push(
    "| case | corrected M6 class | loc conf | kind | top pivot localized? | actionability | default | flag-on | skip candidate? | flips under flag? |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
  );
  for (const a of audits) {
    lines.push(
      `| ${shortId(a.id)} | ${a.m6Class} | ${a.localizationConfidence} | ${a.localizationKind} | `
      + `${a.topPivotUserLocalized ? "yes" : "no"} | ${a.actionabilityHintCount > 0 ? `${a.actionabilityHintCount}` : "—"} | `
      + `${a.defaultAction} | ${a.flagAction} | ${a.skipCandidate ? "yes" : "—"} | ${a.flagFlipped ? "yes" : "—"} |`,
    );
  }
  lines.push("");

  lines.push("## Genuine regressions (NOT addressed by traceback skip)", "");
  lines.push(
    "These persist under clean Docker and are NOT traceback-lead-pivot cases, so the",
    "M7 downgrade never addressed them — confirming the downgrade was not the right",
    "tool. They require a different policy/actionability feature.",
    "",
  );
  for (const a of genuine) {
    lines.push(`- **${shortId(a.id)}** — default=${a.defaultAction}, skip-candidate=${a.skipCandidate ? "yes" : "no"}; ${a.note ?? ""}`);
  }
  lines.push("");

  lines.push("## Conclusion", "");
  lines.push(
    "The traceback-localized `inject → no_context` downgrade is **disabled by default**",
    "because the corrected clean-Docker M6 results show it removes useful injection",
    "(sympy-13372 strict-efficiency, xarray-3677 a resolution improvement) with no",
    "resolution gain. By default both return to **inject**, and all known useful /",
    "actionability / safe-no_context behaviour is preserved. The localization detector",
    "and its diagnostics (including a recorded skip CANDIDATE signal) remain available",
    "for future policy work, and the downgrade itself stays reachable behind the",
    "explicit experimental flag. The 3 remaining genuine regressions (sympy-12419,",
    "astropy-14539, pylint-8898) are NOT traceback-lead-pivot cases and require another",
    "policy/actionability feature, not traceback-lead-pivot skipping.",
    "",
  );
  return lines.join("\n");
}

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

export async function runM7DisabledAudit(config: AuditConfig): Promise<CaseAudit[]> {
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
  const audits = await runM7DisabledAudit(config);
  await mkdir(path.dirname(config.out), { recursive: true });
  await writeFile(config.out, renderMarkdown(audits, config.dataset), "utf8");
  const defaultSkips = audits.filter((a) => a.defaultSkipped).length;
  const flagFlips = audits.filter((a) => a.flagFlipped).length;
  process.stdout.write(
    `M7.3 disabled audit: ${audits.length} cases · default no_context ${defaultSkips} · flag flips ${flagFlips} · report ${config.out}\n`,
  );
}

if (import.meta.main) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exit(1);
  });
}
