// Stage 5 M112 — digest per-file action-contract render smoke (no agent).
//
// Renders, for the M112 smoke case set, the EXACT model-visible context the
// FROZEN default path (M110 manifest / M105–M108 driver flags) would inject —
// digest + bounded decision contract + compact injection + confidence gate,
// with the DB-backed enrichment provider — WITHOUT spawning an agent. Run once
// with `--tag pre` at the unmodified HEAD and once with `--tag post` after the
// M112 wording change; `--compare` then diffs the two captures and writes the
// committed `stage5_m112_render_smoke.detail.json` (+ CSV).
//
// NO Claude, NO Docker, NO agent spawn, NO API calls, NO network. The only
// subprocess is the local `vtrace capsule` CLI over the pre-existing clean
// indexed workspaces (the same ones M103/M104 used).
//
// Usage:
//   bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m112_render_smoke.ts --tag pre
//   bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m112_render_smoke.ts --tag post
//   bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m112_render_smoke.ts --compare

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  buildCapsuleV2Task,
  buildStage5DigestEnrichmentsBestEffort,
  buildVtraceContextMarkdown,
  buildVtraceQueryCommand,
  classifyCapsuleOutput,
  loadSweBenchData,
  parseArgs,
  toSweBenchInstance,
  type SweBenchInstance,
  type VtraceContextSection,
} from "./run_stage5_vexp_swe_bench_smoke";
import {
  derivableFromWorkspace,
  presentInWorkspace,
  scanLeakage,
  sha256,
  type AnnotatedLeakHit,
} from "./run_stage5_m104_live_context_smoke";
import {
  DIGEST_DECISION_CONTRACT_END,
  DIGEST_DECISION_CONTRACT_START,
  parseDigestDecisionContract,
} from "../../src/capsuleV2/digestDecisionContract";
import { normalizeFilePath } from "./run_stage5_retrieval_eval";

const DEFAULT_DATA = "/home/calvin/code/vexp-swe-bench/data/swe-bench-100.jsonl";
const RESULTS_ROOT = path.join("benchmarks", "stage5_vexp_swe_bench_smoke", "results");
const WS_ROOT = path.join(RESULTS_ROOT, "workspaces");
const INDEX_RELPATH = path.join(".vtrace", "index.sqlite");
const CLEAN_WS_ROOTS = ["expanded", "cross_repo"] as const;
const M103_DETAIL = path.join(RESULTS_ROOT, "stage5_m103_deterministic_scoreboard.detail.json");
// Untracked working dir for the full pre/post context texts (raw repo-derived
// content — never staged; only the hashed/parsed detail JSON is committed).
const RENDER_DIR = path.join(RESULTS_ROOT, "_m112_render");

// The M112 smoke case set (plan §10): the required M111 action-wording cases,
// contrast wins, a normal excellent case, a wrong_pivot case, and one frozen
// no_context exclusion.
export const M112_SMOKE_CASE_IDS: readonly string[] = [
  "pydata__xarray-6938",
  "django__django-12325",
  "pytest-dev__pytest-6197",
  "sympy__sympy-15875",
  "django__django-16263",
  "pylint-dev__pylint-4551",
  "pylint-dev__pylint-8898",
  "astropy__astropy-14365",
  "sympy__sympy-12419",
  "django__django-10973",
  "django__django-16256",
  "django__django-11740",
];

// The exact treatment flags of the frozen default path (M105–M108 driver /
// M110 manifest). Env/shell guards and vexp wiring are live-spawn concerns and
// do not affect the rendered context, so they are not (and cannot be) passed
// through this no-agent path.
const FROZEN_PATH_FLAGS: readonly string[] = [
  "--context-policy", "force-inject",
  "--capsule-engine", "v2",
  "--capsule-intent", "debug",
  "--capsule-budget", "8000",
  "--inject-capsule-digest",
  "--digest-decision-contract",
  "--bounded-digest-decisions",
  "--compact-digest-injection",
  "--pivot-confidence-gate",
];

// Evidence markers the co-edit / rescue lanes stamp on support items (the same
// strings the M112 action-contract selection keys on, duplicated here as
// literals so the PRE capture compiles before the src change exists).
const LANE_MARKERS: ReadonlyArray<{ marker: string; label: string }> = [
  { marker: "co-edit lane)", label: "co-edit" },
  { marker: "(import-relation lane)", label: "import-reexport" },
  { marker: "(file-evidence rescue)", label: "file-evidence" },
];

// Per-file action lines rendered by the M112 contract: `- A1: <path> — <reason>`.
const ACTION_LINE_RE = /^- A\d+: (\S+) — (.+)$/gm;
const ACTION_HEADER = "Per-file action contract";

interface CapturedCase {
  readonly instance_id: string;
  readonly workspace_found: boolean;
  readonly error: string | null;
  // Determinism / invariant anchors
  readonly task_hash: string;
  readonly task_chars: number;
  readonly m103_task_text_exact_match: boolean | null;
  readonly capsule_stdout_hash: string | null;
  readonly capsule_exit_code: number | null;
  readonly capsule_policy_action: string | null;
  readonly capsule_actual_mode: string | null;
  readonly lead_pivot_file: string | null;
  readonly pivot_files: string[];
  readonly support_files: string[];
  readonly coedit_lane_files: string[];
  readonly beyond_budget_files: string[];
  readonly plain_support_files: string[];
  readonly m103_lead_pivot_file: string | null;
  readonly m103_capsule_files: string[] | null;
  // Rendered-context facts
  readonly context_chars: number;
  readonly context_hash: string | null;
  readonly digest_block_chars: number;
  readonly contract_block_chars: number;
  readonly contract_present: boolean;
  readonly contract_required_targets: string[];
  readonly action_contract_present: boolean;
  readonly action_files: Array<{ path: string; reason: string }>;
  // Leakage (post-capture scan of the full model-visible markdown)
  readonly leak_unexplained_count: number | null;
  readonly leak_base_commit_content_count: number | null;
  readonly leak_hits: AnnotatedLeakHit[];
}

function resolveCleanWorkspace(instanceId: string): string | null {
  for (const root of CLEAN_WS_ROOTS) {
    const ws = path.join(WS_ROOT, root, instanceId);
    if (existsSync(path.join(ws, INDEX_RELPATH))) return ws;
  }
  return null;
}

function normalizeList(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === "string");
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      if (Array.isArray(parsed)) return parsed.filter((v): v is string => typeof v === "string");
    } catch {
      return [];
    }
  }
  return [];
}

function sliceBlock(text: string, start: string, end: string): string {
  const s = text.indexOf(start);
  const e = text.indexOf(end);
  if (s < 0 || e < 0 || e < s) return "";
  return text.slice(s, e + end.length);
}

export function parseActionLines(contractBlock: string): Array<{ path: string; reason: string }> {
  const out: Array<{ path: string; reason: string }> = [];
  for (const m of contractBlock.matchAll(ACTION_LINE_RE)) {
    out.push({ path: m[1]!, reason: m[2]!.trim() });
  }
  return out;
}

interface M103Row {
  readonly instance_id: string;
  readonly derivation: { readonly task_text: string } | null;
  readonly capsule: { readonly lead_pivot_file: string | null; readonly capsule_files: string[] } | null;
}

function captureCase(
  record: Record<string, unknown>,
  m103Row: M103Row | null,
  repoRoot: string,
): { row: CapturedCase; contextText: string } {
  const instance: SweBenchInstance = toSweBenchInstance(record);
  const task = buildCapsuleV2Task(instance);
  const m103Task = m103Row?.derivation?.task_text ?? null;
  const base = {
    instance_id: instance.instanceId,
    task_hash: sha256(task),
    task_chars: task.length,
    m103_task_text_exact_match: m103Task === null ? null : task === m103Task,
    m103_lead_pivot_file: m103Row?.capsule?.lead_pivot_file ?? null,
    m103_capsule_files: m103Row?.capsule?.capsule_files ?? null,
  };
  const empty = {
    capsule_stdout_hash: null,
    capsule_exit_code: null,
    capsule_policy_action: null,
    capsule_actual_mode: null,
    lead_pivot_file: null,
    pivot_files: [],
    support_files: [],
    coedit_lane_files: [],
    beyond_budget_files: [],
    plain_support_files: [],
    context_chars: 0,
    context_hash: null,
    digest_block_chars: 0,
    contract_block_chars: 0,
    contract_present: false,
    contract_required_targets: [],
    action_contract_present: false,
    action_files: [],
    leak_unexplained_count: null,
    leak_base_commit_content_count: null,
    leak_hits: [],
  };

  const workspace = resolveCleanWorkspace(instance.instanceId);
  if (workspace === null) {
    return {
      row: { ...base, ...empty, workspace_found: false, error: "no clean indexed workspace" },
      contextText: "",
    };
  }

  const config = parseArgs([...FROZEN_PATH_FLAGS]);
  const spec = buildVtraceQueryCommand(config, workspace, task, undefined);
  const proc = spawnSync(spec.command, spec.args, {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (proc.status !== 0) {
    return {
      row: {
        ...base,
        ...empty,
        workspace_found: true,
        capsule_exit_code: proc.status,
        error: `vtrace capsule failed: ${(proc.stderr ?? "").trim().slice(0, 400)}`,
      },
      contextText: "",
    };
  }

  // Mirror the live runner's classification for the frozen treatment exactly
  // (runEngineQuery, run_stage5_vexp_swe_bench_smoke.ts ~line 6877).
  const classification = classifyCapsuleOutput(proc.stdout, {
    injectDigest: true,
    query: task,
    digestEnrichmentProvider: (parsed) =>
      buildStage5DigestEnrichmentsBestEffort({
        dbPath: path.join(workspace, INDEX_RELPATH),
        repoRoot: workspace,
        query: task,
        result: parsed,
        intent: config.capsuleIntent,
      }),
    digestDecisionContract: true,
    compactDigestInjection: true,
    boundedDigestDecisions: true,
    pivotConfidenceGate: true,
  });

  const result = classification.capsuleV2Result;
  const pivotItems = Array.isArray(result?.pivots) ? result!.pivots : [];
  const supportItems = Array.isArray(result?.support) ? result!.support : [];
  const pivotFiles = [...new Set(pivotItems.map((i) => normalizeFilePath(i.path)))];
  const supportFiles = [...new Set(supportItems.map((i) => normalizeFilePath(i.path)))];
  const laneOf = (evidence: unknown): string | null => {
    const text = Array.isArray(evidence) ? evidence.join(" ") : "";
    for (const { marker, label } of LANE_MARKERS) if (text.includes(marker)) return label;
    return null;
  };
  const coeditLaneFiles = [
    ...new Set(
      supportItems
        .filter((i) => laneOf((i as { evidence?: unknown }).evidence) !== null)
        .map((i) => normalizeFilePath(i.path)),
    ),
  ];
  // Pivot-cap-evicted strong targets (the debugRoles demotion marker) — the
  // second action-eligible support class the M112 contract keys on.
  const BEYOND = /strong target (?:but )?beyond the pivot budget/i;
  const beyondBudgetFiles = [
    ...new Set(
      supportItems
        .filter((i) => BEYOND.test(typeof (i as { role_reason?: unknown }).role_reason === "string" ? (i as { role_reason: string }).role_reason : ""))
        .map((i) => normalizeFilePath(i.path)),
    ),
  ];
  const plainSupportFiles = supportFiles.filter(
    (f) => !coeditLaneFiles.includes(f) && !beyondBudgetFiles.includes(f),
  );

  // Assemble the model-visible markdown exactly as the live protocol would
  // (force-inject path; the no_context case yields an empty context honestly).
  let contextText = "";
  if (classification.contextInjected && classification.context.trim().length > 0) {
    const section: VtraceContextSection = {
      instance,
      rawContext: classification.context,
      error: null,
      classification,
      preformatted: true,
      requestedEngine: "v2",
      effectiveEngine: "v2",
      engineFallbackReason: null,
    };
    contextText = buildVtraceContextMarkdown([section], {
      maxChars: config.vtraceContextMaxChars,
      maxItems: config.vtraceContextMaxItems,
      pivotCheckPolicy: config.disablePivotCheck ? "off" : config.pivotCheckPolicy,
      disablePivotCheck: config.disablePivotCheck,
      disableEditGuard: config.disableEditGuard,
      disablePatchVerify: config.disablePatchVerify,
      pivotInspectionEnforcement: config.pivotInspectionEnforcement,
      injectTokenDiscipline: !config.disableTokenDiscipline,
    }).markdown;
  }

  const digestBlock = sliceBlock(contextText, "<VTRACE_CAPSULE_V2_DIGEST_START>", "<VTRACE_CAPSULE_V2_DIGEST_END>");
  const contractBlock = sliceBlock(contextText, DIGEST_DECISION_CONTRACT_START, DIGEST_DECISION_CONTRACT_END);
  const parsedContract = parseDigestDecisionContract(contextText);
  const actionFiles = parseActionLines(contractBlock);

  // Leakage: forbidden ids/markers/gold over the full model-visible markdown,
  // provenance-annotated against the base-commit workspace (M104 policy).
  const labels = {
    failToPass: instance.failToPass,
    passToPass: normalizeList(record.PASS_TO_PASS ?? record.pass_to_pass),
    goldPatch: typeof record.patch === "string" ? record.patch : "",
  };
  const leak = scanLeakage(contextText, labels);
  const annotatedHits: AnnotatedLeakHit[] = leak.hits.map((h) => ({
    ...h,
    in_base_commit_repo: derivableFromWorkspace(workspace, h.needle),
  }));
  const annotatedGoldLines = leak.goldAddedLineMatches.map((line) => ({
    line,
    in_base_commit_repo: presentInWorkspace(workspace, line),
  }));
  const unexplained =
    annotatedHits.filter((h) => !h.in_base_commit_repo).length +
    annotatedGoldLines.filter((g) => !g.in_base_commit_repo).length;
  const baseCommitContent = annotatedHits.length + annotatedGoldLines.length - unexplained;

  const leadPivot = pivotItems[0]?.path;
  return {
    row: {
      ...base,
      workspace_found: true,
      error: null,
      // Hash over latency-normalized stdout: `latencyMs` is the CLI's only
      // nondeterministic field (verified by back-to-back runs) and carries no
      // behavior — normalizing it makes the hash a real selection invariant.
      capsule_stdout_hash: sha256(proc.stdout.replace(/"latencyMs":\s*[0-9.eE+-]+/g, '"latencyMs":0')),
      capsule_exit_code: proc.status,
      capsule_policy_action: classification.policyAction,
      capsule_actual_mode: classification.actualCapsuleMode,
      lead_pivot_file: leadPivot === undefined ? null : normalizeFilePath(leadPivot),
      pivot_files: pivotFiles,
      support_files: supportFiles,
      coedit_lane_files: coeditLaneFiles,
      beyond_budget_files: beyondBudgetFiles,
      plain_support_files: plainSupportFiles,
      context_chars: contextText.length,
      context_hash: contextText.length > 0 ? sha256(contextText) : null,
      digest_block_chars: digestBlock.length,
      contract_block_chars: contractBlock.length,
      contract_present: parsedContract.present,
      contract_required_targets: parsedContract.targets.map((t) => `${t.kind} ${t.target}`),
      action_contract_present: contractBlock.includes(ACTION_HEADER),
      action_files: actionFiles,
      leak_unexplained_count: unexplained,
      leak_base_commit_content_count: baseCommitContent,
      leak_hits: annotatedHits.filter((h) => !h.in_base_commit_repo),
    },
    contextText,
  };
}

// ---------------------------------------------------------------------------
// Compare (pre vs post)
// ---------------------------------------------------------------------------

interface Capture {
  readonly tag: string;
  readonly cases: CapturedCase[];
}

function loadCapture(tag: string): Capture {
  const p = path.join(RENDER_DIR, `stage5_m112_render_smoke.${tag}.json`);
  return JSON.parse(readFileSync(p, "utf8")) as Capture;
}

function percentile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1);
  return sorted[Math.max(0, idx)]!;
}

function compare(): Record<string, unknown> {
  const pre = loadCapture("pre");
  const post = loadCapture("post");
  const preById = new Map(pre.cases.map((c) => [c.instance_id, c]));

  const rows = post.cases.map((p) => {
    const b = preById.get(p.instance_id);
    if (b === undefined) throw new Error(`no pre capture for ${p.instance_id}`);
    const actionPaths = p.action_files.map((a) => normalizeFilePath(a.path));
    const requiredWithAction = p.pivot_files.filter((f) => actionPaths.includes(f));
    const coeditWithAction = p.coedit_lane_files.filter((f) => actionPaths.includes(f));
    const beyondWithAction = (p.beyond_budget_files ?? []).filter((f) => actionPaths.includes(f));
    // Overconstrained = an action entry whose file is NOT action-eligible
    // (not a pivot file, not a lane file, not a pivot-cap-evicted strong
    // target). A support symbol living in a pivot FILE is not overconstraint —
    // the per-file decision is owned by the pivot entry.
    const eligible = new Set([...p.pivot_files, ...p.coedit_lane_files, ...(p.beyond_budget_files ?? [])]);
    const overconstrained = actionPaths.filter((f) => !eligible.has(f));
    return {
      instance_id: p.instance_id,
      // required diff fields (spec §validation.1)
      pre_digest_chars: b.context_chars,
      post_digest_chars: p.context_chars,
      added_chars: p.context_chars - b.context_chars,
      pre_contract_chars: b.contract_block_chars,
      post_contract_chars: p.contract_block_chars,
      contract_added_chars: p.contract_block_chars - b.contract_block_chars,
      action_contract_present: p.action_contract_present,
      per_file_action_count: p.action_files.length,
      action_files: p.action_files,
      required_files_with_action: requiredWithAction,
      coedit_files_with_action: coeditWithAction,
      beyond_budget_files_with_action: beyondWithAction,
      support_files_not_overconstrained: overconstrained.length === 0,
      overconstrained_support_files: overconstrained,
      lead_pivot_action_present:
        p.lead_pivot_file !== null && actionPaths.includes(p.lead_pivot_file),
      gold_leakage_status:
        p.leak_unexplained_count === null
          ? "no_context_rendered"
          : p.leak_unexplained_count === 0
            ? "clean"
            : "LEAK",
      fallback_status: p.error === null ? "none" : `error: ${p.error}`,
      // invariants (spec §validation.2)
      invariant_capsule_stdout_hash_equal: b.capsule_stdout_hash === p.capsule_stdout_hash,
      invariant_task_hash_equal: b.task_hash === p.task_hash,
      invariant_lead_pivot_equal: b.lead_pivot_file === p.lead_pivot_file,
      invariant_pivot_files_equal: JSON.stringify(b.pivot_files) === JSON.stringify(p.pivot_files),
      invariant_support_files_equal:
        JSON.stringify(b.support_files) === JSON.stringify(p.support_files),
      invariant_required_targets_equal:
        JSON.stringify(b.contract_required_targets) === JSON.stringify(p.contract_required_targets),
      invariant_capsule_mode_equal: b.capsule_actual_mode === p.capsule_actual_mode,
      invariant_m103_task_parity: p.m103_task_text_exact_match,
      context_hash_changed: b.context_hash !== p.context_hash,
      capsule_actual_mode: p.capsule_actual_mode,
      capsule_policy_action: p.capsule_policy_action,
      leak_unexplained_count: p.leak_unexplained_count,
      leak_base_commit_content_count: p.leak_base_commit_content_count,
      leak_hits_unexplained: p.leak_hits,
      error: p.error,
    };
  });

  const contextRows = rows.filter((r) => r.post_digest_chars > 0);
  const added = contextRows.map((r) => r.added_chars).sort((a, b) => a - b);
  const summary = {
    milestone: "M112",
    kind: "digest per-file action contract — no-agent render smoke (pre/post)",
    no_agents: true,
    no_docker: true,
    no_api_spend: true,
    cases: rows.length,
    context_rendered: contextRows.length,
    action_contract_present_count: rows.filter((r) => r.action_contract_present).length,
    all_invariants_hold: rows.every(
      (r) =>
        r.invariant_capsule_stdout_hash_equal !== false &&
        r.invariant_task_hash_equal &&
        r.invariant_lead_pivot_equal &&
        r.invariant_pivot_files_equal &&
        r.invariant_support_files_equal &&
        r.invariant_required_targets_equal &&
        r.invariant_capsule_mode_equal,
    ),
    support_overconstrained_any: rows.some((r) => r.support_files_not_overconstrained === false),
    leak_unexplained_total: rows.reduce((n, r) => n + (r.leak_unexplained_count ?? 0), 0),
    added_chars_median: percentile(added, 0.5),
    added_chars_p90: percentile(added, 0.9),
    added_chars_min: added[0] ?? 0,
    added_chars_max: added[added.length - 1] ?? 0,
    added_tokens_median_est: Math.ceil(percentile(added, 0.5) / 4),
  };
  return { summary, rows };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const flag = (name: string, fallback: string): string => {
    const idx = argv.indexOf(name);
    return idx >= 0 && argv[idx + 1] !== undefined ? argv[idx + 1]! : fallback;
  };

  if (argv.includes("--compare")) {
    const result = compare();
    const detailPath = path.join(RESULTS_ROOT, "stage5_m112_render_smoke.detail.json");
    const csvPath = path.join(RESULTS_ROOT, "stage5_m112_render_smoke.csv");
    await writeFile(detailPath, `${JSON.stringify(result, null, 2)}\n`);
    const rows = (result as { rows: Array<Record<string, unknown>> }).rows;
    const header = [
      "instance_id", "pre_digest_chars", "post_digest_chars", "added_chars",
      "action_contract_present", "per_file_action_count", "required_files_with_action",
      "coedit_files_with_action", "support_files_not_overconstrained",
      "lead_pivot_action_present", "gold_leakage_status", "fallback_status",
    ];
    const csv = [
      header.join(","),
      ...rows.map((r) =>
        header
          .map((h) => {
            const v = r[h];
            if (Array.isArray(v)) return `"${v.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(";")}"`;
            return String(v);
          })
          .join(","),
      ),
    ].join("\n");
    await writeFile(csvPath, `${csv}\n`);
    process.stderr.write(`[m112] wrote ${detailPath}\n[m112] wrote ${csvPath}\n`);
    process.stdout.write(`${JSON.stringify((result as { summary: unknown }).summary, null, 2)}\n`);
    return;
  }

  const tag = flag("--tag", "");
  if (tag !== "pre" && tag !== "post") {
    throw new Error("pass --tag pre | --tag post | --compare");
  }
  const dataPath = flag("--data", DEFAULT_DATA);
  const repoRoot = process.cwd();
  const records = await loadSweBenchData(dataPath);
  const m103Rows = new Map<string, M103Row>(
    (JSON.parse(readFileSync(M103_DETAIL, "utf8")) as { rows: M103Row[] }).rows.map((r) => [
      r.instance_id,
      r,
    ]),
  );

  const cases: CapturedCase[] = [];
  const textDir = path.join(RENDER_DIR, tag);
  await mkdir(textDir, { recursive: true });
  for (const id of M112_SMOKE_CASE_IDS) {
    const record = records.find(
      (r) => r.instance_id === id || (r as { instanceId?: string }).instanceId === id,
    );
    if (record === undefined) {
      process.stderr.write(`[m112] SKIP ${id}: not in dataset\n`);
      continue;
    }
    process.stderr.write(`[m112] ${tag} ${id} …\n`);
    const { row, contextText } = captureCase(record as Record<string, unknown>, m103Rows.get(id) ?? null, repoRoot);
    cases.push(row);
    await writeFile(path.join(textDir, `${id}.context.txt`), contextText);
  }

  const outPath = path.join(RENDER_DIR, `stage5_m112_render_smoke.${tag}.json`);
  await writeFile(outPath, `${JSON.stringify({ tag, cases }, null, 2)}\n`);
  process.stderr.write(`[m112] wrote ${outPath}\n`);
  process.stdout.write(
    `${JSON.stringify(
      {
        tag,
        cases: cases.length,
        errors: cases.filter((c) => c.error !== null).map((c) => ({ id: c.instance_id, error: c.error })),
      },
      null,
      2,
    )}\n`,
  );
}

if (import.meta.main) {
  await main();
}
