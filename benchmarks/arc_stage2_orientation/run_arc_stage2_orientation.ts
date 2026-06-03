import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export interface ArcStage2Task {
  readonly id: string;
  readonly category: string;
  readonly task: string;
  readonly query: string;
}

export interface ExpectedTarget {
  readonly expected_paths: readonly string[];
  readonly expected_symbols: readonly string[];
  readonly notes?: string;
}

export type ExpectedTargetsByTask = Record<string, ExpectedTarget>;
export type QualityLabel = "strong" | "acceptable" | "weak" | "missing" | "unchecked";

export interface QualityEvaluation {
  readonly qualityLabel: QualityLabel;
  readonly qualityScore: number | null;
  readonly matchedExpectedPath: string | null;
  readonly matchedExpectedSymbol: string | null;
}

export interface BaselineSnippet {
  readonly file: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly chars: number;
  readonly preview?: string;
}

export interface BaselinePackage {
  readonly files: readonly string[];
  readonly snippets: readonly BaselineSnippet[];
  readonly chars: number;
  readonly estTokens: number;
  readonly notes: readonly string[];
}

export interface VtraceItemRef {
  readonly name: string | null;
  readonly filePath: string | null;
}

export interface VtracePackage {
  readonly selectedIntent: string | null;
  readonly routingProfile: string | null;
  readonly capsuleProfile: string | null;
  readonly itemCount: number;
  readonly pivotCount: number;
  readonly supportCount: number;
  readonly topResult: string | null;
  readonly topFile: string | null;
  readonly files: readonly string[];
  readonly symbols: readonly string[];
  readonly items: readonly VtraceItemRef[];
  readonly chars: number;
  readonly estTokens: number;
  readonly contaminatedPaths: readonly string[];
  readonly contaminationDetected: boolean;
  readonly diagnostics: readonly string[];
  readonly rawSnippet?: unknown;
}

export interface OrientationRow {
  readonly id: string;
  readonly category: string;
  readonly task: string;
  readonly query: string;
  readonly expected: ExpectedTarget | undefined;
  readonly baseline: BaselinePackage;
  readonly vtrace: VtracePackage;
  readonly baselineQuality: QualityEvaluation;
  readonly vtraceQuality: QualityEvaluation;
  readonly vtraceOrientationParity: boolean | null;
  readonly qualityPreservingReductionPct: number | null;
  readonly notes: readonly string[];
}

interface CliConfig {
  repo: string;
  tasks: string;
  expected: string;
  out: string;
  baselineMaxFiles: number;
  snippetContextLines: number;
  maxSnippetsPerFile: number;
  toolCommand: "capsule" | "handoff";
  maxBudgetCharacters: number | null;
  includeContext: boolean;
  dryRun: boolean;
  verbose: boolean;
}

const DEFAULT_CONFIG: CliConfig = {
  repo: "/home/calvin/code/ARC",
  tasks: "benchmarks/arc_stage2_orientation/tasks.arc.stage2.json",
  expected: "benchmarks/arc_stage2_orientation/expected.arc.stage2.json",
  out: "benchmarks/arc_stage2_orientation/results",
  baselineMaxFiles: 5,
  snippetContextLines: 40,
  maxSnippetsPerFile: 3,
  toolCommand: "handoff",
  maxBudgetCharacters: null,
  includeContext: false,
  dryRun: false,
  verbose: false,
};

const STOP_WORDS = new Set([
  "are",
  "arc",
  "does",
  "how",
  "input",
  "is",
  "the",
  "where",
]);

const RG_EXCLUDE_ARGS = [
  "--glob", "!.git/**",
  "--glob", "!.agents/**",
  "--glob", "!.claude/**",
  "--glob", "!.codex/**",
  "--glob", "!__pycache__/**",
  "--glob", "!.pytest_cache/**",
  "--glob", "!venv/**",
  "--glob", "!.venv/**",
  "--glob", "!env/**",
  "--glob", "!build/**",
  "--glob", "!dist/**",
  "--glob", "!*.egg-info/**",
  "--glob", "!node_modules/**",
];

const VTRACE_CONTAMINATED_PATH_MARKERS = [
  ".claude/worktrees/",
  ".git/",
  "__pycache__/",
  ".pytest_cache/",
  "node_modules/",
  "dist/",
  "build/",
];

const CSV_COLUMNS = [
  "id",
  "category",
  "task",
  "query",
  "baseline_quality",
  "vtrace_quality",
  "vtrace_orientation_parity",
  "baseline_est_tokens",
  "vtrace_est_tokens",
  "quality_preserving_reduction_pct",
  "baseline_file_count",
  "baseline_top_file",
  "baseline_matched_expected_path",
  "baseline_matched_expected_symbol",
  "vtrace_item_count",
  "vtrace_pivot_count",
  "vtrace_support_count",
  "top_vtrace_result",
  "top_vtrace_file",
  "vtrace_matched_expected_path",
  "vtrace_matched_expected_symbol",
  "selected_intent",
  "routing_profile",
  "capsule_profile",
  "vtrace_contamination_detected",
  "vtrace_contaminated_paths",
  "notes",
];

export function estimateTokens(chars: number): number {
  return Math.ceil(Math.max(0, chars) / 4);
}

export function qualityScore(label: QualityLabel): number | null {
  switch (label) {
    case "missing":
      return 0;
    case "weak":
      return 1;
    case "acceptable":
      return 2;
    case "strong":
      return 3;
    case "unchecked":
      return null;
  }
}

export function computeOrientationParity(
  baseline: QualityEvaluation,
  vtrace: QualityEvaluation,
): boolean | null {
  if (baseline.qualityScore === null || vtrace.qualityScore === null) {
    return null;
  }

  return vtrace.qualityScore >= baseline.qualityScore;
}

export function computeQualityPreservingReductionPct(
  baselineEstTokens: number,
  vtraceEstTokens: number,
  vtraceOrientationParity: boolean | null,
): number | null {
  if (baselineEstTokens <= 0 || vtraceOrientationParity !== true) {
    return null;
  }

  return 100 * (baselineEstTokens - vtraceEstTokens) / baselineEstTokens;
}

export async function loadTasks(tasksPath: string): Promise<ArcStage2Task[]> {
  const parsed = JSON.parse(await readFile(tasksPath, "utf8")) as unknown;

  if (!Array.isArray(parsed)) {
    throw new Error("Task file must contain an array.");
  }

  return parsed.map((entry, index) => {
    if (
      !isRecord(entry)
      || typeof entry.id !== "string"
      || typeof entry.category !== "string"
      || typeof entry.task !== "string"
      || typeof entry.query !== "string"
    ) {
      throw new Error(`Invalid task entry at index ${index}.`);
    }

    return {
      id: entry.id,
      category: entry.category,
      task: entry.task,
      query: entry.query,
    };
  });
}

export async function loadExpectedTargets(expectedPath: string): Promise<ExpectedTargetsByTask> {
  let content: string;

  try {
    content = await readFile(expectedPath, "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return {};
    }

    throw error;
  }

  const parsed = JSON.parse(content) as unknown;

  if (!isRecord(parsed)) {
    throw new Error("Expected target file must contain an object keyed by task id.");
  }

  const targets: ExpectedTargetsByTask = {};

  for (const [taskId, value] of Object.entries(parsed)) {
    if (!isRecord(value)) {
      throw new Error(`Invalid expected target entry for task: ${taskId}`);
    }

    targets[taskId] = {
      expected_paths: parseStringArray(value.expected_paths),
      expected_symbols: parseStringArray(value.expected_symbols),
      ...(typeof value.notes === "string" ? { notes: value.notes } : {}),
    };
  }

  return targets;
}

export function buildSearchTerms(query: string): string[] {
  const rawTerms = [
    query,
    ...query.split(/[^A-Za-z0-9_]+/),
    ...query.split(/(?=[A-Z][a-z])|_/),
  ];
  const terms: string[] = [];
  const seen = new Set<string>();

  for (const rawTerm of rawTerms) {
    const term = rawTerm.trim();
    const normalized = term.toLowerCase();

    if (term.length < 3 || STOP_WORDS.has(normalized) || seen.has(normalized)) {
      continue;
    }

    seen.add(normalized);
    terms.push(term);
  }

  return terms;
}

export function stableDeduplicateFiles(files: readonly string[], maxFiles: number): string[] {
  const deduped: string[] = [];
  const seen = new Set<string>();

  for (const file of files) {
    const normalized = normalizePath(file);

    if (seen.has(normalized)) {
      continue;
    }

    seen.add(normalized);
    deduped.push(normalized);

    if (deduped.length >= maxFiles) {
      break;
    }
  }

  return deduped;
}

export interface SnippetRange {
  readonly startLine: number;
  readonly endLine: number;
}

export function extractSnippetRanges(
  matchLineNumbers: readonly number[],
  totalLines: number,
  contextLines: number,
  maxSnippetsPerFile: number,
): SnippetRange[] {
  const ranges = [...new Set(matchLineNumbers)]
    .sort((a, b) => a - b)
    .map((lineNumber) => ({
      startLine: Math.max(1, lineNumber - contextLines),
      endLine: Math.min(totalLines, lineNumber + contextLines),
    }));
  const merged: SnippetRange[] = [];

  for (const range of ranges) {
    const previous = merged.at(-1);

    if (previous === undefined || range.startLine > previous.endLine + 1) {
      merged.push(range);
      continue;
    }

    merged[merged.length - 1] = {
      startLine: previous.startLine,
      endLine: Math.max(previous.endLine, range.endLine),
    };
  }

  return merged.slice(0, maxSnippetsPerFile);
}

export function evaluateContextQuality(
  context: {
    readonly itemCount: number;
    readonly topFile: string | null;
    readonly topSymbol: string | null;
    readonly files: readonly string[];
    readonly symbols: readonly string[];
  },
  expectation: ExpectedTarget | undefined,
): QualityEvaluation {
  if (expectation === undefined) {
    return makeQualityEvaluation("unchecked", null, null);
  }

  const expectedPaths = expectation.expected_paths.map(normalizePath);
  const expectedSymbols = [...expectation.expected_symbols];
  const topPathMatch = matchExpectedPath(context.topFile, expectedPaths);
  const topSymbolMatch = matchExpectedSymbol(context.topSymbol, expectedSymbols);

  if (topPathMatch !== null || topSymbolMatch !== null) {
    return makeQualityEvaluation("strong", topPathMatch, topSymbolMatch);
  }

  const pathMatch = firstNonNull(context.files.map((file) => matchExpectedPath(file, expectedPaths)));
  const symbolMatch = firstNonNull(context.symbols.map((symbol) => matchExpectedSymbol(symbol, expectedSymbols)));

  if (pathMatch !== null || symbolMatch !== null) {
    return makeQualityEvaluation("acceptable", pathMatch, symbolMatch);
  }

  if (context.itemCount === 0) {
    return makeQualityEvaluation("missing", null, null);
  }

  return makeQualityEvaluation("weak", null, null);
}

export function detectContaminatedVtracePaths(paths: readonly string[]): string[] {
  const contaminated: string[] = [];
  const seen = new Set<string>();

  for (const pathValue of paths) {
    const normalized = normalizePath(pathValue);

    if (
      seen.has(normalized)
      || !VTRACE_CONTAMINATED_PATH_MARKERS.some((marker) => normalized.includes(marker))
    ) {
      continue;
    }

    seen.add(normalized);
    contaminated.push(normalized);
  }

  return contaminated;
}

export function parseVtraceOutput(
  output: unknown,
  toolCommand: "capsule" | "handoff",
): VtracePackage {
  const root = isRecord(output) ? output : {};
  const capsule = isRecord(root.capsule) ? root.capsule : root;
  const handoffItems = Array.isArray(capsule.items) ? capsule.items.filter(isRecord) : [];
  const pivots = Array.isArray(capsule.pivots) ? capsule.pivots.filter(isRecord) : [];
  const supportingItems = Array.isArray(capsule.supportingItems) ? capsule.supportingItems.filter(isRecord) : [];
  const items = handoffItems.length > 0 ? handoffItems : [...pivots, ...supportingItems];
  const pivotItems = handoffItems.length > 0 ? handoffItems.filter((item) => item.role === "pivot") : pivots;
  const supportItems = handoffItems.length > 0 ? handoffItems.filter((item) => item.role === "support") : supportingItems;
  const budget = isRecord(capsule.budget) ? capsule.budget : null;
  const chars = typeof budget?.usedCharacters === "number" ? budget.usedCharacters : sumItemContentChars(items);
  const top = items[0] ?? null;
  const itemRefs = makeVtraceItemRefs(items);
  const files = stableUnique(itemRefs.map((item) => item.filePath).filter(isString));
  const symbols = stableUnique(itemRefs.map((item) => item.name).filter(isString));
  const contaminatedPaths = detectContaminatedVtracePaths(files);

  return {
    selectedIntent: stringOrNull(root.selectedIntent ?? root.intent),
    routingProfile: stringOrNull(isRecord(root.routingProfile) ? root.routingProfile.id : null),
    capsuleProfile: stringOrNull(isRecord(root.capsuleProfile) ? root.capsuleProfile.id : null),
    itemCount: items.length,
    pivotCount: pivotItems.length,
    supportCount: supportItems.length,
    topResult: stringOrNull(top?.fqName ?? top?.localName ?? top?.symbolId),
    topFile: stringOrNull(top?.filePath),
    files,
    symbols,
    items: itemRefs,
    chars,
    estTokens: estimateTokens(chars),
    contaminatedPaths,
    contaminationDetected: contaminatedPaths.length > 0,
    diagnostics: collectDiagnostics(root, toolCommand),
    rawSnippet: makeRawSnippet(root, capsule, items),
  };
}

export function summarizeRows(rows: readonly OrientationRow[]) {
  const checkedRows = rows.filter((row) => row.baselineQuality.qualityScore !== null && row.vtraceQuality.qualityScore !== null);
  const parityRows = checkedRows.filter((row) => row.vtraceOrientationParity === true);
  const preservingReductions = rows
    .map((row) => row.qualityPreservingReductionPct)
    .filter((value): value is number => value !== null);
  const rowsWithContaminatedVtracePaths = rows.filter((row) => row.vtrace.contaminationDetected).length;
  const contaminatedVtracePathCount = rows.reduce((total, row) => total + row.vtrace.contaminatedPaths.length, 0);
  const vtraceMissingCheckedCount = checkedRows.filter((row) => row.vtraceQuality.qualityLabel === "missing").length;

  return {
    totalTasks: rows.length,
    checkedTasks: checkedRows.length,
    vtraceStrongCount: countQuality(rows, "vtrace", "strong"),
    vtraceAcceptableCount: countQuality(rows, "vtrace", "acceptable"),
    vtraceWeakCount: countQuality(rows, "vtrace", "weak"),
    vtraceMissingCount: countQuality(rows, "vtrace", "missing"),
    baselineStrongCount: countQuality(rows, "baseline", "strong"),
    baselineAcceptableCount: countQuality(rows, "baseline", "acceptable"),
    baselineWeakCount: countQuality(rows, "baseline", "weak"),
    baselineMissingCount: countQuality(rows, "baseline", "missing"),
    parityCount: parityRows.length,
    parityRate: checkedRows.length === 0 ? null : parityRows.length / checkedRows.length,
    vtraceBetterCount: checkedRows.filter((row) => row.vtraceQuality.qualityScore! > row.baselineQuality.qualityScore!).length,
    vtraceWorseCount: checkedRows.filter((row) => row.vtraceQuality.qualityScore! < row.baselineQuality.qualityScore!).length,
    meanQualityPreservingReductionPercent: mean(preservingReductions),
    medianQualityPreservingReductionPercent: median(preservingReductions),
    rowsWithContaminatedVtracePaths,
    contaminatedVtracePathCount,
    benchmarkAcceptableForOrientationClaim: rowsWithContaminatedVtracePaths === 0 && vtraceMissingCheckedCount === 0,
    repeatabilityStatus: "not_checked",
  };
}

export function renderMarkdown(
  metadata: Record<string, unknown>,
  rows: readonly OrientationRow[],
  summary: ReturnType<typeof summarizeRows>,
): string {
  const weakRows = rows.filter((row) => row.vtraceQuality.qualityLabel === "weak" || row.vtraceOrientationParity === false);
  const headlineReduction = formatNumber(summary.meanQualityPreservingReductionPercent);
  const parityRate = summary.parityRate === null ? "n/a" : `${formatNumber(summary.parityRate * 100)}%`;

  return `${[
    "# ARC Stage 2 Orientation Report",
    "",
    "## Headline summary",
    "",
    `Stage 2 tested whether compact vtrace context preserved enough orientation to match grep-snippet targets. vtrace achieved orientation parity or better on ${summary.parityCount}/${summary.checkedTasks} checked tasks, with mean quality-preserving reduction of ${headlineReduction === "" ? "n/a" : `${headlineReduction}%`} on parity-preserving tasks.`,
    "",
    "## Scope and non-goals",
    "",
    "This benchmark measures orientation only: whether each context package points to the expected ARC file or symbol target.",
    "",
    "It does not measure patch correctness, pass@1, SWE-bench performance, full agent cost, whether a model can complete an edit unaided, or total token usage over an entire coding session.",
    "",
    "## Orientation parity summary",
    "",
    `- Total tasks: ${summary.totalTasks}`,
    `- Checked tasks: ${summary.checkedTasks}`,
    `- Parity count: ${summary.parityCount}`,
    `- Parity rate: ${parityRate}`,
    `- vtrace better count: ${summary.vtraceBetterCount}`,
    `- vtrace worse count: ${summary.vtraceWorseCount}`,
    "",
    "## Quality-preserving token reduction summary",
    "",
    `- Mean quality-preserving reduction: ${headlineReduction === "" ? "n/a" : `${headlineReduction}%`}`,
    `- Median quality-preserving reduction: ${formatNumber(summary.medianQualityPreservingReductionPercent) || "n/a"}${summary.medianQualityPreservingReductionPercent === null ? "" : "%"}`,
    "- Reduction is reported only when vtrace orientation parity is true.",
    "",
    "## Baseline vs vtrace quality",
    "",
    "| Label | Baseline | vtrace |",
    "| --- | ---: | ---: |",
    `| strong | ${summary.baselineStrongCount} | ${summary.vtraceStrongCount} |`,
    `| acceptable | ${summary.baselineAcceptableCount} | ${summary.vtraceAcceptableCount} |`,
    `| weak | ${summary.baselineWeakCount} | ${summary.vtraceWeakCount} |`,
    `| missing | ${summary.baselineMissingCount} | ${summary.vtraceMissingCount} |`,
    "",
    "## Per-task table",
    "",
    renderRowsTable(rows),
    "",
    "## Weak/regression cases",
    "",
    weakRows.length === 0 ? "No vtrace weak or parity-regression cases were observed." : renderWeakRowsTable(weakRows),
    "",
    "## Contamination status",
    "",
    `- Rows with contaminated vtrace paths: ${summary.rowsWithContaminatedVtracePaths}`,
    `- Contaminated vtrace path count: ${summary.contaminatedVtracePathCount}`,
    `- Benchmark acceptable for orientation claim: ${summary.benchmarkAcceptableForOrientationClaim ? "yes" : "no"}`,
    "- Repeatability status: not checked in this first implementation; repeated runs should be diffed after excluding timestamp/output-directory metadata.",
    "",
    "## Interpretation",
    "",
    "This benchmark supports only an orientation claim when vtrace reaches parity with the grep-snippet baseline. It does not prove task-solving improvement, SWE-bench performance, or total agent cost reduction.",
    "",
    "Token reduction should be interpreted as quality-preserving only for rows where vtrace_orientation_parity is true.",
    "",
    "## Suggested next step",
    "",
    "Run a repeatability check for Stage 2, then use a small Stage 3 smoke benchmark to test whether compact vtrace context helps an agent identify or edit the correct ARC code region with fewer tool calls/tokens.",
    "",
    "## Metadata",
    "",
    `- Repo: ${String(metadata.arcRepoPath ?? "")}`,
    `- Tool command: ${String(metadata.toolCommand ?? "")}`,
    `- Baseline: grep snippets`,
  ].join("\n")}\n`;
}

export function renderRowsTable(rows: readonly OrientationRow[]): string {
  return [
    "| id | category | baseline | vtrace | parity | baseline tokens | vtrace tokens | preserving reduction | baseline top | vtrace top |",
    "| --- | --- | --- | --- | --- | ---: | ---: | ---: | --- | --- |",
    ...rows.map((row) => [
      escapeMarkdown(row.id),
      escapeMarkdown(row.category),
      row.baselineQuality.qualityLabel,
      row.vtraceQuality.qualityLabel,
      formatBoolean(row.vtraceOrientationParity),
      row.baseline.estTokens,
      row.vtrace.estTokens,
      formatNumber(row.qualityPreservingReductionPct),
      escapeMarkdown(row.baseline.files[0] ?? ""),
      escapeMarkdown(row.vtrace.topFile ?? row.vtrace.topResult ?? ""),
    ].join(" | ")).map((line) => `| ${line} |`),
  ].join("\n");
}

async function runBenchmark(config: CliConfig): Promise<void> {
  const tasks = await loadTasks(config.tasks);
  const expectedTargets = await loadExpectedTargets(config.expected);
  const metadata = {
    benchmark: "arc_stage2_orientation",
    timestamp: new Date().toISOString(),
    arcRepoPath: config.repo,
    taskFile: config.tasks,
    expectedFile: config.expected,
    outputDirectory: config.out,
    baseline: "grep-snippet",
    baselineMaxFiles: config.baselineMaxFiles,
    snippetContextLines: config.snippetContextLines,
    maxSnippetsPerFile: config.maxSnippetsPerFile,
    toolCommand: config.toolCommand,
    maxBudgetCharacters: config.maxBudgetCharacters,
    includeContext: config.includeContext,
    tokenEstimate: "Math.ceil(chars / 4)",
    repeatabilityStatus: "not_checked",
    notes: config.maxBudgetCharacters === null
      ? []
      : ["maxBudgetCharacters is recorded only; current capsule/handoff CLI commands use their built-in budget."],
  };

  if (config.dryRun) {
    process.stdout.write([
      "ARC Stage 2 orientation benchmark dry run",
      `Repo: ${config.repo}`,
      `Tasks: ${tasks.length}`,
      `Expected target file: ${config.expected}`,
      `Tool command: ${config.toolCommand}`,
      `Output directory: ${config.out}`,
      "",
    ].join("\n"));
    return;
  }

  const rows: OrientationRow[] = [];

  for (const task of tasks) {
    if (config.verbose) {
      process.stderr.write(`Running ${task.id}: ${task.query}\n`);
    }

    const expected = expectedTargets[task.id];
    const baseline = await collectBaselinePackage(config.repo, task.query, config);
    const vtrace = await collectVtracePackage(config.repo, task.query, config.toolCommand);
    const baselineQuality = evaluateContextQuality({
      itemCount: baseline.files.length,
      topFile: baseline.files[0] ?? null,
      topSymbol: null,
      files: baseline.files,
      symbols: [],
    }, expected);
    const vtraceQuality = evaluateContextQuality({
      itemCount: vtrace.itemCount,
      topFile: vtrace.topFile,
      topSymbol: vtrace.topResult,
      files: vtrace.files,
      symbols: vtrace.symbols,
    }, expected);
    const parity = computeOrientationParity(baselineQuality, vtraceQuality);
    const notes = [
      ...(expected?.notes === undefined ? [] : [expected.notes]),
      ...baseline.notes,
      ...vtrace.diagnostics,
      ...(config.maxBudgetCharacters === null ? [] : ["requested max budget not passed to existing CLI"]),
    ];

    rows.push({
      id: task.id,
      category: task.category,
      task: task.task,
      query: task.query,
      expected,
      baseline,
      vtrace,
      baselineQuality,
      vtraceQuality,
      vtraceOrientationParity: parity,
      qualityPreservingReductionPct: computeQualityPreservingReductionPct(
        baseline.estTokens,
        vtrace.estTokens,
        parity,
      ),
      notes,
    });
  }

  const summary = summarizeRows(rows);
  const report = {
    metadata,
    tasks,
    rows: rows.map((row) => rowToJson(row, config.includeContext)),
    summary,
  };

  await mkdir(config.out, { recursive: true });
  await writeFile(path.join(config.out, "arc_stage2_orientation.csv"), renderCsv(rows));
  await writeFile(path.join(config.out, "arc_stage2_orientation.json"), `${JSON.stringify(report, null, 2)}\n`);
  await writeFile(path.join(config.out, "arc_stage2_orientation.md"), renderMarkdown(metadata, rows, summary));
}

async function collectBaselinePackage(
  repoRoot: string,
  query: string,
  config: Pick<CliConfig, "baselineMaxFiles" | "snippetContextLines" | "maxSnippetsPerFile" | "includeContext">,
): Promise<BaselinePackage> {
  const matches = await collectBaselineMatches(repoRoot, query);
  const files = stableDeduplicateFiles(matches.map((match) => match.file), config.baselineMaxFiles);
  const snippets: BaselineSnippet[] = [];
  let chars = 0;

  for (const file of files) {
    const content = await readFile(file, "utf8");
    const lines = content.split(/\r?\n/);
    const matchLines = matches.filter((match) => match.file === file).map((match) => match.lineNumber);
    const ranges = extractSnippetRanges(
      matchLines,
      lines.length,
      config.snippetContextLines,
      config.maxSnippetsPerFile,
    );

    for (const range of ranges) {
      const text = lines.slice(range.startLine - 1, range.endLine).join("\n");
      chars += text.length;
      snippets.push({
        file: path.relative(repoRoot, file).replaceAll("\\", "/"),
        startLine: range.startLine,
        endLine: range.endLine,
        chars: text.length,
        ...(config.includeContext ? { preview: text } : {}),
      });
    }
  }

  return {
    files: files.map((file) => path.relative(repoRoot, file).replaceAll("\\", "/")),
    snippets,
    chars,
    estTokens: estimateTokens(chars),
    notes: files.length === 0 ? ["baseline rg returned no files"] : [],
  };
}

interface BaselineMatch {
  readonly file: string;
  readonly lineNumber: number;
}

async function collectBaselineMatches(repoRoot: string, query: string): Promise<BaselineMatch[]> {
  const matches: BaselineMatch[] = [];

  for (const term of buildSearchTerms(query)) {
    const result = await runProcess("rg", [
      "--json",
      "--line-number",
      "--ignore-case",
      "--fixed-strings",
      ...RG_EXCLUDE_ARGS,
      term,
      repoRoot,
    ]);

    if (result.exitCode !== 0 && result.exitCode !== 1) {
      continue;
    }

    matches.push(...parseRipgrepJsonMatches(result.stdout));
  }

  return deduplicateMatches(matches);
}

function parseRipgrepJsonMatches(output: string): BaselineMatch[] {
  const matches: BaselineMatch[] = [];

  for (const line of output.split(/\r?\n/)) {
    if (line.length === 0) {
      continue;
    }

    const parsed = JSON.parse(line) as unknown;

    if (!isRecord(parsed) || parsed.type !== "match" || !isRecord(parsed.data)) {
      continue;
    }

    const data = parsed.data;
    const pathValue = isRecord(data.path) && typeof data.path.text === "string" ? data.path.text : null;
    const lineNumber = typeof data.line_number === "number" ? data.line_number : null;

    if (pathValue !== null && lineNumber !== null) {
      matches.push({ file: pathValue, lineNumber });
    }
  }

  return matches.sort(compareMatches);
}

function deduplicateMatches(matches: readonly BaselineMatch[]): BaselineMatch[] {
  const deduped: BaselineMatch[] = [];
  const seen = new Set<string>();

  for (const match of matches) {
    const file = normalizePath(match.file);
    const key = `${file}:${match.lineNumber}`;

    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    deduped.push({ file, lineNumber: match.lineNumber });
  }

  return deduped;
}

function compareMatches(left: BaselineMatch, right: BaselineMatch): number {
  return left.file.localeCompare(right.file) || left.lineNumber - right.lineNumber;
}

async function collectVtracePackage(
  repoRoot: string,
  query: string,
  toolCommand: "capsule" | "handoff",
): Promise<VtracePackage> {
  const cliPath = path.resolve("bin/vtrace");
  const result = await runProcess(cliPath, [toolCommand, repoRoot, query]);

  if (result.exitCode !== 0) {
    return makeMissingVtracePackage([`${toolCommand} failed: ${result.stderr.trim() || `exit ${result.exitCode}`}`], {
      stdoutPreview: result.stdout.slice(0, 1000),
      stderrPreview: result.stderr.slice(0, 1000),
    });
  }

  try {
    return parseVtraceOutput(JSON.parse(result.stdout), toolCommand);
  } catch (error) {
    return makeMissingVtracePackage([`${toolCommand} JSON parse failed: ${error instanceof Error ? error.message : String(error)}`], {
      stdoutPreview: result.stdout.slice(0, 1000),
      stderrPreview: result.stderr.slice(0, 1000),
    });
  }
}

function makeMissingVtracePackage(diagnostics: readonly string[], rawSnippet: unknown): VtracePackage {
  return {
    selectedIntent: null,
    routingProfile: null,
    capsuleProfile: null,
    itemCount: 0,
    pivotCount: 0,
    supportCount: 0,
    topResult: null,
    topFile: null,
    files: [],
    symbols: [],
    items: [],
    chars: 0,
    estTokens: 0,
    contaminatedPaths: [],
    contaminationDetected: false,
    diagnostics,
    rawSnippet,
  };
}

async function runProcess(
  command: string,
  args: readonly string[],
): Promise<{ readonly exitCode: number; readonly stdout: string; readonly stderr: string }> {
  const proc = Bun.spawn([command, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  return { exitCode, stdout, stderr };
}

function renderCsv(rows: readonly OrientationRow[]): string {
  return `${[
    CSV_COLUMNS.join(","),
    ...rows.map((row) => [
      row.id,
      row.category,
      row.task,
      row.query,
      row.baselineQuality.qualityLabel,
      row.vtraceQuality.qualityLabel,
      row.vtraceOrientationParity,
      row.baseline.estTokens,
      row.vtrace.estTokens,
      formatNumber(row.qualityPreservingReductionPct),
      row.baseline.files.length,
      row.baseline.files[0] ?? null,
      row.baselineQuality.matchedExpectedPath,
      row.baselineQuality.matchedExpectedSymbol,
      row.vtrace.itemCount,
      row.vtrace.pivotCount,
      row.vtrace.supportCount,
      row.vtrace.topResult,
      row.vtrace.topFile,
      row.vtraceQuality.matchedExpectedPath,
      row.vtraceQuality.matchedExpectedSymbol,
      row.vtrace.selectedIntent,
      row.vtrace.routingProfile,
      row.vtrace.capsuleProfile,
      row.vtrace.contaminationDetected,
      row.vtrace.contaminatedPaths.join(";"),
      row.notes.join("; "),
    ].map(csvEscape).join(",")),
  ].join("\n")}\n`;
}

function rowToJson(row: OrientationRow, includeContext: boolean) {
  return {
    id: row.id,
    category: row.category,
    task: row.task,
    query: row.query,
    expected: row.expected ?? null,
    baseline: {
      files: row.baseline.files,
      fileCount: row.baseline.files.length,
      topFile: row.baseline.files[0] ?? null,
      snippetCount: row.baseline.snippets.length,
      snippets: row.baseline.snippets.map((snippet) => ({
        file: snippet.file,
        startLine: snippet.startLine,
        endLine: snippet.endLine,
        chars: snippet.chars,
        ...(includeContext && snippet.preview !== undefined ? { preview: snippet.preview } : {}),
      })),
      chars: row.baseline.chars,
      estTokens: row.baseline.estTokens,
      notes: row.baseline.notes,
    },
    vtrace: {
      selectedIntent: row.vtrace.selectedIntent,
      routingProfile: row.vtrace.routingProfile,
      capsuleProfile: row.vtrace.capsuleProfile,
      itemCount: row.vtrace.itemCount,
      pivotCount: row.vtrace.pivotCount,
      supportCount: row.vtrace.supportCount,
      topResult: row.vtrace.topResult,
      topFile: row.vtrace.topFile,
      files: row.vtrace.files,
      symbols: row.vtrace.symbols,
      chars: row.vtrace.chars,
      estTokens: row.vtrace.estTokens,
      contaminationDetected: row.vtrace.contaminationDetected,
      contaminatedPaths: row.vtrace.contaminatedPaths,
      diagnostics: row.vtrace.diagnostics,
      ...(includeContext ? { rawSnippet: row.vtrace.rawSnippet } : {}),
    },
    quality: {
      baseline: row.baselineQuality,
      vtrace: row.vtraceQuality,
    },
    parity: {
      vtraceOrientationParity: row.vtraceOrientationParity,
      qualityPreservingReductionPct: row.qualityPreservingReductionPct,
    },
    notes: row.notes,
  };
}

function renderWeakRowsTable(rows: readonly OrientationRow[]): string {
  return [
    "| id | baseline | vtrace | parity | top vtrace target | comment |",
    "| --- | --- | --- | --- | --- | --- |",
    ...rows.map((row) => [
      escapeMarkdown(row.id),
      row.baselineQuality.qualityLabel,
      row.vtraceQuality.qualityLabel,
      formatBoolean(row.vtraceOrientationParity),
      escapeMarkdown(row.vtrace.topFile ?? row.vtrace.topResult ?? ""),
      escapeMarkdown(row.expected?.notes ?? ""),
    ].join(" | ")).map((line) => `| ${line} |`),
  ].join("\n");
}

function countQuality(
  rows: readonly OrientationRow[],
  side: "baseline" | "vtrace",
  label: QualityLabel,
): number {
  return rows.filter((row) => {
    const quality = side === "baseline" ? row.baselineQuality : row.vtraceQuality;
    return quality.qualityLabel === label;
  }).length;
}

function mean(values: readonly number[]): number | null {
  if (values.length === 0) {
    return null;
  }

  return values.reduce((total, value) => total + value, 0) / values.length;
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) {
    return null;
  }

  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);

  return sorted.length % 2 === 0 ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[middle]!;
}

function makeQualityEvaluation(
  qualityLabel: QualityLabel,
  matchedExpectedPath: string | null,
  matchedExpectedSymbol: string | null,
): QualityEvaluation {
  return {
    qualityLabel,
    qualityScore: qualityScore(qualityLabel),
    matchedExpectedPath,
    matchedExpectedSymbol,
  };
}

function matchExpectedPath(actualPath: string | null, expectedPaths: readonly string[]): string | null {
  if (actualPath === null) {
    return null;
  }

  const normalizedActual = normalizePath(actualPath);

  return expectedPaths.find((expectedPath) => {
    const normalizedExpected = normalizePath(expectedPath);

    return normalizedActual === normalizedExpected
      || normalizedActual.endsWith(`/${normalizedExpected}`)
      || normalizedActual.startsWith(`${normalizedExpected}/`)
      || normalizedActual.includes(`/${normalizedExpected}/`);
  }) ?? null;
}

function matchExpectedSymbol(actualName: string | null, expectedSymbols: readonly string[]): string | null {
  if (actualName === null) {
    return null;
  }

  const normalizedActual = actualName.toLowerCase();

  return expectedSymbols.find((expectedSymbol) => {
    const normalizedExpected = expectedSymbol.toLowerCase();

    return normalizedActual === normalizedExpected
      || normalizedActual.endsWith(`.${normalizedExpected}`)
      || normalizedActual.endsWith(`::${normalizedExpected}`)
      || normalizedActual.includes(`.${normalizedExpected}.`)
      || normalizedActual.includes(`::${normalizedExpected}.`)
      || (normalizedExpected.length >= 5 && normalizedActual.includes(normalizedExpected));
  }) ?? null;
}

function makeVtraceItemRefs(items: readonly Record<string, unknown>[]): VtraceItemRef[] {
  return items.map((item) => ({
    name: stringOrNull(item.fqName ?? item.localName ?? item.symbolId),
    filePath: stringOrNull(item.filePath),
  }));
}

function sumItemContentChars(items: readonly Record<string, unknown>[]): number {
  return items.reduce((total, item) => total + JSON.stringify(item.content ?? item).length, 0);
}

function collectDiagnostics(root: Record<string, unknown>, toolCommand: "capsule" | "handoff"): string[] {
  const diagnostics: string[] = [];
  const capsule = isRecord(root.capsule) ? root.capsule : root;

  if (capsule.truncated === true) {
    diagnostics.push(`${toolCommand} capsule truncated`);
  }

  if (capsule.compressed === true) {
    diagnostics.push(`${toolCommand} capsule compressed`);
  }

  return diagnostics;
}

function makeRawSnippet(
  root: Record<string, unknown>,
  capsule: Record<string, unknown>,
  items: readonly Record<string, unknown>[],
): unknown {
  return {
    selectedIntent: root.selectedIntent ?? root.intent ?? null,
    routingProfile: root.routingProfile ?? null,
    capsuleProfile: root.capsuleProfile ?? null,
    itemPreview: items.slice(0, 5).map((item) => ({
      role: item.role ?? null,
      fqName: item.fqName ?? null,
      localName: item.localName ?? null,
      filePath: item.filePath ?? null,
    })),
    budget: capsule.budget ?? null,
  };
}

function firstNonNull<T>(values: readonly (T | null)[]): T | null {
  return values.find((value): value is T => value !== null) ?? null;
}

function stableUnique(values: readonly string[]): string[] {
  const result: string[] = [];
  const seen = new Set<string>();

  for (const value of values) {
    const normalized = normalizePath(value);

    if (seen.has(normalized)) {
      continue;
    }

    seen.add(normalized);
    result.push(normalized);
  }

  return result;
}

export function csvEscape(value: unknown): string {
  if (value === null || value === undefined) {
    return "";
  }

  const text = String(value);

  if (!/[",\n\r]/.test(text)) {
    return text;
  }

  return `"${text.replaceAll("\"", "\"\"")}"`;
}

function escapeMarkdown(value: string): string {
  return value.replaceAll("|", "\\|").replaceAll("\n", " ");
}

function formatBoolean(value: boolean | null): string {
  if (value === null) {
    return "n/a";
  }

  return value ? "yes" : "no";
}

function formatNumber(value: number | null): string {
  if (value === null || !Number.isFinite(value)) {
    return "";
  }

  return value.toFixed(2);
}

function normalizePath(value: string): string {
  return value.replaceAll("\\", "/");
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function isString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseStringArray(value: unknown): string[] {
  if (value === undefined) {
    return [];
  }

  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw new Error("Expected a string array.");
  }

  return value.map(normalizePath);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function parseArgs(argv: readonly string[]): CliConfig {
  const config = { ...DEFAULT_CONFIG };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;

    switch (arg) {
      case "--repo":
        config.repo = requireValue(argv, ++index, arg);
        break;
      case "--tasks":
        config.tasks = requireValue(argv, ++index, arg);
        break;
      case "--expected":
        config.expected = requireValue(argv, ++index, arg);
        break;
      case "--out":
        config.out = requireValue(argv, ++index, arg);
        break;
      case "--baseline-max-files":
        config.baselineMaxFiles = parsePositiveInt(requireValue(argv, ++index, arg), arg);
        break;
      case "--snippet-context-lines":
        config.snippetContextLines = parseNonNegativeInt(requireValue(argv, ++index, arg), arg);
        break;
      case "--max-snippets-per-file":
        config.maxSnippetsPerFile = parsePositiveInt(requireValue(argv, ++index, arg), arg);
        break;
      case "--tool-command": {
        const value = requireValue(argv, ++index, arg);
        if (value !== "capsule" && value !== "handoff") {
          throw new Error("--tool-command must be capsule or handoff.");
        }
        config.toolCommand = value;
        break;
      }
      case "--max-budget-characters":
        config.maxBudgetCharacters = parsePositiveInt(requireValue(argv, ++index, arg), arg);
        break;
      case "--include-context":
        config.includeContext = true;
        break;
      case "--dry-run":
        config.dryRun = true;
        break;
      case "--verbose":
        config.verbose = true;
        break;
      case "--help":
      case "-h":
        printUsageAndExit(0);
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return {
    ...config,
    repo: path.resolve(config.repo),
    tasks: path.resolve(config.tasks),
    expected: path.resolve(config.expected),
    out: path.resolve(config.out),
  };
}

function requireValue(argv: readonly string[], index: number, flag: string): string {
  const value = argv[index];

  if (value === undefined || value.startsWith("--")) {
    throw new Error(`${flag} requires a value.`);
  }

  return value;
}

function parsePositiveInt(value: string, flag: string): number {
  const parsed = Number.parseInt(value, 10);

  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${flag} must be a positive integer.`);
  }

  return parsed;
}

function parseNonNegativeInt(value: string, flag: string): number {
  const parsed = Number.parseInt(value, 10);

  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${flag} must be a non-negative integer.`);
  }

  return parsed;
}

function printUsageAndExit(exitCode: number): never {
  process.stdout.write([
    "Usage:",
    "  bun benchmarks/arc_stage2_orientation/run_arc_stage2_orientation.ts --repo /home/calvin/code/ARC --tasks benchmarks/arc_stage2_orientation/tasks.arc.stage2.json --expected benchmarks/arc_stage2_orientation/expected.arc.stage2.json --out benchmarks/arc_stage2_orientation/results --baseline-max-files 5 --snippet-context-lines 40 --max-snippets-per-file 3",
    "",
  ].join("\n"));
  process.exit(exitCode);
}

if (import.meta.main) {
  try {
    await runBenchmark(parseArgs(process.argv.slice(2)));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}
