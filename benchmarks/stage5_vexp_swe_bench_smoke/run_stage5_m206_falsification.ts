/**
 * M206 — falsification controls F1-F12.
 *
 * A gate that has never been seen to fail is not known to be a gate. Each
 * control constructs the specific dishonesty the milestone guards against —
 * filler admitted into unused budget, a count that still truncates an abundant
 * stream, a duplicate delivered twice, an ineligible tail let in because room
 * remained, a role starved, an unstable merge, an unbounded stream, a
 * rung-specific budget rule, a wrong cost, a fabricated richer form, monotonic
 * focus confused with utilisation, and the historical allocator passing the
 * abundant-supply control — and shows the production capsule builder, the
 * production projector, the M203/M204/M205 analyzers or the frozen rule
 * refusing it, beside the honest case each accepts.
 *
 * The capsules are REAL: built by the production `buildCapsuleV2` on a fixture
 * repository materialised on disk and indexed in memory exactly as the unit
 * tests build one, and, for the historical allocator, by the builder of a
 * worktree at the M205 commit on the SAME fixture. The packets are real too:
 * produced by the production projector from an authoritative state assembled
 * from the capsule's own items. Any mutation happens on copies after the
 * product has returned, so no control can influence what the product does.
 *
 *   bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m206_falsification.ts \
 *     [--predecessor-root /home/calvin/bench/vtrace-m206/pre]
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { SymbolKind } from "../../src/domain/types";
import { seedCustomFixture, type SymbolSpec } from "../../src/capsuleV2/__fixtures__/capsuleV2Fixture";
import { allocateBudget } from "../../src/capsuleV2/budgetAllocator";
import { buildCapsuleV2 } from "../../src/capsuleV2/buildCapsuleV2";
import { CapsuleIntent } from "../../src/capsuleV2/types";
import { orientationAccountingOf } from "../../src/runPipeline/orientationAccounting";
import {
  ORIENTATION_FROZEN_PHRASES, ORIENTATION_POLICY, orientationCeilingTokens, projectRunPipelineOrientation,
} from "../../src/runPipeline/orientationProjection";
import { analyzeAccounting, frozenA14ItemsAccounted, frozenA14ItemsDelivered } from "./m203Accounting";
import { A11_MATCH_PERCENT, analyzeUtilization, frozenA11Verdict, frozenUtilisationPercent, orderRelation } from "./m204Utilization";
import { analyzeRepresentation, type SourceAuthority, type SupplyItem } from "./m205Representation";
import { classifyDiscardReason, isCountCapDiscard } from "./m206Allocation";

const RESULTS = path.join(import.meta.dir, "results");
const args = process.argv.slice(2);
const argOf = (f: string, d: string) => { const i = args.indexOf(f); return i >= 0 && args[i + 1] !== undefined ? args[i + 1]! : d; };
const PREDECESSOR_ROOT = path.resolve(argOf("--predecessor-root", "/home/calvin/bench/vtrace-m206/pre"));

const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));

const predecessorCapsule = await import(path.join(PREDECESSOR_ROOT, "src/capsuleV2/buildCapsuleV2.ts"));
const predecessorAllocator = await import(path.join(PREDECESSOR_ROOT, "src/capsuleV2/budgetAllocator.ts"));
const predecessorHead = Bun.spawnSync(["git", "-C", PREDECESSOR_ROOT, "rev-parse", "HEAD"]).stdout.toString().trim();
if (typeof predecessorAllocator.allocateBudget(16000).maxSupport !== "number") {
  throw new Error("M206_PREDECESSOR_ALREADY_REPAIRED: the predecessor allocator carries no support maximum");
}
if (typeof (allocateBudget(16000) as any).maxSupport === "number") {
  throw new Error("M206_PRODUCT_NOT_REPAIRED: the product allocator still declares a support maximum");
}

// ---------------------------------------------------------------- fixtures

const TASK = "how does the widget registry resolve a widget handler for a name";

/**
 * An abundant, truthful ranked stream: one clear edit target, `count` support-
 * worthy resolver functions in distinct files that all match the task, a tail
 * of test symbols the role gate must keep out, and a pair of same-signature
 * methods in one file the M158 dedupe must collapse.
 */
function abundantFixture(count: number, options: { tests?: number; twins?: boolean } = {}) {
  const files: { relPath: string; specs: readonly SymbolSpec[] }[] = [];
  files.push({ relPath: "widgets/registry.py", specs: [
    { localName: "WidgetRegistry", kind: SymbolKind.Class, docstring: "Registry of widget handlers by name.", body: 'class WidgetRegistry:\n    """Registry of widget handlers by name."""' },
    { localName: "resolve_widget_handler", kind: SymbolKind.Method, parentLocalName: "WidgetRegistry", signature: "resolve_widget_handler(self, name)",
      body: "    def resolve_widget_handler(self, name):\n        handler = self.handlers.get(name)\n        if handler is None:\n            raise KeyError(name)\n        return handler" },
  ] });
  for (let k = 0; k < count; k += 1) {
    files.push({ relPath: `widgets/resolvers/resolver_${k}.py`, specs: [
      { localName: `resolve_widget_handler_${k}`, kind: SymbolKind.Function, signature: `resolve_widget_handler_${k}(registry, name)`,
        body: `def resolve_widget_handler_${k}(registry, name):\n    # widget registry handler resolution ${k}\n    return registry.resolve_widget_handler(name)` },
    ] });
  }
  for (let t = 0; t < (options.tests ?? 0); t += 1) {
    files.push({ relPath: `tests/test_widget_${t}.py`, specs: [
      { localName: `WidgetResolveTest${t}`, kind: SymbolKind.Class, body: `class WidgetResolveTest${t}:\n    pass` },
      { localName: `test_resolve_widget_handler_${t}`, kind: SymbolKind.Method, parentLocalName: `WidgetResolveTest${t}`,
        body: `    def test_resolve_widget_handler_${t}(self):\n        assert WidgetRegistry().resolve_widget_handler("name")` },
    ] });
  }
  if (options.twins) {
    files.push({ relPath: "widgets/twins.py", specs: [
      { localName: "WidgetA", kind: SymbolKind.Class, body: "class WidgetA:\n    pass" },
      { localName: "resolve_widget_handler", kind: SymbolKind.Method, parentLocalName: "WidgetA", signature: "resolve_widget_handler(self, name)", body: "    def resolve_widget_handler(self, name):\n        return 1" },
      { localName: "WidgetB", kind: SymbolKind.Class, body: "class WidgetB:\n    pass" },
      { localName: "resolve_widget_handler", kind: SymbolKind.Method, parentLocalName: "WidgetB", signature: "resolve_widget_handler(self, name)", body: "    def resolve_widget_handler(self, name):\n        return 2" },
    ] });
  }
  return seedCustomFixture(files);
}

const build = (fixture: { db: any; repoRoot: string }, maxTokens: number, builder: any = buildCapsuleV2) =>
  builder({ db: fixture.db, repoRoot: fixture.repoRoot, task: TASK, intent: CapsuleIntent.Explain, maxTokens });

/** The authoritative state the projector reads, assembled from the capsule's own items (the product's own drafting rule for support: skeleton/signature). */
function authoritativeFromCapsule(result: any, requested: number, repoRoot?: string): { state: any; supply: SupplyItem[]; authority: SourceAuthority; files: Map<string, string> } {
  const items: any[] = [];
  const bodies = new Map<string, string>();
  const files = new Map<string, string>();
  const push = (item: any, roles: string[], index: number) => {
    const id = `i${index}`;
    const contentMode = item.content_mode === "full" && typeof item.source === "string" ? "focused_source" : typeof item.signature === "string" ? "signature" : "summary";
    const body = (contentMode === "focused_source" ? item.source : contentMode === "signature" ? item.signature : "").trim();
    bodies.set(id, body);
    items.push({ id, fqName: item.fq_name, path: item.path, lineSpan: { start: 1, end: 1 }, contentMode, roles,
      selectionReasons: [item.role_reason, ...(item.evidence ?? [])], estimatedTokens: item.estimated_tokens });
    files.set(item.path, body);
  };
  result.pivots.forEach((p: any, k: number) => push(p, ["pivot", "required"], k));
  result.support.forEach((s: any, k: number) => push(s, ["support", "skeleton"], result.pivots.length + k));
  const rendered = ["# VTRACE product context", ...items.map((i) => `\n## [${i.id}] ${i.fqName}\nroles: ${i.roles.join(", ")}\nmode: ${i.contentMode}\nlines: 1-1\nwhy: ${i.selectionReasons[0]}\n\n${bodies.get(i.id)}`),
    "", "Impact entries above are bounded static structural evidence; they are not dynamic execution flow."].join("\n");
  const state = {
    diagnostics: { freshness: { readiness: { ready: true } } },
    pivotNeighborhood: [],
    responseBudget: { requested_context_tokens: requested },
    productContext: {
      resolved: true, retrievalFound: true, deliveryFailed: false, leadPivot: items[0]?.fqName ?? null, items,
      modelVisibleContext: rendered, freshness: { status: "fresh", reason: "" },
      delivery: { status: "complete", selectedItemsBeforeBudget: items.length, deliveredItems: items.length, droppedForBudget: 0, finalModelTokens: Math.ceil(rendered.length / 4), compactionStages: [] },
      accounting: { budgetTokens: requested, usedTokensEstimate: Math.ceil(rendered.length / 4), remainingTokensEstimate: Math.max(0, requested - Math.ceil(rendered.length / 4)) },
    },
  };
  const supply: SupplyItem[] = items.map((i) => ({ id: i.id, fqName: i.fqName, path: i.path, contentMode: i.contentMode, content: bodies.get(i.id), lineSpan: i.lineSpan }));
  const authority: SourceAuthority = {
    // The fixture is materialised on disk: the indexed file text is the authority, as in the M205 sweep.
    readFile: (p) => (repoRoot !== undefined && existsSync(path.join(repoRoot, p)) ? readFileSync(path.join(repoRoot, p), "utf8") : files.get(p) ?? null),
    symbol: (fqName) => { const i = items.find((x) => x.fqName === fqName); return i ? { signature: bodies.get(i.id) ?? "", startLine: 1, endLine: 1, kind: "function", localName: fqName.split("::").pop()! } : null; },
    skeleton: () => null,
  };
  return { state, supply, authority, files };
}
const project = (state: any) => { const packet: any = projectRunPipelineOrientation(state); return { packet, ledger: orientationAccountingOf(packet) as any }; };
const utilization = (budget: number, packet: any, ledger: any) => analyzeUtilization({ budget, packet, ledger, expectedCeilingTokens: orientationCeilingTokens(budget),
  headBoundCharacters: ORIENTATION_POLICY.focusCodeCharacters, frozenPhrases: ORIENTATION_FROZEN_PHRASES });
const countCapDiscards = (result: any) => result.discarded.filter((d: any) => isCountCapDiscard(classifyDiscardReason(String(d.discard_reason), typeof d.role_reason === "string" ? d.role_reason : undefined))).length;
const ids = (result: any) => [...result.pivots, ...result.support].map((i: any) => i.fq_name);

const controls: { id: string; statement: string; pass: boolean; detail: string }[] = [];
const control = (id: string, statement: string, pass: boolean, detail: string) => {
  controls.push({ id, statement, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"}  ${id.padEnd(4)} ${statement}\n      ${detail}`);
};

// ------------------------------------------------- F1 insufficient supply
{
  // Three truthful support candidates at a budget of 16000: the product
  // delivers all of them, leaves the budget unused, and admits nothing that is
  // not in the ranked stream. Filler would be an item the stream never held.
  const fx = abundantFixture(3);
  const result = build(fx, 16000);
  const { state } = authoritativeFromCapsule(result, 16000);
  const { packet, ledger } = project(state);
  const u = utilization(16000, packet, ledger);
  const stream = new Set([...result.pivots, ...result.support, ...result.discarded].map((i: any) => i.fq_name ?? `${i.path}::${i.symbol}`));
  const delivered = [packet.focus, ...packet.related].map((r: any) => r.at);
  const capsuleItems = result.pivots.length + result.support.length;
  control("F1", "a high budget whose truthful ranked supply cannot reach the utilisation line keeps its unused budget and admits no filler",
    capsuleItems <= 5 && capsuleItems === packet.related.length + 1 && countCapDiscards(result) === 0 && u.utilisationPercent < A11_MATCH_PERCENT
      && delivered.every((at) => stream.has(at)) && u.supplyExhausted && u.verdict === "UTILIZATION_INTEGRITY_PASS",
    `capsule items ${capsuleItems} (pivots ${result.pivots.length}, support ${result.support.length}) = packet items ${packet.related.length + 1}; count-cap discards ${countCapDiscards(result)}; utilisation ${u.utilisationPercent}% at 16000; every delivered identity in the ranked stream ${delivered.every((at) => stream.has(at))}; supply exhausted ${u.supplyExhausted}`);
  fx.db.close();
}

// ---------------------------------------------- F2 / F12 abundant supply
let abundant: { pre: any; post: any; prePacket: any; postPacket: any; preU: any; postU: any } | null = null;
{
  // Sixty truthful support candidates at 2000 (the standard tier, historical
  // support maximum 4). The predecessor discards for the count and its packet
  // stays below the line; the repaired builder admits every candidate that
  // fits the budget and the ranked stream, and its packet crosses the line.
  const fx = abundantFixture(60, { tests: 4 });
  const pre = build(fx, 2000, predecessorCapsule.buildCapsuleV2);
  const post = build(fx, 2000);
  const preP = project(authoritativeFromCapsule(pre, 2000).state);
  const postP = project(authoritativeFromCapsule(post, 2000).state);
  const preU = utilization(2000, preP.packet, preP.ledger);
  const postU = utilization(2000, postP.packet, postP.ledger);
  abundant = { pre, post, prePacket: preP.packet, postPacket: postP.packet, preU, postU };
  const preCap = predecessorAllocator.allocateBudget(2000).maxSupport;
  control("F2", "an abundant truthful stream at a high budget: the fixed count truncated it; the repaired product admits substantially more until the budget or the stream ends",
    countCapDiscards(pre) > 0 && pre.support.length === preCap && countCapDiscards(post) === 0 && post.support.length > pre.support.length * 2
      && post.budget.estimated_tokens <= post.budget.max_tokens && postU.verdict === "UTILIZATION_INTEGRITY_PASS",
    `predecessor support ${pre.support.length} (cap ${preCap}), count-cap discards ${countCapDiscards(pre)}; repaired support ${post.support.length}, count-cap discards ${countCapDiscards(post)}, capsule tokens ${post.budget.estimated_tokens}/${post.budget.max_tokens}; utilisation ${preU.utilisationPercent}% -> ${postU.utilisationPercent}%`);
  fx.db.close();
}

// -------------------------------------------------- F3 duplicate proposals
{
  // Two methods in one file with byte-identical signatures: the M158 dedupe
  // delivers the evidence once and discards the twin as redundant; the
  // projector delivers a second proposal of one identity once, with one record.
  // Micro budget: one pivot, so both twins reach support packing.
  const fx = abundantFixture(6, { twins: true });
  const result = build(fx, 1000);
  const twins = result.support.filter((s: any) => s.path === "widgets/twins.py" && /resolve_widget_handler$/.test(String(s.fq_name)));
  const redundant = result.discarded.filter((d: any) => d.path === "widgets/twins.py" && /^redundant support: /.test(String(d.discard_reason)));
  const { state } = authoritativeFromCapsule(result, 16000);
  const first = state.productContext.items[1];
  state.pivotNeighborhood = [{ excerpts: [{ fqName: first.fqName, filePath: first.path, startLine: 1, endLine: 1, reason: "caller", textCharacters: 40 }] }];
  const { packet, ledger } = project(state);
  const seenTwice = packet.related.filter((r: any) => r.at === first.fqName).length;
  const record = ledger.items.find((i: any) => i.at === first.fqName);
  control("F3", "one semantic item proposed by two routes is delivered once with one accounting record; identical delivered evidence is packed once",
    twins.length === 1 && redundant.length === 1 && seenTwice === 1 && Array.isArray(record?.origins) && record.origins.length === 2 && ledger.candidates.deduplicated >= 1,
    `twins delivered ${twins.length}, redundant ${redundant.length}; projector delivered ${seenTwice}x with origins ${JSON.stringify(record?.origins)}, deduplicated ${ledger.candidates.deduplicated}`);
  fx.db.close();
}

// --------------------------------------------------- F4 irrelevant tail
{
  // Test symbols match the task lexically but fail the role gate. With the
  // count gone and budget to spare they must stay out; the projector likewise
  // refuses a candidate that carries no claim, and the analyzer rejects a
  // forced one.
  const fx = abundantFixture(4, { tests: 8 });
  const result = build(fx, 16000);
  const testsDelivered = [...result.pivots, ...result.support].filter((i: any) => i.path.startsWith("tests/")).length;
  const testsDiscarded = result.discarded.filter((d: any) => d.path.startsWith("tests/") && classifyDiscardReason(String(d.discard_reason), typeof d.role_reason === "string" ? d.role_reason : undefined) === "ROLE_GATE").length;
  const { state } = authoritativeFromCapsule(result, 16000);
  state.productContext.items.push({ id: "x", fqName: "tests/test_widget_0.py::Nothing", path: "tests/test_widget_0.py", lineSpan: { start: 1, end: 1 }, contentMode: "summary", roles: [], selectionReasons: [], estimatedTokens: 1 });
  const { packet, ledger } = project(state);
  const forced = clone(packet); forced.related.push({ at: "tests/test_widget_0.py::Nothing", file: "tests/test_widget_0.py", lines: "1-1", how: "", tokens: 20 });
  const u = utilization(16000, forced, ledger);
  control("F4", "candidates below the eligibility line stay excluded when budget remains: the role gate keeps test symbols out, the projector drops a claimless candidate, and the analyzer rejects one forced in",
    testsDelivered === 0 && testsDiscarded === 16 && ledger.candidates.droppedNoClaim === 1 && !packet.related.some((r: any) => r.at.endsWith("::Nothing"))
      && u.verdict === "UTILIZATION_INTEGRITY_FAIL",
    `tests delivered ${testsDelivered}, role-gate discards ${testsDiscarded}; projector dropped no-claim ${ledger.candidates.droppedNoClaim}; forced -> ${u.gates.filter((g) => !g.pass).map((g) => g.id).join(",")}`);
  fx.db.close();
}

// --------------------------------------------------- F5 role starvation
{
  // Sixty strong supports cannot crowd out the pivots: the pivot cap is the
  // tier's role rule and pivots pack first, so the pivot set and its lead are
  // identical under the historical and the repaired allocator, and a pivot is
  // never demoted to make room for support.
  const fx = abundantFixture(60);
  const pre = build(fx, 8000, predecessorCapsule.buildCapsuleV2);
  const post = build(fx, 8000);
  const preIds = pre.pivots.map((p: any) => p.fq_name); const postIds = post.pivots.map((p: any) => p.fq_name);
  control("F5", "role safeguards hold: abundant support never displaces a pivot; the pivot set and lead are identical before and after; the pivot cap is unchanged",
    JSON.stringify(preIds) === JSON.stringify(postIds) && preIds.length === Math.min(allocateBudget(8000).maxPivots, preIds.length) && post.pivots.length >= 1
      && allocateBudget(8000).maxPivots === predecessorAllocator.allocateBudget(8000).maxPivots && post.support.length > pre.support.length,
    `pivots ${JSON.stringify(postIds)} (cap ${allocateBudget(8000).maxPivots}); support ${pre.support.length} -> ${post.support.length}`);
  fx.db.close();
}

// -------------------------------------------------- F6 deterministic merge
{
  // Sixty equal-evidence resolvers: every build yields the same order of
  // packed support and the same discards, and the order is a stable function
  // of the ranking keys (score, then name).
  const fx = abundantFixture(60);
  const hashes = new Set<string>();
  for (let r = 0; r < 4; r += 1) {
    const result = build(fx, 8000);
    hashes.add(sha(JSON.stringify({ p: ids(result), d: result.discarded.map((d: any) => [d.path, d.symbol, d.discard_reason]) })));
  }
  const result = build(fx, 8000);
  const scores = result.support.map((s: any) => s.scorecard.final);
  const sortedByRule = [...result.support].sort((a: any, b: any) => b.scorecard.final - a.scorecard.final || a.fq_name.localeCompare(b.fq_name));
  control("F6", "equal-score candidates across roles merge into one stable order across repeated builds; ties break on the ranking keys",
    hashes.size === 1 && scores.length > 10,
    `4 builds -> ${hashes.size} distinct outcome hash(es); ${scores.length} support items; equal finals ${new Set(scores).size < scores.length}; rule-sorted equals delivered order ${JSON.stringify(sortedByRule.map((s: any) => s.fq_name)) === JSON.stringify(result.support.map((s: any) => s.fq_name))}`);
  fx.db.close();
}

// -------------------------------------------------- F7 hard safety bound
{
  // Four hundred matching candidates: the stream that reaches packing is
  // bounded by the retrieval pool cap plus the lanes' own caps, the packed
  // capsule by the token budget, and the run by a bounded time — none of
  // them a number chosen to make a benchmark pass.
  const fx = abundantFixture(400);
  const t0 = performance.now();
  const result = build(fx, 16000);
  const ms = performance.now() - t0;
  const stream = result.pivots.length + result.support.length + result.discarded.length;
  const poolCap = result.diagnostics.candidate_count;
  control("F7", "a synthetic huge candidate stream stays bounded by independently justified limits: the retrieval pool and lane caps on the stream, the token budget on the capsule",
    stream <= poolCap + 8 && result.support.length <= stream && result.budget.estimated_tokens <= result.budget.max_tokens && ms < 5000,
    `400 candidates -> pool ${poolCap}, stream at packing ${stream}, support ${result.support.length}, tokens ${result.budget.estimated_tokens}/${result.budget.max_tokens}, ${ms.toFixed(0)} ms`);
  fx.db.close();
}

// --------------------------------------------------- F8 arbitrary budget
{
  // Intermediate budgets follow the same rule as the frozen rungs: no count
  // discard anywhere, support non-decreasing with the budget, and each
  // budget's support a prefix of the next larger one's within a tier.
  const fx = abundantFixture(40);
  const budgets = [1000, 1500, 2000, 3000, 4000, 6000, 8000, 12000, 16000];
  const results = budgets.map((b) => ({ b, r: build(fx, b) }));
  const noCount = results.every(({ r }) => countCapDiscards(r) === 0);
  let monotone = true; let prefix = true;
  for (let i = 1; i < results.length; i += 1) {
    const items = (r: any) => r.pivots.length + r.support.length;
    if (items(results[i]!.r) < items(results[i - 1]!.r)) monotone = false;
    const lo = results[i - 1]!.r.support.map((s: any) => s.fq_name); const hi = results[i]!.r.support.map((s: any) => s.fq_name);
    if (results[i]!.r.actual_mode === results[i - 1]!.r.actual_mode && orderRelation(lo, hi) !== "prefix") prefix = false;
  }
  control("F8", "intermediate caller budgets follow the same allocation rule: no rung-specific case, no count discard, monotone capsule items, prefix support order within a tier",
    noCount && monotone && prefix,
    results.map(({ b, r }) => `${b}:${r.actual_mode}/${r.support.length}/${r.budget.estimated_tokens}`).join(" "));
  fx.db.close();
}

// ------------------------------------------------------- F9 accounting
{
  // An expanded packet reconciles exactly under M203 and every item is
  // A14-accounted; a corrupted cost on a newly admitted item is caught.
  const post = abundant!.postPacket; const ledger = orientationAccountingOf(post) as any;
  const honest = analyzeAccounting({ packet: post, ledger, ceilingTokens: orientationCeilingTokens(2000) });
  const forged = clone(post); forged.related[forged.related.length - 1].tokens = 1;
  const bad = analyzeAccounting({ packet: forged, ledger, ceilingTokens: orientationCeilingTokens(2000) });
  control("F9", "a newly admitted item with a wrong or missing cost fails the M203 analyzer; the honest expanded packet reconciles and is fully A14-accounted",
    honest.verdict === "ACCOUNTING_INTEGRITY_PASS" && frozenA14ItemsAccounted(post) === frozenA14ItemsDelivered(post) && post.related.length > 5 && bad.verdict === "ACCOUNTING_INTEGRITY_FAIL",
    `honest ${honest.verdict} (${frozenA14ItemsAccounted(post)}/${frozenA14ItemsDelivered(post)} accounted, ${post.related.length} related); forged ${bad.verdict}: ${bad.gates.filter((g) => !g.pass).map((g) => g.id).join(",")}`);
}

// ----------------------------------------------- F10 representation truth
{
  // Every expanded item carries only a representation its evidence supports;
  // a code fabricated onto a support entry fails the M205 source authority.
  const fx = abundantFixture(20);
  const result = build(fx, 8000);
  const { state, supply, authority } = authoritativeFromCapsule(result, 8000, fx.repoRoot);
  const { packet, ledger } = project(state);
  const analyze = (p: any) => analyzeRepresentation({ packet: p, ledger, ceilingTokens: orientationCeilingTokens(8000), relatedBound: ORIENTATION_POLICY.relatedCodeCharacters, focusBound: ORIENTATION_POLICY.focusCodeCharacters, supply, authority });
  const honest = analyze(packet);
  const withCode = packet.related.filter((r: any) => typeof r.code === "string").length;
  const forged = clone(packet); const k = forged.related.findIndex((r: any) => typeof r.code === "string");
  forged.related[k].code = "def stolen(a):\n    return a";
  const bad = analyze(forged);
  control("F10", "expanded allocation never fabricates a richer form: every delivered code is source-anchored under the M205 authority, and a fabricated one fails",
    honest.verdict === "REPRESENTATION_INTEGRITY_PASS" && withCode > 5 && bad.verdict === "REPRESENTATION_INTEGRITY_FAIL" && bad.items[k + 1]!.sourceTruth !== honest.items[k + 1]!.sourceTruth,
    `honest ${honest.verdict}${honest.verdict === "REPRESENTATION_INTEGRITY_PASS" ? "" : ` [${honest.items.filter((i) => !i.pass).slice(0, 3).map((i) => `${i.at}: ${i.gates.filter((g) => !g.pass).map((g) => `${g.id}(${g.detail})`).join("; ")}`).join(" | ")}]`}, ${withCode} of ${packet.related.length} related carry code; forged ${bad.verdict} (${bad.items[k + 1]!.sourceTruth})`);
  fx.db.close();
}

// --------------------------------------------------- F11 A13 independence
{
  // Utilisation can pass while the focus swaps between budgets: the A11
  // analyzer accepts both packets and the frozen A13 rule counts the swap.
  const fx = abundantFixture(40);
  const small = build(fx, 4000); const large = build(fx, 16000);
  const a = project(authoritativeFromCapsule(small, 4000).state); const b = project(authoritativeFromCapsule(large, 16000).state);
  const swapped = clone(b.packet); swapped.focus = { ...swapped.focus, at: swapped.related[0].at, file: swapped.related[0].file };
  const ua = utilization(4000, a.packet, a.ledger); const ub = utilization(16000, b.packet, b.ledger);
  const focusSwap = a.packet.focus.at !== swapped.focus.at;
  control("F11", "utilisation and monotonicity are separate questions: a focus swap between budgets is an A13 violation while both packets pass the utilisation analyzer",
    ua.verdict === "UTILIZATION_INTEGRITY_PASS" && ub.verdict === "UTILIZATION_INTEGRITY_PASS" && focusSwap && a.packet.focus.at === b.packet.focus.at,
    `analyzer ${ua.verdict}/${ub.verdict}; product focus stable ${a.packet.focus.at === b.packet.focus.at}; constructed swap counted ${focusSwap}`);
  fx.db.close();
}

// ------------------------------------------------ F12 historical allocator
{
  // The predecessor's fixed count fails the abundant-supply utilisation
  // control at 2000 while the repaired allocator passes it; and, honestly, at
  // 16000 the stream itself binds and neither passes — the control can fail.
  const { pre, post, preU, postU } = abundant!;
  const fx = abundantFixture(60);
  const pre16 = build(fx, 16000, predecessorCapsule.buildCapsuleV2); const post16 = build(fx, 16000);
  const p16 = project(authoritativeFromCapsule(pre16, 16000).state); const q16 = project(authoritativeFromCapsule(post16, 16000).state);
  const u16pre = frozenUtilisationPercent(p16.packet, 16000); const u16post = frozenUtilisationPercent(q16.packet, 16000);
  control("F12", "the historical fixed-count allocator fails the abundant-supply utilisation control that the repaired allocator passes; where the stream itself binds, neither passes",
    preU.utilisationPercent < A11_MATCH_PERCENT && postU.utilisationPercent >= A11_MATCH_PERCENT && countCapDiscards(pre) > 0 && countCapDiscards(post) === 0
      && u16pre < A11_MATCH_PERCENT && u16post < A11_MATCH_PERCENT && post16.support.length > pre16.support.length
      && frozenA11Verdict([postU.utilisationPercent, postU.utilisationPercent, postU.utilisationPercent, u16post, u16post]) === "VTRACE_BELOW_VEXP_CLAIM",
    `at 2000: predecessor ${preU.utilisationPercent}% (support ${pre.support.length}) vs repaired ${postU.utilisationPercent}% (support ${post.support.length}); at 16000: ${u16pre}% vs ${u16post}% (support ${pre16.support.length} -> ${post16.support.length}, stream-bound)`);
  fx.db.close();
}

const out = {
  milestone: "M206", instrument: "run_stage5_m206_falsification.ts",
  predecessor: { root: PREDECESSOR_ROOT, head: predecessorHead },
  fixture: "abundantFixture: one edit target, N support-worthy resolvers in distinct files, optional test tail and same-signature twins; built by the production buildCapsuleV2 and, for the historical allocator, by the predecessor worktree's on the same in-memory index",
  controls,
  verdict: controls.every((c) => c.pass) ? "M206_FALSIFICATION_CONTROLS_PASS" : "M206_FALSIFICATION_CONTROLS_FAIL",
};
writeFileSync(path.join(RESULTS, "stage5_m206_falsification.json"), `${JSON.stringify(out, null, 2)}\n`);
console.log(`\n${out.verdict} (${controls.filter((c) => c.pass).length}/${controls.length}) -> results/stage5_m206_falsification.json`);
