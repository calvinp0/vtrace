/**
 * M204 — falsification controls F1-F12.
 *
 * A gate that has never been seen to fail is not known to be a gate. Each
 * control below constructs the specific dishonesty it guards against — a fixed
 * ceiling under a large budget, filler admitted to fill room, a duplicate, a
 * candidate with no claim, a budget above every bound, a ledger that does not
 * reconcile, an unstable packet, a hard-coded budget, a swapped focus that the
 * utilisation rule would happily accept — and shows the production projector,
 * the utilisation analyzer, or the frozen rule refusing it, beside the honest
 * case each accepts.
 *
 * The packets are REAL: produced by the production projector from a synthetic
 * authoritative state exactly as the unit tests build one, and, for the
 * predecessor policy, by the projector of a worktree at the M203 commit. Any
 * mutation happens on copies after the projector has returned, so no control
 * can influence what the product does.
 *
 *   bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m204_falsification.ts \
 *     [--predecessor-root /home/calvin/bench/vtrace-m204/pre-repair]
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { orientationAccountingOf } from "../../src/runPipeline/orientationAccounting";
import {
  ORIENTATION_CHARACTERS_PER_REQUESTED_TOKEN, ORIENTATION_FROZEN_PHRASES, ORIENTATION_POLICY,
  orientationCeilingTokens, projectRunPipelineOrientation,
} from "../../src/runPipeline/orientationProjection";
import { analyzeAccounting, frozenA14ItemsAccounted, frozenA14ItemsDelivered } from "./m203Accounting";
import {
  A11_MATCH_PERCENT, analyzeUtilization, frozenA11Verdict, frozenUtilisationPercent, frozenWholeResponseTokens,
  orderRelation,
} from "./m204Utilization";

const RESULTS = path.join(import.meta.dir, "results");
const args = process.argv.slice(2);
const argOf = (f: string, d: string) => { const i = args.indexOf(f); return i >= 0 && args[i + 1] !== undefined ? args[i + 1]! : d; };
const PREDECESSOR_ROOT = path.resolve(argOf("--predecessor-root", "/home/calvin/bench/vtrace-m204/pre-repair"));

const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));

// The predecessor's projector: the M203 policy, fixed at 2000, loaded from its own tree.
const predecessor = await import(path.join(PREDECESSOR_ROOT, "src/runPipeline/orientationProjection.ts"));
const predecessorAccounting = await import(path.join(PREDECESSOR_ROOT, "src/runPipeline/orientationAccounting.ts"));
const predecessorHead = Bun.spawnSync(["git", "-C", PREDECESSOR_ROOT, "rev-parse", "HEAD"]).stdout.toString().trim();
if (typeof predecessor.orientationCeilingTokens === "function") {
  throw new Error("M204_PREDECESSOR_ALREADY_REPAIRED: the predecessor tree exports the caller-derived rule");
}

/** A real authoritative state, as the projector's tests build one, packed against `requested`. */
function authoritative(count: number, requested: number | null, overrides: Record<string, unknown> = {}, bodyChars = 300): Record<string, unknown> {
  const items = Array.from({ length: count + 1 }, (_, index) => ({
    id: `i${index}`,
    fqName: index === 0 ? "pkg/focus.py::Focus.run" : `pkg/mod${index}.py::Sym${index}.method`,
    path: index === 0 ? "pkg/focus.py" : `pkg/mod${index}.py`,
    lineSpan: { start: index * 10 + 1, end: index * 10 + 9 },
    contentMode: "focused_source",
    roles: index === 0 ? ["pivot"] : ["support"],
    selectionReasons: [index === 0 ? "lead pivot for this task" : `direct caller ${index}`],
    estimatedTokens: 75 + index,
  }));
  const { productContext: productContextOverride, ...topLevel } = overrides;
  return {
    diagnostics: { freshness: { readiness: { ready: true } } },
    pivotNeighborhood: [],
    ...(requested === null ? {} : { responseBudget: { requested_context_tokens: requested } }),
    ...topLevel,
    productContext: {
      resolved: true, retrievalFound: true, deliveryFailed: false,
      leadPivot: "pkg/focus.py::Focus.run", items,
      modelVisibleContext: items
        .map((item) => `\n## [${item.id}]\nroles: ${item.roles.join(",")}\n\n${"x".repeat(bodyChars)}`).join("\n"),
      freshness: { status: "fresh", reason: "" },
      delivery: { status: "complete", selectedItemsBeforeBudget: count + 1, deliveredItems: count + 1,
        droppedForBudget: 0, finalModelTokens: 900, compactionStages: [] },
      ...(requested === null ? {} : { accounting: { budgetTokens: requested, usedTokensEstimate: 900, remainingTokensEstimate: requested - 900 } }),
      ...(productContextOverride as Record<string, unknown> ?? {}),
    },
  };
}

const project = (state: Record<string, unknown>) => {
  const packet: any = projectRunPipelineOrientation(state);
  const ledger: any = orientationAccountingOf(packet);
  return { packet, ledger };
};
const projectPredecessor = (state: Record<string, unknown>) => {
  const packet: any = predecessor.projectRunPipelineOrientation(state);
  const ledger: any = predecessorAccounting.orientationAccountingOf(packet);
  return { packet, ledger };
};
const analyze = (budget: number, packet: any, ledger: any, expected = orientationCeilingTokens(budget)) =>
  analyzeUtilization({ budget, packet, ledger, expectedCeilingTokens: expected,
    headBoundCharacters: ORIENTATION_POLICY.focusCodeCharacters, frozenPhrases: ORIENTATION_FROZEN_PHRASES });
const failedGates = (a: { gates: readonly { id: string; pass: boolean }[] }) => a.gates.filter((g) => !g.pass).map((g) => g.id);

const controls: { id: string; statement: string; pass: boolean; detail: string }[] = [];
const control = (id: string, statement: string, pass: boolean, detail: string) => {
  controls.push({ id, statement, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"}  ${id.padEnd(4)} ${statement}\n      ${detail}`);
};

// ------------------------------------------ F1 fixed internal ceiling
{
  const state = authoritative(300, 16000);
  const pre = projectPredecessor(state);
  const post = project(state);
  const preAnalysis = analyze(16000, pre.packet, pre.ledger, predecessor.ORIENTATION_POLICY.ceilingTokens);
  const postAnalysis = analyze(16000, post.packet, post.ledger);
  control("F1", "a high budget with abundant eligible evidence underutilises under the fixed ceiling and admits more under the caller's",
    pre.ledger.ceilingTokens === 2000 && pre.ledger.candidates.rejectedForCeiling === 1
      && preAnalysis.bindingReason === "ORIENTATION_CEILING" && preAnalysis.utilisationPercent < A11_MATCH_PERCENT
      && post.ledger.ceilingTokens === orientationCeilingTokens(16000)
      && post.packet.related.length > pre.packet.related.length
      && postAnalysis.verdict === "UTILIZATION_INTEGRITY_PASS",
    `predecessor: ceiling ${pre.ledger.ceilingTokens}, ${pre.packet.related.length} related, ${preAnalysis.utilisationPercent}% (${preAnalysis.bindingReason}); `
      + `repaired: ceiling ${post.ledger.ceilingTokens}, ${post.packet.related.length} related, ${postAnalysis.utilisationPercent}% (${postAnalysis.bindingReason})`);
}

// ------------------------------------------------- F2 no-supply case
{
  const budget = 16000;
  const { packet, ledger } = project(authoritative(4, budget));
  const a = analyze(budget, packet, ledger);
  const smaller = project(authoritative(4, 2000)).packet;
  control("F2", "a high budget with exhausted truthful supply keeps its unused budget and admits no filler",
    a.verdict === "UTILIZATION_INTEGRITY_PASS" && a.bindingReason === "NO_ELIGIBLE_EVIDENCE" && a.supplyExhausted
      && a.unused.frozenBudgetTokens > 0.9 * budget && packet.related.length === 4
      && JSON.stringify(packet) === JSON.stringify(smaller),
    `${packet.related.length} related, ${a.utilisationPercent}% used, ${a.unused.frozenBudgetTokens} tokens unused, ${a.bindingReason}; byte-identical to the 2000 packet: ${JSON.stringify(packet) === JSON.stringify(smaller)}`);
}

// ------------------------------------------------ F3 duplicate filler
{
  const budget = 16000;
  const { packet, ledger } = project(authoritative(5, budget));
  const dup = clone(packet); dup.related.push(clone(dup.related[1]));
  const dupLedger = clone(ledger); dupLedger.items.push({ ...clone(dupLedger.items[2]), ordinal: 6 });
  const a = analyze(budget, dup, dupLedger);
  const m203 = analyzeAccounting({ packet: dup, ledger: dupLedger, ceilingTokens: orientationCeilingTokens(budget) });
  // And the product itself: a second proposal of one identity is delivered once.
  const twice = project(authoritative(3, budget, { pivotNeighborhood: [{ pivot: {}, excerpts: [
    { fqName: "pkg/mod1.py::Sym1.method", filePath: "pkg/mod1.py", startLine: 11, endLine: 19, reason: "caller", text: "x" }] }] }));
  control("F3", "re-admitting an already delivered item to raise utilisation fails; the product deduplicates a second proposal",
    a.verdict === "UTILIZATION_INTEGRITY_FAIL" && failedGates(a).includes("no_duplicate_admission")
      && m203.verdict === "ACCOUNTING_INTEGRITY_FAIL"
      && twice.packet.related.length === 3 && twice.ledger.candidates.deduplicated === 1,
    `duplicate -> ${failedGates(a).join(",")}; M203 analyzer ${m203.verdict}; second proposal delivered ${twice.packet.related.length} related with ${twice.ledger.candidates.deduplicated} deduplicated`);
}

// ---------------------------------------------- F4 irrelevant filler
{
  const budget = 16000;
  // Below the eligibility line: an identity with no claim. The projector drops it.
  const noClaim = project(authoritative(3, budget, { productContext: { items: [
    ...(authoritative(3, budget).productContext as any).items,
    { id: "i9", fqName: "pkg/junk.py::junk", path: "pkg/junk.py", lineSpan: { start: 1, end: 2 }, contentMode: "focused_source", roles: [], selectionReasons: [] },
  ] } }));
  // Forced into the packet anyway, the analyzer refuses it.
  const forced = clone(noClaim.packet);
  forced.related.push({ at: "pkg/junk.py::junk", file: "pkg/junk.py", lines: "1-2", how: "might be relevant", tokens: 27 });
  const forcedLedger = clone(noClaim.ledger);
  forcedLedger.items.push({ ...clone(forcedLedger.items[1]), at: "pkg/junk.py::junk", ordinal: forcedLedger.items.length, sourceId: "unavailable", reason: "might be relevant", reasonSource: "roles" });
  forcedLedger.candidates = { ...forcedLedger.candidates, admitted: forcedLedger.items.length, droppedNoClaim: 0 };
  const a = analyze(budget, forced, forcedLedger);
  control("F4", "a candidate below the eligibility line is dropped by the projector and rejected by the analyzer if forced",
    noClaim.packet.related.length === 3 && noClaim.ledger.candidates.droppedNoClaim === 1
      && a.verdict === "UTILIZATION_INTEGRITY_FAIL" && failedGates(a).includes("no_filler"),
    `projector: ${noClaim.packet.related.length} related, ${noClaim.ledger.candidates.droppedNoClaim} dropped for no claim; forced -> ${failedGates(a).join(",")}`);
}

// ------------------------------------------------- F5 hard safety cap
{
  // The bounds that remain hard: the focus head bound and the supply itself.
  const huge = 10_000_000;
  const head = project(authoritative(2, huge, {}, 50_000)).packet;
  const supply = project(authoritative(300, huge)).packet;
  const enough = project(authoritative(300, 100_000)).packet;
  const ceilingHuge = orientationCeilingTokens(huge);
  control("F5", "a budget above every bound respects the focus head bound and the supply; the ceiling never exceeds the caller's number",
    head.focus.code.length <= ORIENTATION_POLICY.focusCodeCharacters && head.focus.codeTruncated === true
      && supply.related.length === 300 && JSON.stringify(supply) === JSON.stringify(enough)
      && ceilingHuge === Math.round(huge * ORIENTATION_CHARACTERS_PER_REQUESTED_TOKEN * 0.3174032272551657),
    `focus ${head.focus.code.length} <= ${ORIENTATION_POLICY.focusCodeCharacters} chars; 300 of 300 supplied at ${huge} and at 100000, byte-identical; ceiling(${huge}) = ${ceilingHuge}`);
}

// ------------------------------------------- F6 accounting reconciliation
{
  const budget = 16000;
  const { packet, ledger } = project(authoritative(300, budget));
  const m203 = analyzeAccounting({ packet, ledger, ceilingTokens: orientationCeilingTokens(budget) });
  const a = analyze(budget, packet, ledger);
  const broken = clone(ledger); broken.items[7].actualTokens += 1;
  const b = analyze(budget, packet, broken);
  control("F6", "an expanded packet reconciles exactly and every item is A14-accounted; a wrong cost is caught",
    m203.verdict === "ACCOUNTING_INTEGRITY_PASS" && frozenA14ItemsAccounted(packet) === frozenA14ItemsDelivered(packet)
      && ledger.reconciliation.charactersExact === true && packet.related.length > 100
      && a.verdict === "UTILIZATION_INTEGRITY_PASS" && b.verdict === "UTILIZATION_INTEGRITY_FAIL" && failedGates(b).includes("cost_reconciliation"),
    `${packet.related.length} related, ${frozenA14ItemsAccounted(packet)}/${frozenA14ItemsDelivered(packet)} accounted, characters exact ${ledger.reconciliation.charactersExact}; +1 token -> ${failedGates(b).join(",")}`);
}

// ------------------------------------------------ F7 deterministic scaling
{
  const hashes = new Set<string>();
  const ledgers = new Set<string>();
  for (let i = 0; i < 5; i += 1) {
    const { packet, ledger } = project(authoritative(300, 16000));
    hashes.add(sha(JSON.stringify(packet))); ledgers.add(sha(JSON.stringify(ledger)));
  }
  control("F7", "the same budget gives the same packet and the same ledger across repeats",
    hashes.size === 1 && ledgers.size === 1, `5 repeats: ${hashes.size} packet hash(es), ${ledgers.size} ledger hash(es)`);
}

// ------------------------------------------------- F8 arbitrary budget
{
  const budgets = [1000, 1575, 2000, 3000, 4000, 6000, 7331, 8000, 12000, 16000];
  const packets = budgets.map((b) => ({ b, ...project(authoritative(300, b)) }));
  const ruleHolds = packets.every((p) => p.ledger.ceilingTokens === orientationCeilingTokens(p.b)
    && p.ledger.ceilingTokens === Math.round(p.b * 4 * 0.3174032272551657));
  let monotone = true; let prefix = true;
  for (let i = 1; i < packets.length; i += 1) {
    if (packets[i]!.packet.related.length < packets[i - 1]!.packet.related.length) monotone = false;
    if (orderRelation(packets[i - 1]!.packet.related.map((r: any) => r.at), packets[i]!.packet.related.map((r: any) => r.at)) !== "prefix") prefix = false;
  }
  control("F8", "a non-frozen budget follows the same rule: no special case, monotone admission, prefix order",
    ruleHolds && monotone && prefix,
    packets.map((p) => `${p.b}:${p.ledger.ceilingTokens}/${p.packet.related.length}`).join(" "));
}

// ------------------------------------------------- F9 stale fixed cap
{
  // Under the predecessor policy the frozen MATCH line is unreachable by
  // arithmetic at every budget above 1575: the evidence packet is capped at
  // 2000 packet tokens = 6301 characters = 1576 chars/4 tokens.
  const capCharacters = Math.floor(2000 / 0.3174032272551657);
  const capFrozenTokens = Math.ceil(capCharacters / 4);
  const arithmetic = [4000, 8000, 16000].map((b) => ({ b, maxPercent: +(100 * capFrozenTokens / b).toFixed(2) }));
  const pre = projectPredecessor(authoritative(300, 16000));
  const measured = frozenUtilisationPercent(pre.packet, 16000);
  const verdict = frozenA11Verdict([100, 100, ...arithmetic.map((x) => x.maxPercent)]);
  control("F9", "the historical fixed cap fails the frozen utilisation gate by construction above 1575 tokens, and in measurement",
    arithmetic.every((x) => x.maxPercent < A11_MATCH_PERCENT) && measured < A11_MATCH_PERCENT
      && verdict === "VTRACE_BELOW_VEXP_CLAIM" && pre.ledger.candidates.rejectedForCeiling === 1,
    `cap = ${capFrozenTokens} chars/4 tokens -> at most ${arithmetic.map((x) => `${x.b}:${x.maxPercent}%`).join(" ")}; measured ${measured}% at 16000 with the ceiling rejecting; frozen band ${verdict}`);
}

// --------------------------------------------------- F10 output truth
{
  const state = authoritative(300, 16000);
  const items: any[] = (state.productContext as any).items;
  const small = project(authoritative(300, 1000)).packet;
  const { packet, ledger } = project(state);
  const newItems = packet.related.slice(small.related.length);
  const byFq = new Map(items.map((i) => [i.fqName, i]));
  const truthful = newItems.every((r: any, k: number) => {
    const src = byFq.get(r.at); const record = ledger.items[small.related.length + 1 + k];
    return src !== undefined && r.file === src.path && r.lines === `${src.lineSpan.start}-${src.lineSpan.end}`
      && r.how === src.selectionReasons[0] && record.sourceId === src.id && record.origin === "item_supply";
  });
  control("F10", "every item admitted by the larger budget maps to a real supply item: identity, file, span, claim and source id",
    newItems.length > 0 && truthful && packet.related.length > small.related.length,
    `${newItems.length} newly admitted items beyond the ${small.related.length} the 1000 budget admitted, all traced to supply`);
}

// -------------------------------------------------- F11 A5 protection
{
  const file = path.join(RESULTS, "stage5_m201_a5_m204_post.json");
  const a5 = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : null;
  const p90: Record<string, number | null> = a5?.p90ByCorpus ?? {};
  const values = ["C-SMALL", "C-MED", "C-LARGE"].map((c) => p90[c] ?? null);
  const withinMatch = values.every((v) => v !== null && v <= 500);
  control("F11", "the frozen A5 harness after the repair stays at or above MATCHES (p90 <= 500 ms on every corpus)",
    a5 !== null && withinMatch && (a5.classification === "VTRACE_MATCHES_VEXP_CLAIM" || a5.classification === "VTRACE_EXCEEDS_VEXP_CLAIM"),
    a5 === null ? "stage5_m201_a5_m204_post.json ABSENT: run run_stage5_m201_a5.ts --label m204_post first"
      : `p90 ${values.join(" / ")} ms, ${a5.classification}`);
}

// -------------------------------------------- F12 A13 independence
{
  // Two budgets, the larger one swapping the lead pivot: the frozen A13 rule
  // counts a focus swap while the utilisation analyzer passes both packets.
  const lo = project(authoritative(6, 4000));
  const hiState = authoritative(6, 8000, { productContext: { leadPivot: "pkg/mod1.py::Sym1.method" } });
  const hi = project(hiState);
  const focusSwap = lo.packet.focus.at !== hi.packet.focus.at;
  const loA = analyze(4000, lo.packet, lo.ledger); const hiA = analyze(8000, hi.packet, hi.ledger);
  const sizeViolation = Math.ceil((hi.packet.focus.code ?? "").length / 4) < Math.ceil((lo.packet.focus.code ?? "").length / 4);
  control("F12", "a focus swap between budgets stays an A13 violation while both packets pass the utilisation analyzer",
    focusSwap && loA.verdict === "UTILIZATION_INTEGRITY_PASS" && hiA.verdict === "UTILIZATION_INTEGRITY_PASS",
    `focus ${lo.packet.focus.at} -> ${hi.packet.focus.at} (swap ${focusSwap}, size violation ${sizeViolation}); analyzer ${loA.verdict} / ${hiA.verdict}`);
}

const allPass = controls.every((c) => c.pass);
const out = {
  milestone: "M204", instrument: "run_stage5_m204_falsification.ts",
  predecessor: { root: PREDECESSOR_ROOT, head: predecessorHead, ceilingTokens: predecessor.ORIENTATION_POLICY.ceilingTokens },
  repaired: { ceilingRule: "orientationCeilingTokens(requested_context_tokens)", defaultCeilingTokens: ORIENTATION_POLICY.ceilingTokens,
    focusCodeCharacters: ORIENTATION_POLICY.focusCodeCharacters, charactersPerRequestedToken: ORIENTATION_CHARACTERS_PER_REQUESTED_TOKEN },
  frozenRule: { numerator: "ceil(JSON.stringify(output).length/4)", matchPercent: A11_MATCH_PERCENT,
    probe: `an empty output costs ${frozenWholeResponseTokens({})} token under the rule` },
  controls, allPass,
  verdict: allPass ? "M204_FALSIFICATION_CONTROLS_PASS" : "M204_FALSIFICATION_CONTROLS_FAIL",
};
writeFileSync(path.join(RESULTS, "stage5_m204_falsification.json"), `${JSON.stringify(out, null, 2)}\n`);
console.log(`\n${out.verdict} (${controls.filter((c) => c.pass).length}/${controls.length})`);
if (!allPass) process.exit(1);
