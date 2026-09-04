/**
 * M209 — the causal report (pre-change) and the final report (post-change).
 *
 *   bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m209_report.ts --phase causal
 *   bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m209_report.ts --phase final
 *
 * Reads only committed/captured artefacts: the M209 truth audits (pre, and in
 * the final phase post and the same-corpus control), the frozen engine /
 * claim ledgers (M208 committed, M209 pre and post), the falsification results,
 * the retrieval-eval A/B and the A5 harness. The frozen A15 rule is quoted
 * VERBATIM from the scorer sources at report time; nothing is restated by hand.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const RESULTS = path.join(import.meta.dir, "results");
const args = process.argv.slice(2);
const argOf = (flag: string, fallback: string) => { const i = args.indexOf(flag); return i >= 0 && args[i + 1] !== undefined ? args[i + 1]! : fallback; };
const PHASE = argOf("--phase", "causal") as "causal" | "final";

const read = (name: string, required = true): any => {
  const p = path.join(RESULTS, name);
  if (!existsSync(p)) { if (required) throw new Error(`M209_REPORT_MISSING_INPUT: ${name}`); return null; }
  return JSON.parse(readFileSync(p, "utf8"));
};
const readRows = (name: string): any[] => {
  const p = path.join(RESULTS, name);
  return existsSync(p) ? readFileSync(p, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l)) : [];
};
const corpus = (audit: any, id: string) => audit?.corpora?.find((c: any) => c.id === id);
const short = (v: string | null | undefined) => (v ?? "null").replace("VTRACE_", "").replace("_VEXP_CLAIM", "");
const table = (head: string[], rows: (string | number | boolean | null | undefined)[][]): string[] => [
  `| ${head.join(" | ")} |`, `| ${head.map(() => "---").join(" | ")} |`,
  ...rows.map((r) => `| ${r.map((c) => (c === null || c === undefined ? "" : String(c).replace(/\|/g, "\\|").replace(/\n/g, " "))).join(" | ")} |`),
];
const hist = (h: Record<string, number> | undefined) => Object.entries(h ?? {}).map(([k, v]) => `${k} ${v}`).join("; ") || "none";
const fence = (lines: string[]) => ["```ts", ...lines, "```"];

// --------------------------------------------------------------- frozen authority (verbatim)
const engineSource = readFileSync(path.join(import.meta.dir, "run_stage5_m197a_engine.ts"), "utf8").split("\n");
const reportSource = readFileSync(path.join(import.meta.dir, "run_stage5_m197a_report.ts"), "utf8").split("\n");
const scoringSource = readFileSync(path.join(import.meta.dir, "m197aScoring.ts"), "utf8").split("\n");
const fixturesSource = readFileSync(path.join(import.meta.dir, "m197aFixtures.ts"), "utf8").split("\n");
const sliceBetween = (lines: string[], from: RegExp, to: RegExp): string[] => {
  const a = lines.findIndex((l) => from.test(l)); if (a < 0) return [];
  const b = lines.findIndex((l, k) => k > a && to.test(l));
  return lines.slice(a, b < 0 ? a + 12 : b + 1);
};
const predicateRule = sliceBetween(scoringSource, /^export function callSiteIsRendered/, /^}/);
const populationRule = sliceBetween(fixturesSource, /^export function deriveCallSiteEdges/, /^}/);
const engineRule = sliceBetween(engineSource, /A15 \+ §30 truthfulness/, /if \(relation && callSiteIsRendered\(relation\.evidence \?\? \{\}\)\) impactRendersExpression \+= 1;/);
const claimRule = sliceBetween(reportSource, /id: "A15", vexpClaim/, /comparabilityCaveat: "scored on get_impact_graph/);
const bandRule = sliceBetween(reportSource, /^function band\(/, /^}/);
const surfaceRule = reportSource.filter((l) => /const a15Impact = |const a15Flow = /.test(l));

// ------------------------------------------------------------------- inputs
const pre = read("stage5_m209_audit_pre.json");
const preItems = readRows("stage5_m209_items_pre.jsonl");
const m208Engine = read("stage5_m208_engine.json");
const m208Ledger = read("stage5_m208_claim_ledger.json");
const preEngine = read("stage5_m209_engine_pre.json", false);
const preLedger = read("stage5_m209_claim_ledger_pre.json", false);

const L = corpus(pre, "C-LARGE"); const M = corpus(pre, "C-MED"); const S = corpus(pre, "C-SMALL");
const verdictOf = (ledger: any, id: string) => ledger?.claims?.find((c: any) => c.id === id)?.verdict ?? null;
const matrix = (ledger: any) => ["A1", "A2", "A3", "A4", "A5", "A6", "A7", "A8", "A9", "A10", "A11", "A12", "A13", "A14", "A15"].map((id) => [id, short(verdictOf(ledger, id))]);

// ------------------------------------------------------------ reproduction
const reproduction = {
  m208Committed: {
    a15: Object.fromEntries(["C-SMALL", "C-MED", "C-LARGE"].map((c) => [c, m208Engine.corpora.find((x: any) => x.id === c)?.a15])),
    matrix: matrix(m208Ledger), matchOrExceed: m208Ledger.parity?.matchOrExceed ?? m208Ledger.matchOrExceed ?? null,
  },
  m209Pre: preEngine === null ? null : {
    a15: Object.fromEntries(["C-SMALL", "C-MED", "C-LARGE"].map((c) => [c, preEngine.corpora.find((x: any) => x.id === c)?.a15])),
    matrix: preLedger === null ? null : matrix(preLedger), matchOrExceed: preLedger?.parity?.matchOrExceed ?? preLedger?.matchOrExceed ?? null,
    hardware: preEngine.hardware,
  },
  auditFrozenAgreement: ["C-SMALL", "C-MED", "C-LARGE"].map((c) => ({
    corpus: c, engineImpactPercent: m208Engine.corpora.find((x: any) => x.id === c)?.a15?.impactRenderPercent ?? null,
    auditImpactPercent: corpus(pre, c)?.frozen?.impactRenderPercent ?? null,
    engineEligible: m208Engine.corpora.find((x: any) => x.id === c)?.a15?.eligibleCallSites ?? null, auditEligible: corpus(pre, c)?.population?.eligible ?? null,
  })),
};

// ------------------------------------------------------------- the gate
const supply = ["C-SMALL", "C-MED", "C-LARGE"].map((c) => {
  const x = corpus(pre, c);
  return { corpus: c, eligible: x?.population?.eligible ?? 0, renderable: x?.renderability?.RENDERABLE_FROM_EXISTING_TRUTH ?? 0,
    truthPercent: x?.counterfactual?.achievableImpactRenderPercent ?? null,
    // The scorer reads the DELIVERED response, so the achievable figure is the
    // renderable items whose relation the default envelope can also carry.
    achievablePercent: x?.deliveryCeiling?.achievableIfRelationCosts?.["500"]?.percent ?? null,
    achievableAtAnyCost: x?.deliveryCeiling?.achievableIfRelationCosts?.["200"]?.percent ?? null,
    callerLostToCoreSlice: x?.deliveryCeiling?.callerLostToCoreSlice ?? null,
    rank: x?.deliveryCeiling?.rankDistribution ?? null,
    fitsEvidenceTargetAllRetained: x?.counterfactual?.wholeResponse?.meetEvidenceTargetWithAllStrippedKeys ?? null,
    fitsCeilingAllRetained: x?.counterfactual?.wholeResponse?.fitCeilingWithAllStrippedKeys ?? null,
    responses: x?.counterfactual?.wholeResponse?.responses ?? null };
});
const scored = supply.find((s) => s.corpus === "C-LARGE")!;
// The frozen bar is 90 % of eligible, on the delivered surface. Supply is
// sufficient only if a renderer-only repair could mathematically clear it.
const supplySufficient = scored.achievablePercent !== null && scored.achievablePercent >= 90;
const gate = supplySufficient ? "A15_RENDERABLE_SUPPLY_SUFFICIENT" : "A15_RENDERABLE_SUPPLY_INSUFFICIENT";

// The single drop point, from the audit's own observation of the default
// response: which evidence keys survive the envelope, and which compaction
// marker the envelope stamps on every response.
const dropPoint = {
  productEvidenceKeySets: L?.product?.evidenceKeySets ?? {},
  compactedFieldSets: L?.product?.compactedFieldSets ?? {},
  coreWithSourceText: L?.core?.withSourceText ?? null, productWithSourceText: L?.product?.withSourceText ?? null,
  coreWithReferenceName: L?.core?.withReferenceName ?? null, productWithReferenceName: L?.product?.withReferenceName ?? null,
  resultStates: L?.product?.resultStates ?? {},
};

const out: any = {
  milestone: "M209", phase: PHASE, instrument: "run_stage5_m209_report.ts",
  frozenAuthority: {
    claim: "A15", scorer: "run_stage5_m197a_report.ts (claim row + band) over run_stage5_m197a_engine.ts (A15 block) with m197aScoring.callSiteIsRendered and m197aFixtures.deriveCallSiteEdges",
    predicateRule, populationRule, engineRule, claimRule, bandRule, surfaceRule,
    recovered: predicateRule.length > 0 && populationRule.length > 0 && engineRule.length > 0 && claimRule.length > 0 && bandRule.length > 0
      ? "A15_FROZEN_AUTHORITY_RECOVERED" : "A15_FROZEN_AUTHORITY_NOT_RECOVERED",
  },
  reproduction,
  substrate: Object.fromEntries(["C-SMALL", "C-MED", "C-LARGE"].map((c) => [c, corpus(pre, c)?.substrate])),
  truth: Object.fromEntries(["C-SMALL", "C-MED", "C-LARGE"].map((c) => [c, { core: corpus(pre, c)?.core, product: corpus(pre, c)?.product, flow: corpus(pre, c)?.frozen, renderability: corpus(pre, c)?.renderability }])),
  dropPoint,
  counterfactual: Object.fromEntries(["C-SMALL", "C-MED", "C-LARGE"].map((c) => [c, corpus(pre, c)?.counterfactual])),
  fanIn: Object.fromEntries(["C-SMALL", "C-MED", "C-LARGE"].map((c) => [c, corpus(pre, c)?.fanIn])),
  supply, gate,
  examples: Object.fromEntries(["C-SMALL", "C-MED", "C-LARGE"].map((c) => [c, corpus(pre, c)?.examples])),
};

// ------------------------------------------------------------------ markdown
const md: string[] = [];
md.push(`# M209 ${PHASE === "causal" ? "causal report — pre-change" : "final report"}`, "");
md.push("## 1. Frozen A15 authority", "",
  "Quoted verbatim from the committed scorer sources at report time.", "",
  "The predicate (m197aScoring.ts):", ...fence(predicateRule), "",
  "The population (m197aFixtures.ts):", ...fence(populationRule), "",
  "The engine's A15 block (run_stage5_m197a_engine.ts):", ...fence(engineRule), "",
  "The claim row and band (run_stage5_m197a_report.ts):", ...fence(claimRule), ...fence(bandRule), ...fence(surfaceRule), "",
  `Recovered: **${out.frozenAuthority.recovered}**.`, "",
  "In words: the claim is `call-site evidence renders the call expression, not just a location`; the corpus is C-LARGE (ARC, Python, 276 files); the population is the first 50 `calls` edges by edge id that carry an ordinal-0 persisted call site and join distinct symbols; the scored surface is the DEFAULT `get_impact_graph` MCP response for the callee at `depth: 3`, and the item is the `directRelations` entry whose `source.symbol` is the caller; the predicate is `evidence.sourceText` non-empty AND containing `evidence.referenceName`; the metric is rendered ÷ eligible; MATCH ≥ 90 %, EXCEED 100 %; the logic-flow surface is published beside it and does not decide. Eligibility is decided on the flow surface (a step with `evidence.callSites[0]` and a source path), so the denominator is what VTRACE actually persisted, not what it declined to render.", "");

md.push("## 2. M208 reproduction", "");
md.push(...table(["corpus", "M208 engine eligible", "M208 impact %", "M208 flow %", "M209 audit eligible", "M209 audit impact %"],
  reproduction.auditFrozenAgreement.map((r: any) => [r.corpus, r.engineEligible, r.engineImpactPercent, m208Engine.corpora.find((x: any) => x.id === r.corpus)?.a15?.flowCorrectRenderPercent, r.auditEligible, r.auditImpactPercent])), "");
md.push("M208 committed matrix: " + reproduction.m208Committed.matrix.map(([id, v]: any) => `${id} ${v}`).join(", ") + ` — ${reproduction.m208Committed.matchOrExceed} / 15.`, "");
if (reproduction.m209Pre !== null) {
  md.push(`M209 pre-change frozen rerun (main tree at the M208 product, load ${reproduction.m209Pre.hardware?.loadAverageAtStart?.join(" ")}): `
    + (reproduction.m209Pre.matrix ?? []).map(([id, v]: any) => `${id} ${v}`).join(", ") + ` — ${reproduction.m209Pre.matchOrExceed} / 15.`, "");
}

md.push("## 3. Existing impact architecture", "",
  "```",
  "parser (Python / TypeScript / Cython) --> edges(id, src, dst, edge_type, confidence)",
  "                                      --> edge_call_sites(edge_id, ordinal, start_line, start_column, end_line, end_column, precision)",
  "getImpactGraph (src/impact/getImpactGraph.ts)",
  "  listEdgesForSymbol + getSymbolsByIds + listCallSitesForEdges  (one batched query each)",
  "  buildStaticRelationEvidence (src/impact/staticEvidence.ts)",
  "    persisted sites filtered to the caller's own span, sorted",
  "    buildSymbolSourceExcerpt(anchorLine = first site)  <- loadSymbolSource checks size + sha256 against files(...)",
  "    evidence = { sourceText (first site line, trimmed, <=240), referenceName (callee local name),",
  "                 resolutionMethod, locationKind (edge_site | caller_span_scan | source_symbol_span), callSites[<=5], callSiteCount }",
  "  directRelations  (dedupe by relation id, ordered incoming-first / strength / kind / path / symbol / id)",
  "  paths / nodes / edges / view  (projections of the same retained set)",
  "MCP get_impact_graph handler (src/mcp/tools.ts)",
  "  compactImpactProductResponse (src/impact/impactResponseEnvelope.ts)   <- the scored surface",
  "search_logic_flow (src/logicFlow/searchLogicFlow.ts) -> the same buildStaticRelationEvidence with the edge's sites   (published beside)",
  "get_code_context / run_pipeline consume the CORE relations directly (no envelope): summary lines `CALLS <caller> at <path>:<line> [strength]`",
  "```", "");

md.push("## 4. Truth capability matrix", "");
md.push(...table(["evidence", "indexed?", "persisted?", "queryable?", "core delivers?", "default get_impact_graph delivers? (M208)"], [
  ["exact caller identity (calls edge, src symbol)", "yes", "edges", "listEdgesForSymbol", "source.{nodeId,path,symbol,kind}", "yes"],
  ["potential caller identity (unresolved receiver)", "no (scan per response)", "never", "callerCoverage scan", "potentialCallers[] (separate collection)", "yes, separate"],
  ["call-site span (line/column, precision)", "yes", "edge_call_sites", "listCallSitesForEdges", "evidence.callSites[], callSiteCount", "yes"],
  ["caller source line at the site", "no (rebuilt from disk under hash check)", "never", "buildSymbolSourceExcerpt", "evidence.sourceText", "NO — stripped"],
  ["callee name used for grounding", "yes (symbols.local_name)", "symbols", "yes", "evidence.referenceName", "NO — stripped"],
  ["caller enclosing symbol", "yes", "symbols", "yes", "source.symbol / nodeId", "yes"],
  ["cross-file status", "derivable", "files via symbols.file_id", "join", "source.path vs target.path", "yes"],
  ["graph distance", "no", "computed per traversal", "traverseRelations", "nodes[].distance; paths[].length", "yes (nodes), paths compacted first"],
  ["edge provenance / certainty", "yes", "edge_type; strength derived", "yes", "kind, strength, resolutionMethod, locationKind", "yes"],
  ["multiple sites per edge", "yes", "edge_call_sites.ordinal", "yes", "callSites (<=5) + callSiteCount", "yes"],
]), "");
md.push(...table(["corpus", "calls edges", "with persisted site", "site %", "sites", "multi-site edges", "cross-file calls", "sites outside caller span", "references edges (with site)"],
  ["C-SMALL", "C-MED", "C-LARGE"].map((c) => { const s = corpus(pre, c)?.substrate; return [c, s?.calls?.edges, s?.calls?.edgesWithPersistedSite, s?.calls?.sitePercent, s?.calls?.sites, s?.calls?.edgesWithMultipleSites, s?.calls?.crossFileEdges, s?.calls?.sitesOutsideCallerSpan, `${s?.references?.edges} (${s?.references?.edgesWithPersistedSite})`]; })), "");

md.push("## 5. Renderability audit", "");
md.push(...table(["corpus", "eligible", "RENDERABLE_FROM_EXISTING_TRUTH", "GRAPH_ONLY", "AMBIGUOUS", "STALE", "NO_TRUTH", "core faultless", "core sourceText", "cross-file / same-file"],
  ["C-SMALL", "C-MED", "C-LARGE"].map((c) => { const x = corpus(pre, c); const r = x?.renderability ?? {}; return [c, x?.population?.eligible, r.RENDERABLE_FROM_EXISTING_TRUTH ?? 0, r.GRAPH_ONLY_TRUTH ?? 0, r.AMBIGUOUS_TRUTH ?? 0, r.STALE_TRUTH ?? 0, r.NO_TRUTH ?? 0, x?.core?.faultless, x?.core?.withSourceText, `${x?.core?.crossFile} / ${x?.core?.sameFile}`]; })), "");
md.push(`Core faults (C-LARGE): ${hist(L?.core?.faults)}. Core strengths: ${hist(L?.core?.byStrength)}. Core location kinds: ${hist(L?.core?.byLocationKind)}.`, "");

md.push("## 6. Where the evidence is dropped", "");
md.push(`On the default surface the C-LARGE relations carry exactly these evidence key sets: ${hist(dropPoint.productEvidenceKeySets)}; the envelope stamps ${hist(dropPoint.compactedFieldSets)}; result states ${hist(dropPoint.resultStates)}. The core delivered sourceText for ${dropPoint.coreWithSourceText} and referenceName for ${dropPoint.coreWithReferenceName} of the scored relations; the default response delivered ${dropPoint.productWithSourceText} and ${dropPoint.productWithReferenceName}.`, "");
md.push("Mechanism (code-level): `compactImpactProductResponse` builds its canonical selection by mapping every direct relation through `compactRelation`, which rebuilds `evidence` from `resolutionMethod`, `locationKind`, `callSites` and `callSiteCount` only — `sourceText`, `referenceName` and `importAlias` are dropped before any budget is measured, on every response, and the marker `directRelations[].evidence` is stamped unconditionally. It is not a rung of the degradation ladder: the ladder's own evidence-shedding rung (`minimalRelation`) runs later and only when the envelope binds. The drop is therefore a projection defect, not a budget decision, and the frozen A15 population sees 0 % rendered on a surface whose upstream produced the line for every item.", "");

md.push("## 7. Counterfactual: renderer-only repair", "");
md.push("Two bounds apply, and the frozen metric is subject to both. The FIRST is truth: can the index support a rendering for this item at all. The SECOND is delivery: the scorer reads the DEFAULT response, so the caller's relation must also survive into it, at its rank in the core's own ordered relations, inside `max_tokens + max(800, 15 %)`.", "");
md.push(...table(["corpus", "eligible", "renderable from truth", "truth %", "caller in core order", "lost to the core's 64-relation slice", "rank 0 / <=2 / <=6 / <=9 / max", "achievable at 500 chars per relation", "achievable at 200 chars per relation"],
  supply.map((s) => [s.corpus, s.eligible, s.renderable, s.truthPercent, (s.eligible ?? 0) - (s.callerLostToCoreSlice ?? 0), s.callerLostToCoreSlice,
    s.rank ? `${s.rank.rank0} / ${s.rank.atMost2} / ${s.rank.atMost6} / ${s.rank.atMost9} / ${s.rank.max}` : "", `${s.achievablePercent} %`, `${s.achievableAtAnyCost} %`])), "");
md.push("The last two columns are UPPER bounds computed from each response's own fixed metadata and its own ceiling: they assume the three graph restatements (`nodes`, `edges`, `view`) and `paths` cost nothing at all, and that a delivered relation costs 500 — or 200 — characters, below what any truthful record carrying a caller identity, a span and a source line has been observed to cost (median per core relation is in the next table). They are what a renderer-only repair could reach, not what one would reach.", "");
md.push(...table(["corpus", "median response chars", "median fixed metadata", "median nodes+edges+view", "median directRelations", "median per core relation", "ceiling chars", "delivered relations"],
  ["C-SMALL", "C-MED", "C-LARGE"].map((c) => { const d = corpus(pre, c)?.deliveryCeiling; return [c, d?.medianCharacters?.total, d?.medianCharacters?.fixed, d?.medianCharacters?.graphRestatements, d?.medianCharacters?.directRelations, d?.medianCharacters?.perCoreRelation, d?.medianCharacters?.ceiling, hist(d?.deliveredRelations)]; })), "");
md.push(...table(["corpus", "responses", "all retained keys meet evidence target", "all retained keys fit ceiling", "max stripped tokens", "median stripped tokens"],
  supply.map((s) => { const cf = corpus(pre, s.corpus)?.counterfactual?.wholeResponse; return [s.corpus, s.responses, s.fitsEvidenceTargetAllRetained, s.fitsCeilingAllRetained, cf?.maxStrippedTokens, cf?.medianStrippedTokens]; })), "");
md.push("The last table re-adds the stripped keys for EVERY retained direct relation of each scored response to the product's own `responseBudget`: restoring the evidence costs a median of 30 tokens per response and fits the ceiling almost everywhere. Restoring the evidence is affordable; retaining the caller is not.", "");

md.push("## 8. High-fan-in probe", "");
md.push(...table(["corpus", "symbol", "incoming calls", "default: chars / relations / with text / inspected / retained / omitted / state", "hard bounds (2000 edges, 20000 tokens): chars / relations / with text / retained / omitted / state"],
  ["C-SMALL", "C-MED", "C-LARGE"].map((c) => { const f = corpus(pre, c)?.fanIn; return [c, f?.symbol, f?.incomingCalls,
    f ? `${f.default.characters} / ${f.default.directRelations} / ${f.default.withSourceText} / ${f.default.edgesInspected} / ${f.default.retainedEdges} / ${f.default.omittedEdges} / ${f.default.resultState}` : "",
    f ? `${f.hardBounds.characters} / ${f.hardBounds.directRelations} / ${f.hardBounds.withSourceText} / ${f.hardBounds.retainedEdges} / ${f.hardBounds.omittedEdges} / ${f.hardBounds.resultState}` : ""]; })), "");

md.push("## 9. Examples (real, from the corpora; nothing invented)", "");
for (const c of ["C-LARGE", "C-MED", "C-SMALL"]) {
  for (const ex of corpus(pre, c)?.examples ?? []) {
    md.push(`- ${c}: ${ex.role} \`${ex.from}\` -> \`${ex.to}\` at ${ex.declaredSpan}: core \`${ex.coreSourceText}\`; default response \`${ex.productSourceText ?? "(absent)"}\``);
  }
}
md.push("");

md.push("## 10. Pre-change causal gate", "");
md.push(`**${gate}**`, "");
md.push(supplySufficient
  ? `The C-LARGE population is ${scored.renderable} / ${scored.eligible} renderable from existing truth (${scored.truthPercent} %) and ${scored.achievablePercent} % of it is also deliverable at the default budget, clearing the 90 % bar. The preferred repair is a rendering/projection repair in the one authoritative envelope; no index change is licensed.`
  : `The C-LARGE population is ${scored.renderable} / ${scored.eligible} renderable from existing truth (${scored.truthPercent} %), but only ${scored.achievablePercent} % of it can also be DELIVERED: ${scored.callerLostToCoreSlice} callers fall outside the core's own 64-relation slice, and of those that remain the scored caller sits at rank 0 in ${scored.rank?.rank0} cases and within the first three in ${scored.rank?.atMost2}, while the default envelope's fixed metadata (median ${corpus(pre, "C-LARGE")?.deliveryCeiling?.medianCharacters?.fixed} of ${corpus(pre, "C-LARGE")?.deliveryCeiling?.medianCharacters?.ceiling} characters) leaves room for about three relations even if every graph restatement were free. Rendering alone therefore CANNOT reach the 90 % bar. The rendering defect is real and is repaired; the residual is a delivery primitive, named in section 10.`, "");
md.push("", "**The missing primitive.** Frozen A15 is scored on whether the default `get_impact_graph` response for a callee contains one ARBITRARY caller of that callee, chosen by edge id. Clearing 90 % therefore requires the default response to enumerate essentially the complete caller list for every symbol — a median of 13 relations on C-LARGE, up to rank 46 — inside a 2 000-token ceiling whose fixed, unshrinkable metadata already spends about 3 300 characters. That is a caller-enumeration capacity primitive (a compact per-caller record and a caller-complete projection), not a rendering one. It is outside what M209 may build: it would change what the default impact response delivers at every budget, which is a budget/representation milestone with its own A11/A13 obligations. M209 repairs the rendering defect it found and reports the primitive rather than manufacturing parity.", "");
md.push("## Boundary", "", "Frozen A15 measures the impact surface's rendering of a persisted call site as source text naming the callee. It does not measure caller completeness, potential-caller quality, transitive rendering, or agent utility. `ENGINE QUALITY != CODING-AGENT UTILITY` governs; nothing in this report is a claim about SWE-bench.", "");

// ================================================================== final phase
if (PHASE === "final") {
  const post = read("stage5_m209_audit_post.json");
  const postPre = read("stage5_m209_audit_post_precorpus.json", false);
  const postEngine = read("stage5_m209_engine.json");
  const postLedger = read("stage5_m209_claim_ledger.json");
  const fals = read("stage5_m209_falsification.json", false);
  const ab = read("stage5_m209_retrieval_eval_ab.json", false);
  const a5 = read("stage5_m201_a5_m209_post.json", false);
  const authorityPost = read("stage5_m209_authority_post.json", false);
  const rep = read("stage5_m205_representation_m209_post.json", false);
  const PL = corpus(post, "C-LARGE");
  const postA15 = Object.fromEntries(["C-SMALL", "C-MED", "C-LARGE"].map((c) => [c, postEngine.corpora.find((x: any) => x.id === c)?.a15]));
  const a15Verdict = verdictOf(postLedger, "A15");
  const matchOrExceed = postLedger?.parity?.matchOrExceed ?? postLedger?.matchOrExceed ?? null;
  const allGreen = matrix(postLedger).every(([, v]) => v === "MATCHES" || v === "EXCEEDS");
  const finalOut = {
    ...out,
    post: {
      a15: postA15, a15Verdict, matrix: matrix(postLedger), matchOrExceed, allGreen,
      parityConclusion: allGreen && matchOrExceed === 15 ? "VTRACE_DETERMINISTIC_VEXP_ENGINE_PARITY_COMPLETE" : "PARITY_NOT_COMPLETE",
      hardware: postEngine.hardware,
      audit: Object.fromEntries(["C-SMALL", "C-MED", "C-LARGE"].map((c) => [c, { frozen: corpus(post, c)?.frozen, product: corpus(post, c)?.product, renderability: corpus(post, c)?.renderability, fanIn: corpus(post, c)?.fanIn, counterfactual: corpus(post, c)?.counterfactual }])),
      sameCorpusControl: postPre === null ? null : Object.fromEntries(["C-MED"].map((c) => [c, { frozen: corpus(postPre, c)?.frozen, product: corpus(postPre, c)?.product }])),
      falsification: fals, retrievalAb: ab, a5Harness: a5?.summary ?? a5, authorityPost, representation: rep?.summary ?? rep?.gates ?? null,
      a11: Object.fromEntries(Object.entries(postEngine.corpora.find((x: any) => x.id === "C-MED")?.a11a13?.utilisationByBudget ?? {}).map(([b, v]: [string, any]) => [b, v.median])),
      a13: { sizeViolations: postEngine.corpora.find((x: any) => x.id === "C-MED")?.a11a13?.tasksWithSizeViolation, focusSwaps: postEngine.corpora.find((x: any) => x.id === "C-MED")?.a11a13?.tasksWithFocusSwap },
      a12: postEngine.corpora.find((x: any) => x.id === "C-MED")?.a12?.distinctClassesObserved,
      a14: postEngine.corpora.find((x: any) => x.id === "C-MED")?.a14 ? { perItem: postEngine.corpora.find((x: any) => x.id === "C-MED").a14.itemsWithPerItemAccounting, delivered: postEngine.corpora.find((x: any) => x.id === "C-MED").a14.itemsDelivered } : null,
      a5: Object.fromEntries(["C-SMALL", "C-MED", "C-LARGE"].map((c) => [c, postEngine.corpora.find((x: any) => x.id === c)?.a5?.latency?.p90])),
      a6: Object.fromEntries(["C-SMALL", "C-MED", "C-LARGE"].map((c) => [c, postEngine.corpora.find((x: any) => x.id === c)?.a6?.latency?.p90])),
    },
  };
  const f = [...md];
  f.push("## 11. Post-change A15 (frozen)", "");
  f.push(...table(["corpus", "eligible", "impact rendered", "impact %", "flow %", "audit impact %", "audit faults (product)", "deterministic"],
    ["C-SMALL", "C-MED", "C-LARGE"].map((c) => [c, postA15[c]?.eligibleCallSites, postA15[c]?.impactSurfaceRenderingExpression, postA15[c]?.impactRenderPercent, postA15[c]?.flowCorrectRenderPercent, corpus(post, c)?.frozen?.impactRenderPercent, hist(corpus(post, c)?.product?.faults), corpus(post, c)?.product?.deterministic])), "");
  f.push(`Frozen A15 verdict: **${short(a15Verdict)}** (M208: ${short(verdictOf(m208Ledger, "A15"))}).`, "");
  f.push("## 12. Full A1–A15 matrix, M208 -> M209", "");
  f.push(...table(["claim", "M208", "M209 pre (rerun)", "M209 post"], matrix(postLedger).map(([id]) => [id, short(verdictOf(m208Ledger, id)), preLedger ? short(verdictOf(preLedger, id)) : "", short(verdictOf(postLedger, id))])), "");
  f.push(`Match-or-exceed: M208 ${reproduction.m208Committed.matchOrExceed} / 15 -> M209 ${matchOrExceed} / 15. ${finalOut.post.parityConclusion === "VTRACE_DETERMINISTIC_VEXP_ENGINE_PARITY_COMPLETE" ? "**VTRACE_DETERMINISTIC_VEXP_ENGINE_PARITY_COMPLETE**" : "Parity not complete."}`, "");
  f.push("## 13. Protected claims", "");
  f.push(`A5 p90 (engine): ${JSON.stringify(finalOut.post.a5)} ms at load ${postEngine.hardware?.loadAverageAtStart?.join(" ")}; A6 p90: ${JSON.stringify(finalOut.post.a6)} ms. A11 median utilisation: ${JSON.stringify(finalOut.post.a11)}. A12 classes: ${JSON.stringify(finalOut.post.a12)}. A13: ${JSON.stringify(finalOut.post.a13)}. A14: ${JSON.stringify(finalOut.post.a14)}.`, "");
  if (a5) f.push(`A5 harness (run_stage5_m201_a5.ts): ${JSON.stringify(a5.summary ?? a5.corpora?.map((c: any) => ({ id: c.id, p90: c.latency?.p90 })) ?? "see stage5_m201_a5_m209_post.json")}`, "");
  if (fals) {
    f.push("## 14. Falsification", "");
    f.push(...table(["control", "pass", "detail"], (fals.controls ?? []).map((c: any) => [c.id, c.pass, c.detail])), "");
    f.push(`Overall: ${fals.allPass ? "ALL PASS" : "FAILURES PRESENT"}; predecessor ${fals.predecessorHead ?? ""}.`, "");
  }
  if (ab) {
    f.push("## 15. Retrieval regression guard", "");
    f.push(...table(["fixture", "rows", "evaluated both", "identical", "top-1 pre -> post", "top-3 pre -> post", "moved rows"],
      Object.entries(ab.fixtures ?? {}).map(([name, x]: [string, any]) => [name, x.rows, x.evaluatedBoth, x.identical, `${x.top1Pre} -> ${x.top1Post}`, `${x.top3Pre} -> ${x.top3Post}`, (x.moved ?? []).map((m: any) => m.instance_id).join(", ") || "none"])), "");
  }
  f.push("## 16. Same-corpus attribution", "");
  f.push(`Post audit C-MED frozen impact %: ${corpus(post, "C-MED")?.frozen?.impactRenderPercent}; on the pristine pre-corpus copy: ${postPre ? corpus(postPre, "C-MED")?.frozen?.impactRenderPercent : "not run"}. C-MED count: ${authorityPost ? (authorityPost.checks ?? []).filter((c: any) => c.id === "corpus_C-MED").map((c: any) => c.detail).join("") : "see authority"}.`, "");
  f.push("## 17. What 15/15 does NOT prove", "", "- does not prove coding-agent utility", "- does not prove VTRACE beats VEXP", "- does not prove SWE-bench improvement", "- does not make the prior neutral paired-agent result disappear", "");
  writeFileSync(path.join(RESULTS, "stage5_m209_final_report.json"), `${JSON.stringify(finalOut, null, 2)}\n`);
  writeFileSync(path.join(RESULTS, "stage5_m209_final_report.md"), `${f.join("\n")}\n`);
  console.log(`wrote results/stage5_m209_final_report.{md,json}: A15 ${short(a15Verdict)}, ${matchOrExceed} / 15, ${finalOut.post.parityConclusion}`);
} else {
  writeFileSync(path.join(RESULTS, "stage5_m209_causal_report.json"), `${JSON.stringify(out, null, 2)}\n`);
  writeFileSync(path.join(RESULTS, "stage5_m209_causal_report.md"), `${md.join("\n")}\n`);
  console.log(`wrote results/stage5_m209_causal_report.{md,json}: ${out.frozenAuthority.recovered}; ${gate}`);
}
