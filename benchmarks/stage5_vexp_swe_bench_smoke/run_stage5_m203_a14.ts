/**
 * M203 — the frozen A14 block, reproduced on its own, with the per-item ledger.
 *
 * Runs EXACTLY the calls the frozen engine makes for A11-A14: every A13 task on
 * C-MED (and the first three on the other corpora) at each of the five frozen
 * budgets, through the DEFAULT `get_code_context` path, and counts delivered
 * items and accounted items with the engine's own predicate (imported verbatim
 * from m203Accounting.ts). Nothing about the protocol is tuned here; this file
 * exists so the A14 numbers can be reproduced before and after the product
 * change without a full engine run, and so the ledger every packet published
 * can be read back and held to the analyzer.
 *
 * `--product-root` selects which tree's product code answers: the working tree
 * by default, or a worktree at the predecessor commit for the pre-change
 * reproduction. Whichever tree answers, the corpus is a fresh copy and the index
 * is built once, as the frozen engine builds it.
 *
 *   bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m203_a14.ts \
 *     --label post [--product-root <dir>] [--scratch <dir>] [--repeats 1] [--corpora C-MED]
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { A13_TASKS, corpusSpecs, median, prepareCorpus, tokens } from "./m197aFixtures";
import {
  analyzeAccounting, frozenA14ItemsAccounted, frozenA14ItemsDelivered, frozenRepresentationClass,
  frozenA14ItemHasAccounting,
} from "./m203Accounting";

const REPO = path.resolve(import.meta.dir, "../..");
const RESULTS = path.join(import.meta.dir, "results");
const args = process.argv.slice(2);
const argOf = (flag: string, fallback: string) => {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1]! : fallback;
};
const LABEL = argOf("--label", "post");
const PRODUCT_ROOT = path.resolve(argOf("--product-root", REPO));
const SCRATCH = argOf("--scratch", `/tmp/m203-a14-${LABEL}`);
const REPEATS = Number.parseInt(argOf("--repeats", "1"), 10);
const CORPORA = argOf("--corpora", "C-SMALL,C-MED,C-LARGE").split(",");
const A11_BUDGETS = [1000, 2000, 4000, 8000, 16000] as const;
mkdirSync(SCRATCH, { recursive: true });

const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const loadAverage = () => {
  try { return readFileSync("/proc/loadavg", "utf8").split(" ").slice(0, 3).map(Number); }
  catch { return []; }
};

// The product under measurement, from whichever tree was named.
const { createMcpServer } = await import(path.join(PRODUCT_ROOT, "src/mcp/server.ts"));
const { McpToolId, MCP_SERVER_SCHEMA } = await import(path.join(PRODUCT_ROOT, "src/mcp/types.ts"));
const accountingModule = await import(path.join(PRODUCT_ROOT, "src/runPipeline/orientationAccounting.ts"))
  .catch(() => null);
const orientationAccountingOf: ((packet: object) => unknown) | null =
  accountingModule?.orientationAccountingOf ?? null;
const { ORIENTATION_POLICY } = await import(path.join(PRODUCT_ROOT, "src/runPipeline/orientationProjection.ts"));
const productHead = (() => {
  try {
    return Bun.spawnSync(["git", "-C", PRODUCT_ROOT, "rev-parse", "HEAD"]).stdout.toString().trim();
  } catch { return "unknown"; }
})();

const call = async (server: any, toolId: string, input: unknown, id = "m203"): Promise<any> => {
  const res: any = await server.handleRequest(
    { schema: MCP_SERVER_SCHEMA, requestId: id, toolId, input } as any);
  return res?.result?.ok === false ? { __error: res.result.error } : res?.result?.output;
};

console.log(`[${LABEL}] product ${PRODUCT_ROOT} @ ${productHead.slice(0, 12)}; accounting module `
  + `${orientationAccountingOf ? "present" : "ABSENT"}; load ${loadAverage().join(" ")}`);

const perCorpus: any[] = [];
const ledgerRows: any[] = [];

for (const spec of corpusSpecs(REPO).filter((s) => CORPORA.includes(s.id))) {
  const work = prepareCorpus(spec, SCRATCH);
  if (work === null) { perCorpus.push({ id: spec.id, status: "CORPUS_ABSENT" }); continue; }
  const dbPath = path.join(work, ".vtrace/index.sqlite");
  const server = createMcpServer({ context: { repoRoot: work, dbPath } } as any);
  const indexed = await call(server, McpToolId.IndexRepo, { repo_root: work }, "idx");
  if (indexed?.readiness?.status !== "ready") {
    perCorpus.push({ id: spec.id, status: "INDEX_NOT_READY", readiness: indexed?.readiness ?? null });
    continue;
  }

  const budgetTasks = spec.id === "C-MED" ? A13_TASKS : A13_TASKS.slice(0, 3);
  const responses: any[] = [];
  const classCounts: Record<string, { eligible: number; accounted: number }> = {};
  const packetHashes = new Map<string, Set<string>>();
  const ledgerHashes = new Map<string, Set<string>>();
  // The first two distinct packets seen for a key, so an instability can be READ.
  const variants = new Map<string, any[]>();
  let integrityFailures = 0;
  const latencies: number[] = [];

  for (const task of budgetTasks) {
    for (const budget of A11_BUDGETS) {
      let out: any = null; let ledger: any = null; let analysis: any = null;
      for (let r = 0; r < REPEATS; r += 1) {
        const t0 = performance.now();
        out = await call(server, McpToolId.GetCodeContext, { task, repo_root: work, max_tokens: budget });
        latencies.push(performance.now() - t0);
        ledger = orientationAccountingOf && out && typeof out === "object" ? orientationAccountingOf(out) : undefined;
        const key = `${task}@${budget}`;
        const ph = packetHashes.get(key) ?? new Set();
        const packetSha = sha(JSON.stringify(out ?? null));
        if (!ph.has(packetSha) && ph.size < 2) {
          variants.set(key, [...(variants.get(key) ?? []), { repeat: r, sha: packetSha,
            focus: out?.focus?.at ?? null, related: (out?.related ?? []).map((x: any) => x.at), notes: out?.notes ?? null,
            focusCodeChars: out?.focus?.code?.length ?? null }]);
        }
        ph.add(packetSha); packetHashes.set(key, ph);
        const lh = ledgerHashes.get(key) ?? new Set(); lh.add(sha(JSON.stringify(ledger ?? null))); ledgerHashes.set(key, lh);
      }
      const isPacket = out && typeof out === "object" && "focus" in out;
      const delivered = frozenA14ItemsDelivered(out);
      const accounted = frozenA14ItemsAccounted(out);
      const perItem = isPacket ? [out.focus, ...(out.related ?? [])] : [];
      for (const [k, item] of perItem.entries()) {
        const cls = frozenRepresentationClass(item, k === 0 ? "focus" : "related");
        classCounts[cls] ??= { eligible: 0, accounted: 0 };
        classCounts[cls]!.eligible += 1;
        if (frozenA14ItemHasAccounting(item)) classCounts[cls]!.accounted += 1;
      }
      if (isPacket) {
        analysis = analyzeAccounting({ packet: out, ledger, ceilingTokens: ORIENTATION_POLICY.ceilingTokens });
        if (analysis.verdict !== "ACCOUNTING_INTEGRITY_PASS") integrityFailures += 1;
        for (const item of (ledger?.items ?? [])) {
          ledgerRows.push({
            corpus: spec.id, task, budget, item_id: item.at, ordinal: item.ordinal, slot: item.slot,
            representation: item.representation, origin: item.origin, origins: item.origins,
            source_id: item.sourceId, reason: item.reason, reason_source: item.reasonSource,
            estimated_tokens: item.estimatedTokens, actual_tokens: item.actualTokens,
            characters: item.characters, cumulative_tokens: item.cumulativeTokens,
            admission_packet_tokens: item.admissionPacketTokens, ceiling_tokens: ledger.ceilingTokens,
            upstream_estimated_tokens: item.upstreamEstimatedTokens, body_characters: item.bodyCharacters,
            delivered_code_characters: item.deliveredCodeCharacters, truncated: item.truncated,
          });
        }
      }
      responses.push({
        task, budget,
        shape: isPacket ? "orientation" : String(out?.schemaVersion ?? out?.__error?.code ?? "other"),
        frozen: { itemsDelivered: delivered, itemsWithTokenAccounting: accounted,
          wholeResponseTokens: tokens(JSON.stringify(out ?? {})),
          representationClasses: [...new Set(perItem.map((it, k) => frozenRepresentationClass(it, k === 0 ? "focus" : "related")))] },
        ledger: ledger === undefined ? "absent" : {
          ceilingTokens: ledger.ceilingTokens,
          evidenceTokens: ledger.evidence.tokens, evidenceWithinCeiling: ledger.evidence.withinCeiling,
          packetTokens: ledger.packet.tokens, packetCharacters: ledger.packet.characters,
          accountingOverheadTokens: ledger.accountingOverhead.tokens,
          wrapperTokens: ledger.wrapper.tokens, wrapperCharacters: ledger.wrapper.characters,
          itemTokens: ledger.reconciliation.itemTokens, itemCharacters: ledger.reconciliation.itemCharacters,
          charactersExact: ledger.reconciliation.charactersExact,
          tokenDeviation: ledger.reconciliation.tokenDeviation, tokenDeviationBound: ledger.reconciliation.tokenDeviationBound,
          unusedCeilingTokens: ledger.ceilingTokens - ledger.evidence.tokens,
          candidates: { proposed: ledger.candidates.proposed, deduplicated: ledger.candidates.deduplicated,
            admitted: ledger.candidates.admitted, rejectedForCeiling: ledger.candidates.rejectedForCeiling,
            firstRejected: ledger.candidates.rejected[0]?.at ?? null },
          evidenceBudget: ledger.evidenceBudget,
        },
        integrity: analysis === null ? null : { verdict: analysis.verdict,
          failed: analysis.gates.filter((g: any) => !g.pass).map((g: any) => `${g.id}: ${g.detail}`) },
      });
    }
  }

  const unstable = [...packetHashes.entries()].filter(([, s]) => s.size > 1).map(([k]) => k);
  const unstableLedgers = [...ledgerHashes.entries()].filter(([, s]) => s.size > 1).map(([k]) => k);
  const itemsDelivered = responses.reduce((n, r) => n + r.frozen.itemsDelivered, 0);
  const itemsAccounted = responses.reduce((n, r) => n + r.frozen.itemsWithTokenAccounting, 0);
  const packets = responses.filter((r) => r.ledger !== "absent");
  perCorpus.push({
    id: spec.id, filesIndexed: indexed?.summary?.filesIndexed ?? null, tasks: budgetTasks.length,
    budgets: A11_BUDGETS, responseCount: responses.length,
    a14: { itemsDelivered, itemsWithPerItemAccounting: itemsAccounted,
      coveragePercent: itemsDelivered === 0 ? null : +(100 * itemsAccounted / itemsDelivered).toFixed(2),
      // The frozen scorer's rule, restated only as a read-out.
      frozenVerdict: itemsAccounted > 0 ? "VTRACE_MATCHES_VEXP_CLAIM" : "VTRACE_BELOW_VEXP_CLAIM" },
    representationClasses: classCounts,
    integrity: { packets: packets.length, failures: integrityFailures,
      verdict: packets.length > 0 && integrityFailures === 0 ? "ACCOUNTING_INTEGRITY_PASS"
        : packets.length === 0 ? "NO_LEDGERS" : "ACCOUNTING_INTEGRITY_FAIL" },
    reconciliation: packets.length === 0 ? null : {
      allCharactersExact: packets.every((r) => r.ledger.charactersExact),
      allTokensWithinBound: packets.every((r) => r.ledger.tokenDeviation <= r.ledger.tokenDeviationBound),
      allEvidenceWithinCeiling: packets.every((r) => r.ledger.evidenceWithinCeiling),
      ceilingBoundResponses: packets.filter((r) => r.ledger.candidates.rejectedForCeiling > 0).length,
      overheadTokens: { median: median(packets.map((r) => r.ledger.accountingOverheadTokens)),
        max: Math.max(...packets.map((r) => r.ledger.accountingOverheadTokens)) },
      packetTokens: { median: median(packets.map((r) => r.ledger.packetTokens)),
        max: Math.max(...packets.map((r) => r.ledger.packetTokens)) },
      unusedCeilingTokens: { median: median(packets.map((r) => r.ledger.unusedCeilingTokens)),
        min: Math.min(...packets.map((r) => r.ledger.unusedCeilingTokens)) },
      deduplicatedProposals: packets.reduce((n, r) => n + r.ledger.candidates.deduplicated, 0),
    },
    determinism: { repeats: REPEATS, packetsStable: unstable.length === 0, unstablePackets: unstable,
      ledgersStable: unstableLedgers.length === 0, unstableLedgers,
      unstableVariants: Object.fromEntries(unstable.map((k) => [k, variants.get(k) ?? []])) },
    latencyMs: { median: +median(latencies).toFixed(2), n: latencies.length },
    responses,
  });
  const c = perCorpus.at(-1)!;
  console.log(`[${LABEL}] ${spec.id.padEnd(8)} A14 ${c.a14.itemsWithPerItemAccounting}/${c.a14.itemsDelivered} `
    + `(${c.a14.coveragePercent}%) ${c.a14.frozenVerdict} | integrity ${c.integrity.verdict} `
    + `| classes ${Object.keys(classCounts).join(",")} | stable ${c.determinism.packetsStable}/${c.determinism.ledgersStable}`);
}

const cmed = perCorpus.find((c) => c.id === "C-MED");
const out = {
  milestone: "M203", instrument: "run_stage5_m203_a14.ts", label: LABEL,
  product: { root: PRODUCT_ROOT, head: productHead, accountingModulePresent: orientationAccountingOf !== null },
  protocol: {
    calls: "get_code_context, default detail, max_tokens at each frozen budget, one index per corpus copy",
    tasks: "A13_TASKS (all 20 on C-MED, first 3 elsewhere)", budgets: A11_BUDGETS,
    numerator: "items where tokens|tokenReductionPercent|rawTokens|savedTokens !== undefined (engine predicate, verbatim)",
    denominator: "1 + related.length per response (engine rule, verbatim)",
    frozenRule: "MATCHES when the C-MED numerator > 0; EXCEEDS is unreachable in the committed scorer",
    tokenizerForWholeResponse: "ceil(characters/4), the frozen fixture",
  },
  hardware: { cpus: navigator.hardwareConcurrency, loadAverageAtEnd: loadAverage() },
  frozenA14: cmed === undefined ? null : cmed.a14,
  corpora: perCorpus,
};
writeFileSync(path.join(RESULTS, `stage5_m203_a14_${LABEL}.json`), `${JSON.stringify(out, null, 2)}\n`);
if (ledgerRows.length > 0) {
  writeFileSync(path.join(RESULTS, `stage5_m203_accounting_ledger_${LABEL}.jsonl`),
    `${ledgerRows.map((r) => JSON.stringify(r)).join("\n")}\n`);
}
console.log(`[${LABEL}] frozen A14 C-MED ${cmed?.a14.itemsWithPerItemAccounting ?? "?"}/${cmed?.a14.itemsDelivered ?? "?"} `
  + `${cmed?.a14.frozenVerdict ?? "UNMEASURED"} -> results/stage5_m203_a14_${LABEL}.json`
  + (ledgerRows.length ? ` + ${ledgerRows.length} ledger rows` : ""));
