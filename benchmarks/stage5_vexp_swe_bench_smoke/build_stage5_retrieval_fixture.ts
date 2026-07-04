// Stage 5R fixture builder.
//
// WHY THIS EXISTS
// ----------------
// Hand-authoring retrieval-eval fixture rows does not scale past a handful of
// instances and risks over-tuning the `task` prose to the answer. This helper
// PROPOSES fixture rows deterministically from SWE-bench artifacts:
//
//   - `task`           derived from the instance's problem_statement (title +
//                      first substantive sentence) — NOT from the patch.
//   - `expected_files` / `expected_symbols` derived from the GOLD reference
//                      `patch` (label_source = gold_patch), or, when asked, from
//                      an evaluated `modelPatch` that passed (label_source =
//                      passing_model_patch — kept separate because a passing
//                      patch may be a valid ALTERNATIVE fix site).
//   - `workspace`      the indexed checkout under the workspaces root.
//
// CRITICAL: expected labels are EVALUATION-ONLY. This helper writes them into the
// fixture for SCORING; they are never fed into Capsule v2 retrieval (the eval
// builds the capsule from `(task, intent, budget)` alone). Gold labels are
// preferred over passing-model-patch labels.
//
// NO Claude, NO Docker, NO agent run, NO API calls.

import { readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  extractChangedFromDiff,
  LABEL_SOURCES,
  loadRetrievalFixture,
  type LabelSource,
  type RetrievalEvalFixtureEntry,
} from "./run_stage5_retrieval_eval";
import {
  CROSS_REPO_30_INSTANCES,
  CROSS_REPO_INSTANCES,
  DEFAULT_EXPANSION_INSTANCES,
} from "./prepare_stage5_workspaces";

// ---------------------------------------------------------------------------
// Task derivation (moved to the shared module in M103; re-exported so the
// frozen M94–M102 runners/tests keep their import path AND their V0 behavior)
// ---------------------------------------------------------------------------

import { deriveStructuredTaskFromProblemStatement } from "./stage5_task_derivation";

export { deriveTaskFromProblemStatement, splitSentencesSafe } from "./stage5_task_derivation";

// ---------------------------------------------------------------------------
// SWE-bench record loading + label extraction
// ---------------------------------------------------------------------------

export interface SweBenchInstance {
  readonly instance_id: string;
  readonly repo: string;
  readonly patch: string;
  readonly problem_statement: string;
}

export async function loadSweBench(dataPath: string): Promise<Map<string, SweBenchInstance>> {
  const content = await readFile(dataPath, "utf8");
  const out = new Map<string, SweBenchInstance>();
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    let record: unknown;
    try {
      record = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!isRecord(record) || typeof record.instance_id !== "string") continue;
    out.set(record.instance_id, {
      instance_id: record.instance_id,
      repo: typeof record.repo === "string" ? record.repo : "django/django",
      patch: typeof record.patch === "string" ? record.patch : "",
      problem_statement: typeof record.problem_statement === "string" ? record.problem_statement : "",
    });
  }
  return out;
}

export interface ExtractedGoldLabels {
  readonly expected_files: string[];
  readonly expected_symbols: string[];
}

// Pull expected files + best-effort symbols from a gold (or model) unified diff.
// Source-file edits are preferred; pure test-file edits are excluded from
// expected_files (the eval is about recovering the PRODUCTION edit site), but if
// a patch touches ONLY tests we keep them so the row is never label-less.
export function extractLabelsFromPatch(patch: string): ExtractedGoldLabels {
  const changed = extractChangedFromDiff(patch);
  const isTestFile = (f: string): boolean =>
    /(^|\/)tests?\//.test(f) || /(^|\/)test_[^/]+$/.test(f) || /_tests?\.py$/.test(f);
  const source = changed.filter((c) => !isTestFile(c.file));
  const chosen = source.length > 0 ? source : changed;
  const files: string[] = [];
  const symbols = new Set<string>();
  for (const c of chosen) {
    files.push(c.file);
    for (const s of c.symbols) symbols.add(s);
  }
  return { expected_files: files, expected_symbols: [...symbols].sort() };
}

// ---------------------------------------------------------------------------
// Workspace resolution
// ---------------------------------------------------------------------------

async function pathExists(target: string): Promise<boolean> {
  return stat(target).then(() => true).catch(() => false);
}

// Resolve the indexed workspace for an instance. The expansion layout is
// `<results-root>/workspaces/expanded/<instance_id>`; if that is not indexed we
// fall back to scanning the legacy `<results-root>/workspaces/*/<instance_id>`
// experiment dirs for one that carries a `.vtrace/index.sqlite`.
export async function resolveWorkspace(
  resultsRoot: string,
  instanceId: string,
): Promise<string | null> {
  const indexRel = path.join(".vtrace", "index.sqlite");
  const expanded = path.join(resultsRoot, "workspaces", "expanded", instanceId);
  if (await pathExists(path.join(expanded, indexRel))) return expanded;
  // Cross-repo (non-Django) workspaces live under workspaces/cross_repo/<id>.
  const crossRepo = path.join(resultsRoot, "workspaces", "cross_repo", instanceId);
  if (await pathExists(path.join(crossRepo, indexRel))) return crossRepo;
  // Legacy experiment dirs: <results-root>/workspaces/<exp>/<instance_id>.
  const { readdir } = await import("node:fs/promises");
  const root = path.join(resultsRoot, "workspaces");
  const exps = await readdir(root).catch(() => [] as string[]);
  for (const exp of exps) {
    const candidate = path.join(root, exp, instanceId);
    if (await pathExists(path.join(candidate, indexRel))) return candidate;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Fixture row construction
// ---------------------------------------------------------------------------

export interface BuildRowResult {
  readonly row: RetrievalEvalFixtureEntry | null;
  readonly skipped?: string;
}

export function buildGoldRow(
  instance: SweBenchInstance,
  workspace: string,
  labelSource: LabelSource = "gold_patch",
  budget = 8000,
): BuildRowResult {
  const labels = extractLabelsFromPatch(instance.patch);
  if (labels.expected_files.length === 0) {
    return { row: null, skipped: "no files in patch" };
  }
  // M103: the fixture task is the structured derivation (V0 base + extracted
  // errors / failing tests / traceback frames) — the M102-measured V5 shape.
  const task = deriveStructuredTaskFromProblemStatement(instance.problem_statement).taskText;
  if (task.length === 0) {
    return { row: null, skipped: "empty problem statement" };
  }
  return {
    row: {
      instance_id: instance.instance_id,
      repo: instance.repo,
      workspace,
      task,
      intent: "debug",
      budget,
      label_source: labelSource,
      expected_files: labels.expected_files,
      expected_symbols: labels.expected_symbols,
      notes:
        `Auto-built from the ${labelSource === "gold_patch" ? "SWE-bench gold reference patch" : labelSource} `
        + `(files + best-effort symbols). task derived from problem_statement (structured: base + error/test/traceback `
        + `evidence). Expected labels are evaluation-only and never passed into Capsule v2 retrieval.`,
    },
    skipped: undefined,
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export interface BuildFixtureConfig {
  readonly sweBenchData: string;
  readonly resultsRoot: string;
  readonly out: string;
  readonly instances: readonly string[];
  readonly labelSource: LabelSource;
  readonly budget: number;
  /** Optional base fixture whose rows are kept (e.g. the original manual set). */
  readonly baseFixture: string | null;
}

const DEFAULT_DATA = "/home/calvin/code/vexp-swe-bench/data/swe-bench-100.jsonl";
const DEFAULT_RESULTS_ROOT = path.join("benchmarks", "stage5_vexp_swe_bench_smoke", "results");
const DEFAULT_OUT = path.join(
  "benchmarks",
  "stage5_vexp_swe_bench_smoke",
  "retrieval_eval.django.expanded.json",
);
const CROSS_REPO_OUT = path.join(
  "benchmarks",
  "stage5_vexp_swe_bench_smoke",
  "retrieval_eval.cross_repo.json",
);
const CROSS_REPO_30_OUT = path.join(
  "benchmarks",
  "stage5_vexp_swe_bench_smoke",
  "retrieval_eval.cross_repo.30.json",
);

export function parseBuildArgs(argv: readonly string[]): BuildFixtureConfig {
  let sweBenchData = DEFAULT_DATA;
  let resultsRoot = DEFAULT_RESULTS_ROOT;
  let out: string | null = null;
  let instances: string[] | null = null;
  let crossRepo = false;
  let crossRepo30 = false;
  let labelSource: LabelSource = "gold_patch";
  let budget = 8000;
  let baseFixture: string | null = null;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    const value = (): string => {
      const v = argv[(i += 1)];
      if (v === undefined) throw new Error(`Flag ${arg} requires a value.`);
      return v;
    };
    if (arg === "--swe-bench-data") sweBenchData = value();
    else if (arg === "--results-root") resultsRoot = value();
    else if (arg === "--out") out = value();
    else if (arg === "--instances") instances = value().split(",").map((s) => s.trim()).filter(Boolean);
    // Cross-repo mode flips the defaults to the non-Django instance set + output.
    else if (arg === "--cross-repo") crossRepo = true;
    // The ~30-instance superset: the 30-instance set + its own output fixture.
    else if (arg === "--cross-repo-30") {
      crossRepo = true;
      crossRepo30 = true;
    } else if (arg === "--label-source") {
      const v = value();
      if (!(LABEL_SOURCES as readonly string[]).includes(v)) {
        throw new Error(`Invalid --label-source "${v}" (expected ${LABEL_SOURCES.join(", ")}).`);
      }
      labelSource = v as LabelSource;
    } else if (arg === "--budget") budget = Number(value());
    else if (arg === "--base-fixture") baseFixture = value();
    else throw new Error(`Unknown argument: ${arg}`);
  }
  const defaultOut = crossRepo30 ? CROSS_REPO_30_OUT : crossRepo ? CROSS_REPO_OUT : DEFAULT_OUT;
  const defaultInstances = crossRepo30
    ? [...CROSS_REPO_30_INSTANCES]
    : crossRepo
      ? [...CROSS_REPO_INSTANCES]
      : [...DEFAULT_EXPANSION_INSTANCES];
  return {
    sweBenchData,
    resultsRoot,
    out: out ?? defaultOut,
    instances: instances ?? defaultInstances,
    labelSource,
    budget,
    baseFixture,
  };
}

export async function buildFixture(config: BuildFixtureConfig): Promise<RetrievalEvalFixtureEntry[]> {
  const data = await loadSweBench(config.sweBenchData);
  const rows: RetrievalEvalFixtureEntry[] = [];
  const seen = new Set<string>();

  // Carry the base fixture rows first (e.g. the curated manual_verified set).
  if (config.baseFixture) {
    for (const entry of await loadRetrievalFixture(config.baseFixture)) {
      rows.push(entry);
      seen.add(entry.instance_id);
    }
  }

  for (const instanceId of config.instances) {
    if (seen.has(instanceId)) {
      process.stdout.write(`· ${instanceId}: already in base fixture, keeping base row\n`);
      continue;
    }
    const instance = data.get(instanceId);
    if (!instance) {
      process.stderr.write(`✗ ${instanceId}: not found in ${config.sweBenchData}\n`);
      continue;
    }
    const workspace = await resolveWorkspace(config.resultsRoot, instanceId);
    if (workspace === null) {
      process.stderr.write(`✗ ${instanceId}: no indexed workspace under ${config.resultsRoot}/workspaces\n`);
      continue;
    }
    const { row, skipped } = buildGoldRow(instance, workspace, config.labelSource, config.budget);
    if (row === null) {
      process.stderr.write(`✗ ${instanceId}: ${skipped}\n`);
      continue;
    }
    rows.push(row);
    seen.add(instanceId);
    process.stdout.write(`✓ ${instanceId}: ${row.expected_files.join(", ")} (${row.label_source})\n`);
  }
  return rows;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

if (import.meta.main) {
  const config = parseBuildArgs(process.argv.slice(2));
  buildFixture(config)
    .then(async (rows) => {
      await writeFile(config.out, JSON.stringify(rows, null, 2) + "\n", "utf8");
      process.stdout.write(`\nWrote ${rows.length} fixture rows to ${config.out}\n`);
    })
    .catch((error) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exit(1);
    });
}
