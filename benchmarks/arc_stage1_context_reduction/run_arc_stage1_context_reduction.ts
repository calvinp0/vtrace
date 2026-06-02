import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export interface ArcStage1Query {
  readonly category: string;
  readonly query: string;
}

export interface BaselineResult {
  readonly files: readonly string[];
  readonly chars: number;
  readonly estTokens: number;
  readonly snippets: readonly BaselineSnippet[];
  readonly notes: readonly string[];
}

export interface BaselineSnippet {
  readonly file: string;
  readonly chars: number;
  readonly preview: string;
}

export interface VtraceMeasurement {
  readonly selectedIntent: string | null;
  readonly routingProfile: string | null;
  readonly capsuleProfile: string | null;
  readonly itemCount: number;
  readonly pivotCount: number;
  readonly supportCount: number;
  readonly sourceBackedPivotCount: number | null;
  readonly chars: number;
  readonly estTokens: number;
  readonly topResult: string | null;
  readonly topFile: string | null;
  readonly contaminatedPaths: readonly string[];
  readonly contaminationDetected: boolean;
  readonly diagnostics: readonly string[];
  readonly rawSnippet: unknown;
}

export interface BenchmarkRow {
  readonly query: string;
  readonly category: string;
  readonly baseline: BaselineResult;
  readonly vtrace: VtraceMeasurement;
  readonly reductionPct: number | null;
  readonly expectedAreaHits: readonly string[];
  readonly notes: readonly string[];
}

interface CliConfig {
  repo: string;
  queries: string;
  out: string;
  baselineMaxFiles: number;
  toolCommand: "capsule" | "handoff";
  maxBudgetCharacters: number | null;
  dryRun: boolean;
  verbose: boolean;
}

const DEFAULT_CONFIG: CliConfig = {
  repo: "/home/calvin/code/ARC",
  queries: "benchmarks/arc_stage1_context_reduction/queries.arc.stage1.json",
  out: "benchmarks/arc_stage1_context_reduction/results",
  baselineMaxFiles: 5,
  toolCommand: "handoff",
  maxBudgetCharacters: null,
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

const EXPECTED_AREA_TERMS: ReadonlyArray<readonly [string, readonly string[]]> = [
  ["species", ["ARCSpecies", "species"]],
  ["reaction", ["ARCReaction", "reaction"]],
  ["scheduler", ["Scheduler", "scheduler"]],
  ["family", ["determine_family", "family"]],
  ["run_arc", ["run_arc"]],
  ["ts", ["ts", "transition state"]],
  ["conformer", ["conformer"]],
  ["kinetics", ["kinetics", "arkane"]],
  ["arkane", ["arkane"]],
  ["rotor", ["rotor"]],
  ["cython", ["cython", ".pyx", ".pxd"]],
  ["parser", ["parser", "parse"]],
];

export function estimateTokens(chars: number): number {
  return Math.ceil(Math.max(0, chars) / 4);
}

export function calculateReductionPct(
  baselineEstTokens: number,
  vtraceEstTokens: number,
): number | null {
  if (baselineEstTokens <= 0) {
    return null;
  }

  return 100 * (baselineEstTokens - vtraceEstTokens) / baselineEstTokens;
}

export async function loadQueries(queriesPath: string): Promise<ArcStage1Query[]> {
  const parsed = JSON.parse(await readFile(queriesPath, "utf8")) as unknown;

  if (!Array.isArray(parsed)) {
    throw new Error("Query file must contain an array.");
  }

  return parsed.map((entry, index) => {
    if (!isRecord(entry) || typeof entry.category !== "string" || typeof entry.query !== "string") {
      throw new Error(`Invalid query entry at index ${index}.`);
    }

    return {
      category: entry.category,
      query: entry.query,
    };
  });
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

export function stableDeduplicateFiles(
  files: readonly string[],
  maxFiles: number,
): string[] {
  const deduped: string[] = [];
  const seen = new Set<string>();

  for (const file of files) {
    const normalized = file.replaceAll("\\", "/");

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

export function detectContaminatedVtracePaths(paths: readonly string[]): string[] {
  const contaminated: string[] = [];
  const seen = new Set<string>();

  for (const pathValue of paths) {
    const normalized = pathValue.replaceAll("\\", "/");

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
): VtraceMeasurement {
  const root = isRecord(output) ? output : {};
  const capsule = isRecord(root.capsule) ? root.capsule : root;
  const handoffItems = Array.isArray(capsule.items) ? capsule.items.filter(isRecord) : [];
  const pivots = Array.isArray(capsule.pivots) ? capsule.pivots.filter(isRecord) : [];
  const supportingItems = Array.isArray(capsule.supportingItems) ? capsule.supportingItems.filter(isRecord) : [];
  const items = handoffItems.length > 0 ? handoffItems : [...pivots, ...supportingItems];
  const pivotItems = handoffItems.length > 0
    ? handoffItems.filter((item) => item.role === "pivot")
    : pivots;
  const supportItems = handoffItems.length > 0
    ? handoffItems.filter((item) => item.role === "support")
    : supportingItems;
  const budget = isRecord(capsule.budget) ? capsule.budget : null;
  const budgetChars = typeof budget?.usedCharacters === "number"
    ? budget.usedCharacters
    : sumItemContentChars(items);
  const top = items[0] ?? null;
  const sourceBackedDetectable = pivotItems.some((item) => typeof item.sourceBacked === "boolean");
  const contaminatedPaths = detectContaminatedVtracePaths(collectVtracePaths(items));

  return {
    selectedIntent: stringOrNull(root.selectedIntent ?? root.intent),
    routingProfile: stringOrNull(
      isRecord(root.routingProfile) ? root.routingProfile.id : null,
    ),
    capsuleProfile: stringOrNull(
      isRecord(root.capsuleProfile) ? root.capsuleProfile.id : null,
    ),
    itemCount: items.length,
    pivotCount: pivotItems.length,
    supportCount: supportItems.length,
    sourceBackedPivotCount: sourceBackedDetectable
      ? pivotItems.filter((item) => item.sourceBacked === true).length
      : null,
    chars: budgetChars,
    estTokens: estimateTokens(budgetChars),
    topResult: stringOrNull(top?.fqName ?? top?.localName ?? top?.symbolId),
    topFile: stringOrNull(top?.filePath),
    contaminatedPaths,
    contaminationDetected: contaminatedPaths.length > 0,
    diagnostics: collectDiagnostics(root, toolCommand),
    rawSnippet: makeRawSnippet(root, capsule, items),
  };
}

async function runBenchmark(config: CliConfig): Promise<void> {
  const queries = await loadQueries(config.queries);
  const metadata = {
    benchmark: "arc_stage1_context_reduction",
    timestamp: new Date().toISOString(),
    arcRepoPath: config.repo,
    queryFile: config.queries,
    outputDirectory: config.out,
    baselineMaxFiles: config.baselineMaxFiles,
    toolCommand: config.toolCommand,
    maxBudgetCharacters: config.maxBudgetCharacters,
    tokenEstimate: "Math.ceil(chars / 4)",
    notes: config.maxBudgetCharacters === null
      ? []
      : ["maxBudgetCharacters is recorded only; current capsule/handoff CLI commands use their built-in budget."],
  };

  if (config.dryRun) {
    const lines = [
      "ARC Stage 1 context reduction benchmark dry run",
      `Repo: ${config.repo}`,
      `Queries: ${queries.length}`,
      `Tool command: ${config.toolCommand}`,
      `Output directory: ${config.out}`,
    ];
    process.stdout.write(`${lines.join("\n")}\n`);
    return;
  }

  const rows: BenchmarkRow[] = [];

  for (const query of queries) {
    if (config.verbose) {
      process.stderr.write(`Running ${query.category}: ${query.query}\n`);
    }

    const baseline = await collectBaselineContext(config.repo, query.query, config.baselineMaxFiles);
    const vtrace = await collectVtraceMeasurement(config.repo, query.query, config.toolCommand);
    const rowNotes = [
      ...baseline.notes,
      ...vtrace.diagnostics,
      ...(config.maxBudgetCharacters === null
        ? []
        : ["requested max budget not passed to existing CLI"]),
    ];

    rows.push({
      query: query.query,
      category: query.category,
      baseline,
      vtrace,
      reductionPct: calculateReductionPct(baseline.estTokens, vtrace.estTokens),
      expectedAreaHits: detectExpectedAreaHits(query.query, baseline.files, vtrace),
      notes: rowNotes,
    });
  }

  const summary = summarizeRows(rows);
  const report = {
    metadata,
    rows: rows.map(rowToJson),
    summary,
  };

  await mkdir(config.out, { recursive: true });
  await writeFile(
    path.join(config.out, "arc_stage1_context_reduction.csv"),
    renderCsv(rows),
  );
  await writeFile(
    path.join(config.out, "arc_stage1_context_reduction.json"),
    `${JSON.stringify(report, null, 2)}\n`,
  );
  await writeFile(
    path.join(config.out, "arc_stage1_context_reduction.md"),
    renderMarkdown(metadata, rows, summary),
  );
}

async function collectBaselineContext(
  repoRoot: string,
  query: string,
  maxFiles: number,
): Promise<BaselineResult> {
  const terms = buildSearchTerms(query);
  const candidateFiles: string[] = [];
  const notes: string[] = [];

  for (const term of terms) {
    const result = await runProcess("rg", [
      "--files-with-matches",
      "--ignore-case",
      "--fixed-strings",
      ...RG_EXCLUDE_ARGS,
      term,
      repoRoot,
    ]);

    if (result.exitCode !== 0 && result.exitCode !== 1) {
      notes.push(`rg failed for term ${term}: ${result.stderr.trim() || `exit ${result.exitCode}`}`);
      continue;
    }

    candidateFiles.push(...result.stdout.split(/\r?\n/).filter((line) => line.length > 0).sort());
  }

  const files = stableDeduplicateFiles(candidateFiles, maxFiles);
  const snippets: BaselineSnippet[] = [];
  let chars = 0;

  for (const file of files) {
    const content = await readFile(file, "utf8");
    chars += content.length;
    snippets.push({
      file: path.relative(repoRoot, file).replaceAll("\\", "/"),
      chars: content.length,
      preview: content.slice(0, 500),
    });
  }

  if (files.length === 0) {
    notes.push("baseline rg returned no files");
  }

  return {
    files: files.map((file) => path.relative(repoRoot, file).replaceAll("\\", "/")),
    chars,
    estTokens: estimateTokens(chars),
    snippets,
    notes,
  };
}

async function collectVtraceMeasurement(
  repoRoot: string,
  query: string,
  toolCommand: "capsule" | "handoff",
): Promise<VtraceMeasurement> {
  const cliPath = path.resolve("bin/vtrace");
  const result = await runProcess(cliPath, [toolCommand, repoRoot, query]);

  if (result.exitCode !== 0) {
    return {
      selectedIntent: null,
      routingProfile: null,
      capsuleProfile: null,
      itemCount: 0,
      pivotCount: 0,
      supportCount: 0,
      sourceBackedPivotCount: null,
      chars: 0,
      estTokens: 0,
      topResult: null,
      topFile: null,
      contaminatedPaths: [],
      contaminationDetected: false,
      diagnostics: [`${toolCommand} failed: ${result.stderr.trim() || `exit ${result.exitCode}`}`],
      rawSnippet: {
        stdoutPreview: result.stdout.slice(0, 1000),
        stderrPreview: result.stderr.slice(0, 1000),
      },
    };
  }

  try {
    return parseVtraceOutput(JSON.parse(result.stdout), toolCommand);
  } catch (error) {
    return {
      selectedIntent: null,
      routingProfile: null,
      capsuleProfile: null,
      itemCount: 0,
      pivotCount: 0,
      supportCount: 0,
      sourceBackedPivotCount: null,
      chars: 0,
      estTokens: 0,
      topResult: null,
      topFile: null,
      contaminatedPaths: [],
      contaminationDetected: false,
      diagnostics: [`${toolCommand} JSON parse failed: ${error instanceof Error ? error.message : String(error)}`],
      rawSnippet: {
        stdoutPreview: result.stdout.slice(0, 1000),
        stderrPreview: result.stderr.slice(0, 1000),
      },
    };
  }
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

function renderCsv(rows: readonly BenchmarkRow[]): string {
  const columns = [
    "query",
    "category",
    "baseline_file_count",
    "baseline_chars",
    "baseline_est_tokens",
    "vtrace_item_count",
    "vtrace_pivot_count",
    "vtrace_support_count",
    "vtrace_source_backed_pivot_count",
    "vtrace_chars",
    "vtrace_est_tokens",
    "reduction_pct",
    "selected_intent",
    "routing_profile",
    "capsule_profile",
    "top_vtrace_result",
    "top_vtrace_file",
    "vtrace_contaminated_paths",
    "vtrace_contamination_detected",
    "baseline_files",
    "expected_area_hits",
    "notes",
  ];

  const lines = [
    columns.join(","),
    ...rows.map((row) => [
      row.query,
      row.category,
      row.baseline.files.length,
      row.baseline.chars,
      row.baseline.estTokens,
      row.vtrace.itemCount,
      row.vtrace.pivotCount,
      row.vtrace.supportCount,
      row.vtrace.sourceBackedPivotCount,
      row.vtrace.chars,
      row.vtrace.estTokens,
      formatNumber(row.reductionPct),
      row.vtrace.selectedIntent,
      row.vtrace.routingProfile,
      row.vtrace.capsuleProfile,
      row.vtrace.topResult,
      row.vtrace.topFile,
      row.vtrace.contaminatedPaths.join(";"),
      row.vtrace.contaminationDetected,
      row.baseline.files.join(";"),
      row.expectedAreaHits.join(";"),
      row.notes.join("; "),
    ].map(csvEscape).join(",")),
  ];

  return `${lines.join("\n")}\n`;
}

export function summarizeRows(rows: readonly BenchmarkRow[]) {
  const reductions = rows
    .map((row) => row.reductionPct)
    .filter((value): value is number => value !== null);
  const categories = [...new Set(rows.map((row) => row.category))].sort();
  const rowsWithContaminatedVtracePaths = rows.filter((row) => row.vtrace.contaminationDetected).length;
  const contaminatedVtracePathCount = rows.reduce(
    (sum, row) => sum + row.vtrace.contaminatedPaths.length,
    0,
  );

  return {
    totalQueries: rows.length,
    averageBaselineTokens: mean(rows.map((row) => row.baseline.estTokens)),
    averageVtraceTokens: mean(rows.map((row) => row.vtrace.estTokens)),
    medianReductionPercent: median(reductions),
    meanReductionPercent: mean(reductions),
    vtraceTokensLessThanBaselineCount: rows.filter((row) => row.vtrace.estTokens < row.baseline.estTokens).length,
    vtraceReturnedContextCount: rows.filter((row) => row.vtrace.itemCount > 0 || row.vtrace.pivotCount > 0).length,
    baselineReturnedNoFilesCount: rows.filter((row) => row.baseline.files.length === 0).length,
    rowsWithContaminatedVtracePaths,
    contaminatedVtracePathCount,
    benchmarkAcceptableForReductionClaim: contaminatedVtracePathCount === 0,
    categoryAverages: categories.map((category) => {
      const categoryRows = rows.filter((row) => row.category === category);
      const categoryReductions = categoryRows
        .map((row) => row.reductionPct)
        .filter((value): value is number => value !== null);

      return {
        category,
        queryCount: categoryRows.length,
        averageBaselineTokens: mean(categoryRows.map((row) => row.baseline.estTokens)),
        averageVtraceTokens: mean(categoryRows.map((row) => row.vtrace.estTokens)),
        meanReductionPercent: mean(categoryReductions),
        medianReductionPercent: median(categoryReductions),
      };
    }),
  };
}

function rowToJson(row: BenchmarkRow) {
  return {
    query: row.query,
    category: row.category,
    baseline: {
      files: row.baseline.files,
      fileCount: row.baseline.files.length,
      chars: row.baseline.chars,
      estTokens: row.baseline.estTokens,
      snippets: row.baseline.snippets,
      notes: row.baseline.notes,
    },
    vtrace: row.vtrace,
    vtrace_contaminated_paths: row.vtrace.contaminatedPaths,
    vtrace_contamination_detected: row.vtrace.contaminationDetected,
    reductionPct: row.reductionPct,
    expectedAreaHits: row.expectedAreaHits,
    notes: row.notes,
  };
}

function renderMarkdown(
  metadata: Record<string, unknown>,
  rows: readonly BenchmarkRow[],
  summary: ReturnType<typeof summarizeRows>,
): string {
  const validRows = rows.filter((row) => row.reductionPct !== null);
  const worst = [...validRows].sort((a, b) => (a.reductionPct ?? 0) - (b.reductionPct ?? 0)).slice(0, 5);
  const best = [...validRows].sort((a, b) => (b.reductionPct ?? 0) - (a.reductionPct ?? 0)).slice(0, 5);
  const noUseful = rows.filter((row) => row.vtrace.itemCount === 0 && row.vtrace.pivotCount === 0);
  const noBaseline = rows.filter((row) => row.baseline.files.length === 0);
  const headline = summary.benchmarkAcceptableForReductionClaim
    ? `Ran ${summary.totalQueries} fixed queries against ${metadata.arcRepoPath}. Mean measured reduction was ${formatNumber(summary.meanReductionPercent)}%, median was ${formatNumber(summary.medianReductionPercent)}%. vtrace used fewer estimated tokens than the naive full-file baseline for ${summary.vtraceTokensLessThanBaselineCount}/${summary.totalQueries} queries.`
    : "The benchmark executed, but the reduction result is not claimable because contaminated indexed paths were detected.";
  const warning = summary.benchmarkAcceptableForReductionClaim
    ? []
    : [
      "## Warning",
      "",
      "WARNING: This run is contaminated and should not be used for context-reduction claims until the target repo is reindexed cleanly.",
      "",
      `Detected ${summary.contaminatedVtracePathCount} contaminated vtrace path(s) across ${summary.rowsWithContaminatedVtracePaths} row(s).`,
      "",
    ];

  return [
    "# ARC Stage 1 Context Reduction Report",
    "",
    ...warning,
    "## Headline summary",
    "",
    headline,
    "",
    "## Overall reduction",
    "",
    "| Metric | Value |",
    "| --- | ---: |",
    `| Total queries | ${summary.totalQueries} |`,
    `| Average baseline estimated tokens | ${formatNumber(summary.averageBaselineTokens)} |`,
    `| Average vtrace estimated tokens | ${formatNumber(summary.averageVtraceTokens)} |`,
    `| Mean reduction percent | ${formatNumber(summary.meanReductionPercent)} |`,
    `| Median reduction percent | ${formatNumber(summary.medianReductionPercent)} |`,
    `| vtrace tokens < baseline tokens | ${summary.vtraceTokensLessThanBaselineCount} |`,
    `| vtrace returned at least one pivot/item | ${summary.vtraceReturnedContextCount} |`,
    `| baseline returned no files | ${summary.baselineReturnedNoFilesCount} |`,
    `| rows with contaminated vtrace paths | ${summary.rowsWithContaminatedVtracePaths} |`,
    `| contaminated vtrace path count | ${summary.contaminatedVtracePathCount} |`,
    `| acceptable for reduction claim | ${summary.benchmarkAcceptableForReductionClaim ? "yes" : "no"} |`,
    "",
    "## Category-level averages",
    "",
    "| Category | Queries | Avg baseline tokens | Avg vtrace tokens | Mean reduction % | Median reduction % |",
    "| --- | ---: | ---: | ---: | ---: | ---: |",
    ...summary.categoryAverages.map((category) => (
      `| ${category.category} | ${category.queryCount} | ${formatNumber(category.averageBaselineTokens)} | ${formatNumber(category.averageVtraceTokens)} | ${formatNumber(category.meanReductionPercent)} | ${formatNumber(category.medianReductionPercent)} |`
    )),
    "",
    "## Worst reductions",
    "",
    renderRowsTable(worst),
    "",
    "## Best reductions",
    "",
    renderRowsTable(best),
    "",
    "## Queries where vtrace returned no useful context",
    "",
    noUseful.length === 0 ? "None." : renderRowsTable(noUseful),
    "",
    "## Queries where baseline returned no files",
    "",
    noBaseline.length === 0 ? "None." : renderRowsTable(noBaseline),
    "",
    "## Known limitations",
    "",
    "- Token counts are estimated as `Math.ceil(chars / 4)`, not tokenizer-exact counts.",
    "- The baseline intentionally reads full matching files and is not a tuned retrieval baseline.",
    "- Expected ARC area hits are lightweight path/name heuristics for inspection.",
    "- vtrace measurements use the existing ARC vtrace index; stale or over-broad indexes can surface stale paths.",
    "- The benchmark records measured context sizes only and does not claim task-solving performance.",
    "",
    "## Suggested next measurement step",
    "",
    "Run the same fixed query set twice on the same indexed ARC repo state, diff the CSV/JSON excluding timestamp metadata, and classify misses before changing retrieval or capsule behavior.",
    "",
  ].join("\n");
}

export function renderRowsTable(rows: readonly BenchmarkRow[]): string {
  if (rows.length === 0) {
    return "None.";
  }

  return [
    "| Query | Category | Baseline tokens | vtrace tokens | Reduction % | Items | Source-backed pivots | Contaminated | Top vtrace file | Notes |",
    "| --- | --- | ---: | ---: | ---: | ---: | ---: | --- | --- | --- |",
    ...rows.map((row) => (
      `| ${escapeMarkdown(row.query)} | ${escapeMarkdown(row.category)} | ${row.baseline.estTokens} | ${row.vtrace.estTokens} | ${formatNumber(row.reductionPct)} | ${row.vtrace.itemCount} | ${formatSourceBackedPivotCount(row.vtrace.sourceBackedPivotCount)} | ${row.vtrace.contaminationDetected ? "yes" : "no"} | ${escapeMarkdown(row.vtrace.topFile ?? "")} | ${escapeMarkdown(row.notes.join("; "))} |`
    )),
  ].join("\n");
}

function formatSourceBackedPivotCount(value: number | null): string {
  return value === null ? "unknown" : String(value);
}

function detectExpectedAreaHits(
  query: string,
  baselineFiles: readonly string[],
  vtrace: VtraceMeasurement,
): string[] {
  const haystack = [
    query,
    ...baselineFiles,
    vtrace.topResult ?? "",
    vtrace.topFile ?? "",
    JSON.stringify(vtrace.rawSnippet),
  ].join("\n").toLowerCase();

  return EXPECTED_AREA_TERMS
    .filter(([, terms]) => terms.some((term) => haystack.includes(term.toLowerCase())))
    .map(([area]) => area);
}

function collectDiagnostics(root: Record<string, unknown>, toolCommand: string): string[] {
  const diagnostics: string[] = [];

  if (isRecord(root.trust) && root.trust.capsuleStaleness !== null && root.trust.capsuleStaleness !== undefined) {
    diagnostics.push("trust capsule staleness present");
  }

  if (toolCommand === "capsule" && !isRecord(root.capsule)) {
    diagnostics.push("parsed capsule command payload");
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
    classification: root.classification ?? null,
    routingProfile: root.routingProfile ?? null,
    capsuleProfile: root.capsuleProfile ?? null,
    budget: capsule.budget ?? null,
    truncated: capsule.truncated ?? null,
    compressed: capsule.compressed ?? null,
    topItems: items.slice(0, 3).map((item) => ({
      role: item.role ?? null,
      fqName: item.fqName ?? null,
      localName: item.localName ?? null,
      filePath: item.filePath ?? null,
      kind: item.kind ?? null,
      sourceBacked: item.sourceBacked ?? null,
      contentMode: isRecord(item.content) ? item.content.mode ?? null : null,
    })),
  };
}

function collectVtracePaths(items: readonly Record<string, unknown>[]): string[] {
  const paths: string[] = [];

  for (const item of items) {
    if (typeof item.filePath === "string") {
      paths.push(item.filePath);
      continue;
    }

    if (typeof item.fqName === "string" && looksPathLike(item.fqName)) {
      paths.push(item.fqName.split("::", 1)[0]!);
    }
  }

  return paths;
}

function looksPathLike(value: string): boolean {
  return value.includes("/") || value.includes("\\");
}

function sumItemContentChars(items: readonly Record<string, unknown>[]): number {
  return items.reduce((sum, item) => {
    if (!isRecord(item.content)) {
      return sum;
    }

    return sum + contentChars(item.content);
  }, 0);
}

function contentChars(content: Record<string, unknown>): number {
  if (typeof content.source === "string") {
    return content.source.length;
  }
  if (typeof content.signature === "string") {
    return content.signature.length;
  }
  if (typeof content.summary === "string") {
    return content.summary.length;
  }
  if (typeof content.stub === "string") {
    return content.stub.length;
  }

  return JSON.stringify(content).length;
}

function mean(values: readonly number[]): number | null {
  if (values.length === 0) {
    return null;
  }

  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) {
    return null;
  }

  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);

  return sorted.length % 2 === 0
    ? (sorted[middle - 1]! + sorted[middle]!) / 2
    : sorted[middle]!;
}

function formatNumber(value: number | null): string {
  if (value === null || !Number.isFinite(value)) {
    return "";
  }

  return value.toFixed(2);
}

function escapeMarkdown(value: string): string {
  return value.replaceAll("|", "\\|").replaceAll("\n", " ");
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseArgs(argv: readonly string[]): CliConfig {
  const config = { ...DEFAULT_CONFIG };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;

    switch (arg) {
      case "--repo":
        config.repo = requireValue(argv, ++index, arg);
        break;
      case "--queries":
        config.queries = requireValue(argv, ++index, arg);
        break;
      case "--out":
        config.out = requireValue(argv, ++index, arg);
        break;
      case "--baseline-max-files":
        config.baselineMaxFiles = parsePositiveInt(requireValue(argv, ++index, arg), arg);
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
    queries: path.resolve(config.queries),
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

function printUsageAndExit(exitCode: number): never {
  process.stdout.write([
    "Usage:",
    "  bun benchmarks/arc_stage1_context_reduction/run_arc_stage1_context_reduction.ts --repo /home/calvin/code/ARC --queries benchmarks/arc_stage1_context_reduction/queries.arc.stage1.json --out benchmarks/arc_stage1_context_reduction/results --baseline-max-files 5",
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
