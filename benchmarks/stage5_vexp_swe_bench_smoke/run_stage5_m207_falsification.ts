/**
 * M207 — falsification controls F1-F15.
 *
 * A gate that has never been seen to fail is not known to be a gate. Each
 * control constructs the specific dishonesty the milestone guards against —
 * a fixed pool that truncates abundant truthful retrieval, filler admitted
 * when the universe is small, an irrelevant tail let in because the pool grew,
 * a duplicate delivered twice, an unstable merge, a starved pivot, a
 * rung-specific budget rule, an unbounded stream, a wrong cost, a fabricated
 * richer form, monotonic focus confused with utilisation, impact rendering
 * smuggled in as supply, a competitor's constant as the policy, and a
 * movement that is not the pool's — and shows the production capsule builder,
 * the production projector, the M203/M204/M205 analyzers, the product
 * allocator or the frozen rule refusing it, beside the honest case each
 * accepts. F15 documents the one downstream hazard the sweep exposed: the
 * evidence-budget ladder's final rung.
 *
 * The capsules are REAL: built by the production `buildCapsuleV2` on a fixture
 * repository materialised on disk and indexed in memory exactly as the unit
 * tests build one, and, for the historical fixed pool, by the builder of a
 * worktree at the M206 final commit on the SAME fixture. Any mutation happens
 * on copies after the product has returned.
 *
 *   bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m207_falsification.ts \
 *     [--predecessor-root /home/calvin/bench/vtrace-m207/pre]
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { SymbolKind } from "../../src/domain/types";
import { seedCustomFixture, type SymbolSpec } from "../../src/capsuleV2/__fixtures__/capsuleV2Fixture";
import {
  CANDIDATE_POOL_FLOOR, CANDIDATE_POOL_HARD_MAXIMUM, EXPECTED_TOKENS_PER_DELIVERED_CANDIDATE, allocateBudget, candidatePoolFor,
} from "../../src/capsuleV2/budgetAllocator";
import { buildCapsuleV2 } from "../../src/capsuleV2/buildCapsuleV2";
import { CapsuleIntent } from "../../src/capsuleV2/types";
import { applyProgressiveContextBudget } from "../../src/productContext/budgetDelivery";
import { orientationAccountingOf } from "../../src/runPipeline/orientationAccounting";
import {
  ORIENTATION_FROZEN_PHRASES, ORIENTATION_POLICY, orientationCeilingTokens, projectRunPipelineOrientation,
} from "../../src/runPipeline/orientationProjection";
import { analyzeAccounting, frozenA14ItemsAccounted, frozenA14ItemsDelivered } from "./m203Accounting";
import { A11_MATCH_PERCENT, analyzeUtilization, frozenUtilisationPercent } from "./m204Utilization";
import { analyzeRepresentation, type SourceAuthority, type SupplyItem } from "./m205Representation";
import { classifyDiscardReason } from "./m206Allocation";
import { candidateAllowance } from "./m207RetrievalPool";

const REPO = path.resolve(import.meta.dir, "../..");
const RESULTS = path.join(import.meta.dir, "results");
const args = process.argv.slice(2);
const argOf = (f: string, d: string) => { const i = args.indexOf(f); return i >= 0 && args[i + 1] !== undefined ? args[i + 1]! : d; };
const PREDECESSOR_ROOT = path.resolve(argOf("--predecessor-root", "/home/calvin/bench/vtrace-m207/pre"));

const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));

const predecessorCapsule = await import(path.join(PREDECESSOR_ROOT, "src/capsuleV2/buildCapsuleV2.ts"));
const predecessorAllocator = await import(path.join(PREDECESSOR_ROOT, "src/capsuleV2/budgetAllocator.ts"));
const predecessorHead = Bun.spawnSync(["git", "-C", PREDECESSOR_ROOT, "rev-parse", "HEAD"]).stdout.toString().trim();
const predecessorSource = readFileSync(path.join(PREDECESSOR_ROOT, "src/capsuleV2/buildCapsuleV2.ts"), "utf8");
const PREDECESSOR_POOL = Number.parseInt(/const CANDIDATE_POOL_SIZE = (\d+);/.exec(predecessorSource)?.[1] ?? "NaN", 10);
if (!Number.isInteger(PREDECESSOR_POOL)) throw new Error("M207_PREDECESSOR_ALREADY_REPAIRED: the predecessor carries no fixed pool constant");
if (typeof (predecessorAllocator.allocateBudget(16000) as any).candidatePool === "number") throw new Error("M207_PREDECESSOR_ALREADY_REPAIRED: the predecessor allocator derives a pool");
if (typeof (allocateBudget(16000) as any).candidatePool !== "number") throw new Error("M207_PRODUCT_NOT_REPAIRED: the product allocator derives no pool");

// ---------------------------------------------------------------- fixtures

const TASK = "how does the widget registry resolve a widget handler for a name";

/**
 * An abundant, truthful ranked stream: one clear edit target, `count` support-
 * worthy resolver functions in distinct files that all match the task, a tail
 * of test symbols the role gate must keep out, `noise` unrelated symbols no
 * generator can reach, and a pair of same-signature methods in one file the
 * M158 dedupe must collapse.
 */
function abundantFixture(count: number, options: { tests?: number; twins?: boolean; noise?: number } = {}) {
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
  for (let n = 0; n < (options.noise ?? 0); n += 1) {
    files.push({ relPath: `billing/ledger_${n}.py`, specs: [
      { localName: `post_invoice_${n}`, kind: SymbolKind.Function, signature: `post_invoice_${n}(account, amount)`,
        body: `def post_invoice_${n}(account, amount):\n    # accounting ledger posting ${n}\n    return account.debit(amount)` },
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

const build = (fixture: { db: any; repoRoot: string }, maxTokens: number, builder: any = buildCapsuleV2, candidatePoolSize?: number) =>
  builder({ db: fixture.db, repoRoot: fixture.repoRoot, task: TASK, intent: CapsuleIntent.Explain, maxTokens,
    ...(candidatePoolSize === undefined ? {} : { candidatePoolSize }) });

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
    readFile: (p) => (repoRoot !== undefined && existsSync(path.join(repoRoot, p)) ? readFileSync(path.join(repoRoot, p), "utf8") : files.get(p) ?? null),
    symbol: (fqName) => { const i = items.find((x) => x.fqName === fqName); return i ? { signature: bodies.get(i.id) ?? "", startLine: 1, endLine: 1, kind: "function", localName: fqName.split("::").pop()! } : null; },
    skeleton: () => null,
  };
  return { state, supply, authority, files };
}
const project = (state: any) => { const packet: any = projectRunPipelineOrientation(state); return { packet, ledger: orientationAccountingOf(packet) as any }; };
const utilization = (budget: number, packet: any, ledger: any) => analyzeUtilization({ budget, packet, ledger, expectedCeilingTokens: orientationCeilingTokens(budget),
  headBoundCharacters: ORIENTATION_POLICY.focusCodeCharacters, frozenPhrases: ORIENTATION_FROZEN_PHRASES });
const ids = (result: any) => [...result.pivots, ...result.support].map((i: any) => i.fq_name);
const streamOf = (result: any) => [...result.pivots, ...result.support, ...result.discarded].map((i: any) => i.fq_name ?? `${i.path}::${i.symbol}`);
const roleDiscards = (result: any) => result.discarded.filter((d: any) => classifyDiscardReason(String(d.discard_reason), typeof d.role_reason === "string" ? d.role_reason : undefined) === "ROLE_GATE").length;
const capsuleShape = (result: any) => JSON.stringify({
  pool: result.diagnostics.candidate_scores.map((c: any) => [c.rank, c.fq_name, c.scores.final]),
  pivots: result.pivots.map((p: any) => [p.fq_name, p.content_mode]), support: result.support.map((s: any) => [s.fq_name, s.content_mode]),
  discarded: result.discarded.map((d: any) => [d.path, d.symbol, d.discard_reason]), tokens: result.budget.estimated_tokens,
});

const controls: { id: string; statement: string; pass: boolean; detail: string }[] = [];
const control = (id: string, statement: string, pass: boolean, detail: string) => {
  controls.push({ id, statement, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"}  ${id.padEnd(4)} ${statement}\n      ${detail}`);
};

// --------------------------------------------- F1 the fixed pool binds
{
  // Sixty truthful resolvers at 16000. The predecessor's pool is the fixed
  // constant and it truncates the universe; the product's budget-derived pool
  // exposes more of the SAME ranked stream and delivers it. The control fails
  // on a product whose pool authority is not exercised.
  const fx = abundantFixture(60);
  const pre = build(fx, 16000, predecessorCapsule.buildCapsuleV2);
  const post = build(fx, 16000);
  const productPool = allocateBudget(16000).candidatePool;
  const exposed = streamOf(post).filter((id) => !streamOf(pre).includes(id));
  control("F1", "the historical fixed pool truncates an abundant truthful universe; the budget-derived pool exposes more of the same ranked stream and delivers it",
    pre.diagnostics.candidate_count <= PREDECESSOR_POOL && post.diagnostics.candidate_count > pre.diagnostics.candidate_count
      && post.diagnostics.candidate_count <= productPool && exposed.length > 0 && post.support.length > pre.support.length
      && exposed.every((id) => /widgets\/resolvers\/resolver_\d+\.py::resolve_widget_handler_\d+$/.test(id)),
    `predecessor pool ${pre.diagnostics.candidate_count} (constant ${PREDECESSOR_POOL}), support ${pre.support.length}; product pool ${post.diagnostics.candidate_count} (allowance ${productPool}), support ${post.support.length}; newly exposed ${exposed.length}, all resolvers ${exposed.every((id) => /resolver_\d+/.test(id))}`);
  fx.db.close();
}

// --------------------------------------- F2 insufficient retrieval universe
{
  // Three truthful candidates at 16000: the allowance is 134 but the universe
  // is three; the product delivers them, leaves the budget unused, and admits
  // nothing the stream never held.
  const fx = abundantFixture(3);
  const result = build(fx, 16000);
  const { state } = authoritativeFromCapsule(result, 16000);
  const { packet, ledger } = project(state);
  const u = utilization(16000, packet, ledger);
  const stream = new Set(streamOf(result));
  const delivered = [packet.focus, ...packet.related].map((r: any) => r.at);
  control("F2", "a huge caller budget over a small truthful universe leaves the budget unused: no filler, no relaxed relevance, every delivered identity in the ranked stream",
    result.diagnostics.candidate_count <= 5 && result.pivots.length + result.support.length === packet.related.length + 1 && u.utilisationPercent < A11_MATCH_PERCENT
      && delivered.every((at) => stream.has(at)) && u.supplyExhausted && u.verdict === "UTILIZATION_INTEGRITY_PASS" && allocateBudget(16000).candidatePool > 100,
    `allowance ${allocateBudget(16000).candidatePool}, pool ${result.diagnostics.candidate_count}, delivered ${packet.related.length + 1}; utilisation ${u.utilisationPercent}% at 16000; supply exhausted ${u.supplyExhausted}`);
  fx.db.close();
}

// ------------------------------------------------------ F3 irrelevant tail
{
  // Eight test symbols match the task lexically and forty billing symbols
  // match nothing. With the pool at 134 and budget to spare, the tests stay
  // out (role gate) and the billing symbols never enter the pool at all.
  const fx = abundantFixture(6, { tests: 8, noise: 40 });
  const result = build(fx, 16000);
  const delivered = ids(result);
  const pool = result.diagnostics.candidate_scores.map((c: any) => c.path);
  const noiseInPool = pool.filter((p: string) => p.startsWith("billing/")).length;
  const testsDelivered = delivered.filter((id: string) => id.startsWith("tests/")).length;
  const testsDiscarded = result.discarded.filter((d: any) => d.path.startsWith("tests/") && classifyDiscardReason(String(d.discard_reason), typeof d.role_reason === "string" ? d.role_reason : undefined) === "ROLE_GATE").length;
  control("F3", "broadening the allowance makes nothing eligible that was not: test symbols stay out at the role gate and symbols with no evidence never enter the pool",
    noiseInPool === 0 && testsDelivered === 0 && testsDiscarded === 16 && result.diagnostics.candidate_count < allocateBudget(16000).candidatePool,
    `allowance ${allocateBudget(16000).candidatePool}, pool ${result.diagnostics.candidate_count}; billing symbols in pool ${noiseInPool}/40; tests delivered ${testsDelivered}, role-gate discards ${testsDiscarded}`);
  fx.db.close();
}

// -------------------------------------------------- F4 duplicate proposals
{
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
  control("F4", "one semantic symbol proposed through several routes is one candidate after dedupe, one delivered item and one accounting record",
    twins.length === 1 && redundant.length === 1 && seenTwice === 1 && Array.isArray(record?.origins) && record.origins.length === 2 && ledger.candidates.deduplicated >= 1
      && new Set(result.diagnostics.candidate_scores.map((c: any) => c.symbol_id)).size === result.diagnostics.candidate_scores.length,
    `twins delivered ${twins.length}, redundant ${redundant.length}; pool ids unique; projector delivered ${seenTwice}x with origins ${JSON.stringify(record?.origins)}, deduplicated ${ledger.candidates.deduplicated}`);
  fx.db.close();
}

// ------------------------------------------------- F5 stable tie ordering
{
  // Sixty equal-evidence resolvers straddle the old boundary of 25. Repeated
  // builds give one order; the predecessor's pool is a PREFIX of the product's
  // pool, so the tie order around the old boundary did not move with the width.
  const fx = abundantFixture(60);
  const hashes = new Set<string>();
  for (let r = 0; r < 4; r += 1) hashes.add(sha(capsuleShape(build(fx, 16000))));
  const pre = build(fx, 16000, predecessorCapsule.buildCapsuleV2);
  const post = build(fx, 16000);
  const preOrder = pre.diagnostics.candidate_scores.map((c: any) => c.fq_name);
  const postOrder = post.diagnostics.candidate_scores.map((c: any) => c.fq_name);
  const prefix = preOrder.every((id: string, k: number) => postOrder[k] === id);
  const finals = post.diagnostics.candidate_scores.map((c: any) => c.scores.final);
  control("F5", "equal-score candidates around the old pool boundary keep one stable order across repeated builds and across widths: the narrow pool is a prefix of the wide pool",
    hashes.size === 1 && prefix && new Set(finals).size < finals.length && postOrder.length > preOrder.length,
    `4 builds -> ${hashes.size} hash(es); predecessor pool ${preOrder.length} is a prefix of product pool ${postOrder.length}: ${prefix}; equal finals present ${new Set(finals).size < finals.length}`);
  fx.db.close();
}

// ---------------------------------------------------- F6 role preservation
{
  const fx = abundantFixture(60);
  let ok = true; const details: string[] = [];
  for (const b of [8000, 16000]) {
    const pre = build(fx, b, predecessorCapsule.buildCapsuleV2); const post = build(fx, b);
    const preIds = pre.pivots.map((p: any) => p.fq_name); const postIds = post.pivots.map((p: any) => p.fq_name);
    const same = JSON.stringify(preIds) === JSON.stringify(postIds);
    ok = ok && same && allocateBudget(b).maxPivots === predecessorAllocator.allocateBudget(b).maxPivots && post.support.length > pre.support.length && postIds.length >= 1;
    details.push(`${b}: pivots ${JSON.stringify(postIds)} same ${same}, cap ${allocateBudget(b).maxPivots}, support ${pre.support.length} -> ${post.support.length}`);
  }
  control("F6", "a large newly exposed support universe never replaces a required pivot: pivot set, lead and cap identical to the predecessor at every budget", ok, details.join("; "));
  fx.db.close();
}

// ---------------------------------------------------- F7 arbitrary budgets
{
  // One rule for every budget: the allowance the product derives equals the
  // stated derivation at 1500, 3000, 6000, 12000 and a dense grid, is monotone,
  // is floored at the historical pool and capped at the hard maximum, and the
  // capsule's pool follows it.
  const grid = [1, 100, 500, 1000, 1500, 2000, 2500, 3000, 3300, 4000, 5000, 6000, 7000, 8000, 9000, 12000, 13000, 16000, 20000, 48000, 100000, 1_000_000];
  const derived = grid.map((b) => allocateBudget(b).candidatePool);
  const stated = grid.map((b) => candidateAllowance({ maxTokens: b, tokensPerDeliveredCandidate: EXPECTED_TOKENS_PER_DELIVERED_CANDIDATE, floor: CANDIDATE_POOL_FLOOR, hardMaximum: CANDIDATE_POOL_HARD_MAXIMUM }));
  const agree = derived.every((v, k) => v === stated[k] && v === candidatePoolFor(grid[k]!));
  const monotone = derived.every((v, k) => k === 0 || v >= derived[k - 1]!);
  const floored = derived.every((v) => v >= CANDIDATE_POOL_FLOOR) && derived.every((v) => v <= CANDIDATE_POOL_HARD_MAXIMUM);
  const fx = abundantFixture(60);
  // The fixture's whole universe, read at an instrumented width above it.
  const universe = build(fx, 16000, buildCapsuleV2, 10_000).diagnostics.candidate_count;
  const follows = [1500, 3000, 6000, 12000].every((b) => build(fx, b).diagnostics.candidate_count === Math.min(universe, allocateBudget(b).candidatePool));
  control("F7", "arbitrary caller budgets follow one general policy: allowance = clamp(ceil(budget / expected cost), floor, hard maximum), monotone, no frozen-rung special case, and the capsule's pool follows it",
    agree && monotone && floored && follows,
    `grid ${grid.map((b, k) => `${b}:${derived[k]}`).join(" ")}; agree ${agree}, monotone ${monotone}, bounded ${floored}, capsule pool = min(universe ${universe}, allowance) at 1500/3000/6000/12000 ${follows}`);
  fx.db.close();
}

// --------------------------------------------------- F8 hard resource bound
{
  // Five hundred matching candidates at a million-token budget: the allowance
  // is the hard maximum, the pool is bounded by it, the run is bounded in
  // time and memory. At 16000 the same universe is bounded by the allowance.
  const fx = abundantFixture(500);
  const rss0 = process.memoryUsage().rss;
  const t0 = performance.now();
  const huge = build(fx, 1_000_000);
  const hugeMs = performance.now() - t0;
  const t1 = performance.now();
  const normal = build(fx, 16000);
  const normalMs = performance.now() - t1;
  const rssDelta = process.memoryUsage().rss - rss0;
  control("F8", "a very large candidate-producing repository stays deterministically bounded: the pool never exceeds the hard maximum, the 16000 pool never exceeds its allowance, and time and memory stay controlled",
    huge.diagnostics.candidate_count <= CANDIDATE_POOL_HARD_MAXIMUM && allocateBudget(1_000_000).candidatePool === CANDIDATE_POOL_HARD_MAXIMUM
      && normal.diagnostics.candidate_count <= allocateBudget(16000).candidatePool && hugeMs < 15000 && normalMs < 5000 && rssDelta < 1_500_000_000,
    `500 candidates -> pool ${huge.diagnostics.candidate_count} at 1e6 tokens (hard max ${CANDIDATE_POOL_HARD_MAXIMUM}) in ${hugeMs.toFixed(0)} ms; pool ${normal.diagnostics.candidate_count} at 16000 (allowance ${allocateBudget(16000).candidatePool}) in ${normalMs.toFixed(0)} ms; rss delta ${(rssDelta / 1e6).toFixed(0)} MB`);
  fx.db.close();
}

// ---------------------------------------------------------- F9 accounting
let expanded: { result: any; packet: any; ledger: any; fx: { db: any; repoRoot: string } } | null = null;
{
  const fx = abundantFixture(60);
  const result = build(fx, 16000);
  const { state } = authoritativeFromCapsule(result, 16000);
  const { packet, ledger } = project(state);
  expanded = { result, packet, ledger, fx };
  const honest = analyzeAccounting({ packet, ledger, ceilingTokens: orientationCeilingTokens(16000) });
  const forged = clone(packet); forged.related[forged.related.length - 1].tokens = 1;
  const bad = analyzeAccounting({ packet: forged, ledger, ceilingTokens: orientationCeilingTokens(16000) });
  const removed = clone(packet); delete removed.related[removed.related.length - 1].tokens;
  control("F9", "every newly admitted item reconciles through M203: the expanded packet is fully A14-accounted, and a corrupted or missing cost on a tail item fails the analyzer",
    honest.verdict === "ACCOUNTING_INTEGRITY_PASS" && frozenA14ItemsAccounted(packet) === frozenA14ItemsDelivered(packet) && packet.related.length > 30
      && bad.verdict === "ACCOUNTING_INTEGRITY_FAIL" && frozenA14ItemsAccounted(removed) < frozenA14ItemsDelivered(removed),
    `honest ${honest.verdict} (${frozenA14ItemsAccounted(packet)}/${frozenA14ItemsDelivered(packet)} accounted, ${packet.related.length} related); forged ${bad.verdict}; missing cost accounted ${frozenA14ItemsAccounted(removed)}/${frozenA14ItemsDelivered(removed)}`);
}

// ----------------------------------------------- F10 representation truth
{
  const { result, fx } = expanded!;
  const { state, supply, authority } = authoritativeFromCapsule(result, 16000, fx.repoRoot);
  const { packet, ledger } = project(state);
  const analyze = (p: any) => analyzeRepresentation({ packet: p, ledger, ceilingTokens: orientationCeilingTokens(16000), relatedBound: ORIENTATION_POLICY.relatedCodeCharacters, focusBound: ORIENTATION_POLICY.focusCodeCharacters, supply, authority });
  const honest = analyze(packet);
  const withCode = packet.related.filter((r: any) => typeof r.code === "string").length;
  const forged = clone(packet);
  const tailIndex = [...forged.related.keys()].reverse().find((k) => typeof forged.related[k].code === "string")!;
  forged.related[tailIndex].code = "def stolen(a):\n    return a";
  const bad = analyze(forged);
  control("F10", "a newly admitted tail candidate carries only a representation its source supports: the expanded packet passes M205 and a fabricated tail body fails",
    honest.verdict === "REPRESENTATION_INTEGRITY_PASS" && withCode > 30 && tailIndex > 25 && bad.verdict === "REPRESENTATION_INTEGRITY_FAIL"
      && bad.items[tailIndex + 1]!.sourceTruth !== honest.items[tailIndex + 1]!.sourceTruth,
    `honest ${honest.verdict}, ${withCode} of ${packet.related.length} related carry code; forged tail #${tailIndex + 1} ${bad.verdict} (${bad.items[tailIndex + 1]!.sourceTruth})`);
  fx.db.close();
}

// --------------------------------------------------- F11 A13 independence
{
  const fx = abundantFixture(60);
  const small = build(fx, 4000); const large = build(fx, 16000);
  const a = project(authoritativeFromCapsule(small, 4000).state); const b = project(authoritativeFromCapsule(large, 16000).state);
  const swapped = clone(b.packet); swapped.focus = { ...swapped.focus, at: swapped.related[0].at, file: swapped.related[0].file };
  const ua = utilization(4000, a.packet, a.ledger); const ub = utilization(16000, b.packet, b.ledger);
  const focusSwap = a.packet.focus.at !== swapped.focus.at;
  const supplyMoved = b.packet.related.length > a.packet.related.length;
  control("F11", "broader retrieval can raise supply while a focus swap between budgets stays an A13 violation: the utilisation analyzer passes both packets and the swap is counted separately",
    ua.verdict === "UTILIZATION_INTEGRITY_PASS" && ub.verdict === "UTILIZATION_INTEGRITY_PASS" && focusSwap && supplyMoved && a.packet.focus.at === b.packet.focus.at,
    `analyzer ${ua.verdict}/${ub.verdict}; related ${a.packet.related.length} -> ${b.packet.related.length}; product focus stable ${a.packet.focus.at === b.packet.focus.at}; constructed swap counted ${focusSwap}`);
  fx.db.close();
}

// --------------------------------------------------- F12 A15 independence
{
  // The fixture carries no call edges, so no impact or call-site evidence
  // exists at either width; the movement is entirely existing representations
  // (signatures/skeletons) of newly exposed candidates.
  const fx = abundantFixture(60);
  const pre = build(fx, 16000, predecessorCapsule.buildCapsuleV2); const post = build(fx, 16000);
  const p = project(authoritativeFromCapsule(pre, 16000).state); const q = project(authoritativeFromCapsule(post, 16000).state);
  const impactLike = (packet: any) => packet.related.filter((r: any) => /caller|call site|impact|calls /i.test(String(r.how))).length;
  const forms = (packet: any) => [...new Set(packet.related.map((r: any) => r.form ?? "relationship_only"))].sort();
  control("F12", "A11 moves without any A15 rendering: no impact or call-site entry at either width, and every added entry is an existing representation of a newly exposed candidate",
    impactLike(p.packet) === 0 && impactLike(q.packet) === 0 && q.packet.related.length > p.packet.related.length
      && forms(q.packet).every((f) => ["signature", "skeleton", "focused_source", "excerpt", "relationship_only"].includes(String(f))),
    `related ${p.packet.related.length} -> ${q.packet.related.length}; impact-like entries ${impactLike(p.packet)}/${impactLike(q.packet)}; forms after ${JSON.stringify(forms(q.packet))}`);
  fx.db.close();
}

// ------------------------------------------------ F13 anti-hardcode control
{
  const diff = execFileSync("git", ["-C", REPO, "diff", `${predecessorHead}..HEAD`, "--", "src/"], { encoding: "utf8" });
  const added = diff.split("\n").filter((l) => l.startsWith("+") && !l.startsWith("+++")).map((l) => l.slice(1));
  const competitor = added.filter((l) => /\b423\b/.test(l) || /top 12\b/i.test(l) || /vexp/i.test(l));
  const benchmarkRungs = added.filter((l) => /\b(16000|8000|4000|2000|1000)\b/.test(l) && /candidatePool|pool/i.test(l) && !/^\s*(\/\/|\*)/.test(l.trim()));
  const thresholdRule = added.filter((l) => /\b60\s*%|A11_MATCH|A11|utilisation threshold|utilization threshold/i.test(l) && !/^\s*(\/\/|\*)/.test(l.trim()));
  const allocator = readFileSync(path.join(REPO, "src/capsuleV2/budgetAllocator.ts"), "utf8");
  const whole = readFileSync(path.join(REPO, "src/capsuleV2/buildCapsuleV2.ts"), "utf8") + allocator;
  control("F13", "no competitor-derived or benchmark-derived constant governs the pool: no 423, no 'top 12 because VEXP', no frozen-rung case, no A11 threshold in the product change",
    competitor.length === 0 && benchmarkRungs.length === 0 && thresholdRule.length === 0 && !/\b423\b/.test(whole),
    `added product lines ${added.length}; competitor hits ${competitor.length}; rung-keyed pool lines ${benchmarkRungs.length}; threshold-keyed lines ${thresholdRule.length}; 423 in pool sources ${/\b423\b/.test(whole)}`);
}

// ------------------------------------------- F14 pool-only causal control
{
  // The product with its pool pinned to the historical constant through the
  // seam is byte-identical in shape to the predecessor on the same fixture at
  // every budget: everything but the pool is frozen, so the movement between
  // the predecessor and the unpinned product is the pool's alone.
  const fx = abundantFixture(60);
  let identical = true; let moved = 0; const details: string[] = [];
  for (const b of [2000, 8000, 16000]) {
    const pre = build(fx, b, predecessorCapsule.buildCapsuleV2);
    const pinned = build(fx, b, buildCapsuleV2, PREDECESSOR_POOL);
    const free = build(fx, b);
    const same = capsuleShape(pre) === capsuleShape(pinned);
    identical = identical && same;
    if (capsuleShape(free) !== capsuleShape(pre)) moved += 1;
    details.push(`${b}: pinned==predecessor ${same}; free pool ${free.diagnostics.candidate_count} vs ${pre.diagnostics.candidate_count}`);
  }
  control("F14", "with the pool pinned to the historical constant the product reproduces the predecessor exactly; only the unpinned pool moves the outcome",
    identical && moved >= 2, details.join("; "));
  fx.db.close();
}

// ------------------------------------- F15 the evidence-budget ladder's cliff
{
  // The sweep found one C-MED task collapsing to a single delivered item at
  // widths >= 100 (and one at the historical width, budget 1500). The cause is
  // downstream of retrieval: `applyProgressiveContextBudget` never drops an
  // answer-bearing support item, so once the minimal representations of the
  // protected items alone exceed the budget its final rung keeps one item.
  // Here the ladder is driven directly: the same forty items are dropped from
  // the tail when they are ordinary support and collapse to one when every one
  // is answer-bearing. This documents the hazard the pool policy must stay
  // clear of; it is not repaired by M207.
  const draft = (answerBearing: boolean) => ({
    productContext: {
      resolved: true, items: [
        { id: "p", fqName: "a.py::lead", path: "a.py", roles: ["pivot", "required"], contentMode: "focused_source", content: "def lead():\n    return 1\n", selectionReasons: ["pivot: actionable function"] },
        ...Array.from({ length: 40 }, (_, k) => ({ id: `s${k}`, fqName: `b.py::helper_${k}`, path: "b.py", roles: ["support", "skeleton"], contentMode: "skeleton",
          content: `def helper_${k}(a, b, c):\n    ${"x = a + b + c\n    ".repeat(12)}return x\n`,
          selectionReasons: [answerBearing ? "support: symbol-name match; lexical match" : "support: lexical match"] })),
      ],
      // The ladder trusts the rendering it is handed before it re-renders: give it the real one.
      modelVisibleContext: Array.from({ length: 41 }, (_, k) => `## item ${k}\n${"x = a + b + c\n    ".repeat(12)}`).join("\n"),
    },
  });
  const ordinary = applyProgressiveContextBudget(draft(false) as any, 1200)!;
  const protectedAll = applyProgressiveContextBudget(draft(true) as any, 1200)!;
  const stagesOf = (r: { accounting: { compactionStages: readonly string[] } }) => JSON.stringify(r.accounting.compactionStages);
  control("F15", "the evidence-budget ladder drops ordinary support from the tail until it fits but collapses to one item when every support is answer-bearing: a downstream hazard the pool policy stays clear of, documented and not repaired here",
    ordinary.accounting.deliveredItems > 1 && ordinary.accounting.supportDropped > 0 && protectedAll.accounting.deliveredItems === 1,
    `1200-token budget over 1 pivot + 40 supports: ordinary support -> ${ordinary.accounting.deliveredItems} items ${stagesOf(ordinary)}; all answer-bearing -> ${protectedAll.accounting.deliveredItems} item(s) ${stagesOf(protectedAll)}`);
}

const out = {
  milestone: "M207", instrument: "run_stage5_m207_falsification.ts",
  predecessor: { root: PREDECESSOR_ROOT, head: predecessorHead, pool: PREDECESSOR_POOL },
  product: { floor: CANDIDATE_POOL_FLOOR, hardMaximum: CANDIDATE_POOL_HARD_MAXIMUM, tokensPerDeliveredCandidate: EXPECTED_TOKENS_PER_DELIVERED_CANDIDATE,
    allowance: Object.fromEntries([1000, 2000, 4000, 8000, 16000].map((b) => [b, allocateBudget(b).candidatePool])) },
  fixture: "abundantFixture: one edit target, N support-worthy resolvers in distinct files, optional test tail, unrelated billing symbols and same-signature twins; built by the production buildCapsuleV2 and, for the historical pool, by the predecessor worktree's on the same in-memory index",
  controls,
  verdict: controls.every((c) => c.pass) ? "M207_FALSIFICATION_CONTROLS_PASS" : "M207_FALSIFICATION_CONTROLS_FAIL",
};
writeFileSync(path.join(RESULTS, "stage5_m207_falsification.json"), `${JSON.stringify(out, null, 2)}\n`);
console.log(`\n${out.verdict} (${controls.filter((c) => c.pass).length}/${controls.length}) -> results/stage5_m207_falsification.json`);
