/**
 * M201 — frozen output equivalence between two A5 captures (§23, §20).
 *
 * Compares two `stage5_m201_a5_<label>.json` captures query by query. A latency
 * repair is only a repair if the answer did not move, so the comparison is
 * asymmetric on purpose: latency fields are ignored, and EVERYTHING else —
 * selection, ordering, provenance, token counts, boundedness — must match.
 *
 * Byte equality is reported but not required, because the serialized response
 * carries the timing block the semantic projection strips. A byte difference
 * with an equal semantic hash is a timing difference; a byte difference with an
 * unequal semantic hash is a regression, and the two are never conflated.
 *
 *   bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m201_equivalence.ts \
 *     --before pre_a --after post_a [--out stage5_m201_equivalence.json]
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const RESULTS = path.join(import.meta.dir, "results");
const args = process.argv.slice(2);
const argOf = (f: string, d: string) => { const i = args.indexOf(f); return i >= 0 && args[i + 1] !== undefined ? args[i + 1]! : d; };
const BEFORE = argOf("--before", "pre_a");
const AFTER = argOf("--after", "post_a");
const OUT = argOf("--out", `stage5_m201_equivalence_${BEFORE}_vs_${AFTER}.json`);

const read = (label: string) => {
  const p = path.join(RESULTS, `stage5_m201_a5_${label}.json`);
  if (!existsSync(p)) throw new Error(`M201_CAPTURE_MISSING: ${p}`);
  return JSON.parse(readFileSync(p, "utf8"));
};
const before = read(BEFORE);
const after = read(AFTER);

const eq = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const corpora: any[] = [];
let comparedTotal = 0; let semanticEqualTotal = 0; let byteEqualTotal = 0;
const differences: any[] = [];

for (const b of before.corpora) {
  const a = after.corpora.find((c: any) => c.id === b.id);
  if (a === undefined) {
    corpora.push({ id: b.id, status: "MISSING_IN_AFTER" });
    differences.push({ corpus: b.id, kind: "corpus_missing" });
    continue;
  }
  // A comparison across two different corpora proves nothing about the change.
  const corpusIdentical = eq(b.snapshotFingerprint, a.snapshotFingerprint);
  if (!corpusIdentical) {
    differences.push({ corpus: b.id, kind: "corpus_fingerprint_differs",
      before: b.snapshotFingerprint, after: a.snapshotFingerprint });
  }
  let compared = 0; let semanticEqual = 0; let byteEqual = 0;
  let tokenEqual = 0; let selectionEqual = 0; let boundednessEqual = 0;
  for (const bq of b.perQuery ?? []) {
    const aq = (a.perQuery ?? []).find((q: any) => q.task === bq.task);
    if (aq === undefined) { differences.push({ corpus: b.id, task: bq.task, kind: "query_missing" }); continue; }
    compared += 1;
    const semantic = eq(bq.semanticSha, aq.semanticSha);
    const bytes = eq(bq.byteSha, aq.byteSha);
    const tokens = bq.responseTokens === aq.responseTokens
      && bq.serializedCharacters === aq.serializedCharacters;
    const selection = bq.selectionSha === aq.selectionSha;
    const bounded = eq(bq.boundedness, aq.boundedness);
    if (semantic) semanticEqual += 1;
    if (bytes) byteEqual += 1;
    if (tokens) tokenEqual += 1;
    if (selection) selectionEqual += 1;
    if (bounded) boundednessEqual += 1;
    if (!(semantic && tokens && selection && bounded)) {
      differences.push({
        corpus: b.id, task: bq.task,
        semanticEqual: semantic, byteEqual: bytes, tokenEqual: tokens,
        selectionEqual: selection, boundednessEqual: bounded,
        beforeSelection: selection ? undefined : bq.selection,
        afterSelection: selection ? undefined : aq.selection,
        beforeTokens: bq.responseTokens, afterTokens: aq.responseTokens,
      });
    }
  }
  comparedTotal += compared; semanticEqualTotal += semanticEqual; byteEqualTotal += byteEqual;
  corpora.push({ id: b.id, corpusIdentical, compared, semanticEqual, byteEqual,
    tokenEqual, selectionEqual, boundednessEqual,
    p90Before: b.latency?.p90 ?? null, p90After: a.latency?.p90 ?? null,
    medianBefore: b.latency?.median ?? null, medianAfter: a.latency?.median ?? null });
}

const allCorporaIdentical = corpora.every((c) => c.corpusIdentical === true);
const verdict = differences.length === 0 && allCorporaIdentical
  ? "M201_OUTPUT_EQUIVALENT"
  : "M201_OUTPUT_DIFFERS";

const out = {
  milestone: "M201", instrument: "run_stage5_m201_equivalence.ts",
  before: BEFORE, after: AFTER,
  rule: "semantic hash, selection/order, token counts and boundedness must all match; "
    + "byte equality is reported, and is not required because the serialized response carries timing",
  compared: comparedTotal, semanticEqual: semanticEqualTotal, byteEqual: byteEqualTotal,
  corpusFingerprintsIdentical: allCorporaIdentical,
  corpora, differences, verdict,
};
writeFileSync(path.join(RESULTS, OUT), `${JSON.stringify(out, null, 2)}\n`);
for (const c of corpora) {
  console.log(`${String(c.id).padEnd(8)} corpus=${c.corpusIdentical} compared=${c.compared} `
    + `semantic=${c.semanticEqual} byte=${c.byteEqual} tokens=${c.tokenEqual} selection=${c.selectionEqual} `
    + `| p90 ${c.p90Before} -> ${c.p90After}`);
}
console.log(`\n${verdict}  (${differences.length} differences)  -> results/${OUT}`);
