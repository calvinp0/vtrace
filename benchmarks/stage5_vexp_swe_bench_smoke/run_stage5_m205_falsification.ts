/**
 * M205 — falsification controls F1-F12.
 *
 * A gate that has never been seen to fail is not known to be a gate. Each
 * control below constructs the specific dishonesty it guards against — a
 * relabelled class, an invented excerpt, a wrong signature, an oversized code,
 * a form forced onto a body that is not source, a stale cost, an unstable
 * routing, a tight budget forced rich, a rich class that exists only on paper,
 * a duplicated item, a severed provenance, a hard-coded class count — and
 * shows the production projector, the representation analyzer, or the frozen
 * rule refusing it, beside the honest case each accepts.
 *
 * The packets are REAL: produced by the production projector from a synthetic
 * authoritative state exactly as the unit tests build one, and, for the
 * predecessor policy, by the projector of a worktree at the M204 commit. Any
 * mutation happens on copies after the projector has returned, so no control
 * can influence what the product does. F9 additionally reads the post-change
 * sweep, because a class must be shown on a genuine production-path item.
 *
 *   bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m205_falsification.ts \
 *     [--predecessor-root /home/calvin/bench/vtrace-m205/pre]
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { orientationAccountingOf } from "../../src/runPipeline/orientationAccounting";
import { ORIENTATION_POLICY, orientationCeilingTokens, projectRunPipelineOrientation } from "../../src/runPipeline/orientationProjection";
import { REPRESENTATION_LADDER, availableRepresentation, representationClassOf } from "../../src/runPipeline/orientationRepresentation";
import { analyzeAccounting, frozenA14ItemsAccounted, frozenA14ItemsDelivered } from "./m203Accounting";
import {
  A12_MATCH_CLASSES, analyzeRepresentation, classDistinction, frozenA12Classes, frozenA12Verdict,
  type SourceAuthority, type SupplyItem,
} from "./m205Representation";

const RESULTS = path.join(import.meta.dir, "results");
const args = process.argv.slice(2);
const argOf = (f: string, d: string) => { const i = args.indexOf(f); return i >= 0 && args[i + 1] !== undefined ? args[i + 1]! : d; };
const PREDECESSOR_ROOT = path.resolve(argOf("--predecessor-root", "/home/calvin/bench/vtrace-m205/pre"));

const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));

const predecessor = await import(path.join(PREDECESSOR_ROOT, "src/runPipeline/orientationProjection.ts"));
const predecessorAccounting = await import(path.join(PREDECESSOR_ROOT, "src/runPipeline/orientationAccounting.ts"));
const predecessorHead = Bun.spawnSync(["git", "-C", PREDECESSOR_ROOT, "rev-parse", "HEAD"]).stdout.toString().trim();
if (typeof predecessor.ORIENTATION_POLICY.relatedCodeCharacters === "number") {
  throw new Error("M205_PREDECESSOR_ALREADY_REPAIRED: the predecessor tree declares a related code bound");
}

/** A synthetic corpus: one file per related item, its body at the item's span; the authority answers from it. */
function corpus(forms: readonly string[], requested: number, options: { bodyLines?: number; neighbour?: boolean } = {}) {
  const lines = options.bodyLines ?? 3;
  const bodyFor = (k: number, form: string): string => form === "signature" ? `def method_${k}(a, b):`
    : form === "skeleton" ? `def method_${k}(a, b):\n# docstring ${k}`
      : Array.from({ length: lines }, (_, l) => (l === 0 ? `def method_${k}(a, b):` : `    step_${l} = a + b * ${k}`)).join("\n");
  const items = Array.from({ length: forms.length + 1 }, (_, index) => ({
    id: `i${index}`,
    fqName: index === 0 ? "pkg/focus.py::Focus.run" : `pkg/mod${index}.py::Sym${index}.method`,
    path: index === 0 ? "pkg/focus.py" : `pkg/mod${index}.py`,
    lineSpan: { start: index * 10 + 1, end: index * 10 + 9 + Math.max(0, lines - 9) },
    contentMode: index === 0 ? "focused_source" : forms[index - 1]!,
    roles: index === 0 ? ["pivot"] : ["support"],
    selectionReasons: [index === 0 ? "lead pivot for this task" : `direct caller ${index}`],
    estimatedTokens: 75 + index,
  }));
  const bodyOf = (index: number) => (index === 0 ? "def run(self):\n    return 1" : bodyFor(index, forms[index - 1]!));
  const files = new Map<string, string>();
  for (const [index, item] of items.entries()) {
    const filler = Array.from({ length: index * 10 + lines + 4 }, (_, l) => `# filler ${l + 1}`);
    const full = index === 0 ? bodyOf(0) : bodyFor(index, "focused_source");
    filler.splice(index * 10, full.split("\n").length, ...full.split("\n"));
    files.set(item.path, filler.join("\n"));
  }
  const state: any = {
    diagnostics: { freshness: { readiness: { ready: true } } },
    pivotNeighborhood: options.neighbour ? [{ excerpts: [{ fqName: "pkg/n.py::Near", filePath: "pkg/n.py", startLine: 1, endLine: 4, reason: "caller", textCharacters: 88 }] }] : [],
    responseBudget: { requested_context_tokens: requested },
    productContext: {
      resolved: true, retrievalFound: true, deliveryFailed: false, leadPivot: "pkg/focus.py::Focus.run", items,
      modelVisibleContext: items.map((item, k) => `\n## [${item.id}]\nroles: ${item.roles.join(",")}\nmode: ${item.contentMode}\n\n${bodyOf(k)}`).join("\n"),
      freshness: { status: "fresh", reason: "" },
      delivery: { status: "complete", selectedItemsBeforeBudget: items.length, deliveredItems: items.length, droppedForBudget: 0, finalModelTokens: 900, compactionStages: [] },
      accounting: { budgetTokens: requested, usedTokensEstimate: 900, remainingTokensEstimate: requested - 900 },
    },
  };
  const supply: SupplyItem[] = items.map((item, k) => ({ id: item.id, fqName: item.fqName, path: item.path, contentMode: item.contentMode, content: bodyOf(k), lineSpan: item.lineSpan }));
  const authority: SourceAuthority = {
    readFile: (p) => files.get(p) ?? null,
    symbol: (fqName) => {
      const k = items.findIndex((i) => i.fqName === fqName);
      return k < 0 ? null : { signature: `def method_${k}(a, b):`, startLine: k * 10 + 1, endLine: k * 10 + 9, kind: "function", localName: `method_${k}` };
    },
    skeleton: (_p, fqName) => { const k = items.findIndex((i) => i.fqName === fqName); return k < 0 ? null : `def method_${k}(a, b):\n# docstring ${k}`; },
  };
  return { state, supply, authority, files };
}

const project = (state: any) => { const packet: any = projectRunPipelineOrientation(state); return { packet, ledger: orientationAccountingOf(packet) as any }; };
const projectPredecessor = (state: any) => {
  const packet: any = predecessor.projectRunPipelineOrientation(state);
  return { packet, ledger: predecessorAccounting.orientationAccountingOf(packet) as any };
};
const analyze = (budget: number, packet: any, ledger: any, supply: SupplyItem[] | null, authority: SourceAuthority | null) =>
  analyzeRepresentation({ packet, ledger, ceilingTokens: orientationCeilingTokens(budget), relatedBound: ORIENTATION_POLICY.relatedCodeCharacters,
    focusBound: ORIENTATION_POLICY.focusCodeCharacters, supply, authority });
const failedItemGates = (a: ReturnType<typeof analyzeRepresentation>, k: number) => a.items[k]!.gates.filter((g) => !g.pass).map((g) => g.id);
const failedGates = (a: { gates: readonly { id: string; pass: boolean }[] }) => a.gates.filter((g) => !g.pass).map((g) => g.id);
const compactKeys = (r: any) => JSON.stringify(Object.keys(r));

const controls: { id: string; statement: string; pass: boolean; detail: string }[] = [];
const control = (id: string, statement: string, pass: boolean, detail: string) => {
  controls.push({ id, statement, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"}  ${id.padEnd(4)} ${statement}\n      ${detail}`);
};

// ------------------------------------------------ F1 relabel-only class
{
  // Same bytes, same construction, different label: the class authority does
  // not count a label without code, the analyzer refuses a skeleton labelled
  // signature against the parser, and a pair of classes that never differ
  // collapses.
  const { state, supply, authority } = corpus(["skeleton"], 16000);
  const { packet, ledger } = project(state);
  const relabelled = clone(packet); relabelled.related[0].form = "signature";
  const relabelledLedger = clone(ledger); relabelledLedger.items[1].representation = "signature"; relabelledLedger.items[1].availableRepresentation = "signature";
  const a = analyze(16000, relabelled, relabelledLedger, supply, authority);
  const labelOnly = representationClassOf({ form: "signature" }, "related") === representationClassOf({ form: "skeleton" }, "related");
  const collapse = classDistinction([{ a: "skeleton", b: "signature", textA: "def f():", textB: "def f():" }]);
  control("F1", "a label without a construction is not a class: relabelling fails the source authority, counts nothing, and identical classes collapse",
    labelOnly && a.items[1]!.sourceTruth === "SIGNATURE_NOT_PARSER" && a.verdict === "REPRESENTATION_INTEGRITY_FAIL" && collapse.pass === false
      && frozenA12Classes({ focus: packet.focus, related: [{ ...relabelled.related[0], code: undefined }] }).length === 2,
    `relabelled skeleton -> ${a.items[1]!.sourceTruth}; label-only classes equal: ${labelOnly}; identical-text pair collapses: ${!collapse.pass}`);
}

// ---------------------------------------------- F2 invented excerpt
{
  const { state, supply, authority } = corpus(["focused_source"], 16000);
  const { packet, ledger } = project(state);
  const honest = analyze(16000, packet, ledger, supply, authority);
  const forged = clone(packet); forged.related[0].code = "def stolen(a):\n    return a";
  const a = analyze(16000, forged, ledger, supply, authority);
  control("F2", "an excerpt whose bytes do not exist at the claimed source fails; the real one is anchored in its span",
    honest.items[1]!.sourceTruth === "ANCHORED_IN_SPAN" && a.items[1]!.sourceTruth === "NOT_LOCATED" && failedItemGates(a, 1).includes("source_truth"),
    `honest ${honest.items[1]!.sourceTruth}; forged ${a.items[1]!.sourceTruth} -> ${failedItemGates(a, 1).join(",")}`);
}

// ------------------------------------------------ F3 wrong signature
{
  const { state, supply, authority } = corpus(["signature"], 16000);
  const { packet, ledger } = project(state);
  const honest = analyze(16000, packet, ledger, supply, authority);
  const forged = clone(packet); forged.related[0].code = "def method_1(a, b, c):";
  const a = analyze(16000, forged, ledger, supply, authority);
  control("F3", "a signature differing from the parser's fails; the parser's passes",
    honest.items[1]!.sourceTruth === "PARSER_SIGNATURE" && a.items[1]!.sourceTruth === "SIGNATURE_NOT_PARSER" && a.verdict === "REPRESENTATION_INTEGRITY_FAIL",
    `honest ${honest.items[1]!.sourceTruth}; forged ${a.items[1]!.sourceTruth}`);
}

// ------------------------------------------- F4 oversized representation
{
  const { state, supply, authority } = corpus(["focused_source"], 16000, { bodyLines: 200 });
  const { packet, ledger } = project(state);
  const entry = packet.related[0];
  const a = analyze(16000, packet, ledger, supply, authority);
  const big = clone(packet); big.related[0].code = supply[1]!.content;
  const b = analyze(16000, big, ledger, supply, authority);
  control("F4", "a body over the bound is deterministically truncated on a line boundary and says so; a forced oversized code fails",
    entry.code.length <= ORIENTATION_POLICY.relatedCodeCharacters && entry.codeTruncated === true && supply[1]!.content!.startsWith(entry.code)
      && entry.code.endsWith(")") === false && a.verdict === "REPRESENTATION_INTEGRITY_PASS"
      && failedItemGates(b, 1).includes("bound_respected"),
    `body ${supply[1]!.content!.length} chars -> ${entry.code.length} delivered, truncated ${entry.codeTruncated}; forced ${big.related[0].code.length} -> ${failedItemGates(b, 1).join(",")}`);
}

// ------------------------------------------ F5 unavailable representation
{
  const { state, supply, authority } = corpus(["summary", "focused_source"], 16000, { neighbour: true });
  const items = state.productContext.items;
  // An item with a code-bearing label and no body at all.
  items.push({ id: "i9", fqName: "pkg/empty.py::Empty", path: "pkg/empty.py", lineSpan: { start: 1, end: 2 }, contentMode: "focused_source", roles: ["support"], selectionReasons: ["direct caller 9"], estimatedTokens: 1 });
  state.productContext.modelVisibleContext += "\n## [i9]\nroles: support\nmode: focused_source\n\n";
  const { packet, ledger } = project(state);
  const byAt = new Map(ledger.items.map((i: any) => [i.at, i]));
  const summary: any = byAt.get("pkg/mod1.py::Sym1.method"); const near: any = byAt.get("pkg/n.py::Near"); const empty: any = byAt.get("pkg/empty.py::Empty");
  const availability = availableRepresentation({ origin: "item_supply", form: "summary", body: "CALLS x", bound: 600 });
  const forced = clone(packet); const k = forced.related.findIndex((r: any) => r.at === "pkg/mod1.py::Sym1.method");
  forced.related[k] = { ...forced.related[k], form: "summary", code: "CALLS x", codeTruncated: false };
  const a = analyze(16000, forced, ledger, [...supply, { id: "i9", fqName: "pkg/empty.py::Empty", path: "pkg/empty.py", contentMode: "focused_source", content: "" }], authority);
  control("F5", "an item whose evidence supports no richer form falls back to relationship-only with the reason recorded; a forced form on a non-source body fails",
    summary.representationReason === "form_not_code_bearing" && near.representationReason === "neighbour_text_not_carried" && empty.representationReason === "no_rendered_body"
      && !("code" in packet.related.find((r: any) => r.at === "pkg/mod1.py::Sym1.method")) && availability.available === false
      && failedItemGates(a, k + 1).includes("form_is_code_bearing"),
    `summary -> ${summary.representationReason}; neighbour -> ${near.representationReason}; empty body -> ${empty.representationReason}; forced summary code -> ${failedItemGates(a, k + 1).join(",")}`);
}

// ------------------------------------------------ F6 accounting mismatch
{
  const { state, supply, authority } = corpus(["focused_source", "skeleton", "signature"], 16000);
  const { packet, ledger } = project(state);
  const compact = projectPredecessor(state);
  const m203 = analyzeAccounting({ packet, ledger, ceilingTokens: orientationCeilingTokens(16000) });
  const stale = clone(ledger);
  // Report the relationship-only cost for an entry that now carries an excerpt.
  stale.items[1].actualTokens = compact.ledger.items[1].actualTokens; stale.items[1].characters = compact.ledger.items[1].characters;
  const staleM203 = analyzeAccounting({ packet, ledger: stale, ceilingTokens: orientationCeilingTokens(16000) });
  const a = analyze(16000, packet, stale, supply, authority);
  control("F6", "a rich packet reconciles exactly under M203 and every item is A14-accounted; the relationship-only cost reported for an excerpt fails",
    m203.verdict === "ACCOUNTING_INTEGRITY_PASS" && frozenA14ItemsAccounted(packet) === frozenA14ItemsDelivered(packet)
      && packet.related[0].tokens > compact.packet.related[0].tokens
      && staleM203.verdict === "ACCOUNTING_INTEGRITY_FAIL" && failedGates(a).includes("m203_accounting"),
    `rich entry ${packet.related[0].tokens} tokens vs compact ${compact.packet.related[0].tokens}; M203 ${m203.verdict}; stale -> ${staleM203.gates.filter((g) => !g.pass).map((g) => g.id).join(",")}`);
}

// ------------------------------------------------ F7 deterministic routing
{
  const forms = ["focused_source", "skeleton", "signature", "summary", "focused_source", "skeleton"];
  const hashes = new Set<string>(); const ledgers = new Set<string>();
  for (let i = 0; i < 5; i += 1) {
    const { packet, ledger } = project(corpus(forms, 3000).state);
    hashes.add(sha(JSON.stringify(packet))); ledgers.add(sha(JSON.stringify(ledger)));
  }
  control("F7", "the same items, budget and source state select the same representations across repeats",
    hashes.size === 1 && ledgers.size === 1, `5 repeats: ${hashes.size} packet hash(es), ${ledgers.size} ledger hash(es)`);
}

// ------------------------------------------------ F8 compact fallback
{
  const forms = Array.from({ length: 14 }, () => "focused_source");
  const { state, supply, authority } = corpus(forms, 1000, { bodyLines: 12 });
  const { packet, ledger } = project(state);
  const pre = projectPredecessor(state);
  const reasons = ledger.items.slice(1).map((i: any) => i.representationReason);
  const compactEntries = packet.related.filter((r: any) => !("code" in r));
  const sameSet = JSON.stringify(packet.related.map((r: any) => r.at)) === JSON.stringify(pre.packet.related.map((r: any) => r.at));
  const compactBytesIdentical = compactEntries.every((r: any) => {
    const p = pre.packet.related.find((x: any) => x.at === r.at); const { tokens: _a, ...ra } = r; const { tokens: _b, ...rb } = p ?? {};
    return JSON.stringify(ra) === JSON.stringify(rb);
  });
  const a = analyze(1000, packet, ledger, supply, authority);
  control("F8", "at a tight budget the richer form is refused where it does not fit and the compact entry survives, byte-identical to the predecessor's",
    reasons.includes("ceiling") && compactEntries.length > 0 && sameSet && compactBytesIdentical && a.verdict === "REPRESENTATION_INTEGRITY_PASS"
      && ledger.evidence.tokens <= ledger.ceilingTokens,
    `${reasons.filter((r: string) => r === "upstream_form_delivered").length} rich, ${reasons.filter((r: string) => r === "ceiling").length} refused for the ceiling of ${ledger.ceilingTokens}; same set as predecessor ${sameSet}; compact bytes identical ${compactBytesIdentical}`);
}

// ------------------------------------------------ F9 rich availability
{
  const file = path.join(RESULTS, "stage5_m205_representation_post.json");
  const post = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : null;
  const cmed = post?.corpora?.find((c: any) => c.id === "C-MED") ?? null;
  const at16k = cmed?.byBudget?.["16000"] ?? null;
  const truth = cmed?.sourceTruth ?? {};
  const anchored = Object.values(truth).every((t: any) => Object.keys(t).every((k) => ["ANCHORED_IN_SPAN", "ANCHORED_IN_FILE", "LINEWISE_VERBATIM", "PARSER_SIGNATURE", "SKELETON_MATCHES_INDEX", "SKELETON_HEAD_OF_INDEX"].includes(k)));
  const forms = Array.from({ length: 6 }, () => "focused_source");
  const { packet } = project(corpus(forms, 16000).state);
  control("F9", "at a large budget a genuine production-path related item carries its richer form, source-anchored; the class is not on paper",
    packet.related.every((r: any) => typeof r.code === "string") && at16k !== null && at16k.totals.relatedWithCode > 0 && anchored
      && (cmed?.frozenA12?.distinctClassesObserved ?? []).includes("RELATED_WITH_CODE"),
    post === null ? "stage5_m205_representation_post.json ABSENT: run run_stage5_m205_representation.ts --label post first"
      : `C-MED @16000: ${at16k?.totals?.relatedWithCode} of ${at16k?.totals?.relatedDelivered} related carry code; source truth ${JSON.stringify(truth)}`);
}

// -------------------------------------------- F10 no duplicate semantic item
{
  const { state, supply, authority } = corpus(["focused_source", "skeleton"], 16000);
  const { packet, ledger } = project(state);
  const dup = clone(packet); const { form: _f, code: _c, codeTruncated: _t, ...compact } = dup.related[0]; dup.related.push(compact);
  const dupLedger = clone(ledger); dupLedger.items.push({ ...clone(dupLedger.items[1]), ordinal: 3, representation: "relationship_only", codeDelivered: false, deliveredCodeCharacters: 0 });
  const a = analyze(16000, dup, dupLedger, supply, authority);
  // The product: a second proposal of one identity (the neighbourhood proposing a supply item) is delivered once.
  const twice = project(corpus(["focused_source"], 16000, { neighbour: true }).state);
  const twiceState = corpus(["focused_source"], 16000).state;
  twiceState.pivotNeighborhood = [{ excerpts: [{ fqName: "pkg/mod1.py::Sym1.method", filePath: "pkg/mod1.py", startLine: 11, endLine: 19, reason: "caller", textCharacters: 10 }] }];
  const once = project(twiceState);
  control("F10", "one candidate delivered twice to exhibit two classes fails; the product delivers a second proposal of one identity once",
    failedGates(a).includes("no_duplicate_identity") && once.packet.related.length === 1 && once.ledger.candidates.deduplicated === 1
      && frozenA12Classes(dup).length === 3 && frozenA12Classes(once.packet).length === 2 && twice.packet.related.length === 2,
    `duplicate -> ${failedGates(a).join(",")}; second proposal delivered ${once.packet.related.length} related, ${once.ledger.candidates.deduplicated} deduplicated`);
}

// ------------------------------------------------------- F11 provenance
{
  const { state, supply, authority } = corpus(["focused_source", "skeleton", "signature"], 16000);
  const { packet, ledger } = project(state);
  const honest = analyze(16000, packet, ledger, supply, authority);
  const everyMapped = ledger.items.slice(1).every((i: any, k: number) => supply.find((s) => s.id === i.sourceId)?.fqName === packet.related[k].at);
  const severed = clone(ledger); severed.items[1].sourceId = "unavailable";
  const a = analyze(16000, packet, severed, supply, authority);
  const foreign = clone(packet); foreign.related[0].file = "pkg/elsewhere.py";
  const b = analyze(16000, foreign, ledger, supply, authority);
  control("F11", "every source-backed entry maps to an authoritative supply item; a severed source id or a file outside the corpus fails",
    honest.verdict === "REPRESENTATION_INTEGRITY_PASS" && everyMapped && failedItemGates(a, 1).includes("provenance")
      && failedItemGates(b, 1).some((g) => g === "source_truth" || g === "provenance"),
    `all mapped ${everyMapped}; severed -> ${failedItemGates(a, 1).join(",")}; foreign file -> ${failedItemGates(b, 1).join(",")}`);
}

// ---------------------------------------------- F12 class-count authority
{
  // A ledger that asserts the classes, a packet that does not carry them.
  const { state, supply, authority } = corpus(["summary", "summary", "summary"], 16000);
  const { packet, ledger } = project(state);
  const claimed = clone(ledger); claimed.items[1].representation = "signature"; claimed.items[2].representation = "skeleton";
  const a = analyze(16000, packet, claimed, supply, authority);
  const frozen = frozenA12Classes(packet);
  control("F12", "a hard-coded class count without delivered classes fails the analyzer, and the frozen rule counts only what the packet carries",
    frozen.length === 2 && frozenA12Verdict(frozen.length) === "VTRACE_BELOW_VEXP_CLAIM"
      && a.items[1]!.gates.find((g) => g.id === "class_is_ledger_class")!.pass === false && a.verdict === "REPRESENTATION_INTEGRITY_FAIL"
      && REPRESENTATION_LADDER.length === 2,
    `packet classes ${frozen.join(", ")} (${frozen.length} < ${A12_MATCH_CLASSES}); asserted ledger classes -> ${failedItemGates(a, 1).join(",")}`);
}

const allPass = controls.every((c) => c.pass);
const out = {
  milestone: "M205", instrument: "run_stage5_m205_falsification.ts",
  predecessor: { root: PREDECESSOR_ROOT, head: predecessorHead },
  policy: { relatedCodeCharacters: ORIENTATION_POLICY.relatedCodeCharacters, focusCodeCharacters: ORIENTATION_POLICY.focusCodeCharacters, ladder: REPRESENTATION_LADDER },
  controls, allPass,
  verdict: allPass ? "M205_FALSIFICATION_CONTROLS_PASS" : "M205_FALSIFICATION_CONTROLS_FAIL",
};
writeFileSync(path.join(RESULTS, "stage5_m205_falsification.json"), `${JSON.stringify(out, null, 2)}\n`);
console.log(`\n${out.verdict} (${controls.filter((c) => c.pass).length}/${controls.length})`);
if (!allPass) process.exit(1);
