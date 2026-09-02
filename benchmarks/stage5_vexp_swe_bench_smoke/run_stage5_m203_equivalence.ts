/**
 * M203 — output equivalence against the frozen M201 capture (§30, §31, F10).
 *
 * The frozen A5 instrument hashes each of the fifteen frozen queries' responses
 * (`stage5_m201_a5_base.json`, taken on the M201 immutable snapshot). Those
 * captures hold hashes, not packets, so the comparison runs the same fifteen
 * queries on the same snapshot through the CURRENT product, and holds each
 * packet to the base capture two ways:
 *
 *   as delivered      the byte hash of the packet as the model receives it.
 *                     EXPECTED TO DIFFER: every item now carries `tokens`, which
 *                     the frozen A14 contract requires in the default response.
 *
 *   with `tokens`     the byte hash after the one accounting field is removed
 *   removed           from every item. REQUIRED TO MATCH: the field was appended
 *                     last, so stripping it must restore the pre-M203 bytes
 *                     exactly — same focus, same related, same order, same
 *                     framing, same notes.
 *
 * Selection and ordering are compared through the capture's own `selectionSha`,
 * which never saw `tokens`; a selection change fails on its own line.
 *
 *   bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m203_equivalence.ts \
 *     [--base base] [--snapshot /tmp/m201-snapshot] [--work /tmp/m203-equivalence]
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { createMcpServer } from "../../src/mcp/server";
import { McpToolId, MCP_SERVER_SCHEMA } from "../../src/mcp/types";
import { orientationAccountingOf } from "../../src/runPipeline/orientationAccounting";
import { A5_QUERIES, corpusSpecs, tokens } from "./m197aFixtures";
import { ensureSnapshot, materializeWorkingCopy, snapshotFingerprint } from "./m201Corpus";
import { semanticProjection } from "./m197aScoring";
import { stripAccounting } from "./m203Accounting";

const REPO = path.resolve(import.meta.dir, "../..");
const RESULTS = path.join(import.meta.dir, "results");
const args = process.argv.slice(2);
const argOf = (f: string, d: string) => { const i = args.indexOf(f); return i >= 0 && args[i + 1] !== undefined ? args[i + 1]! : d; };
const BASE = argOf("--base", "base");
const SNAPSHOT = argOf("--snapshot", "/tmp/m201-snapshot");
const WORK_ROOT = argOf("--work", "/tmp/m203-equivalence");
mkdirSync(WORK_ROOT, { recursive: true });

const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const basePath = path.join(RESULTS, `stage5_m201_a5_${BASE}.json`);
if (!existsSync(basePath)) throw new Error(`M203_BASE_CAPTURE_MISSING: ${basePath}`);
const base = JSON.parse(readFileSync(basePath, "utf8"));

type Server = ReturnType<typeof createMcpServer>;
const call = async (server: Server, toolId: string, input: unknown): Promise<any> => {
  const res: any = await server.handleRequest(
    { schema: MCP_SERVER_SCHEMA, requestId: "m203", toolId, input } as any);
  return res?.result?.ok === false ? { __error: res.result.error } : res?.result?.output;
};

/** The base capture's selection extractor, restated so both sides use one rule. */
function selectionOf(out: any): unknown {
  const item = (i: any) => i === undefined || i === null ? null : {
    at: i.at ?? null, form: i.form ?? null, why: i.why ?? i.reason ?? null,
    codeChars: typeof i.code === "string" ? i.code.length : null,
    codeSha: typeof i.code === "string" ? sha(i.code).slice(0, 16) : null,
  };
  return {
    schemaVersion: out?.schemaVersion ?? null,
    focus: item(out?.focus),
    related: (out?.related ?? []).map(item),
    boundary: out?.boundary ?? null,
    notes: out?.notes ?? null,
    topLevelKeys: Object.keys(out ?? {}).sort(),
  };
}

const corpora: any[] = [];
const differences: any[] = [];
let compared = 0; let selectionEqual = 0; let orderEqual = 0; let deliveredByteEqual = 0;
let strippedByteEqual = 0; let strippedSemanticEqual = 0; let itemCountEqual = 0; let tokenCountEqual = 0;
let tokensOnlyDifference = 0;

for (const spec of corpusSpecs(REPO)) {
  const baseCorpus = (base.corpora ?? []).find((c: any) => c.id === spec.id);
  if (baseCorpus === undefined) { corpora.push({ id: spec.id, status: "MISSING_IN_BASE" }); continue; }
  ensureSnapshot(spec, SNAPSHOT);
  const work = materializeWorkingCopy(spec, SNAPSHOT, WORK_ROOT);
  if (work === null) { corpora.push({ id: spec.id, status: "CORPUS_ABSENT" }); continue; }
  const fingerprint = snapshotFingerprint(spec, SNAPSHOT);
  const corpusIdentical = JSON.stringify(fingerprint) === JSON.stringify(baseCorpus.snapshotFingerprint);
  if (!corpusIdentical) differences.push({ corpus: spec.id, kind: "corpus_fingerprint_differs" });

  const dbPath = path.join(work, ".vtrace/index.sqlite");
  const server = createMcpServer({ context: { repoRoot: work, dbPath } } as any);
  const indexed = await call(server, McpToolId.IndexRepo, { repo_root: work });
  if (indexed?.readiness?.status !== "ready") { corpora.push({ id: spec.id, status: "INDEX_NOT_READY" }); continue; }

  const perQuery: any[] = [];
  for (const task of A5_QUERIES[spec.id] ?? []) {
    const bq = (baseCorpus.perQuery ?? []).find((q: any) => q.task === task);
    if (bq === undefined) { differences.push({ corpus: spec.id, task, kind: "query_missing_in_base" }); continue; }
    await call(server, McpToolId.GetCodeContext, { task, repo_root: work });
    const out = await call(server, McpToolId.GetCodeContext, { task, repo_root: work });
    const stripped = stripAccounting(out);
    const deliveredSha = sha(JSON.stringify(out));
    const strippedSha = sha(JSON.stringify(stripped));
    const strippedSemanticSha = sha(JSON.stringify(semanticProjection(stripped)));
    const selectionSha = sha(JSON.stringify(selectionOf(out)));
    const row = {
      task,
      base: { byteSha: bq.byteSha, semanticSha: bq.semanticSha, selectionSha: bq.selectionSha,
        relatedCount: bq.relatedCount, responseTokens: bq.responseTokens, serializedCharacters: bq.serializedCharacters },
      now: {
        deliveredSha, strippedSha, strippedSemanticSha, selectionSha,
        relatedCount: (out?.related ?? []).length,
        deliveredTokens: tokens(JSON.stringify(out ?? {})),
        strippedTokens: tokens(JSON.stringify(stripped ?? {})),
        deliveredCharacters: JSON.stringify(out ?? {}).length,
        strippedCharacters: JSON.stringify(stripped ?? {}).length,
        orderedIds: [out?.focus?.at, ...(out?.related ?? []).map((r: any) => r.at)],
        selectionOrder: (selectionOf(out) as any).related.map((r: any) => r.at),
        ledgerOverheadTokens: (orientationAccountingOf(out) as any)?.accountingOverhead?.tokens ?? null,
      },
      equal: {
        selection: (bq.selectionSha ?? null) === selectionSha,
        // Order is inside selectionSha (a positional array); stated separately so a
        // reorder that kept the set would still be named.
        order: JSON.stringify(bq.selection?.related?.map((r: any) => r.at) ?? null)
          === JSON.stringify((selectionOf(out) as any).related.map((r: any) => r.at)),
        deliveredBytes: (bq.byteSha ?? []).includes(deliveredSha),
        strippedBytes: (bq.byteSha ?? []).includes(strippedSha),
        strippedSemantic: (bq.semanticSha ?? []).includes(strippedSemanticSha),
        itemCount: bq.relatedCount === (out?.related ?? []).length,
        strippedTokenCount: bq.responseTokens === tokens(JSON.stringify(stripped ?? {})),
      },
    };
    compared += 1;
    if (row.equal.selection) selectionEqual += 1;
    if (row.equal.order) orderEqual += 1;
    if (row.equal.deliveredBytes) deliveredByteEqual += 1;
    if (row.equal.strippedBytes) strippedByteEqual += 1;
    if (row.equal.strippedSemantic) strippedSemanticEqual += 1;
    if (row.equal.itemCount) itemCountEqual += 1;
    if (row.equal.strippedTokenCount) tokenCountEqual += 1;
    if (row.equal.strippedBytes && !row.equal.deliveredBytes) tokensOnlyDifference += 1;
    if (!row.equal.strippedBytes || !row.equal.selection) {
      differences.push({ corpus: spec.id, task, kind: !row.equal.selection ? "selection_differs" : "stripped_bytes_differ", row });
    }
    perQuery.push(row);
  }
  corpora.push({ id: spec.id, corpusIdentical, compared: perQuery.length,
    selectionEqual: perQuery.filter((q) => q.equal.selection).length,
    strippedByteEqual: perQuery.filter((q) => q.equal.strippedBytes).length,
    deliveredByteEqual: perQuery.filter((q) => q.equal.deliveredBytes).length,
    perQuery });
  console.log(`${spec.id.padEnd(8)} compared ${perQuery.length} selection= ${corpora.at(-1)!.selectionEqual} `
    + `stripped-bytes= ${corpora.at(-1)!.strippedByteEqual} delivered-bytes= ${corpora.at(-1)!.deliveredByteEqual}`);
}

const verdict = compared > 0 && differences.length === 0 && strippedByteEqual === compared && selectionEqual === compared
  ? "M203_EVIDENCE_EQUIVALENT" : "M203_EVIDENCE_NOT_EQUIVALENT";
const out = {
  milestone: "M203", instrument: "run_stage5_m203_equivalence.ts", base: BASE, snapshot: SNAPSHOT,
  rule: "selection, order, item count, and the packet bytes with the per-item tokens field removed must equal the base capture; the delivered bytes are expected to differ by that field alone",
  compared, selectionEqual, orderEqual, itemCountEqual, strippedByteEqual, strippedSemanticEqual,
  strippedTokenCountEqual: tokenCountEqual, deliveredByteEqual,
  differencesExplainedByTokensFieldAlone: tokensOnlyDifference,
  corpora, differences, verdict,
};
writeFileSync(path.join(RESULTS, "stage5_m203_equivalence.json"), `${JSON.stringify(out, null, 2)}\n`);
console.log(`\n${verdict}: ${compared} compared, selection ${selectionEqual}, order ${orderEqual}, `
  + `stripped bytes ${strippedByteEqual}, delivered bytes ${deliveredByteEqual} `
  + `(${tokensOnlyDifference} differ by the tokens field alone)`);
