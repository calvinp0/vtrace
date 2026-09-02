/**
 * M203 — falsification controls F1-F12.
 *
 * A gate that has never been seen to fail is not known to be a gate. Each
 * control below constructs the specific dishonesty it guards against — a
 * missing record, a wrong cost, a duplicate, an unstable identity, a false
 * objective, a full-object cost for a truncated item, a fabricated zero-item
 * record, a hidden budget, an artificially slow path, a detached denominator —
 * and shows the relevant analyzer or frozen rule rejecting it, next to the
 * honest case it accepts.
 *
 * The packets and ledgers the controls mutate are REAL: produced by the
 * production projector from a synthetic authoritative state, exactly as the
 * unit tests build one. Mutation happens on copies, after the projector has
 * returned, so no control can influence what the product does.
 *
 *   bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m203_falsification.ts
 */
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { createMcpServer } from "../../src/mcp/server";
import { McpToolId, MCP_SERVER_SCHEMA } from "../../src/mcp/types";
import { orientationAccountingOf } from "../../src/runPipeline/orientationAccounting";
import { ORIENTATION_POLICY, projectRunPipelineOrientation } from "../../src/runPipeline/orientationProjection";
import { A5_QUERIES, corpusSpecs, latencyStats } from "./m197aFixtures";
import { ensureSnapshot, materializeWorkingCopy } from "./m201Corpus";
import { satisfiedByDefaultOutput } from "./m197aScoring";
import {
  analyzeAccounting, frozenA14ItemsAccounted, frozenA14ItemsDelivered, stripAccounting,
} from "./m203Accounting";

const REPO = path.resolve(import.meta.dir, "../..");
const RESULTS = path.join(import.meta.dir, "results");
const args = process.argv.slice(2);
const argOf = (f: string, d: string) => { const i = args.indexOf(f); return i >= 0 && args[i + 1] !== undefined ? args[i + 1]! : d; };
const SNAPSHOT = argOf("--snapshot", "/tmp/m201-snapshot");
const WORK_ROOT = argOf("--work", "/tmp/m203-falsification");
mkdirSync(WORK_ROOT, { recursive: true });

const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));
const CEILING = ORIENTATION_POLICY.ceilingTokens;
const failed = (analysis: ReturnType<typeof analyzeAccounting>) =>
  analysis.gates.filter((g) => !g.pass).map((g) => g.id);

/** A real authoritative state, as the projector's tests build one. */
function authoritative(count: number, overrides: Record<string, unknown> = {}, bodyChars = 300): Record<string, unknown> {
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
    responseBudget: { requested_context_tokens: 8000 },
    ...topLevel,
    productContext: {
      resolved: true, retrievalFound: true, deliveryFailed: false,
      leadPivot: "pkg/focus.py::Focus.run", items,
      modelVisibleContext: items
        .map((item) => `\n## [${item.id}]\nroles: ${item.roles.join(",")}\n\n${"x".repeat(bodyChars)}`).join("\n"),
      freshness: { status: "fresh", reason: "" },
      delivery: { status: "complete", selectedItemsBeforeBudget: count + 1, deliveredItems: count + 1,
        droppedForBudget: 0, finalModelTokens: 900, compactionStages: [] },
      accounting: { budgetTokens: 8000, usedTokensEstimate: 900, remainingTokensEstimate: 7100 },
      ...(productContextOverride as Record<string, unknown> ?? {}),
    },
  };
}

const real = (count: number, overrides?: Record<string, unknown>, bodyChars?: number) => {
  const packet: any = projectRunPipelineOrientation(authoritative(count, overrides, bodyChars));
  const ledger: any = orientationAccountingOf(packet);
  const honest = analyzeAccounting({ packet, ledger, ceilingTokens: CEILING });
  if (honest.verdict !== "ACCOUNTING_INTEGRITY_PASS") {
    throw new Error(`M203_CONTROL_BASELINE_NOT_HONEST: ${failed(honest).join(",")}`);
  }
  return { packet, ledger };
};

const controls: { id: string; statement: string; pass: boolean; detail: string }[] = [];
const control = (id: string, statement: string, pass: boolean, detail: string) => {
  controls.push({ id, statement, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"}  ${id.padEnd(4)} ${statement}\n      ${detail}`);
};

// ------------------------------------------------------------------ F1 missing
{
  const { packet, ledger } = real(5);
  const missingRecord = clone(ledger); missingRecord.items.splice(2, 1);
  const a = analyzeAccounting({ packet, ledger: missingRecord, ceilingTokens: CEILING });
  const missingField = clone(packet); delete missingField.related[1].tokens;
  const b = analyzeAccounting({ packet: missingField, ledger, ceilingTokens: CEILING });
  const frozenShort = frozenA14ItemsAccounted(missingField) < frozenA14ItemsDelivered(missingField);
  control("F1", "one eligible delivered item without accounting fails coverage",
    a.verdict === "ACCOUNTING_INTEGRITY_FAIL" && failed(a).includes("every_item_accounted")
      && b.verdict === "ACCOUNTING_INTEGRITY_FAIL" && failed(b).includes("model_facing_field_per_item") && frozenShort,
    `record removed -> ${failed(a).join(",")}; field removed -> ${failed(b).join(",")}; `
      + `frozen count ${frozenA14ItemsAccounted(missingField)}/${frozenA14ItemsDelivered(missingField)}`);
}

// --------------------------------------------------------------- F2 wrong cost
{
  const { packet, ledger } = real(4);
  const wrongLedger = clone(ledger); wrongLedger.items[1].actualTokens += 1;
  const a = analyzeAccounting({ packet, ledger: wrongLedger, ceilingTokens: CEILING });
  const wrongPacket = clone(packet); wrongPacket.related[0].tokens -= 1;
  const b = analyzeAccounting({ packet: wrongPacket, ledger, ceilingTokens: CEILING });
  control("F2", "a reported cost that is not the serializer's cost fails integrity",
    a.verdict === "ACCOUNTING_INTEGRITY_FAIL" && failed(a).includes("actual_cost_is_measured")
      && b.verdict === "ACCOUNTING_INTEGRITY_FAIL" && failed(b).includes("field_is_measured"),
    `ledger +1 -> ${failed(a).join(",")}; packet -1 -> ${failed(b).join(",")}`);
}

// ---------------------------------------------------------------- F3 duplicate
{
  const { packet, ledger } = real(4);
  const dup = clone(ledger); dup.items.push(clone(dup.items[2]));
  const a = analyzeAccounting({ packet, ledger: dup, ceilingTokens: CEILING });
  // And the honest case where two routes propose one item: delivered once, one record.
  const two = real(3, { pivotNeighborhood: [{ pivot: {}, excerpts: [
    { fqName: "pkg/mod1.py::Sym1.method", filePath: "pkg/mod1.py", startLine: 11, endLine: 19, reason: "caller", textCharacters: 100 },
  ] }] });
  const onceDelivered = two.packet.related.filter((r: any) => r.at === "pkg/mod1.py::Sym1.method").length === 1;
  const onceAccounted = two.ledger.items.filter((i: any) => i.at === "pkg/mod1.py::Sym1.method").length === 1;
  const bothOrigins = JSON.stringify(two.ledger.items.find((i: any) => i.at === "pkg/mod1.py::Sym1.method").origins)
    === JSON.stringify(["item_supply", "pivot_neighborhood"]);
  control("F3", "one delivered item with two accounting records fails; two routes to one item yield one record",
    a.verdict === "ACCOUNTING_INTEGRITY_FAIL" && failed(a).includes("no_duplicate_records")
      && onceDelivered && onceAccounted && bothOrigins && two.ledger.candidates.deduplicated === 1,
    `duplicated record -> ${failed(a).join(",")}; dual-route item delivered ${onceDelivered ? 1 : 2}x, `
      + `accounted ${onceAccounted ? 1 : 2}x, origins recorded ${bothOrigins}`);
}

// ------------------------------------------------------------ F4 unstable identity
{
  const { packet, ledger } = real(4);
  const randomIds = clone(ledger); randomIds.items[1].at = randomUUID();
  const a = analyzeAccounting({ packet, ledger: randomIds, ceilingTokens: CEILING });
  const stamped = clone(ledger); stamped.items[0].timestamp = Date.now();
  const b = analyzeAccounting({ packet, ledger: stamped, ceilingTokens: CEILING });
  const repeatA = sha(JSON.stringify(real(6).ledger));
  const repeatB = sha(JSON.stringify(real(6).ledger));
  control("F4", "a random or clock-derived identity fails; identical states hash identically",
    a.verdict === "ACCOUNTING_INTEGRITY_FAIL" && failed(a).includes("identities_match_in_order")
      && b.verdict === "ACCOUNTING_INTEGRITY_FAIL" && failed(b).includes("identity_is_semantic") && repeatA === repeatB,
    `uuid -> ${failed(a).join(",")}; timestamp -> ${failed(b).join(",")}; repeat hash equal ${repeatA === repeatB}`);
}

// -------------------------------------------------------------- F5 wrong objective
{
  const { packet, ledger } = real(4);
  const swapped = clone(ledger); swapped.items[1].reason = "direct caller 2";
  const a = analyzeAccounting({ packet, ledger: swapped, ceilingTokens: CEILING });
  const misrouted = clone(ledger); misrouted.items[2].origin = "pivot_neighborhood"; misrouted.items[2].origins = ["pivot_neighborhood"];
  const b = analyzeAccounting({ packet, ledger: misrouted, ceilingTokens: CEILING });
  control("F5", "an admission reason the packet does not make, or a route that did not admit, fails attribution",
    a.verdict === "ACCOUNTING_INTEGRITY_FAIL" && failed(a).includes("reason_is_the_packet_claim")
      && b.verdict === "ACCOUNTING_INTEGRITY_FAIL" && failed(b).includes("neighbour_reason_is_frozen_phrase"),
    `reason swapped -> ${failed(a).join(",")}; origin swapped -> ${failed(b).join(",")}`);
}

// ------------------------------------------------------------ F6 truncated cost
{
  const { packet, ledger } = real(2, {}, 5000);
  if (!packet.focus.codeTruncated) throw new Error("M203_CONTROL_F6_NOT_TRUNCATED");
  const fullObject = clone(ledger);
  // Report the full body as if it had been delivered.
  const fullBodyChars = JSON.stringify({ ...packet.focus, code: "x".repeat(5000) }).length;
  fullObject.items[0].characters = fullBodyChars;
  fullObject.items[0].actualTokens = Math.round(fullBodyChars * 0.3174032272551657);
  const a = analyzeAccounting({ packet, ledger: fullObject, ceilingTokens: CEILING });
  const denied = clone(ledger); denied.items[0].truncated = false;
  const b = analyzeAccounting({ packet, ledger: denied, ceilingTokens: CEILING });
  control("F6", "a full-object cost, or a denied truncation, for a head-bounded item fails",
    a.verdict === "ACCOUNTING_INTEGRITY_FAIL" && failed(a).includes("actual_cost_is_measured")
      && b.verdict === "ACCOUNTING_INTEGRITY_FAIL" && failed(b).includes("truncation_truthful")
      && ledger.items[0].bodyCharacters === 5000 && ledger.items[0].deliveredCodeCharacters < 5000,
    `full-body cost -> ${failed(a).join(",")}; truncated=false -> ${failed(b).join(",")}; honest record: body 5000, `
      + `delivered ${ledger.items[0].deliveredCodeCharacters}, tokens ${ledger.items[0].actualTokens}`);
}

// --------------------------------------------------------------- F7 zero items
{
  const none = projectRunPipelineOrientation(authoritative(0, { productContext: { resolved: false, retrievalFound: false, items: [] } }));
  const noLedger = none === null && orientationAccountingOf({}) === undefined;
  // The frozen rule counts the focus SLOT even on a decline (1 + related.length),
  // so a declined response reads as one delivered, zero accounted. Stated, not
  // normalised: on the scored corpus no query declines (see the A14 artefact).
  const frozenOnDecline = { delivered: frozenA14ItemsDelivered({ schemaVersion: "decline" }),
    accounted: frozenA14ItemsAccounted({ schemaVersion: "decline" }) };
  control("F7", "a result with no delivered items publishes no fabricated accounting item",
    noLedger && frozenOnDecline.accounted === 0,
    `projector declined: ${none === null}; ledger for a non-packet: none; frozen rule on a decline counts `
      + `${frozenOnDecline.delivered} slot / ${frozenOnDecline.accounted} accounted (the 1+ convention, reported as such)`);
}

// ---------------------------------------------------------- F8 underutilised budget
{
  const { packet, ledger } = real(3);
  const unused = ledger.ceilingTokens - ledger.evidence.tokens;
  const evidenceBytes = JSON.stringify(stripAccounting(packet));
  const unchanged = evidenceBytes.length === ledger.evidence.characters
    && ledger.candidates.rejectedForCeiling === 0 && packet.related.length === 3;
  control("F8", "unused budget is visible and nothing was added to consume it",
    unused > 0 && unchanged && ledger.evidenceBudget.remainingTokens === 7100,
    `ceiling ${ledger.ceilingTokens}, evidence ${ledger.evidence.tokens}, unused ${unused}; upstream remaining `
      + `${ledger.evidenceBudget.remainingTokens}; related delivered 3 of 3, rejected 0`);
}

// ----------------------------------------------------------- F9 budget exhausted
{
  const { packet, ledger } = real(300);
  const last = ledger.items.at(-1);
  const exact = ledger.reconciliation.charactersExact
    && ledger.reconciliation.itemCharacters + ledger.reconciliation.wrapperCharacters === JSON.stringify(packet).length
    && last.characters === JSON.stringify(packet.related.at(-1)).length;
  control("F9", "a ceiling-exhausted packet reconciles exactly and records the rejection",
    ledger.candidates.rejectedForCeiling === 1 && ledger.evidence.withinCeiling && exact
      && ledger.candidates.rejected[0].admissionPacketTokens > CEILING,
    `related ${packet.related.length} of 300, evidence ${ledger.evidence.tokens} <= ${CEILING}, first rejected `
      + `${ledger.candidates.rejected[0].at} at ${ledger.candidates.rejected[0].admissionPacketTokens}; exact ${exact}`);
}

// --------------------------------------------------------- F10 output equivalence
{
  const p = path.join(RESULTS, "stage5_m203_equivalence.json");
  const eq = existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : null;
  control("F10", "machine-facing accounting did not alter the model-facing evidence",
    eq !== null && eq.verdict === "M203_EVIDENCE_EQUIVALENT" && eq.strippedByteEqual === eq.compared
      && eq.selectionEqual === eq.compared && eq.differencesExplainedByTokensFieldAlone === eq.compared,
    eq === null ? "stage5_m203_equivalence.json missing" : `${eq.compared} frozen queries: selection ${eq.selectionEqual}, `
      + `bytes-with-tokens-removed ${eq.strippedByteEqual}, delivered bytes ${eq.deliveredByteEqual} `
      + `(${eq.differencesExplainedByTokensFieldAlone} differ by the tokens field alone)`);
}

// ------------------------------------------------------------- F11 A5 protection
{
  /** The frozen A5 rule as run_stage5_m201_a5.ts states it: every corpus p90 <= 500 (MATCH), <= 200 (EXCEED). */
  const classify = (p90s: number[]) => p90s.every((v) => v <= 200) ? "VTRACE_EXCEEDS_VEXP_CLAIM"
    : p90s.every((v) => v <= 500) ? "VTRACE_MATCHES_VEXP_CLAIM" : "VTRACE_BELOW_VEXP_CLAIM";
  const spec = corpusSpecs(REPO).find((s) => s.id === "C-SMALL")!;
  ensureSnapshot(spec, SNAPSHOT);
  const work = materializeWorkingCopy(spec, SNAPSHOT, WORK_ROOT);
  let detail = "C-SMALL corpus absent";
  let pass = false;
  if (work !== null) {
    const server = createMcpServer({ context: { repoRoot: work, dbPath: path.join(work, ".vtrace/index.sqlite") } } as any);
    const call = async (toolId: string, input: unknown) => {
      const res: any = await server.handleRequest({ schema: MCP_SERVER_SCHEMA, requestId: "f11", toolId, input } as any);
      return res?.result?.output;
    };
    await call(McpToolId.IndexRepo, { repo_root: work });
    const honest: number[] = []; const expensive: number[] = [];
    for (const task of A5_QUERIES["C-SMALL"] ?? []) {
      await call(McpToolId.GetCodeContext, { task, repo_root: work });
      for (let i = 0; i < 3; i += 1) {
        const t0 = performance.now();
        const out = await call(McpToolId.GetCodeContext, { task, repo_root: work });
        const ledger = orientationAccountingOf(out ?? {});
        if (ledger !== undefined) analyzeAccounting({ packet: out, ledger, ceilingTokens: CEILING });
        honest.push(performance.now() - t0);
        // An artificially expensive accounting path: the same call, then the
        // analyzer run until it has cost more than the whole budget allows.
        const t1 = performance.now();
        const out2 = await call(McpToolId.GetCodeContext, { task, repo_root: work });
        const deadline = performance.now() + 520;
        do { analyzeAccounting({ packet: out2, ledger: orientationAccountingOf(out2 ?? {}), ceilingTokens: CEILING }); }
        while (performance.now() < deadline);
        expensive.push(performance.now() - t1);
      }
    }
    const honestP90 = latencyStats(honest).p90; const expensiveP90 = latencyStats(expensive).p90;
    pass = classify([expensiveP90]) === "VTRACE_BELOW_VEXP_CLAIM" && classify([honestP90]) !== "VTRACE_BELOW_VEXP_CLAIM";
    detail = `C-SMALL p90 with the real accounting path ${honestP90} ms -> ${classify([honestP90])}; with a ~520 ms `
      + `accounting path ${expensiveP90} ms -> ${classify([expensiveP90])}`;
  }
  control("F11", "an artificially expensive accounting path fails the frozen A5 gate", pass, detail);
}

// ----------------------------------------------------- F12 denominator authority
{
  const p = path.join(RESULTS, "stage5_m203_a14_post.json");
  const post = existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : null;
  const cmed = post?.corpora?.find((c: any) => c.id === "C-MED");
  const fromResponses = cmed === undefined ? null : {
    delivered: cmed.responses.reduce((n: number, r: any) => n + r.frozen.itemsDelivered, 0),
    accounted: cmed.responses.reduce((n: number, r: any) => n + r.frozen.itemsWithTokenAccounting, 0),
  };
  const derived = fromResponses !== null && fromResponses.delivered === cmed.a14.itemsDelivered
    && fromResponses.accounted === cmed.a14.itemsWithPerItemAccounting;
  // No module on the delivery path names the frozen denominators, the frozen
  // tasks, the frozen corpus, or compares an item count to a constant.
  const src = Bun.spawnSync(["grep", "-rlE",
    "\\b(985|996|1002)\\b|(itemCount|items\\.length|related\\.length) === [1-9]|A13_TASKS|C-MED|where are import edges extracted from typescript",
    path.join(REPO, "src/runPipeline"), path.join(REPO, "src/productContext"), path.join(REPO, "src/mcp/responseEnvelope.ts"),
    "--include=*.ts"]).stdout.toString().trim();
  const detached = { itemsDelivered: 1002, itemsWithPerItemAccounting: 1002 };
  const detachedCannotSatisfy = frozenA14ItemsAccounted(detached) === 0 && frozenA14ItemsDelivered(detached) === 1;
  control("F12", "the denominator is derived from delivered responses; a detached count satisfies nothing",
    derived && src === "" && detachedCannotSatisfy,
    post === null ? "stage5_m203_a14_post.json missing" : `C-MED ${fromResponses?.accounted}/${fromResponses?.delivered} `
      + `recomputed from ${cmed?.responses.length} responses equals the summary ${derived}; product sources naming a frozen `
      + `count/task: ${src === "" ? "none" : src}; a bare {itemsDelivered:1002,...} object scores `
      + `${frozenA14ItemsAccounted(detached)}/${frozenA14ItemsDelivered(detached)}`);
}

// The frozen F6 RULE (m197aScoring.satisfiedByDefaultOutput), applied to M203's field.
{
  const { packet } = real(1);
  const inDefault = packet.focus.tokens !== undefined;
  control("F6-rule", "the frozen default-output rule is satisfied by a field the default response carries",
    satisfiedByDefaultOutput({ inDefaultResponse: inDefault, inDebugResponse: false }) === true
      && satisfiedByDefaultOutput({ inDefaultResponse: false, inDebugResponse: true }) === false,
    `tokens in default packet: ${inDefault}; debug-only presence still fails the rule`);
}

const allPass = controls.every((c) => c.pass);
const out = { milestone: "M203", instrument: "run_stage5_m203_falsification.ts", controls,
  verdict: allPass ? "M203_FALSIFICATION_CONTROLS_PASS" : "M203_FALSIFICATION_CONTROLS_FAIL" };
writeFileSync(path.join(RESULTS, "stage5_m203_falsification.json"), `${JSON.stringify(out, null, 2)}\n`);
console.log(`\n${out.verdict}`);
if (!allPass) process.exit(1);
