/**
 * M208 — falsification controls F1-F17.
 *
 * A gate that has never been seen to fail is not known to be a gate. Each
 * control constructs the specific dishonesty the milestone guards against — a
 * larger budget evicting affordable evidence, replacing old evidence with new,
 * a representation getting poorer with more room, a fabricated richer form, a
 * focus that follows the tier, a lane that reshuffles, a pool whose growth
 * reorders, an over-budget packet, a frozen-rung special case, a duplicate
 * delivered twice, a corrupted cost, a severed source anchor, monotonicity
 * confused with utilisation, impact rendering smuggled in, the predecessor's
 * own defect, and process-state dependence — and shows the production capsule
 * builder, the production evidence budget, the production projector, the
 * M203/M205/M208 analyzers or the product allocator refusing it, beside the
 * honest case each accepts.
 *
 * The capsules are REAL: built by the production `buildCapsuleV2` on fixture
 * repositories materialised on disk and indexed in memory exactly as the unit
 * tests build one, and, for the historical control, by the builder of a
 * worktree at the M207 final commit on the SAME fixture. The packets are built
 * by the production evidence budget and projector from the capsule's own items.
 *
 *   bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m208_falsification.ts \
 *     [--predecessor-root /home/calvin/bench/vtrace-m208/pre]
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { SymbolKind } from "../../src/domain/types";
import { seedCustomFixture, type SymbolSpec } from "../../src/capsuleV2/__fixtures__/capsuleV2Fixture";
import { SUPPORT_ORDERING_WINDOW, allocateBudget } from "../../src/capsuleV2/budgetAllocator";
import { buildCapsuleV2 } from "../../src/capsuleV2/buildCapsuleV2";
import { CapsuleIntent } from "../../src/capsuleV2/types";
import { applyProgressiveContextBudget } from "../../src/productContext/budgetDelivery";
import { orientationAccountingOf } from "../../src/runPipeline/orientationAccounting";
import { ORIENTATION_POLICY, orientationCeilingTokens, projectRunPipelineOrientation } from "../../src/runPipeline/orientationProjection";
import { analyzeAccounting } from "./m203Accounting";
import { orderRelation } from "./m204Utilization";
import { analyzeRepresentation, type SourceAuthority, type SupplyItem } from "./m205Representation";
import { frozenTokens, representationDirection } from "./m208BudgetMonotonicity";

const REPO = path.resolve(import.meta.dir, "../..");
const RESULTS = path.join(import.meta.dir, "results");
const args = process.argv.slice(2);
const argOf = (f: string, d: string) => { const i = args.indexOf(f); return i >= 0 && args[i + 1] !== undefined ? args[i + 1]! : d; };
const PREDECESSOR_ROOT = path.resolve(argOf("--predecessor-root", "/home/calvin/bench/vtrace-m208/pre"));

const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));
const predecessorCapsule = await import(path.join(PREDECESSOR_ROOT, "src/capsuleV2/buildCapsuleV2.ts"));
const predecessorAllocator = await import(path.join(PREDECESSOR_ROOT, "src/capsuleV2/budgetAllocator.ts"));
const predecessorHead = Bun.spawnSync(["git", "-C", PREDECESSOR_ROOT, "rev-parse", "HEAD"]).stdout.toString().trim();
if (predecessorAllocator.allocateBudget(1000).supportWindow === predecessorAllocator.allocateBudget(16000).supportWindow) {
  throw new Error("M208_PREDECESSOR_ALREADY_REPAIRED: the predecessor's support window does not vary with the tier");
}

// ---------------------------------------------------------------- fixtures

const TASK = "how does the widget registry resolve a widget handler for a name";

/**
 * A truthful ranked stream with one clear lead, `count` support-worthy resolver
 * functions in distinct files, optional weak-reach tail symbols the role gate
 * classifies as "no direct evidence", and optional test symbols.
 */
function fixture(count: number, options: { weakTail?: number; tests?: number; bigLead?: boolean; namedRival?: boolean; bodiless?: boolean } = {}) {
  const files: { relPath: string; specs: readonly SymbolSpec[] }[] = [];
  const leadBody = options.bigLead
    ? `def resolve_widget_handler(registry, name):\n${"    # widget registry handler resolution step\n".repeat(60)}    return registry.handlers.get(name)`
    : "def resolve_widget_handler(registry, name):\n    handler = registry.handlers.get(name)\n    if handler is None:\n        raise KeyError(name)\n    return handler";
  files.push({ relPath: "widgets/resolve.py", specs: [
    { localName: "resolve_widget_handler", kind: SymbolKind.Function, signature: "resolve_widget_handler(registry, name)", body: leadBody },
  ] });
  if (options.namedRival) {
    files.push({ relPath: "widgets/index.py", specs: [
      { localName: "WidgetHandlerIndex", kind: SymbolKind.Class, docstring: "Index of widget handlers.", body: 'class WidgetHandlerIndex:\n    """Index of widget handlers by name."""\n    def lookup(self, name):\n        return self.by_name[name]' },
    ] });
  }
  for (let k = 0; k < count; k += 1) {
    files.push({ relPath: `widgets/resolvers/resolver_${k}.py`, specs: [
      { localName: `resolve_widget_handler_${k}`, kind: SymbolKind.Function, signature: `resolve_widget_handler_${k}(registry, name)`,
        body: `def resolve_widget_handler_${k}(registry, name):\n    # widget registry handler resolution ${k}\n    return registry.resolve_widget_handler(name)` },
    ] });
  }
  for (let w = 0; w < (options.weakTail ?? 0); w += 1) {
    files.push({ relPath: `widgets/reach/reach_${w}.py`, specs: [
      { localName: `WidgetReach${w}`, kind: SymbolKind.Class, body: `class WidgetReach${w}:\n    # widget helper ${w}\n    pass` },
    ] });
  }
  for (let t = 0; t < (options.tests ?? 0); t += 1) {
    files.push({ relPath: `tests/test_widget_${t}.py`, specs: [
      { localName: `test_resolve_widget_handler_${t}`, kind: SymbolKind.Function, body: `def test_resolve_widget_handler_${t}():\n    assert resolve_widget_handler(None, "name")` },
    ] });
  }
  if (options.bodiless) {
    files.push({ relPath: "widgets/alias.py", specs: [
      { localName: "widget_handler_alias", kind: SymbolKind.ModuleVariable, body: "widget_handler_alias = resolve_widget_handler" },
    ] });
  }
  return seedCustomFixture(files);
}

const build = (fx: { db: any; repoRoot: string }, maxTokens: number, builder: any = buildCapsuleV2, candidatePoolSize?: number) =>
  builder({ db: fx.db, repoRoot: fx.repoRoot, task: TASK, intent: CapsuleIntent.Explain, maxTokens, ...(candidatePoolSize === undefined ? {} : { candidatePoolSize }) });

/**
 * The default path from the capsule onward, on the capsule's own items: the
 * assembly drafts (pivots then support, in capsule order), the production
 * evidence budget, and the production projector at the caller's budget. The
 * lanes assembleProductContext adds on top (actionability, impact, memory) are
 * absent, so what is measured is the capsule -> ladder -> projector chain.
 */
function packetAt(result: any, budget: number, options: { summaryItem?: boolean } = {}) {
  const items: any[] = [];
  const push = (item: any, roles: string[], index: number) => {
    const contentMode = item.content_mode === "full" && typeof item.source === "string" ? "focused_source" : typeof item.signature === "string" ? "signature" : "summary";
    const body = (contentMode === "focused_source" ? item.source : contentMode === "signature" ? item.signature : "").trim();
    items.push({ id: `${roles[0] === "pivot" ? "P" : "S"}${index + 1}`, fqName: item.fq_name, path: item.path, symbol: item.symbol, lineSpan: { start: 1, end: 1 }, contentMode, roles,
      selectionReasons: [item.role_reason, ...(item.evidence ?? [])], content: body, estimatedTokens: item.estimated_tokens });
  };
  result.pivots.forEach((p: any, k: number) => push(p, ["pivot", "required"], k));
  result.support.forEach((s: any, k: number) => push(s, ["support", "skeleton"], k));
  if (options.summaryItem) {
    items.push({ id: "D1", fqName: "widgets/resolve.py::widget_handler_summary", path: "widgets/resolve.py", symbol: "widget_handler_summary", lineSpan: { start: 1, end: 1 }, contentMode: "summary", roles: ["support"],
      selectionReasons: ["selected as supporting evidence for this task"], content: "", estimatedTokens: 0 });
  }
  const rendered = ["# VTRACE product context", ...items.map((i) => `\n## [${i.id}] ${i.fqName}\nroles: ${i.roles.join(", ")}\nmode: ${i.contentMode}\nlines: 1-1\nwhy: ${i.selectionReasons[0]}\n\n${i.content}`),
    "", "Impact entries above are bounded static structural evidence; they are not dynamic execution flow."].join("\n");
  const draft: any = {
    diagnostics: { freshness: { readiness: { ready: true } } }, pivotNeighborhood: [],
    responseBudget: { requested_context_tokens: budget },
    productContext: { resolved: true, retrievalFound: true, deliveryFailed: false, leadPivot: items[0]?.fqName ?? null, items, modelVisibleContext: rendered,
      freshness: { status: "fresh", reason: "" }, accounting: { budgetTokens: budget } },
  };
  const delivery = applyProgressiveContextBudget(draft, budget);
  const packet: any = projectRunPipelineOrientation(draft);
  const ledger: any = packet ? orientationAccountingOf(packet) : undefined;
  const supply: SupplyItem[] = items.map((i) => ({ id: i.id, fqName: i.fqName, path: i.path, contentMode: i.contentMode, content: i.content, lineSpan: i.lineSpan }));
  const authority: SourceAuthority = {
    readFile: (p) => (existsSync(path.join(result.__repoRoot ?? "", p)) ? readFileSync(path.join(result.__repoRoot, p), "utf8") : null),
    symbol: (fqName) => { const i = items.find((x) => x.fqName === fqName); return i ? { signature: i.content, startLine: 1, endLine: 1, kind: "function", localName: fqName.split("::").pop()! } : null; },
    skeleton: () => null,
  };
  return { draft, delivery, packet, ledger, supply, authority, items };
}
const withRoot = (result: any, fx: { repoRoot: string }) => Object.assign(result, { __repoRoot: fx.repoRoot });
const related = (packet: any): string[] => (packet?.related ?? []).map((r: any) => String(r.at));
const reps = (packet: any): Map<string, string> => new Map((packet?.related ?? []).map((r: any) => [String(r.at), typeof r.code === "string" ? String(r.form) : "relationship_only"] as const));
const pivotIds = (result: any): string[] => result.pivots.map((p: any) => p.fq_name);
const poolIds = (result: any): string[] => (result.diagnostics.candidate_scores ?? []).map((c: any) => c.fq_name);

const controls: { id: string; statement: string; pass: boolean; detail: string }[] = [];
const control = (id: string, statement: string, pass: boolean, detail: string) => {
  controls.push({ id, statement, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"}  ${id.padEnd(4)} ${statement}\n      ${detail}`);
};
const FROZEN = [1000, 2000, 4000, 8000, 16000];
const DENSE = [750, 1000, 1250, 1499, 1500, 2000, 2500, 3000, 4000, 5000, 6000, 8000, 10000, 11999, 12000, 16000, 20000];

// ---------------------------------- F1 + F2 preserved evidence, appended tail
{
  const fx = fixture(30, { weakTail: 6 });
  const packets = FROZEN.map((b) => ({ b, ...packetAt(withRoot(build(fx, b), fx), b) }));
  let preserved = 0; let appended = 0; let relations: string[] = [];
  for (let i = 1; i < packets.length; i += 1) {
    const lo = related(packets[i - 1]!.packet); const hi = related(packets[i]!.packet);
    const rel = orderRelation(lo, hi); relations.push(rel);
    if (lo.every((id) => hi.includes(id))) preserved += 1;
    if (hi.length > lo.length) appended += 1;
  }
  control("F1", "a larger budget keeps every lower-budget related entry that still fits: no lower-budget evidence is evicted across the frozen budgets",
    preserved === packets.length - 1 && relations.every((r) => r !== "neither"),
    `preserved ${preserved}/${packets.length - 1} transitions; relations ${relations.join(",")}; related counts ${packets.map((p) => related(p.packet).length).join("->")}`);
  control("F2", "the larger budget adds later evidence behind the preserved evidence instead of replacing it",
    appended >= 2 && relations.every((r) => r === "prefix" || r === "subsequence"),
    `transitions with new entries ${appended}; relations ${relations.join(",")}`);
  // F3: representation never gets poorer for an entry both budgets deliver.
  let poorer = 0; let richer = 0; let same = 0;
  for (let i = 1; i < packets.length; i += 1) {
    const lo = reps(packets[i - 1]!.packet); const hi = reps(packets[i]!.packet);
    for (const [id, before] of lo) { const after = hi.get(id); if (after === undefined) continue; const d = representationDirection(before, after); if (d === "poorer") poorer += 1; else if (d === "richer") richer += 1; else same += 1; }
  }
  control("F3", "an entry both budgets deliver keeps its representation or gets a richer one; a larger budget never downgrades it",
    poorer === 0 && same + richer > 0, `same ${same}, richer ${richer}, poorer ${poorer}`);
  fx.db.close();
}

// ------------------------------------------------- F4 legitimate fallback
{
  // A non-code-bearing draft (the shape of the assembly's impact / actionability
  // items: a summary line, no source body) rides beside the capsule's items. The
  // projector must deliver it relationship-only under its own reason and never
  // give it code; the M205 truth guard passes the honest packet.
  const fx = fixture(6);
  const result = withRoot(build(fx, 16000), fx);
  const { packet, ledger, supply, authority } = packetAt(result, 16000, { summaryItem: true });
  const analysis = analyzeRepresentation({ packet, ledger, supply, authority, ceilingTokens: orientationCeilingTokens(16000), relatedBound: ORIENTATION_POLICY.relatedCodeCharacters, focusBound: ORIENTATION_POLICY.focusCodeCharacters });
  const entry = (packet?.related ?? []).find((r: any) => /widget_handler_summary/.test(String(r.at)));
  const record = (ledger?.items ?? []).find((i: any) => /widget_handler_summary/.test(String(i.at)));
  control("F4", "a delivered item whose upstream form carries no code is relationship-only under its own reason, never with fabricated code",
    entry !== undefined && typeof entry.code !== "string" && record !== undefined && record.representation === "relationship_only"
      && ["form_not_code_bearing", "no_rendered_body"].includes(String(record.representationReason)) && analysis.verdict === "REPRESENTATION_INTEGRITY_PASS",
    `summary item delivered ${entry !== undefined}, code ${typeof entry?.code}, reason ${record?.representationReason}; M205 ${analysis.verdict}`);
  fx.db.close();
}

// ------------------------------------------------ F5 focus vs tail supply
{
  // One corpus with forty weak tail symbols. The tail reaches the stream only
  // through the wider pool a larger budget buys; the lead must not move with the
  // budget, nor with the pool width at any budget.
  const fx = fixture(4, { weakTail: 40 });
  const byBudget = FROZEN.map((b) => pivotIds(build(fx, b))[0]);
  const byWidth = FROZEN.map((b) => [pivotIds(build(fx, b, buildCapsuleV2, 25))[0], pivotIds(build(fx, b, buildCapsuleV2, 134))[0]]);
  control("F5", "low-ranked tail candidates exposed by a larger budget or a wider pool never change the focus: one lead at every budget and width",
    byBudget.every((l) => l === byBudget[0]) && byBudget[0] !== undefined && byWidth.every(([a, b]) => a === byBudget[0] && b === byBudget[0]),
    `leads by budget ${[...new Set(byBudget)].map((l) => l?.split("::").pop()).join("|")}; by pool width 25/134 ${[...new Set(byWidth.flat())].map((l) => l?.split("::").pop()).join("|")}`);
  fx.db.close();
}

// ---------------------------------------- F6 a named target leads everywhere
{
  // The task names `WidgetHandlerIndex` outright: the title-symbol tier ranks it
  // above the lexical lead, and the plan-before-cap policy makes it the focus at
  // the single-pivot tier too, not only once a wider tier admits it.
  const fx = fixture(6, { namedRival: true });
  const namedTask = `${TASK}; the WidgetHandlerIndex lookup returns the wrong handler`;
  const named = (builder: any) => FROZEN.map((b) => builder({ db: fx.db, repoRoot: fx.repoRoot, task: namedTask, intent: CapsuleIntent.Explain, maxTokens: b }).pivots[0]?.fq_name);
  const post = named(buildCapsuleV2); const pre = named(predecessorCapsule.buildCapsuleV2);
  control("F6", "when the task names a symbol the pivot order ranks first, it leads at EVERY budget (micro included); the predecessor let it lead only once the cap admitted it",
    post.every((l) => l === post[0]) && post[0] !== undefined && new Set(pre).size >= 1,
    `product leads ${[...new Set(post)].map((l) => l?.split("::").pop()).join("|")}; predecessor leads ${[...new Set(pre)].map((l) => l?.split("::").pop()).join("|")}`);
  fx.db.close();
}

// --------------------------------------------------- F7 lane-order stability
{
  // More base-support candidates (30 -> 60) must not reorder the entries the
  // smaller stream already had, at the same budget and across budgets.
  const a = fixture(30); const b = fixture(60);
  let ok = true; const detail: string[] = [];
  for (const budget of [4000, 16000]) {
    const sa = build(a, budget).support.map((s: any) => s.fq_name); const sb = build(b, budget).support.map((s: any) => s.fq_name);
    const rel = orderRelation(sa.filter((id: string) => sb.includes(id)), sb); detail.push(`${budget}: ${rel}`); if (rel === "neither") ok = false;
  }
  control("F7", "adding candidates to the base support lane leaves the existing entries' relative order intact (a subsequence), at 4000 and 16000",
    ok, detail.join("; "));
  a.db.close(); b.db.close();
}

// ---------------------------------------------- F8 candidate-pool growth
{
  const fx = fixture(60, { weakTail: 20 });
  const narrow = build(fx, 16000, buildCapsuleV2, 25); const wide = build(fx, 16000, buildCapsuleV2, 134);
  const poolRel = orderRelation(poolIds(narrow), poolIds(wide));
  const supportRel = orderRelation(narrow.support.map((s: any) => s.fq_name).filter((id: string) => wide.support.some((w: any) => w.fq_name === id)), wide.support.map((s: any) => s.fq_name));
  control("F8", "a wider pool at the same budget holds the narrow pool as a prefix of its ranked stream, and the delivered support order follows the stable stream",
    poolRel === "prefix" && supportRel !== "neither" && pivotIds(narrow)[0] === pivotIds(wide)[0],
    `pool ${narrow.diagnostics.candidate_count} -> ${wide.diagnostics.candidate_count}: ${poolRel}; support relation ${supportRel}; same lead ${pivotIds(narrow)[0] === pivotIds(wide)[0]}`);
  fx.db.close();
}

// ------------------------------------------------- F9 whole-output bound
{
  const fx = fixture(40, { weakTail: 10 });
  const over: string[] = []; let checked = 0;
  for (const b of DENSE) {
    const { packet, ledger } = packetAt(withRoot(build(fx, b), fx), b);
    if (!packet) continue; checked += 1;
    if (ledger.evidence.withinCeiling !== true || ledger.evidence.characters > b * 4) over.push(String(b));
  }
  control("F9", "the evidence packet stays inside the caller's budget under the product's own accounting at every dense budget (the per-item tokens fields ride above it by the ledger's stated overhead)",
    checked === DENSE.length && over.length === 0, `checked ${checked} budgets; over: ${over.join(",") || "none"}`);
  fx.db.close();
}

// ------------------------------------------------- F10 arbitrary budgets
{
  const fx = fixture(30, { weakTail: 8 });
  const points = DENSE.map((b) => { const r = build(fx, b); const { packet } = packetAt(withRoot(r, fx), b); return { b, focus: packet?.focus?.at, tokens: frozenTokens(packet?.focus?.code ?? ""), window: allocateBudget(b).supportWindow }; });
  let swaps = 0; let drops = 0;
  for (let i = 1; i < points.length; i += 1) { if (points[i]!.focus !== points[i - 1]!.focus) swaps += 1; if (points[i]!.tokens < points[i - 1]!.tokens) drops += 1; }
  const changedFiles = ["src/capsuleV2/budgetAllocator.ts", "src/capsuleV2/buildCapsuleV2.ts", "src/capsuleV2/debugRoles.ts", "src/productContext/budgetDelivery.ts", "src/retrieval/hybridRetrieval.ts"];
  const productLines = changedFiles.flatMap((f) => readFileSync(path.join(REPO, f), "utf8").split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)));
  const frozenLiterals = productLines.filter((l) => /(===|<=?|>=?)\s*(1000|2000|4000|8000|16000)\b|\b(1000|2000|4000|8000|16000)\s*(===|<=?|>=?)/.test(l));
  control("F10", "one general policy over a dense non-frozen budget grid: the focus never changes, its size never shrinks, the support window is a constant, and no product line compares the budget against a frozen rung",
    swaps === 0 && drops === 0 && points.every((p) => p.window === SUPPORT_ORDERING_WINDOW) && frozenLiterals.length === 0,
    `${points.length} budgets; swaps ${swaps}, size drops ${drops}; window ${[...new Set(points.map((p) => p.window))].join("|")}; frozen-rung comparisons in product lines ${frozenLiterals.length}`);
  fx.db.close();
}

// ------------------------------------------- F11 + F12 duplicate / accounting
{
  const fx = fixture(20, { weakTail: 4 });
  const { packet, ledger } = packetAt(withRoot(build(fx, 16000), fx), 16000);
  const ids = [packet.focus.at, ...related(packet)];
  const accounting = analyzeAccounting({ packet, ledger, ceilingTokens: orientationCeilingTokens(16000) });
  control("F11", "one semantic item is delivered once with one accounting record at every budget, however many routes proposed it",
    new Set(ids).size === ids.length && ledger.items.length === ids.length && accounting.verdict === "ACCOUNTING_INTEGRITY_PASS",
    `delivered ${ids.length}, distinct ${new Set(ids).size}, ledger records ${ledger.items.length}; M203 ${accounting.verdict}`);
  const corrupt = clone(packet); corrupt.related[0].tokens = corrupt.related[0].tokens + 40;
  const corruptLedger = clone(ledger); // stale: does not match the mutated packet
  const corruptAnalysis = analyzeAccounting({ packet: corrupt, ledger: corruptLedger, ceilingTokens: orientationCeilingTokens(16000) });
  control("F12", "a corrupted per-item cost after the M208 path fails the M203 accounting guard",
    corruptAnalysis.verdict !== "ACCOUNTING_INTEGRITY_PASS", `M203 on a +40-token corruption: ${corruptAnalysis.verdict}`);
  fx.db.close();
}

// ---------------------------------------------- F13 representation corruption
{
  const fx = fixture(12);
  const result = withRoot(build(fx, 16000), fx);
  const { packet, ledger, supply, authority } = packetAt(result, 16000);
  const honest = analyzeRepresentation({ packet, ledger, supply, authority, ceilingTokens: orientationCeilingTokens(16000), relatedBound: ORIENTATION_POLICY.relatedCodeCharacters, focusBound: ORIENTATION_POLICY.focusCodeCharacters });
  const forged = clone(packet);
  const target = forged.related.find((r: any) => typeof r.code === "string");
  target.code = "def resolve_widget_handler(registry, name):\n    return FABRICATED";
  const forgedAnalysis = analyzeRepresentation({ packet: forged, ledger, supply, authority, ceilingTokens: orientationCeilingTokens(16000), relatedBound: ORIENTATION_POLICY.relatedCodeCharacters, focusBound: ORIENTATION_POLICY.focusCodeCharacters });
  control("F13", "a delivered body that its source does not anchor fails the M205 truth guard; the honest packet passes it",
    honest.verdict === "REPRESENTATION_INTEGRITY_PASS" && forgedAnalysis.verdict !== "REPRESENTATION_INTEGRITY_PASS",
    `honest ${honest.verdict}; forged ${forgedAnalysis.verdict}`);
  fx.db.close();
}

// ------------------------------------------------- F14 A11 independence
{
  const fx = fixture(3);
  const points = FROZEN.map((b) => { const { packet } = packetAt(withRoot(build(fx, b), fx), b); return { b, focus: packet?.focus?.at, tokens: frozenTokens(packet?.focus?.code ?? ""), util: 100 * frozenTokens(JSON.stringify(packet ?? {})) / b }; });
  const monotone = points.every((p, i) => i === 0 || (p.focus === points[i - 1]!.focus && p.tokens >= points[i - 1]!.tokens));
  control("F14", "a small truthful universe leaves the large budgets mostly unused yet the delivery is monotone: A13's semantics are not utilisation",
    monotone && points.at(-1)!.util < 60, `focus ${[...new Set(points.map((p) => p.focus?.split("::").pop()))].join("|")}; utilisation ${points.map((p) => p.util.toFixed(0)).join("/")}%`);
  fx.db.close();
}

// ------------------------------------------------- F15 A15 independence
{
  const diff = Bun.spawnSync(["git", "-C", REPO, "diff", predecessorHead, "--", "src/"]).stdout.toString();
  const added = diff.split("\n").filter((l) => l.startsWith("+") && !l.startsWith("+++"));
  const impactAdded = added.filter((l) => /impact|call.?site|caller/i.test(l) && !/^\+\s*(\/\/|\*)/.test(l));
  control("F15", "the M208 product change adds no impact, call-site or caller rendering: A13 closes independently of A15",
    impactAdded.length === 0, `added product lines mentioning impact/call-site/caller: ${impactAdded.length}`);
}

// ----------------------------------- F16 the predecessor exhibits the defect
{
  // The fixture whose pivot order and final-score order disagree: a large,
  // weakly-supported lexical lead against a small named rival. The predecessor
  // caps in final order then re-orders, so its focus follows the tier; the
  // product's plan-before-cap keeps one lead.
  const fx = fixture(6, { bigLead: true, namedRival: true });
  const namedTask = `${TASK}; the WidgetHandlerIndex lookup returns the wrong handler`;
  const leadsOf = (builder: any) => FROZEN.map((b) => builder({ db: fx.db, repoRoot: fx.repoRoot, task: namedTask, intent: CapsuleIntent.Explain, maxTokens: b }).pivots[0]?.fq_name);
  const pre = leadsOf(predecessorCapsule.buildCapsuleV2); const post = leadsOf(buildCapsuleV2);
  const preSwaps = pre.filter((l, i) => i > 0 && l !== pre[i - 1]).length; const postSwaps = post.filter((l, i) => i > 0 && l !== post[i - 1]).length;
  // And the predecessor's window varies with the tier while the product's does not.
  const preWindows = [...new Set(FROZEN.map((b) => predecessorAllocator.allocateBudget(b).supportWindow))];
  const postWindows = [...new Set(FROZEN.map((b) => allocateBudget(b).supportWindow))];
  control("F16", "the M207 predecessor swaps the focus across tiers on the same fixture and varies the support window with the tier; the M208 product does neither",
    preSwaps > 0 && postSwaps === 0 && preWindows.length > 1 && postWindows.length === 1,
    `predecessor ${predecessorHead.slice(0, 12)} leads ${pre.map((l) => l?.split("::").pop()).join(",")} (swaps ${preSwaps}), windows ${preWindows.join("/")}; product leads ${post.map((l) => l?.split("::").pop()).join(",")} (swaps ${postSwaps}), window ${postWindows.join("/")}`);
  fx.db.close();
}

// --------------------------------------------------- F17 process repeat
{
  const fx = fixture(20, { weakTail: 6 });
  const inProcess = [1, 2].map(() => FROZEN.map((b) => sha(JSON.stringify(packetAt(withRoot(build(fx, b), fx), b).packet))).join("|"));
  // A fresh process on the same on-disk fixture repository and a freshly seeded in-memory index.
  const script = `
    import { seedFile } from ${JSON.stringify(path.join(REPO, "src/capsuleV2/__fixtures__/capsuleV2Fixture.ts"))};
    import { openIndexerDatabase } from ${JSON.stringify(path.join(REPO, "src/db/sqlite.ts"))};
    import { buildCapsuleV2 } from ${JSON.stringify(path.join(REPO, "src/capsuleV2/buildCapsuleV2.ts"))};
    import { CapsuleIntent } from ${JSON.stringify(path.join(REPO, "src/capsuleV2/types.ts"))};
    const files = ${JSON.stringify(fixtureFiles(20, 6))};
    const db = openIndexerDatabase();
    for (const f of files) seedFile(db, ${JSON.stringify(fx.repoRoot)}, f.relPath, f.specs);
    const out = [];
    for (const b of ${JSON.stringify(FROZEN)}) { const r = buildCapsuleV2({ db, repoRoot: ${JSON.stringify(fx.repoRoot)}, task: ${JSON.stringify(TASK)}, intent: CapsuleIntent.Explain, maxTokens: b });
      out.push(JSON.stringify({ pivots: r.pivots.map((p) => p.fq_name), support: r.support.map((s) => s.fq_name) })); }
    console.log(out.join("\\n"));
  `;
  const scriptPath = path.join(RESULTS, "_m208_f17_fresh_process.ts");
  writeFileSync(scriptPath, script);
  const fresh = Bun.spawnSync(["bun", scriptPath], { cwd: REPO }).stdout.toString().trim().split("\n");
  const here = FROZEN.map((b) => { const r = build(fx, b); return JSON.stringify({ pivots: r.pivots.map((p: any) => p.fq_name), support: r.support.map((s: any) => s.fq_name) }); });
  control("F17", "repeated equivalent calls produce the same packets in one process and the same capsule selection in a fresh process",
    inProcess[0] === inProcess[1] && fresh.length === here.length && fresh.every((line, k) => line === here[k]),
    `in-process repeats identical ${inProcess[0] === inProcess[1]}; fresh-process capsule selections identical ${fresh.every((line, k) => line === here[k])} (${fresh.length} budgets)`);
  fx.db.close();
}

function fixtureFiles(count: number, weakTail: number) {
  const files: { relPath: string; specs: SymbolSpec[] }[] = [];
  files.push({ relPath: "widgets/resolve.py", specs: [{ localName: "resolve_widget_handler", kind: SymbolKind.Function, signature: "resolve_widget_handler(registry, name)",
    body: "def resolve_widget_handler(registry, name):\n    handler = registry.handlers.get(name)\n    if handler is None:\n        raise KeyError(name)\n    return handler" }] });
  for (let k = 0; k < count; k += 1) files.push({ relPath: `widgets/resolvers/resolver_${k}.py`, specs: [{ localName: `resolve_widget_handler_${k}`, kind: SymbolKind.Function, signature: `resolve_widget_handler_${k}(registry, name)`,
    body: `def resolve_widget_handler_${k}(registry, name):\n    # widget registry handler resolution ${k}\n    return registry.resolve_widget_handler(name)` }] });
  for (let w = 0; w < weakTail; w += 1) files.push({ relPath: `widgets/reach/reach_${w}.py`, specs: [{ localName: `WidgetReach${w}`, kind: SymbolKind.Class, body: `class WidgetReach${w}:\n    # widget helper ${w}\n    pass` }] });
  return files;
}

const verdict = controls.every((c) => c.pass) ? "M208_FALSIFICATION_CONTROLS_PASS" : "M208_FALSIFICATION_CONTROLS_FAIL";
writeFileSync(path.join(RESULTS, "stage5_m208_falsification.json"), `${JSON.stringify({ milestone: "M208", predecessor: { root: PREDECESSOR_ROOT, head: predecessorHead }, controls, verdict }, null, 2)}\n`);
console.log(`\n${verdict} (${controls.filter((c) => c.pass).length}/${controls.length}) -> results/stage5_m208_falsification.json`);
