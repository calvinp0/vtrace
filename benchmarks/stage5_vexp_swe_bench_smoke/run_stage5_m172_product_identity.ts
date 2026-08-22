/**
 * M172-E — does the SHIPPED projector do what the qualified one did?
 *
 *   bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m172_product_identity.ts
 *
 * The gates in M172-D were measured with `m172Projection.ts`, a benchmark module.
 * What now ships is `src/runPipeline/orientationProjection.ts`, a separate file
 * written against the product's own types. A qualification transfers to the
 * product only if the product computes the same thing, so this compares the two
 * implementations packet-for-packet over every capture in all three corpora —
 * 212 authoritative responses, byte-compared after serialization.
 *
 * A difference here would mean the holdout numbers describe code that is not the
 * code running. Offline; reads captures only.
 */

import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { projectRunPipelineOrientation } from "../../src/runPipeline/orientationProjection";
import { P_SUPPLY, projectOrientationM172 } from "./m172Projection";

const ROOT = path.resolve(".");
const RESULTS = path.join(ROOT, "benchmarks/stage5_vexp_swe_bench_smoke/results");
const CAPTURES = path.join(RESULTS, "_m171_capture");

interface Mismatch {
  readonly corpus: string;
  readonly instanceId: string;
  readonly reason: string;
  readonly benchmark: string;
  readonly product: string;
}

const mismatches: Mismatch[] = [];
let compared = 0;
let bothProjected = 0;
let bothDeclined = 0;

for (const corpus of ["dev", "broad100a", "broad100b"]) {
  const dir = path.join(CAPTURES, corpus);
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".json")).sort()) {
    const captured = JSON.parse(readFileSync(path.join(dir, file), "utf-8")) as Record<string, any>;
    const output = captured.default?.structuredContent?.result?.output;
    if (output == null) continue;
    compared += 1;

    const benchmarkPacket = projectOrientationM172(output as Record<string, unknown>, P_SUPPLY);
    const productPacket = projectRunPipelineOrientation(output);

    // The benchmark projector renders non-resolved states as a `problem` packet;
    // the product DECLINES on them so the authoritative failure envelope survives
    // untouched. That is a deliberate divergence and the only one allowed: it is
    // strictly more conservative, and no measured number depends on it because
    // non-resolved cases are excluded from every rate and every median.
    if (benchmarkPacket.state !== "resolved") {
      if (productPacket !== null) {
        mismatches.push({
          corpus, instanceId: String(captured.instanceId),
          reason: "product projected a state the benchmark treated as non-resolved",
          benchmark: benchmarkPacket.state, product: "projected",
        });
      } else bothDeclined += 1;
      continue;
    }

    if (productPacket === null) {
      mismatches.push({
        corpus, instanceId: String(captured.instanceId),
        reason: "product declined a resolved state the benchmark projected",
        benchmark: "resolved", product: "declined",
      });
      continue;
    }

    // Compare the model-facing content. The benchmark packet carries a `state`
    // discriminator the product packet does not need (the product signals the
    // non-resolved case by declining), so it is dropped before comparison.
    const { state: _state, ...benchmarkComparable } = benchmarkPacket as unknown as Record<string, unknown>;
    const a = JSON.stringify(benchmarkComparable);
    const b = JSON.stringify(productPacket);
    if (a === b) bothProjected += 1;
    else {
      mismatches.push({
        corpus, instanceId: String(captured.instanceId),
        reason: "projected packets differ", benchmark: a.slice(0, 400), product: b.slice(0, 400),
      });
    }
  }
}

const report = {
  schemaVersion: "stage5.m172.product-identity.v1",
  milestone: "M172",
  workstream: "M172-E",
  title: "The shipped projector against the qualified one, over every capture in all three corpora",
  method: {
    qualified: "benchmarks/stage5_vexp_swe_bench_smoke/m172Projection.ts at P_SUPPLY — the module M172-D measured",
    shipped: "src/runPipeline/orientationProjection.ts — what run_pipeline now returns by default",
    comparison: "JSON.stringify of the model-facing packet, byte-compared",
    allowedDivergence: "on non-resolved states the benchmark emits a `problem` packet and the product declines, leaving the authoritative failure envelope intact. Strictly more conservative, and no measured number depends on it: non-resolved cases are excluded from every rate and median.",
  },
  capturesCompared: compared,
  identicalProjections: bothProjected,
  bothDeclined,
  mismatches: mismatches.length,
  pass: mismatches.length === 0,
  detail: mismatches.slice(0, 10),
};

writeFileSync(path.join(RESULTS, "stage5_m172_product_identity.json"), `${JSON.stringify(report, null, 1)}\n`);
console.log(`compared ${compared} captures: ${bothProjected} identical projections, ${bothDeclined} both declined, ${mismatches.length} mismatches`);
console.log(mismatches.length === 0 ? "PASS — the shipped projector is the qualified projector" : "FAIL");
for (const m of mismatches.slice(0, 5)) console.log(` ${m.corpus}/${m.instanceId}: ${m.reason}`);
