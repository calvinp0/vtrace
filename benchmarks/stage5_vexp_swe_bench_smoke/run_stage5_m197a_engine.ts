/**
 * M197A — Track-A engine measurements: A1 language coverage, A5-A7 latency,
 * A9-A10 skeletonisation, A11-A13 budget and representation, A14 token
 * accounting, A15 call-site rendering, plus the §29 determinism replay and the
 * §30 truthfulness audit.
 *
 * Everything is measured through the DEFAULT model-facing product path — the MCP
 * server's own request handler at its default options — never through an
 * internal function or a debug detail level. That distinction is the whole point
 * of A12/A14/A15: a capability the model cannot see does not satisfy a claim
 * about what the model is given (control F6).
 *
 * No product behaviour is changed. Where a capability is absent, the measurement
 * records its absence; it does not construct the capability in the benchmark and
 * then score it.
 *
 *   bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m197a_engine.ts \
 *     [--repeats 5] [--scratch <dir>]
 */
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { Language } from "../../src/domain/types";
import { createDefaultParserRegistry } from "../../src/indexer/indexProject";
import { detectLanguage, isAdvertisedIndexableLanguage } from "../../src/fs/languageDetection";
import { createMcpServer } from "../../src/mcp/server";
import { McpToolId, MCP_SERVER_SCHEMA } from "../../src/mcp/types";
import { defaultMcpToolRegistry } from "../../src/mcp/tools";
import {
  A13_TASKS, A5_QUERIES, corpusSpecs, deriveCallSiteEdges, deriveFlowPairs,
  deriveImpactTargets, latencyStats, median, prepareCorpus, tokens,
} from "./m197aFixtures";
import {
  callSiteIsRendered, countsTowardReduction, determinismVerdict, isStructuralDeclaration,
  renderSkeleton, semanticProjection, skeletonValidity,
} from "./m197aScoring";

const REPO = path.resolve(import.meta.dir, "../..");
const RESULTS = path.join(import.meta.dir, "results");
const args = process.argv.slice(2);
const argOf = (flag: string, fallback: string) => {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1]! : fallback;
};
const REPEATS = Number.parseInt(argOf("--repeats", "5"), 10);
const SCRATCH = argOf("--scratch", path.join(process.env.TMPDIR ?? "/tmp", "m197a"));
const A11_BUDGETS = [1000, 2000, 4000, 8000, 16000] as const;
mkdirSync(SCRATCH, { recursive: true });

const loadAverage = () => {
  try { return readFileSync("/proc/loadavg", "utf8").split(" ").slice(0, 3).map(Number); }
  catch { return []; }
};
const sha = (text: string) => createHash("sha256").update(text).digest("hex");

type Server = ReturnType<typeof createMcpServer>;
const call = async (server: Server, toolId: string, input: unknown, id = "m197a"): Promise<any> => {
  const res: any = await server.handleRequest(
    { schema: MCP_SERVER_SCHEMA, requestId: id, toolId, input } as any);
  return res?.result?.ok === false ? { __error: res.result.error } : res?.result?.output;
};

// =========================================================== A1 language coverage
/**
 * A1 counts PARSER-BACKED language families, not enum members (control F7). The
 * four populations are reported separately so the gap between what the type
 * system declares and what can actually be indexed is visible rather than
 * averaged away.
 */
function measureA1() {
  const declaredEnum = Object.values(Language);
  const probeExtensions = [
    ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".pyi", ".pyx", ".pxd", ".pxi",
    ".yml", ".yaml", ".toml", ".go", ".rs", ".java", ".kt", ".rb", ".php", ".c", ".h",
    ".cpp", ".hpp", ".cs", ".swift", ".scala", ".sh", ".sql", ".md", ".json", ".html",
    ".css", ".vue", ".svelte", ".ex", ".erl", ".hs", ".lua", ".pl", ".r", ".m", ".dart",
  ];
  const detected = new Map<string, string[]>();
  for (const ext of probeExtensions) {
    const lang = detectLanguage(`probe${ext}`);
    if (lang === undefined) continue;
    detected.set(lang, [...(detected.get(lang) ?? []), ext]);
  }
  // The registry the indexer actually builds. An empty knownFiles list is fine:
  // registration is what is under test, not resolution.
  const registered = createDefaultParserRegistry([]).registeredLanguages();
  const advertised = declaredEnum.filter((l) => isAdvertisedIndexableLanguage(l));

  return {
    declaredEnumMembers: declaredEnum.length,
    declaredEnum,
    extensionDetectedFamilies: detected.size,
    extensionDetection: Object.fromEntries(detected),
    advertisedIndexableFamilies: advertised.length,
    advertisedIndexable: advertised,
    parserBackedFamilies: registered.length,
    parserBacked: [...registered],
    // The decisive number: a family with an extension but no parser is a
    // detection rule, not language support.
    detectedWithoutParser: [...detected.keys()].filter((l) => !registered.includes(l as Language)),
  };
}

// ================================================================== main sweep
const specs = corpusSpecs(REPO);
const startLoad = loadAverage();
console.log(`load average at start: ${startLoad.join(" ")} (${navigator.hardwareConcurrency} cpus)`);

const perCorpus: any[] = [];

for (const spec of specs) {
  const work = prepareCorpus(spec, SCRATCH);
  if (work === null) { perCorpus.push({ id: spec.id, status: "CORPUS_ABSENT" }); continue; }

  const dbPath = path.join(work, ".vtrace/index.sqlite");
  const server = createMcpServer({ context: { repoRoot: work, dbPath } } as any);

  // A ready index is a precondition for every model-facing call. Built through
  // the product's own index_repo tool so the manifest and readiness state are
  // the ones the product would have in the field.
  const indexed = await call(server, McpToolId.IndexRepo, { repo_root: work }, "idx");
  const ready = indexed?.readiness?.status === "ready";
  if (!ready) { perCorpus.push({ id: spec.id, status: "INDEX_NOT_READY", indexed }); continue; }

  const db = new Database(dbPath, { readonly: true });
  const sourceLines = new Map<string, string[]>();
  const linesOf = (rel: string): string[] => {
    if (!sourceLines.has(rel)) {
      try { sourceLines.set(rel, readFileSync(path.join(work, rel), "utf8").split("\n")); }
      catch { sourceLines.set(rel, []); }
    }
    return sourceLines.get(rel)!;
  };

  // ------------------------------------------------------------------ A5 latency
  const queries = A5_QUERIES[spec.id] ?? [];
  const a5: number[] = [];
  const a5Hashes = new Map<string, Set<string>>();
  for (const task of queries) {
    // One warm-up so the measurement is warm by the frozen definition (§2).
    await call(server, McpToolId.GetCodeContext, { task, repo_root: work });
    for (let i = 0; i < REPEATS; i += 1) {
      const t0 = performance.now();
      const out = await call(server, McpToolId.GetCodeContext, { task, repo_root: work });
      a5.push(performance.now() - t0);
      const set = a5Hashes.get(task) ?? new Set<string>();
      set.add(sha(JSON.stringify(semanticProjection(out))));
      a5Hashes.set(task, set);
    }
  }
  const a5Determinism = determinismVerdict(a5Hashes);

  // ------------------------------------------------------------ A6 impact latency
  const impactTargets = deriveImpactTargets(db, 10);
  const a6: number[] = [];
  const a6Hashes = new Map<string, Set<string>>();
  for (const fqn of impactTargets) {
    await call(server, McpToolId.GetImpactGraph, { repo_root: work, symbol_fqn: fqn, depth: 3 });
    for (let i = 0; i < REPEATS; i += 1) {
      const t0 = performance.now();
      const out = await call(server, McpToolId.GetImpactGraph, { repo_root: work, symbol_fqn: fqn, depth: 3 });
      a6.push(performance.now() - t0);
      const set = a6Hashes.get(fqn) ?? new Set<string>();
      // Latency varies by §29; semantic content may not.
      set.add(sha(JSON.stringify(semanticProjection(out))));
      a6Hashes.set(fqn, set);
    }
  }
  const a6Determinism = determinismVerdict(a6Hashes);

  // -------------------------------------------------------------- A7 flow latency
  const flowPairs = deriveFlowPairs(db, 10);
  const a7: number[] = [];
  const a7PathLengths: number[] = [];
  const a7Hashes = new Map<string, Set<string>>();
  for (const pair of flowPairs) {
    const key = `${pair.start}->${pair.end}`;
    await call(server, McpToolId.SearchLogicFlow, { repo_root: work, start: pair.start, end: pair.end });
    for (let i = 0; i < REPEATS; i += 1) {
      const t0 = performance.now();
      const out = await call(server, McpToolId.SearchLogicFlow,
        { repo_root: work, start: pair.start, end: pair.end });
      a7.push(performance.now() - t0);
      if (i === 0) {
        for (const p of out?.paths ?? []) a7PathLengths.push(p.edgeCount);
      }
      const set = a7Hashes.get(key) ?? new Set<string>();
      set.add(sha(JSON.stringify(semanticProjection(out))));
      a7Hashes.set(key, set);
    }
  }
  const a7Determinism = determinismVerdict(a7Hashes);

  // ---------------------------------------------------------- A9 / A10 skeleton
  const files = (db.query("select path from files order by path").all() as { path: string }[])
    .map((r) => r.path)
    .filter((p) => spec.exts.some((e) => p.endsWith(e)));
  const reductionRendered: number[] = [];
  const reductionWholeResponse: number[] = [];
  let declarations = 0; let withSignature = 0; let withNonEmptySignature = 0;
  let members = 0; let membersWithSignature = 0;
  let namesFoundInSource = 0; let namesChecked = 0;
  const structuralFaults: Record<string, number> = {};
  let filesMeasured = 0; let filesMalformed = 0;
  const stratified: Record<string, number[]> = { small: [], medium: [], large: [] };

  for (const rel of files) {
    let raw = "";
    try { raw = readFileSync(path.join(work, rel), "utf8"); } catch { continue; }
    if (raw.length < 2000) continue;   // M196's floor: tiny files make the ratio noise
    const out = await call(server, McpToolId.GetSkeleton, { repo_root: work, files: [rel] });
    const file = out?.files?.[0];
    if (!file || file.status !== "ok") continue;

    const validity = skeletonValidity(file, raw);
    for (const f of validity.faults) structuralFaults[f] = (structuralFaults[f] ?? 0) + 1;

    // A10 counts every declaration on every file, malformed or not: preservation
    // is a property of the whole representation, and dropping the bad files
    // first would measure only the ones that already worked.
    declarations += validity.declarations;
    withSignature += validity.validSignatures;
    withNonEmptySignature += (file.declarations ?? [])
      .filter((d: any) => !isStructuralDeclaration(d)
        && typeof d.signature === "string" && d.signature.length > 0).length;
    for (const d of file.declarations ?? []) {
      if (isStructuralDeclaration(d)) continue;
      namesChecked += 1;
      if (raw.includes(d.name)) namesFoundInSource += 1;
      for (const m of d.members ?? []) {
        members += 1;
        if (typeof m.signature === "string" && m.signature.length > 0) membersWithSignature += 1;
      }
    }

    // F4: a file whose skeleton is malformed is excluded from A9's reduction
    // population rather than counted as a very small — and therefore very
    // impressive — output. Rewarding a truncation for being short is the exact
    // failure this control exists to prevent.
    if (!countsTowardReduction(validity)) { filesMalformed += 1; continue; }

    filesMeasured += 1;
    const rendered = renderSkeleton(file);
    const rawTokens = tokens(raw);
    reductionRendered.push(100 * (1 - tokens(rendered) / rawTokens));
    reductionWholeResponse.push(100 * (1 - tokens(JSON.stringify(out)) / rawTokens));
    const bucket = raw.length < 8000 ? "small" : raw.length < 30000 ? "medium" : "large";
    stratified[bucket]!.push(100 * (1 - tokens(rendered) / rawTokens));
  }

  // A10's member-retention denominator comes from the INDEX, which is the only
  // enumeration of what a skeleton could have carried. Stated explicitly because
  // it makes A10 a representation-fidelity measure, not an extraction-recall one.
  const indexedMethods = (db.query(
    "select count(*) c from symbols where parent_symbol_id is not null and kind='method'").get() as any).c;

  // -------------------------------------------- A11 / A12 / A13 budget behaviour
  const budgetTasks = spec.id === "C-MED" ? A13_TASKS : A13_TASKS.slice(0, 3);
  const curves: any[] = [];
  for (const task of budgetTasks) {
    const points: any[] = [];
    for (const budget of A11_BUDGETS) {
      const t0 = performance.now();
      const out = await call(server, McpToolId.GetCodeContext,
        { task, repo_root: work, max_tokens: budget });
      const whole = tokens(JSON.stringify(out ?? {}));
      const related = out?.related ?? [];
      // Representation classes present in the DEFAULT response (A12). A header is
      // not a representation class; carrying source, or carrying only a relation,
      // is. `form` is the product's own name for what it delivered.
      const classes = new Set<string>();
      if (out?.focus?.code) classes.add(`FOCUS:${out.focus.form ?? "unknown"}`);
      for (const r of related) classes.add(typeof r.code === "string" ? "RELATED_WITH_CODE" : "RELATIONSHIP_ONLY");
      points.push({
        budget,
        latencyMs: +(performance.now() - t0).toFixed(1),
        wholeResponseTokens: whole,
        utilisationPercent: +(100 * whole / budget).toFixed(2),
        focusAt: out?.focus?.at ?? null,
        focusForm: out?.focus?.form ?? null,
        focusCodeTokens: tokens(out?.focus?.code ?? ""),
        relatedCount: related.length,
        relatedCarryingCode: related.filter((r: any) => typeof r.code === "string").length,
        representationClasses: [...classes],
        // A14: per-item accounting in the DEFAULT response, if any item carries it.
        itemsWithTokenAccounting: [out?.focus, ...related].filter((it: any) =>
          it && (it.tokens !== undefined || it.tokenReductionPercent !== undefined
            || it.rawTokens !== undefined || it.savedTokens !== undefined)).length,
      });
    }
    // A13: information must not decrease as the budget grows. A focus swap is a
    // separate violation from a size regression, because swapping the delivered
    // symbol is a loss the token count alone cannot show.
    let sizeViolations = 0; let focusSwaps = 0;
    for (let i = 1; i < points.length; i += 1) {
      if (points[i]!.focusCodeTokens < points[i - 1]!.focusCodeTokens) sizeViolations += 1;
      if (points[i]!.focusAt !== points[i - 1]!.focusAt) focusSwaps += 1;
    }
    curves.push({ task, points, sizeViolations, focusSwaps });
  }

  /**
   * Control F6, measured rather than assumed: is per-item token accounting and
   * per-item representation richness present in the DEFAULT response, or only
   * behind `detail: "debug"`? M166 moved diagnostics behind the debug lever, so
   * a field found only there satisfies no claim about what the model is given.
   */
  const defaultProbe = await call(server, McpToolId.GetCodeContext,
    { task: A13_TASKS[0], repo_root: work });
  const debugProbe = await call(server, McpToolId.GetCodeContext,
    { task: A13_TASKS[0], repo_root: work, detail: "debug" });
  const hasAccounting = (o: any) => JSON.stringify(o ?? {}).includes("\"accounting\"");
  const hasReduction = (o: any) => /reductionPercent|token_reduction|savedTokens/.test(JSON.stringify(o ?? {}));
  const defaultVsDebug = {
    accountingInDefaultResponse: hasAccounting(defaultProbe),
    accountingInDebugResponse: hasAccounting(debugProbe),
    reductionFieldInDefaultResponse: hasReduction(defaultProbe),
    reductionFieldInDebugResponse: hasReduction(debugProbe),
    defaultResponseTopLevelKeys: Object.keys(defaultProbe ?? {}),
    debugResponseTopLevelKeys: Object.keys(debugProbe ?? {}),
    defaultResponseTokens: tokens(JSON.stringify(defaultProbe ?? {})),
    debugResponseTokens: tokens(JSON.stringify(debugProbe ?? {})),
  };

  /**
   * The other token authority: `get_skeleton` publishes a per-CALL accounting
   * block. A14 asks for per-ITEM accounting, so this is recorded to show what
   * does exist and at what granularity — and to reconfirm, not reconcile, that
   * two authorities disagree (§25 forbids reconciling them here).
   */
  const skeletonSample = files[0];
  const skeletonAccounting = skeletonSample === undefined ? null : await (async () => {
    const o = await call(server, McpToolId.GetSkeleton, { repo_root: work, files: [skeletonSample] });
    const acct = o?.accounting ?? null;
    let independentReduction: number | null = null;
    try {
      const raw = readFileSync(path.join(work, skeletonSample), "utf8");
      independentReduction = +(100 * (1 - tokens(renderSkeleton(o?.files?.[0])) / tokens(raw))).toFixed(2);
    } catch { /* file unreadable; leave null */ }
    return {
      file: skeletonSample,
      perCallAccounting: acct,
      perItemAccounting: (o?.files?.[0]?.declarations ?? [])
        .filter((d: any) => d.tokens !== undefined || d.tokenReductionPercent !== undefined).length,
      declarations: (o?.files?.[0]?.declarations ?? []).length,
      productReportedSavingsPercent: acct?.estimatedSavingsPercentVsNaiveFullFile ?? null,
      independentRenderedReductionPercent: independentReduction,
      authoritiesDisagreeByPoints: acct?.estimatedSavingsPercentVsNaiveFullFile !== undefined
        && independentReduction !== null
        ? +(independentReduction - acct.estimatedSavingsPercentVsNaiveFullFile).toFixed(2) : null,
    };
  })();

  // -------------------------------------------------- A15 + §30 truthfulness
  const callEdges = deriveCallSiteEdges(db, 50);
  let eligible = 0;
  let impactRendersExpression = 0;
  let flowRendersExpression = 0;
  let flowTextNamesCallee = 0;
  let flowTextMatchesDeclaredSpan = 0;
  let declaredSpanNamesCallee = 0;
  const renderExamples: any[] = [];

  for (const pair of callEdges) {
    const flow = await call(server, McpToolId.SearchLogicFlow,
      { repo_root: work, start: pair.start, end: pair.end });
    const step = flow?.paths?.[0]?.steps?.[0];
    const ev = step?.relation?.evidence;
    const site = ev?.callSites?.[0];
    const srcPath = step?.relation?.source?.path;
    if (!ev || !site || !srcPath) continue;
    eligible += 1;

    const lines = linesOf(srcPath);
    const spanText = lines.slice(site.startLine - 1, site.endLine).join("\n");
    const callee: string = ev.referenceName ?? "";
    if (callee && spanText.includes(callee)) declaredSpanNamesCallee += 1;

    if (typeof ev.sourceText === "string" && ev.sourceText.trim().length > 0) {
      flowRendersExpression += 1;
      if (callSiteIsRendered(ev)) flowTextNamesCallee += 1;
      if (ev.sourceText.trim() === spanText.trim()) flowTextMatchesDeclaredSpan += 1;
      else if (renderExamples.length < 5) {
        renderExamples.push({ from: pair.start, to: pair.end, callee,
          declaredSpan: `${srcPath}:${site.startLine}-${site.endLine}`,
          rendered: ev.sourceText.slice(0, 140), actualAtDeclaredSpan: spanText.slice(0, 140) });
      }
    }

    // The impact surface, which is where a caller list is actually consumed.
    const impact = await call(server, McpToolId.GetImpactGraph,
      { repo_root: work, symbol_fqn: pair.end, depth: 3 });
    const relation = (impact?.directRelations ?? []).find((r: any) => r.source?.symbol === pair.start);
    if (relation && callSiteIsRendered(relation.evidence ?? {})) impactRendersExpression += 1;
  }

  // Excerpt anchoring: does an excerpt's declared startLine agree with where its
  // text actually begins? This is what `sourceText` indexes into, so a mismatch
  // here is the mechanism behind a misrendered call line.
  let excerptChecked = 0; let excerptAnchored = 0;
  const excerptDeltas: Record<string, number> = {};
  for (const pair of callEdges.slice(0, 30)) {
    const flow = await call(server, McpToolId.SearchLogicFlow,
      { repo_root: work, start: pair.start, end: pair.end });
    const ex = flow?.paths?.[0]?.steps?.[0]?.sourceExcerpt;
    if (!ex?.text) continue;
    excerptChecked += 1;
    const lines = linesOf(ex.filePath);
    const first = ex.text.split("\n")[0]!;
    if (lines[ex.startLine - 1] === first) { excerptAnchored += 1; excerptDeltas["0"] = (excerptDeltas["0"] ?? 0) + 1; continue; }
    let found: number | null = null;
    for (let d = 1; d <= 12 && found === null; d += 1) {
      for (const cand of [ex.startLine + d, ex.startLine - d]) {
        if (cand >= 1 && cand <= lines.length && lines[cand - 1] === first) { found = cand; break; }
      }
    }
    const key = found === null ? "not_located" : String(found - ex.startLine);
    excerptDeltas[key] = (excerptDeltas[key] ?? 0) + 1;
  }
  // An excerpt whose first line cannot be located anywhere nearby is
  // INCONCLUSIVE, not misanchored: a blank or truncated first line defeats the
  // locator, and counting those as defects would inflate the finding.
  const excerptNotLocated = excerptDeltas["not_located"] ?? 0;
  const excerptMisanchored = excerptChecked - excerptAnchored - excerptNotLocated;
  const excerptConclusive = excerptAnchored + excerptMisanchored;

  db.close();

  perCorpus.push({
    id: spec.id, language: spec.language, filesIndexed: files.length,
    a5: { queries: queries.length, repeats: REPEATS, latency: latencyStats(a5),
      deterministic: a5Determinism.deterministic, nonDeterministicQueries: a5Determinism.unstableQueries },
    a6: { targets: impactTargets.length, repeats: REPEATS, latency: latencyStats(a6),
      deterministic: a6Determinism.deterministic, nonDeterministicQueries: a6Determinism.unstableQueries, targetsSample: impactTargets.slice(0, 5) },
    a7: { pairs: flowPairs.length, repeats: REPEATS, latency: latencyStats(a7),
      deterministic: a7Determinism.deterministic, nonDeterministicQueries: a7Determinism.unstableQueries,
      pathEdgeCounts: { n: a7PathLengths.length, median: median(a7PathLengths),
        distribution: a7PathLengths.reduce((acc: Record<string, number>, l) => {
          acc[String(l)] = (acc[String(l)] ?? 0) + 1; return acc; }, {}) } },
    a9: { filesMeasured, filesMalformed,
      filesConsidered: filesMeasured + filesMalformed,
      malformedPercent: (filesMeasured + filesMalformed) > 0
        ? +(100 * filesMalformed / (filesMeasured + filesMalformed)).toFixed(2) : null,
      renderedReduction: { median: +median(reductionRendered).toFixed(2),
        min: reductionRendered.length ? +Math.min(...reductionRendered).toFixed(2) : null,
        max: reductionRendered.length ? +Math.max(...reductionRendered).toFixed(2) : null },
      wholeResponseReduction: { median: +median(reductionWholeResponse).toFixed(2),
        min: reductionWholeResponse.length ? +Math.min(...reductionWholeResponse).toFixed(2) : null },
      stratifiedMedian: Object.fromEntries(Object.entries(stratified)
        .map(([k, v]) => [k, { n: v.length, median: v.length ? +median(v).toFixed(2) : null }])),
      structuralFaults },
    a10: { declarations, validSignatures: withSignature, withNonEmptySignature,
      // M196's prior asked only whether a signature FIELD was populated. §21
      // requires source truth, so both are published: the gap between them is
      // the malformation rate, not a change of threshold.
      signaturePresencePercent: declarations
        ? +(100 * withNonEmptySignature / declarations).toFixed(2) : null,
      signatureRetentionPercent: declarations ? +(100 * withSignature / declarations).toFixed(2) : null,
      signatureRetentionBasis: "declarations whose emitted signature is a verbatim, token-aligned, bracket-closed slice of the source",
      members, membersWithSignature, indexedMethods,
      memberRetentionPercent: indexedMethods ? +(100 * members / indexedMethods).toFixed(2) : null,
      declarationNamesFoundInSource: namesFoundInSource, declarationNamesChecked: namesChecked,
      nameSourceTruthPercent: namesChecked ? +(100 * namesFoundInSource / namesChecked).toFixed(2) : null },
    a11a13: { budgets: A11_BUDGETS, tasks: budgetTasks.length, curves,
      utilisationByBudget: Object.fromEntries(A11_BUDGETS.map((b) => [b, {
        median: +median(curves.flatMap((c) => c.points.filter((p: any) => p.budget === b)
          .map((p: any) => p.utilisationPercent))).toFixed(2) }])),
      tasksWithSizeViolation: curves.filter((c) => c.sizeViolations > 0).length,
      tasksWithFocusSwap: curves.filter((c) => c.focusSwaps > 0).length },
    a12: { distinctClassesObserved: [...new Set(curves.flatMap((c) =>
      c.points.flatMap((p: any) => p.representationClasses)))] },
    a14: { defaultVsDebug, skeletonAccounting, itemsWithPerItemAccounting: curves.reduce((n, c) =>
      n + c.points.reduce((m: number, p: any) => m + p.itemsWithTokenAccounting, 0), 0),
      itemsDelivered: curves.reduce((n, c) =>
        n + c.points.reduce((m: number, p: any) => m + 1 + p.relatedCount, 0), 0) },
    a15: { eligibleCallSites: eligible,
      impactSurfaceRenderingExpression: impactRendersExpression,
      flowSurfaceRenderingExpression: flowRendersExpression,
      flowRenderedTextNamesCallee: flowTextNamesCallee,
      flowRenderedTextMatchesDeclaredSpan: flowTextMatchesDeclaredSpan,
      declaredSpanActuallyNamesCallee: declaredSpanNamesCallee,
      impactRenderPercent: eligible ? +(100 * impactRendersExpression / eligible).toFixed(2) : null,
      flowCorrectRenderPercent: eligible ? +(100 * flowTextNamesCallee / eligible).toFixed(2) : null,
      misrenderedExamples: renderExamples },
    truthfulness: {
      excerptChecked, excerptAnchored, excerptMisanchored, excerptNotLocated,
      excerptAnchorPercentOfConclusive: excerptConclusive
        ? +(100 * excerptAnchored / excerptConclusive).toFixed(2) : null,
      excerptStartLineDeltas: excerptDeltas,
      // §30: a call-site rendering that does not name the callee it is offered
      // as evidence for is a STRENGTHENED structural claim — the relationship is
      // real, the source shown for it is not. Target 0.
      strengthenedCallSiteRenderings: flowRendersExpression - flowTextNamesCallee,
      renderedCallSites: flowRendersExpression,
      // Truth of the underlying data, as opposed to its rendering.
      inventedStructuralClaims: eligible - declaredSpanNamesCallee,
    },
  });

  const c = perCorpus.at(-1)!;
  console.log(`${spec.id.padEnd(8)} A5 p90 ${c.a5.latency.p90}ms | A6 p90 ${c.a6.latency.p90}ms `
    + `| A7 p90 ${c.a7.latency.p90}ms | A9 ${c.a9.renderedReduction.median}% (${c.a9.filesMeasured} files, `
    + `${c.a9.filesMalformed} malformed) | A15 flow ${c.a15.flowCorrectRenderPercent}% impact ${c.a15.impactRenderPercent}%`);
}

const out = {
  milestone: "M197A",
  instrument: "run_stage5_m197a_engine.ts",
  claims: ["A1", "A5", "A6", "A7", "A9", "A10", "A11", "A12", "A13", "A14", "A15"],
  repeats: REPEATS,
  tokenAuthority: "ceil(characters / 4), applied identically to both sides of every ratio (§2)",
  hardware: { cpus: navigator.hardwareConcurrency, loadAverageAtStart: startLoad,
    loadAverageAtEnd: loadAverage(), scratch: SCRATCH },
  // Reconfirmed from the same authority M196A used, not transcribed (§36, §40).
  toolSchemaTokens: {
    registeredTools: defaultMcpToolRegistry.tools.length,
    modelVisibleTools: defaultMcpToolRegistry.listMetadata().length,
    estimatedTokens: defaultMcpToolRegistry.listMetadata().reduce((a, m) => a + tokens(JSON.stringify(
      { name: m.toolId, description: m.description, inputSchema: m.inputSchema })), 0),
  },
  a1: measureA1(),
  corpora: perCorpus,
};
writeFileSync(path.join(RESULTS, "stage5_m197a_engine.json"), `${JSON.stringify(out, null, 2)}\n`);
console.log(`\nwrote results/stage5_m197a_engine.json`);
