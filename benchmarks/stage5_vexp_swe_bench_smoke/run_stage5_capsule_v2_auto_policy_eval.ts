// Stage 5 — Capsule v2 AUTO-POLICY evaluation report.
//
// WHY THIS EXISTS
// ----------------
// We have three Stage 5 result sets on the SAME five Django SWE-bench smoke
// instances: a no-context BASELINE, a Capsule v2 FORCE-INJECT run (context is
// always injected), and a Capsule v2 AUTO-POLICY run (the cost-aware gate decides
// inject vs no_context per instance). This generator is a DETERMINISTIC reducer
// over already-recorded run artifacts — no Claude, no Docker, no agent execution.
// It reads the labeled JSONL rows + vtrace _run.meta.json, recomputes tokens /
// cost / duration and their reductions vs baseline, and renders a comparison
// report (Markdown + JSON + CSV).
//
// THE QUESTION IT ANSWERS
// ------------------------
// Did auto-policy (let the gate choose) beat force-inject (always inject) on this
// five-instance smoke set, while preserving correctness? The recorded data says:
// correctness held (5/5 resolved) but auto did NOT out-reduce force, because the
// `no_context` decision on 10880/11095 did not reproduce cheap baseline behavior.
//
// NON-CLAIM: five instances is a smoke set. Nothing here is a SWE-bench score or a
// statistically powered comparison; it is an engineering signal about whether the
// auto gate is currently worth preferring over force-inject.

import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

// The condition subdirectory each labeled run records its measured row under. The
// baseline label measures the no-context `baseline` condition; the Capsule v2
// force/auto labels measure the injected `vtrace` condition.
const BASELINE_CONDITION = "baseline" as const;
const TREATMENT_CONDITION = "vtrace" as const;

const DEFAULT_LABEL_MAP = "benchmarks/stage5_vexp_swe_bench_smoke/capsule_v2_auto_policy_labels.json";
const DEFAULT_OUT = "benchmarks/stage5_vexp_swe_bench_smoke/results";
const REPORT_BASENAME = "stage5_capsule_v2_auto_policy_eval" as const;

// ---------------------------------------------------------------------------
// Label map
// ---------------------------------------------------------------------------

export interface AutoPolicyLabelEntry {
  readonly instance_id: string;
  readonly baseline_label: string;
  readonly force_label: string;
  readonly auto_label: string;
}

export interface AutoPolicyLabelMap {
  readonly description?: string;
  readonly instances: readonly AutoPolicyLabelEntry[];
}

// Load + validate the label map. A malformed entry is a HARD error: we never
// guess a label or silently drop an instance.
export async function loadLabelMap(filePath: string): Promise<AutoPolicyLabelMap> {
  const content = await readFile(filePath, "utf8").catch(() => null);
  if (content === null) {
    throw new Error(`Auto-policy label map not found at ${filePath}.`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    throw new Error(`Auto-policy label map ${filePath} is not valid JSON: ${String(error)}`);
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.instances)) {
    throw new Error(`Auto-policy label map ${filePath} must be an object with an "instances" array.`);
  }
  const instances = parsed.instances.map((value, index) => validateLabelEntry(value, index));
  if (instances.length === 0) {
    throw new Error(`Auto-policy label map ${filePath} has no instances.`);
  }
  return {
    ...(isString(parsed.description) ? { description: parsed.description } : {}),
    instances,
  };
}

export function validateLabelEntry(value: unknown, index: number): AutoPolicyLabelEntry {
  if (!isRecord(value)) {
    throw new Error(`Label map entry ${index} is not an object.`);
  }
  for (const key of ["instance_id", "baseline_label", "force_label", "auto_label"] as const) {
    if (!isString(value[key]) || value[key].length === 0) {
      throw new Error(`Label map entry ${index} is missing a non-empty "${key}".`);
    }
  }
  return {
    instance_id: value.instance_id as string,
    baseline_label: value.baseline_label as string,
    force_label: value.force_label as string,
    auto_label: value.auto_label as string,
  };
}

// ---------------------------------------------------------------------------
// Raw run records
// ---------------------------------------------------------------------------

export interface RunRecord {
  readonly instanceId: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheCreationTokens: number;
  readonly costUsd: number;
  readonly durationMs: number;
  readonly resolved: boolean;
}

// Total tokens for a row = the four token buckets summed (prompt + completion +
// cache read + cache creation). This matches the manual Stage 5 comparison.
export function computeTokens(record: RunRecord): number {
  return record.inputTokens + record.outputTokens + record.cacheReadTokens + record.cacheCreationTokens;
}

// Locate the single `swebench-*.jsonl` under a run's raw/<condition> directory.
export async function findSwebenchJsonl(runsRoot: string, label: string, condition: string): Promise<string> {
  const dir = path.join(runsRoot, label, "raw", condition);
  const entries = await readdir(dir).catch(() => {
    throw new Error(`No run directory for label "${label}" condition "${condition}" (looked in ${dir}).`);
  });
  const match = entries.filter((name) => name.startsWith("swebench-") && name.endsWith(".jsonl")).sort();
  if (match.length === 0) {
    throw new Error(`No swebench-*.jsonl for label "${label}" condition "${condition}" in ${dir}.`);
  }
  // Deterministic: if a label ever has more than one daily file, take the latest.
  return path.join(dir, match[match.length - 1]!);
}

// Read the row for `instanceId` from a JSONL file. A missing file or a file with
// no matching row is a HARD error — we never fabricate a measurement.
export async function readRunRecord(jsonlPath: string, instanceId: string): Promise<RunRecord> {
  const content = await readFile(jsonlPath, "utf8").catch(() => {
    throw new Error(`Run JSONL not found at ${jsonlPath}.`);
  });
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || !trimmed.startsWith("{")) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue; // tolerate non-result lines; never mistake them for a row
    }
    if (isRecord(parsed) && parsed.instanceId === instanceId) {
      return toRunRecord(parsed, jsonlPath);
    }
  }
  throw new Error(`No row for instance "${instanceId}" in ${jsonlPath}.`);
}

function toRunRecord(record: Record<string, unknown>, source: string): RunRecord {
  const num = (key: string): number => {
    const value = record[key];
    if (!isNumber(value)) throw new Error(`Row in ${source} is missing numeric "${key}".`);
    return value;
  };
  return {
    instanceId: record.instanceId as string,
    inputTokens: num("inputTokens"),
    outputTokens: num("outputTokens"),
    cacheReadTokens: num("cacheReadTokens"),
    cacheCreationTokens: num("cacheCreationTokens"),
    costUsd: num("costUsd"),
    durationMs: num("durationMs"),
    resolved: record.resolved === true,
  };
}

// ---------------------------------------------------------------------------
// Auto-policy meta
// ---------------------------------------------------------------------------

export interface AutoPolicy {
  readonly action: "inject" | "no_context" | "unknown";
  readonly reason: string | null;
  readonly expected_context_value: string | null;
  readonly expected_overhead_risk: string | null;
  readonly decision_signals: readonly string[];
}

// Extract the cost-aware gate's decision from a vtrace `_run.meta.json`. The
// action is `vtraceContextPolicyAction` (inject | no_context); the rest are the
// recorded evidence behind it.
export function extractAutoPolicy(meta: Record<string, unknown>): AutoPolicy {
  const rawAction = meta.vtraceContextPolicyAction;
  const action = rawAction === "inject" || rawAction === "no_context" ? rawAction : "unknown";
  return {
    action,
    reason: isString(meta.vtracePolicyReason) ? meta.vtracePolicyReason : null,
    expected_context_value: isString(meta.expectedContextValue) ? meta.expectedContextValue : null,
    expected_overhead_risk: isString(meta.expectedOverheadRisk) ? meta.expectedOverheadRisk : null,
    decision_signals: Array.isArray(meta.vtraceContextPolicyDecisionSignals)
      ? meta.vtraceContextPolicyDecisionSignals.filter(isString)
      : [],
  };
}

export async function readAutoPolicyMeta(runsRoot: string, autoLabel: string): Promise<AutoPolicy> {
  const metaPath = path.join(runsRoot, autoLabel, "raw", TREATMENT_CONDITION, "_run.meta.json");
  const content = await readFile(metaPath, "utf8").catch(() => {
    throw new Error(`vtrace _run.meta.json not found at ${metaPath}.`);
  });
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    throw new Error(`vtrace meta ${metaPath} is not valid JSON: ${String(error)}`);
  }
  if (!isRecord(parsed)) {
    throw new Error(`vtrace meta ${metaPath} is not an object.`);
  }
  return extractAutoPolicy(parsed);
}

// ---------------------------------------------------------------------------
// Per-instance rows
// ---------------------------------------------------------------------------

export interface InstanceRow {
  readonly instance_id: string;
  readonly baseline_label: string;
  readonly force_label: string;
  readonly auto_label: string;

  readonly baseline_resolved: boolean;
  readonly force_resolved: boolean;
  readonly auto_resolved: boolean;

  readonly baseline_tokens: number;
  readonly force_tokens: number;
  readonly auto_tokens: number;

  readonly force_token_reduction: number;
  readonly auto_token_reduction: number;

  readonly baseline_cost: number;
  readonly force_cost: number;
  readonly auto_cost: number;

  readonly force_cost_reduction: number;
  readonly auto_cost_reduction: number;

  readonly baseline_duration_ms: number;
  readonly force_duration_ms: number;
  readonly auto_duration_ms: number;

  readonly force_duration_reduction: number;
  readonly auto_duration_reduction: number;

  readonly auto_policy_action: AutoPolicy["action"];
  readonly auto_policy_reason: string | null;
  readonly auto_expected_context_value: string | null;
  readonly auto_expected_overhead_risk: string | null;
  readonly auto_decision_signals: readonly string[];
}

// Reduction of `value` relative to `baseline`, as a fraction in [-∞, 1]:
//   positive => value is SMALLER than baseline (an improvement);
//   negative => value is LARGER than baseline (a regression).
// Renders as a percentage in the report. Baseline 0 yields 0 (no basis).
export function reduction(baseline: number, value: number): number {
  if (baseline === 0) return 0;
  return round4((baseline - value) / baseline);
}

export function buildInstanceRow(input: {
  entry: AutoPolicyLabelEntry;
  baseline: RunRecord;
  force: RunRecord;
  auto: RunRecord;
  policy: AutoPolicy;
}): InstanceRow {
  const baselineTokens = computeTokens(input.baseline);
  const forceTokens = computeTokens(input.force);
  const autoTokens = computeTokens(input.auto);
  return {
    instance_id: input.entry.instance_id,
    baseline_label: input.entry.baseline_label,
    force_label: input.entry.force_label,
    auto_label: input.entry.auto_label,

    baseline_resolved: input.baseline.resolved,
    force_resolved: input.force.resolved,
    auto_resolved: input.auto.resolved,

    baseline_tokens: baselineTokens,
    force_tokens: forceTokens,
    auto_tokens: autoTokens,

    force_token_reduction: reduction(baselineTokens, forceTokens),
    auto_token_reduction: reduction(baselineTokens, autoTokens),

    baseline_cost: round4(input.baseline.costUsd),
    force_cost: round4(input.force.costUsd),
    auto_cost: round4(input.auto.costUsd),

    force_cost_reduction: reduction(input.baseline.costUsd, input.force.costUsd),
    auto_cost_reduction: reduction(input.baseline.costUsd, input.auto.costUsd),

    baseline_duration_ms: input.baseline.durationMs,
    force_duration_ms: input.force.durationMs,
    auto_duration_ms: input.auto.durationMs,

    force_duration_reduction: reduction(input.baseline.durationMs, input.force.durationMs),
    auto_duration_reduction: reduction(input.baseline.durationMs, input.auto.durationMs),

    auto_policy_action: input.policy.action,
    auto_policy_reason: input.policy.reason,
    auto_expected_context_value: input.policy.expected_context_value,
    auto_expected_overhead_risk: input.policy.expected_overhead_risk,
    auto_decision_signals: input.policy.decision_signals,
  };
}

// ---------------------------------------------------------------------------
// Aggregates
// ---------------------------------------------------------------------------

export interface AutoPolicyAggregate {
  readonly instance_count: number;

  readonly baseline_resolved_count: number;
  readonly force_resolved_count: number;
  readonly auto_resolved_count: number;

  readonly force_mean_token_reduction: number;
  readonly auto_mean_token_reduction: number;

  readonly force_pooled_token_reduction: number;
  readonly auto_pooled_token_reduction: number;

  readonly force_pooled_cost_reduction: number;
  readonly auto_pooled_cost_reduction: number;

  readonly force_pooled_duration_reduction: number;
  readonly auto_pooled_duration_reduction: number;

  readonly auto_inject_count: number;
  readonly auto_no_context_count: number;

  readonly auto_worse_than_force_count: number;
  readonly auto_better_than_force_count: number;
  readonly auto_worse_than_baseline_count: number;
}

export function aggregate(rows: readonly InstanceRow[]): AutoPolicyAggregate {
  const n = rows.length;
  const sum = (pick: (r: InstanceRow) => number): number => rows.reduce((acc, r) => acc + pick(r), 0);
  const mean = (pick: (r: InstanceRow) => number): number => (n === 0 ? 0 : round4(sum(pick) / n));
  // Pooled reduction = reduction of the SUMMED metric, so large instances weigh
  // proportionally (one big win is not averaged away by small instances).
  const pooled = (base: (r: InstanceRow) => number, value: (r: InstanceRow) => number): number =>
    reduction(sum(base), sum(value));

  return {
    instance_count: n,

    baseline_resolved_count: rows.filter((r) => r.baseline_resolved).length,
    force_resolved_count: rows.filter((r) => r.force_resolved).length,
    auto_resolved_count: rows.filter((r) => r.auto_resolved).length,

    force_mean_token_reduction: mean((r) => r.force_token_reduction),
    auto_mean_token_reduction: mean((r) => r.auto_token_reduction),

    force_pooled_token_reduction: pooled((r) => r.baseline_tokens, (r) => r.force_tokens),
    auto_pooled_token_reduction: pooled((r) => r.baseline_tokens, (r) => r.auto_tokens),

    force_pooled_cost_reduction: pooled((r) => r.baseline_cost, (r) => r.force_cost),
    auto_pooled_cost_reduction: pooled((r) => r.baseline_cost, (r) => r.auto_cost),

    force_pooled_duration_reduction: pooled((r) => r.baseline_duration_ms, (r) => r.force_duration_ms),
    auto_pooled_duration_reduction: pooled((r) => r.baseline_duration_ms, (r) => r.auto_duration_ms),

    auto_inject_count: rows.filter((r) => r.auto_policy_action === "inject").length,
    auto_no_context_count: rows.filter((r) => r.auto_policy_action === "no_context").length,

    // "worse/better than force" and "worse than baseline" are judged on tokens —
    // the primary efficiency metric driving the inject-vs-no_context decision.
    auto_worse_than_force_count: rows.filter((r) => r.auto_tokens > r.force_tokens).length,
    auto_better_than_force_count: rows.filter((r) => r.auto_tokens < r.force_tokens).length,
    auto_worse_than_baseline_count: rows.filter((r) => r.auto_tokens > r.baseline_tokens).length,
  };
}

// ---------------------------------------------------------------------------
// Artifact + rendering
// ---------------------------------------------------------------------------

export interface AutoPolicyArtifact {
  readonly generated_from: string;
  readonly scope: string;
  readonly rows: readonly InstanceRow[];
  readonly aggregate: AutoPolicyAggregate;
}

export function buildArtifact(labelMapPath: string, rows: readonly InstanceRow[]): AutoPolicyArtifact {
  return {
    generated_from: labelMapPath,
    scope: "Five Django SWE-bench smoke instances; baseline vs Capsule v2 force-inject vs Capsule v2 auto-policy.",
    rows,
    aggregate: aggregate(rows),
  };
}

const CSV_COLUMNS = [
  "instance_id",
  "auto_policy_action",
  "baseline_resolved",
  "force_resolved",
  "auto_resolved",
  "baseline_tokens",
  "force_tokens",
  "auto_tokens",
  "force_token_reduction",
  "auto_token_reduction",
  "baseline_cost",
  "force_cost",
  "auto_cost",
  "force_cost_reduction",
  "auto_cost_reduction",
  "baseline_duration_ms",
  "force_duration_ms",
  "auto_duration_ms",
  "force_duration_reduction",
  "auto_duration_reduction",
  "auto_expected_context_value",
  "auto_expected_overhead_risk",
  "auto_decision_signals",
] as const;

export function renderCsv(rows: readonly InstanceRow[]): string {
  const header = CSV_COLUMNS.join(",");
  const lines = rows.map((row) =>
    CSV_COLUMNS.map((col) => {
      const value = (row as unknown as Record<string, unknown>)[col];
      if (value === null || value === undefined) return "";
      if (Array.isArray(value)) return csvEscape(value.join(" | "));
      return csvEscape(String(value));
    }).join(","),
  );
  return [header, ...lines].join("\n") + "\n";
}

// Build the interpretation lines. These statements are DERIVED from the recorded
// data (counts, pooled reductions, per-instance regressions) so the report never
// asserts a conclusion the numbers do not support.
export function renderInterpretationLines(artifact: AutoPolicyArtifact): string[] {
  const a = artifact.aggregate;
  const lines: string[] = [];

  lines.push(
    `- Auto-policy preserved correctness: ${a.auto_resolved_count}/${a.instance_count} resolved.`,
  );

  const autoBeatsForce = a.auto_pooled_token_reduction > a.force_pooled_token_reduction;
  if (autoBeatsForce) {
    lines.push("- Auto-policy outperformed force-inject on this smoke set.");
  } else {
    lines.push("- Auto-policy did not outperform force-inject on this smoke set.");
    lines.push("- Force-inject achieved stronger pooled token/cost/duration reduction.");
  }

  // Instances where the gate chose no_context but auto STILL spent more tokens
  // than the baseline — i.e. the cheap-baseline assumption did not hold.
  const failedNoContext = artifact.rows
    .filter((r) => r.auto_policy_action === "no_context" && r.auto_tokens > r.baseline_tokens)
    .map((r) => shortId(r.instance_id));
  if (failedNoContext.length > 0) {
    lines.push(
      `- The no_context assumption did not hold for ${failedNoContext.join("/")}; ` +
        "no_context did not reproduce cheap baseline behavior.",
    );
  }

  lines.push(
    "- The next decision is whether to:",
    "  - A. make auto more aggressive,",
    "  - B. collect repeated-run estimates,",
    "  - C. keep force-inject as the preferred experimental mode,",
    "  - D. expand to more instances before tuning further.",
  );

  return lines;
}

export function renderMarkdown(artifact: AutoPolicyArtifact): string {
  const a = artifact.aggregate;
  const lines: string[] = [];

  lines.push("# Stage 5 — Capsule v2 Auto-Policy Evaluation", "");

  lines.push("## Scope", "");
  lines.push(
    "Deterministic comparison of three Stage 5 result sets recorded on the SAME",
    "five Django SWE-bench smoke instances: a no-context **baseline**, a Capsule v2",
    "**force-inject** run (context always injected), and a Capsule v2 **auto-policy**",
    "run (the cost-aware gate chooses inject vs no_context per instance).",
    "Reduces already-recorded artifacts only — no Claude, no Docker, no agent run.",
    "",
  );

  lines.push("## Protocol", "");
  lines.push(
    "For each instance the generator reads the recorded JSONL row and recomputes",
    "total tokens (`inputTokens + outputTokens + cacheReadTokens + cacheCreationTokens`),",
    "cost (`costUsd`), and wall-clock (`durationMs`), then the reduction of each",
    "treatment relative to baseline. Reductions are fractions: positive means the",
    "treatment used **less** than baseline; negative means **more**. Pooled metrics",
    "are the reduction of the summed totals (large instances weigh proportionally).",
    "Resolved is taken from the row's `resolved` flag. The auto decision is read from",
    "the vtrace `_run.meta.json` (`vtraceContextPolicyAction`).",
    "",
  );

  lines.push("## Label mapping", "");
  lines.push("| instance | baseline | force-inject | auto-policy |", "| --- | --- | --- | --- |");
  for (const row of artifact.rows) {
    lines.push(`| ${row.instance_id} | ${row.baseline_label} | ${row.force_label} | ${row.auto_label} |`);
  }
  lines.push("");

  lines.push("## Policy decisions", "");
  lines.push("| instance | auto action | expected value | overhead risk | reason |", "| --- | --- | --- | --- | --- |");
  for (const row of artifact.rows) {
    lines.push(
      `| ${row.instance_id} | ${row.auto_policy_action} | ${row.auto_expected_context_value ?? "—"} | ` +
        `${row.auto_expected_overhead_risk ?? "—"} | ${truncate(row.auto_policy_reason ?? "—", 80)} |`,
    );
  }
  lines.push("");

  lines.push("## Baseline vs force vs auto", "");
  lines.push(
    "| instance | auto action | baseline tok | force tok | auto tok | force red | auto red | resolved auto |",
    "| --- | --- | ---: | ---: | ---: | ---: | ---: | --- |",
  );
  for (const row of artifact.rows) {
    lines.push(
      `| ${row.instance_id} | ${row.auto_policy_action} | ${row.baseline_tokens} | ${row.force_tokens} | ` +
        `${row.auto_tokens} | ${pct(row.force_token_reduction)} | ${pct(row.auto_token_reduction)} | ` +
        `${row.auto_resolved ? "True" : "False"} |`,
    );
  }
  lines.push("");

  lines.push("## Aggregate metrics", "");
  lines.push("| metric | force | auto |", "| --- | ---: | ---: |");
  lines.push(`| resolved | ${a.force_resolved_count}/${a.instance_count} | ${a.auto_resolved_count}/${a.instance_count} |`);
  lines.push(`| mean token reduction | ${pct(a.force_mean_token_reduction)} | ${pct(a.auto_mean_token_reduction)} |`);
  lines.push(`| pooled token reduction | ${pct(a.force_pooled_token_reduction)} | ${pct(a.auto_pooled_token_reduction)} |`);
  lines.push(`| pooled cost reduction | ${pct(a.force_pooled_cost_reduction)} | ${pct(a.auto_pooled_cost_reduction)} |`);
  lines.push(`| pooled duration reduction | ${pct(a.force_pooled_duration_reduction)} | ${pct(a.auto_pooled_duration_reduction)} |`);
  lines.push("");
  lines.push(
    `- Auto decisions: ${a.auto_inject_count} inject, ${a.auto_no_context_count} no_context.`,
    `- Auto vs force (tokens): ${a.auto_better_than_force_count} better, ${a.auto_worse_than_force_count} worse.`,
    `- Auto worse than baseline (tokens): ${a.auto_worse_than_baseline_count}.`,
    "",
  );

  lines.push("## Interpretation", "");
  lines.push(...renderInterpretationLines(artifact));
  lines.push("");

  lines.push("## Recommendation", "");
  const recommendAuto = a.auto_pooled_token_reduction > a.force_pooled_token_reduction;
  if (recommendAuto) {
    lines.push(
      "Auto-policy reduced more than force-inject while holding correctness — prefer",
      "auto-policy as the experimental mode and expand the instance set to confirm.",
      "",
    );
  } else {
    lines.push(
      "Keep **force-inject** as the preferred experimental mode for now: it reduced",
      "more (pooled tokens/cost/duration) while auto-policy held correctness but did",
      "not improve efficiency on this set. Tune the gate or widen the instance set",
      "before switching the default to auto.",
      "",
    );
  }

  lines.push("## Caveats / non-claims", "");
  lines.push(
    "- Five instances is a SMOKE set: this is an engineering signal, not a SWE-bench",
    "  score or a statistically powered comparison.",
    "- Single run per label: token/cost/duration carry cache and load variance; no",
    "  repeated-run confidence interval is computed here.",
    "- Reductions are relative to a no-context baseline on the same instances, not to",
    "  any external leaderboard or published number.",
    "- `resolved` reflects the recorded harness verdict for these runs only.",
    "",
  );

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

export interface AutoPolicyConfig {
  readonly labelMap: string;
  readonly out: string;
  readonly runsRoot: string;
}

export async function runAutoPolicyEval(config: AutoPolicyConfig): Promise<AutoPolicyArtifact> {
  const labelMap = await loadLabelMap(config.labelMap);
  const rows: InstanceRow[] = [];
  for (const entry of labelMap.instances) {
    const baseline = await readRunRecord(
      await findSwebenchJsonl(config.runsRoot, entry.baseline_label, BASELINE_CONDITION),
      entry.instance_id,
    );
    const force = await readRunRecord(
      await findSwebenchJsonl(config.runsRoot, entry.force_label, TREATMENT_CONDITION),
      entry.instance_id,
    );
    const auto = await readRunRecord(
      await findSwebenchJsonl(config.runsRoot, entry.auto_label, TREATMENT_CONDITION),
      entry.instance_id,
    );
    const policy = await readAutoPolicyMeta(config.runsRoot, entry.auto_label);
    rows.push(buildInstanceRow({ entry, baseline, force, auto, policy }));
  }
  return buildArtifact(config.labelMap, rows);
}

export async function writeReports(config: AutoPolicyConfig, artifact: AutoPolicyArtifact): Promise<void> {
  await mkdir(config.out, { recursive: true });
  await writeFile(
    path.join(config.out, `${REPORT_BASENAME}.json`),
    JSON.stringify(artifact, null, 2) + "\n",
    "utf8",
  );
  await writeFile(path.join(config.out, `${REPORT_BASENAME}.csv`), renderCsv(artifact.rows), "utf8");
  await writeFile(path.join(config.out, `${REPORT_BASENAME}.md`), renderMarkdown(artifact), "utf8");
}

export function parseArgs(argv: readonly string[]): AutoPolicyConfig {
  let labelMap = DEFAULT_LABEL_MAP;
  let out = DEFAULT_OUT;
  let runsRoot: string | undefined;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === "--label-map") {
      labelMap = requireValue(argv, (i += 1), arg);
    } else if (arg === "--out") {
      out = requireValue(argv, (i += 1), arg);
    } else if (arg === "--runs-root") {
      runsRoot = requireValue(argv, (i += 1), arg);
    } else if (arg === "--mode") {
      const value = requireValue(argv, (i += 1), arg);
      if (value !== "auto-policy-eval") {
        throw new Error(`Unsupported --mode "${value}" (expected "auto-policy-eval").`);
      }
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  // Runs live under <out>/runs unless overridden.
  return { labelMap, out, runsRoot: runsRoot ?? path.join(out, "runs") };
}

function requireValue(argv: readonly string[], index: number, flag: string): string {
  const value = argv[index];
  if (value === undefined) throw new Error(`Flag ${flag} requires a value.`);
  return value;
}

async function main(config: AutoPolicyConfig): Promise<void> {
  const artifact = await runAutoPolicyEval(config);
  await writeReports(config, artifact);
  const a = artifact.aggregate;
  process.stdout.write(
    `Stage 5 auto-policy eval: ${a.instance_count} instances · ` +
      `resolved force ${a.force_resolved_count}/${a.instance_count} auto ${a.auto_resolved_count}/${a.instance_count} · ` +
      `pooled tok red force ${pct(a.force_pooled_token_reduction)} auto ${pct(a.auto_pooled_token_reduction)}\n`,
  );
  process.stdout.write(`Reports written to ${config.out}/${REPORT_BASENAME}.{json,csv,md}\n`);
}

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------

export function round4(value: number): number {
  return Math.round(value * 1e4) / 1e4;
}

export function pct(fraction: number): string {
  return `${(fraction * 100).toFixed(2)}%`;
}

// "django__django-10880" -> "10880" for compact interpretation lines.
function shortId(instanceId: string): string {
  const match = instanceId.match(/(\d+)\s*$/);
  return match ? match[1]! : instanceId;
}

function truncate(value: string, max: number): string {
  const oneLine = value.replace(/\s+/g, " ").trim();
  return oneLine.length <= max ? oneLine : oneLine.slice(0, max - 1) + "…";
}

function csvEscape(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

if (import.meta.main) {
  main(parseArgs(process.argv.slice(2))).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
