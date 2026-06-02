import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export interface ArcStage1Query {
  readonly category: string;
  readonly query: string;
}

export interface BaselineResult {
  readonly mode: BaselineMode;
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
  readonly startLine?: number;
  readonly endLine?: number;
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
  readonly items: readonly VtraceItemRef[];
  readonly contaminatedPaths: readonly string[];
  readonly contaminationDetected: boolean;
  readonly diagnostics: readonly string[];
  readonly rawSnippet: unknown;
}

export interface VtraceItemRef {
  readonly name: string | null;
  readonly filePath: string | null;
}

export interface BenchmarkRow {
  readonly query: string;
  readonly category: string;
  readonly baselineMode: BaselineMode | "all";
  readonly baseline: BaselineResult;
  readonly baselines: BaselineResultsByMode;
  readonly vtrace: VtraceMeasurement;
  readonly reductionPct: number | null;
  readonly reductions: ReductionResultsByMode;
  readonly quality: QualityEvaluation;
  readonly expectedAreaHits: readonly string[];
  readonly notes: readonly string[];
}

export type BaselineMode = "full-file" | "snippet" | "capped-full-file";
export type BaselineResultsByMode = Partial<Record<BaselineMode, BaselineResult>>;
export type ReductionResultsByMode = Partial<Record<BaselineMode, number | null>>;
export type QualityLabel = "strong" | "acceptable" | "weak" | "missing" | "unchecked";

export interface QualityExpectation {
  readonly expected_paths: readonly string[];
  readonly expected_symbols: readonly string[];
  readonly notes?: string;
}

export type QualityExpectationsByQuery = Record<string, QualityExpectation>;

export interface QualityEvaluation {
  readonly qualityLabel: QualityLabel;
  readonly expectedPaths: readonly string[];
  readonly expectedSymbols: readonly string[];
  readonly matchedExpectedPath: string | null;
  readonly matchedExpectedSymbol: string | null;
}

interface CliConfig {
  repo: string;
  queries: string;
  expected: string;
  out: string;
  baselineMaxFiles: number;
  baselineMode: BaselineMode | "all";
  snippetContextLines: number;
  maxSnippetsPerFile: number;
  baselineMaxCharsPerFile: number;
  toolCommand: "capsule" | "handoff";
  maxBudgetCharacters: number | null;
  dryRun: boolean;
  verbose: boolean;
}

const DEFAULT_CONFIG: CliConfig = {
  repo: "/home/calvin/code/ARC",
  queries: "benchmarks/arc_stage1_context_reduction/queries.arc.stage1.json",
  expected: "benchmarks/arc_stage1_context_reduction/expected.arc.stage1.json",
  out: "benchmarks/arc_stage1_context_reduction/results",
  baselineMaxFiles: 5,
  baselineMode: "full-file",
  snippetContextLines: 40,
  maxSnippetsPerFile: 3,
  baselineMaxCharsPerFile: 40_000,
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

const BASELINE_MODES: readonly BaselineMode[] = [
  "full-file",
  "snippet",
  "capped-full-file",
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

export async function loadQualityExpectations(
  expectedPath: string,
): Promise<QualityExpectationsByQuery> {
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
    throw new Error("Expected quality file must contain an object keyed by query.");
  }

  const expectations: QualityExpectationsByQuery = {};

  for (const [query, value] of Object.entries(parsed)) {
    if (!isRecord(value)) {
      throw new Error(`Invalid expected quality entry for query: ${query}`);
    }

    expectations[query] = {
      expected_paths: parseStringArray(value.expected_paths),
      expected_symbols: parseStringArray(value.expected_symbols),
      ...(typeof value.notes === "string" ? { notes: value.notes } : {}),
    };
  }

  return expectations;
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
  const itemRefs = makeVtraceItemRefs(items);
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
    items: itemRefs,
    contaminatedPaths,
    contaminationDetected: contaminatedPaths.length > 0,
    diagnostics: collectDiagnostics(root, toolCommand),
    rawSnippet: makeRawSnippet(root, capsule, items),
  };
}

async function runBenchmark(config: CliConfig): Promise<void> {
  const queries = await loadQueries(config.queries);
  const qualityExpectations = await loadQualityExpectations(config.expected);
  const metadata = {
    benchmark: "arc_stage1_context_reduction",
    timestamp: new Date().toISOString(),
    arcRepoPath: config.repo,
    queryFile: config.queries,
    expectedFile: config.expected,
    outputDirectory: config.out,
    baselineMaxFiles: config.baselineMaxFiles,
    baselineMode: config.baselineMode,
    snippetContextLines: config.snippetContextLines,
    maxSnippetsPerFile: config.maxSnippetsPerFile,
    baselineMaxCharsPerFile: config.baselineMaxCharsPerFile,
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
      `Expected quality file: ${config.expected}`,
      `Tool command: ${config.toolCommand}`,
      `Baseline mode: ${config.baselineMode}`,
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

    const baselines = await collectBaselines(config.repo, query.query, config);
    const baseline = selectPrimaryBaseline(baselines, config.baselineMode);
    const vtrace = await collectVtraceMeasurement(config.repo, query.query, config.toolCommand);
    const quality = evaluateQuality(vtrace, qualityExpectations[query.query]);
    const rowNotes = [
      ...collectBaselineNotes(baselines),
      ...vtrace.diagnostics,
      ...(config.maxBudgetCharacters === null
        ? []
        : ["requested max budget not passed to existing CLI"]),
    ];

    rows.push({
      query: query.query,
      category: query.category,
      baselineMode: config.baselineMode,
      baseline,
      baselines,
      vtrace,
      reductionPct: calculateReductionPct(baseline.estTokens, vtrace.estTokens),
      reductions: calculateReductions(baselines, vtrace.estTokens),
      quality,
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

async function collectBaselines(
  repoRoot: string,
  query: string,
  config: Pick<CliConfig, "baselineMode" | "baselineMaxFiles" | "snippetContextLines" | "maxSnippetsPerFile" | "baselineMaxCharsPerFile">,
): Promise<BaselineResultsByMode> {
  const matches = await collectBaselineMatches(repoRoot, query);
  const files = stableDeduplicateFiles(matches.map((match) => match.file), config.baselineMaxFiles);
  const notes = files.length === 0 ? ["baseline rg returned no files"] : [];
  const modes = config.baselineMode === "all" ? BASELINE_MODES : [config.baselineMode];
  const baselines: BaselineResultsByMode = {};

  for (const mode of modes) {
    switch (mode) {
      case "full-file":
        baselines[mode] = await collectFullFileBaseline(repoRoot, files, notes);
        break;
      case "snippet":
        baselines[mode] = await collectSnippetBaseline(repoRoot, files, matches, {
          contextLines: config.snippetContextLines,
          maxSnippetsPerFile: config.maxSnippetsPerFile,
          notes,
        });
        break;
      case "capped-full-file":
        baselines[mode] = await collectCappedFullFileBaseline(repoRoot, files, {
          maxCharsPerFile: config.baselineMaxCharsPerFile,
          notes,
        });
        break;
    }
  }

  return baselines;
}

interface BaselineMatch {
  readonly file: string;
  readonly lineNumber: number;
}

async function collectBaselineMatches(
  repoRoot: string,
  query: string,
): Promise<BaselineMatch[]> {
  const terms = buildSearchTerms(query);
  const matches: BaselineMatch[] = [];

  for (const term of terms) {
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
    const pathValue = isRecord(data.path) && typeof data.path.text === "string"
      ? data.path.text
      : null;
    const lineNumber = typeof data.line_number === "number" ? data.line_number : null;

    if (pathValue !== null && lineNumber !== null) {
      matches.push({
        file: pathValue,
        lineNumber,
      });
    }
  }

  return matches.sort(compareMatches);
}

function deduplicateMatches(matches: readonly BaselineMatch[]): BaselineMatch[] {
  const deduped: BaselineMatch[] = [];
  const seen = new Set<string>();

  for (const match of matches) {
    const key = `${match.file.replaceAll("\\", "/")}:${match.lineNumber}`;

    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    deduped.push({
      file: match.file.replaceAll("\\", "/"),
      lineNumber: match.lineNumber,
    });
  }

  return deduped;
}

function compareMatches(left: BaselineMatch, right: BaselineMatch): number {
  return left.file.localeCompare(right.file) || left.lineNumber - right.lineNumber;
}

async function collectFullFileBaseline(
  repoRoot: string,
  files: readonly string[],
  notes: readonly string[],
): Promise<BaselineResult> {
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

  return {
    mode: "full-file",
    files: files.map((file) => path.relative(repoRoot, file).replaceAll("\\", "/")),
    chars,
    estTokens: estimateTokens(chars),
    snippets,
    notes,
  };
}

async function collectCappedFullFileBaseline(
  repoRoot: string,
  files: readonly string[],
  options: { readonly maxCharsPerFile: number; readonly notes: readonly string[] },
): Promise<BaselineResult> {
  const snippets: BaselineSnippet[] = [];
  let chars = 0;

  for (const file of files) {
    const content = await readFile(file, "utf8");
    const counted = capContentByChars(content, options.maxCharsPerFile);
    chars += counted.length;
    snippets.push({
      file: path.relative(repoRoot, file).replaceAll("\\", "/"),
      chars: counted.length,
      preview: counted.slice(0, 500),
    });
  }

  return {
    mode: "capped-full-file",
    files: files.map((file) => path.relative(repoRoot, file).replaceAll("\\", "/")),
    chars,
    estTokens: estimateTokens(chars),
    snippets,
    notes: options.notes,
  };
}

export function capContentByChars(content: string, maxChars: number): string {
  return content.slice(0, Math.max(0, maxChars));
}

async function collectSnippetBaseline(
  repoRoot: string,
  files: readonly string[],
  matches: readonly BaselineMatch[],
  options: {
    readonly contextLines: number;
    readonly maxSnippetsPerFile: number;
    readonly notes: readonly string[];
  },
): Promise<BaselineResult> {
  const snippets: BaselineSnippet[] = [];
  let chars = 0;

  for (const file of files) {
    const content = await readFile(file, "utf8");
    const fileLines = content.split(/\r?\n/);
    const fileMatches = matches
      .filter((match) => match.file === file)
      .map((match) => match.lineNumber);
    const ranges = extractSnippetRanges(
      fileMatches,
      fileLines.length,
      options.contextLines,
      options.maxSnippetsPerFile,
    );

    for (const range of ranges) {
      const text = fileLines.slice(range.startLine - 1, range.endLine).join("\n");
      chars += text.length;
      snippets.push({
        file: path.relative(repoRoot, file).replaceAll("\\", "/"),
        chars: text.length,
        preview: text.slice(0, 500),
        startLine: range.startLine,
        endLine: range.endLine,
      });
    }
  }

  return {
    mode: "snippet",
    files: files.map((file) => path.relative(repoRoot, file).replaceAll("\\", "/")),
    chars,
    estTokens: estimateTokens(chars),
    snippets,
    notes: options.notes,
  };
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

export function evaluateQuality(
  vtrace: Pick<VtraceMeasurement, "itemCount" | "topFile" | "topResult" | "items">,
  expectation: QualityExpectation | undefined,
): QualityEvaluation {
  if (expectation === undefined) {
    return makeQualityEvaluation("unchecked", [], [], null, null);
  }

  const expectedPaths = expectation.expected_paths.map(normalizePath);
  const expectedSymbols = [...expectation.expected_symbols];
  const topPathMatch = matchExpectedPath(vtrace.topFile, expectedPaths);
  const topSymbolMatch = matchExpectedSymbol(vtrace.topResult, expectedSymbols);

  if (topPathMatch !== null || topSymbolMatch !== null) {
    return makeQualityEvaluation("strong", expectedPaths, expectedSymbols, topPathMatch, topSymbolMatch);
  }

  const itemPathMatch = firstNonNull(vtrace.items.map((item) => matchExpectedPath(item.filePath, expectedPaths)));
  const itemSymbolMatch = firstNonNull(vtrace.items.map((item) => matchExpectedSymbol(item.name, expectedSymbols)));

  if (itemPathMatch !== null || itemSymbolMatch !== null) {
    return makeQualityEvaluation("acceptable", expectedPaths, expectedSymbols, itemPathMatch, itemSymbolMatch);
  }

  if (vtrace.itemCount === 0) {
    return makeQualityEvaluation("missing", expectedPaths, expectedSymbols, null, null);
  }

  return makeQualityEvaluation("weak", expectedPaths, expectedSymbols, null, null);
}

function makeQualityEvaluation(
  qualityLabel: QualityLabel,
  expectedPaths: readonly string[],
  expectedSymbols: readonly string[],
  matchedExpectedPath: string | null,
  matchedExpectedSymbol: string | null,
): QualityEvaluation {
  return {
    qualityLabel,
    expectedPaths,
    expectedSymbols,
    matchedExpectedPath,
    matchedExpectedSymbol,
  };
}

function matchExpectedPath(
  actualPath: string | null,
  expectedPaths: readonly string[],
): string | null {
  if (actualPath === null) {
    return null;
  }

  const normalizedActual = normalizePath(actualPath);

  return expectedPaths.find((expectedPath) => normalizedActual === expectedPath || normalizedActual.endsWith(`/${expectedPath}`)) ?? null;
}

function matchExpectedSymbol(
  actualName: string | null,
  expectedSymbols: readonly string[],
): string | null {
  if (actualName === null) {
    return null;
  }

  return expectedSymbols.find((expectedSymbol) => {
    return actualName === expectedSymbol
      || actualName.endsWith(`.${expectedSymbol}`)
      || actualName.endsWith(`::${expectedSymbol}`)
      || actualName.includes(`.${expectedSymbol}.`)
      || actualName.includes(`::${expectedSymbol}.`);
  }) ?? null;
}

function firstNonNull<T>(values: readonly (T | null)[]): T | null {
  return values.find((value): value is T => value !== null) ?? null;
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
      items: [],
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
      items: [],
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
  const allBaselines = rows.some((row) => row.baselineMode === "all");
  const columns = allBaselines ? [
    "query",
    "category",
    "baseline_full_file_est_tokens",
    "baseline_snippet_est_tokens",
    "baseline_capped_full_file_est_tokens",
    "vtrace_item_count",
    "vtrace_pivot_count",
    "vtrace_support_count",
    "vtrace_source_backed_pivot_count",
    "vtrace_chars",
    "vtrace_est_tokens",
    "reduction_full_file_pct",
    "reduction_snippet_pct",
    "reduction_capped_full_file_pct",
    "selected_intent",
    "routing_profile",
    "capsule_profile",
    "top_vtrace_result",
    "top_vtrace_file",
    "quality_label",
    "expected_paths",
    "expected_symbols",
    "matched_expected_path",
    "matched_expected_symbol",
    "vtrace_contaminated_paths",
    "vtrace_contamination_detected",
    "baseline_files",
    "expected_area_hits",
    "notes",
  ] : [
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
    "quality_label",
    "expected_paths",
    "expected_symbols",
    "matched_expected_path",
    "matched_expected_symbol",
    "vtrace_contaminated_paths",
    "vtrace_contamination_detected",
    "baseline_files",
    "expected_area_hits",
    "notes",
  ];

  const lines = [
    columns.join(","),
    ...rows.map((row) => (allBaselines ? renderAllBaselineCsvRow(row) : renderSingleBaselineCsvRow(row))),
  ];

  return `${lines.join("\n")}\n`;
}

function renderSingleBaselineCsvRow(row: BenchmarkRow): string {
  return [
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
    row.quality.qualityLabel,
    row.quality.expectedPaths.join(";"),
    row.quality.expectedSymbols.join(";"),
    row.quality.matchedExpectedPath,
    row.quality.matchedExpectedSymbol,
    row.vtrace.contaminatedPaths.join(";"),
    row.vtrace.contaminationDetected,
    row.baseline.files.join(";"),
    row.expectedAreaHits.join(";"),
    row.notes.join("; "),
  ].map(csvEscape).join(",");
}

function renderAllBaselineCsvRow(row: BenchmarkRow): string {
  return [
    row.query,
    row.category,
    row.baselines["full-file"]?.estTokens,
    row.baselines.snippet?.estTokens,
    row.baselines["capped-full-file"]?.estTokens,
    row.vtrace.itemCount,
    row.vtrace.pivotCount,
    row.vtrace.supportCount,
    row.vtrace.sourceBackedPivotCount,
    row.vtrace.chars,
    row.vtrace.estTokens,
    formatNumber(row.reductions["full-file"] ?? null),
    formatNumber(row.reductions.snippet ?? null),
    formatNumber(row.reductions["capped-full-file"] ?? null),
    row.vtrace.selectedIntent,
    row.vtrace.routingProfile,
    row.vtrace.capsuleProfile,
    row.vtrace.topResult,
    row.vtrace.topFile,
    row.quality.qualityLabel,
    row.quality.expectedPaths.join(";"),
    row.quality.expectedSymbols.join(";"),
    row.quality.matchedExpectedPath,
    row.quality.matchedExpectedSymbol,
    row.vtrace.contaminatedPaths.join(";"),
    row.vtrace.contaminationDetected,
    row.baseline.files.join(";"),
    row.expectedAreaHits.join(";"),
    row.notes.join("; "),
  ].map(csvEscape).join(",");
}

export function summarizeRows(rows: readonly BenchmarkRow[]) {
  const reductions = rows
    .map((row) => row.reductionPct)
    .filter((value): value is number => value !== null);
  const categories = [...new Set(rows.map((row) => row.category))].sort();
  const baselineSummaries = summarizeBaselineModes(rows);
  const qualityCounts = summarizeQualityLabels(rows);
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
    baselineSummaries,
    qualityCounts,
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
        mean_full_file_reduction_pct: meanReductionForMode(categoryRows, "full-file"),
        mean_snippet_reduction_pct: meanReductionForMode(categoryRows, "snippet"),
        mean_capped_full_file_reduction_pct: meanReductionForMode(categoryRows, "capped-full-file"),
      };
    }),
  };
}

function summarizeQualityLabels(rows: readonly BenchmarkRow[]): Record<QualityLabel, number> {
  return {
    strong: rows.filter((row) => row.quality.qualityLabel === "strong").length,
    acceptable: rows.filter((row) => row.quality.qualityLabel === "acceptable").length,
    weak: rows.filter((row) => row.quality.qualityLabel === "weak").length,
    missing: rows.filter((row) => row.quality.qualityLabel === "missing").length,
    unchecked: rows.filter((row) => row.quality.qualityLabel === "unchecked").length,
  };
}

function meanReductionForMode(
  rows: readonly BenchmarkRow[],
  mode: BaselineMode,
): number | null {
  const reductions = rows
    .map((row) => row.reductions[mode])
    .filter((value): value is number => value !== null && value !== undefined);

  return mean(reductions);
}

function summarizeBaselineModes(rows: readonly BenchmarkRow[]) {
  return BASELINE_MODES
    .filter((mode) => rows.some((row) => row.baselines[mode] !== undefined))
    .map((mode) => {
      const rowsWithMode = rows.filter((row) => row.baselines[mode] !== undefined);
      const reductions = rowsWithMode
        .map((row) => row.reductions[mode])
        .filter((value): value is number => value !== null && value !== undefined);

      return {
        mode,
        queryCount: rowsWithMode.length,
        averageBaselineTokens: mean(rowsWithMode.map((row) => row.baselines[mode]!.estTokens)),
        averageVtraceTokens: mean(rowsWithMode.map((row) => row.vtrace.estTokens)),
        meanReductionPercent: mean(reductions),
        medianReductionPercent: median(reductions),
      };
    });
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
    baselineMode: row.baselineMode,
    baselines: row.baselines,
    reductions: row.reductions,
    vtrace: row.vtrace,
    quality: row.quality,
    quality_label: row.quality.qualityLabel,
    expected_paths: row.quality.expectedPaths,
    expected_symbols: row.quality.expectedSymbols,
    matched_expected_path: row.quality.matchedExpectedPath,
    matched_expected_symbol: row.quality.matchedExpectedSymbol,
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
  const hasAllBaselines = summary.baselineSummaries.length > 1;
  const snippetSummary = summary.baselineSummaries.find((baseline) => baseline.mode === "snippet");
  const headline = summary.benchmarkAcceptableForReductionClaim
    ? hasAllBaselines
      ? `Against the grep-snippet baseline, mean measured context reduction was ${formatNumber(snippetSummary?.meanReductionPercent ?? null)}%, median was ${formatNumber(snippetSummary?.medianReductionPercent ?? null)}%. Full-file and capped-full-file reductions are shown as secondary baselines.`
      : `Ran ${summary.totalQueries} fixed queries against ${metadata.arcRepoPath}. Mean measured reduction was ${formatNumber(summary.meanReductionPercent)}%, median was ${formatNumber(summary.medianReductionPercent)}%. vtrace used fewer estimated tokens than the selected baseline for ${summary.vtraceTokensLessThanBaselineCount}/${summary.totalQueries} queries.`
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
    ...(hasAllBaselines ? renderBaselineComparisonTable(summary.baselineSummaries) : renderSingleBaselineMetricTable(summary)),
    "",
    "## Run status",
    "",
    "| Metric | Value |",
    "| --- | ---: |",
    `| Total queries | ${summary.totalQueries} |`,
    `| vtrace returned at least one pivot/item | ${summary.vtraceReturnedContextCount} |`,
    `| baseline returned no files | ${summary.baselineReturnedNoFilesCount} |`,
    `| rows with contaminated vtrace paths | ${summary.rowsWithContaminatedVtracePaths} |`,
    `| contaminated vtrace path count | ${summary.contaminatedVtracePathCount} |`,
    `| acceptable for reduction claim | ${summary.benchmarkAcceptableForReductionClaim ? "yes" : "no"} |`,
    "",
    "## Quality labels",
    "",
    "| Label | Count |",
    "| --- | ---: |",
    `| strong | ${summary.qualityCounts.strong} |`,
    `| acceptable | ${summary.qualityCounts.acceptable} |`,
    `| weak | ${summary.qualityCounts.weak} |`,
    `| missing | ${summary.qualityCounts.missing} |`,
    `| unchecked | ${summary.qualityCounts.unchecked} |`,
    "",
    "## Interpretation",
    "",
    "The full-file baseline represents naive grep followed by opening whole files.",
    "The snippet baseline represents grep-like context inspection.",
    "The capped-full-file baseline limits very large files from dominating the measurement.",
    "",
    "## Category-level averages",
    "",
    ...(hasAllBaselines ? renderAllBaselineCategoryTable(summary.categoryAverages) : renderSingleBaselineCategoryTable(summary.categoryAverages)),
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
    "- Source-backed pivot count `unknown` means the current parsed output did not expose source-backed status for those items; it is not equivalent to zero source-backed pivots.",
    "- The benchmark records measured context sizes only and does not claim task-solving performance.",
    "",
    "## Suggested next measurement step",
    "",
    "Run the same fixed query set twice on the same indexed ARC repo state, diff the CSV/JSON excluding timestamp metadata, and classify misses before changing retrieval or capsule behavior.",
    "",
  ].join("\n");
}

function renderSingleBaselineMetricTable(summary: ReturnType<typeof summarizeRows>): string[] {
  return [
    "| Metric | Value |",
    "| --- | ---: |",
    `| Average baseline estimated tokens | ${formatNumber(summary.averageBaselineTokens)} |`,
    `| Average vtrace estimated tokens | ${formatNumber(summary.averageVtraceTokens)} |`,
    `| Mean reduction percent | ${formatNumber(summary.meanReductionPercent)} |`,
    `| Median reduction percent | ${formatNumber(summary.medianReductionPercent)} |`,
    `| vtrace tokens < baseline tokens | ${summary.vtraceTokensLessThanBaselineCount} |`,
  ];
}

function renderBaselineComparisonTable(
  baselineSummaries: ReturnType<typeof summarizeRows>["baselineSummaries"],
): string[] {
  return [
    "| Baseline mode | Avg baseline tokens | Avg vtrace tokens | Mean reduction | Median reduction |",
    "| --- | ---: | ---: | ---: | ---: |",
    ...baselineSummaries.map((summary) => (
      `| ${formatBaselineMode(summary.mode)} | ${formatNumber(summary.averageBaselineTokens)} | ${formatNumber(summary.averageVtraceTokens)} | ${formatNumber(summary.meanReductionPercent)} | ${formatNumber(summary.medianReductionPercent)} |`
    )),
  ];
}

function renderSingleBaselineCategoryTable(
  categoryAverages: ReturnType<typeof summarizeRows>["categoryAverages"],
): string[] {
  return [
    "| Category | Queries | Avg baseline tokens | Avg vtrace tokens | Mean reduction % | Median reduction % |",
    "| --- | ---: | ---: | ---: | ---: | ---: |",
    ...categoryAverages.map((category) => (
      `| ${category.category} | ${category.queryCount} | ${formatNumber(category.averageBaselineTokens)} | ${formatNumber(category.averageVtraceTokens)} | ${formatNumber(category.meanReductionPercent)} | ${formatNumber(category.medianReductionPercent)} |`
    )),
  ];
}

function renderAllBaselineCategoryTable(
  categoryAverages: ReturnType<typeof summarizeRows>["categoryAverages"],
): string[] {
  return [
    "| Category | Queries | Avg vtrace tokens | mean_full_file_reduction_pct | mean_snippet_reduction_pct | mean_capped_full_file_reduction_pct |",
    "| --- | ---: | ---: | ---: | ---: | ---: |",
    ...categoryAverages.map((category) => (
      `| ${category.category} | ${category.queryCount} | ${formatNumber(category.averageVtraceTokens)} | ${formatNumber(category.mean_full_file_reduction_pct)} | ${formatNumber(category.mean_snippet_reduction_pct)} | ${formatNumber(category.mean_capped_full_file_reduction_pct)} |`
    )),
  ];
}

export function renderRowsTable(rows: readonly BenchmarkRow[]): string {
  if (rows.length === 0) {
    return "None.";
  }

  return [
    "| Query | Category | Quality | Baseline tokens | vtrace tokens | Reduction % | Items | Source-backed pivots | Contaminated | Top vtrace file | Notes |",
    "| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | --- | --- | --- |",
    ...rows.map((row) => (
      `| ${escapeMarkdown(row.query)} | ${escapeMarkdown(row.category)} | ${row.quality.qualityLabel} | ${row.baseline.estTokens} | ${row.vtrace.estTokens} | ${formatNumber(row.reductionPct)} | ${row.vtrace.itemCount} | ${formatSourceBackedPivotCount(row.vtrace.sourceBackedPivotCount)} | ${row.vtrace.contaminationDetected ? "yes" : "no"} | ${escapeMarkdown(row.vtrace.topFile ?? "")} | ${escapeMarkdown(row.notes.join("; "))} |`
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

function makeVtraceItemRefs(items: readonly Record<string, unknown>[]): VtraceItemRef[] {
  return items.map((item) => ({
    name: stringOrNull(item.fqName ?? item.localName ?? item.symbolId),
    filePath: stringOrNull(item.filePath),
  }));
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

function normalizePath(value: string): string {
  return value.replaceAll("\\", "/").replace(/^\.\//, "");
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

function formatBaselineMode(mode: BaselineMode): string {
  switch (mode) {
    case "full-file":
      return "full-file";
    case "snippet":
      return "snippet";
    case "capped-full-file":
      return "capped-full-file";
  }
}

function selectPrimaryBaseline(
  baselines: BaselineResultsByMode,
  baselineMode: BaselineMode | "all",
): BaselineResult {
  const selectedMode = baselineMode === "all" ? "full-file" : baselineMode;
  const baseline = baselines[selectedMode];

  if (baseline === undefined) {
    throw new Error(`Missing baseline result for ${selectedMode}.`);
  }

  return baseline;
}

function calculateReductions(
  baselines: BaselineResultsByMode,
  vtraceEstTokens: number,
): ReductionResultsByMode {
  const reductions: ReductionResultsByMode = {};

  for (const mode of BASELINE_MODES) {
    const baseline = baselines[mode];

    if (baseline !== undefined) {
      reductions[mode] = calculateReductionPct(baseline.estTokens, vtraceEstTokens);
    }
  }

  return reductions;
}

function collectBaselineNotes(baselines: BaselineResultsByMode): string[] {
  const notes: string[] = [];
  const seen = new Set<string>();

  for (const mode of BASELINE_MODES) {
    for (const note of baselines[mode]?.notes ?? []) {
      if (seen.has(note)) {
        continue;
      }

      seen.add(note);
      notes.push(note);
    }
  }

  return notes;
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
      case "--queries":
        config.queries = requireValue(argv, ++index, arg);
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
      case "--baseline-mode": {
        const value = requireValue(argv, ++index, arg);
        if (!isBaselineModeOrAll(value)) {
          throw new Error("--baseline-mode must be full-file, snippet, capped-full-file, or all.");
        }
        config.baselineMode = value;
        break;
      }
      case "--snippet-context-lines":
        config.snippetContextLines = parseNonNegativeInt(requireValue(argv, ++index, arg), arg);
        break;
      case "--max-snippets-per-file":
        config.maxSnippetsPerFile = parsePositiveInt(requireValue(argv, ++index, arg), arg);
        break;
      case "--baseline-max-chars-per-file":
        config.baselineMaxCharsPerFile = parsePositiveInt(requireValue(argv, ++index, arg), arg);
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
    expected: path.resolve(config.expected),
    out: path.resolve(config.out),
  };
}

function isBaselineModeOrAll(value: string): value is BaselineMode | "all" {
  return value === "all" || BASELINE_MODES.includes(value as BaselineMode);
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
    "  bun benchmarks/arc_stage1_context_reduction/run_arc_stage1_context_reduction.ts --repo /home/calvin/code/ARC --queries benchmarks/arc_stage1_context_reduction/queries.arc.stage1.json --expected benchmarks/arc_stage1_context_reduction/expected.arc.stage1.json --out benchmarks/arc_stage1_context_reduction/results --baseline-max-files 5 [--baseline-mode full-file|snippet|capped-full-file|all]",
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
