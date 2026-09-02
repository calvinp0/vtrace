/**
 * M201 — was M200's A5 BELOW a property of the code or of the machine? (§5, §34)
 *
 * M200 measured 111.08 / 439.18 / 627.30 ms p90 at load average 16.73 of 20 cpus
 * and classified A5 BELOW. This assembles every M201 capture of the SAME frozen
 * protocol against a tree with no source change since, and reports the
 * classification against the load each was taken under.
 *
 * It deliberately reports EVERY run, including the slowest. §34 forbids choosing
 * the quietest one, and a milestone that reported only its best measurement
 * would be doing exactly what the load caveat exists to prevent.
 *
 *   bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m201_reproduction.ts \
 *     --captures pre1,pre2,pre3,pre_a,pre_b,pre_c
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { execFileSync } from "node:child_process";
import { median } from "./m197aFixtures";

const REPO = path.resolve(import.meta.dir, "../..");
const RESULTS = path.join(import.meta.dir, "results");
const args = process.argv.slice(2);
const argOf = (f: string, d: string) => { const i = args.indexOf(f); return i >= 0 && args[i + 1] !== undefined ? args[i + 1]! : d; };
const LABELS = argOf("--captures", "pre1,pre2,pre3,pre_a,pre_b,pre_c").split(",");

/** M200's committed A5 measurement, read from its ledger rather than retyped. */
const m200 = JSON.parse(readFileSync(path.join(RESULTS, "stage5_m200_engine.json"), "utf8"));
const m200Ledger = JSON.parse(readFileSync(path.join(RESULTS, "stage5_m200_claim_ledger.json"), "utf8"));
const m200A5 = m200Ledger.claims.find((c: any) => c.id === "A5");
const m200P90 = Object.fromEntries(m200.corpora.map((c: any) => [c.id, c.a5?.latency?.p90 ?? null]));

const CORPORA = ["C-SMALL", "C-MED", "C-LARGE"];
const MATCH_MS = 500;
const EXCEED_MS = 200;
const classify = (p90s: (number | null)[]) =>
  p90s.some((v) => v === null) ? "UNMEASURED"
    : p90s.every((v) => v! <= EXCEED_MS) ? "VTRACE_EXCEEDS_VEXP_CLAIM"
    : p90s.every((v) => v! <= MATCH_MS) ? "VTRACE_MATCHES_VEXP_CLAIM"
    : "VTRACE_BELOW_VEXP_CLAIM";

const runs: any[] = [];
for (const label of LABELS) {
  const file = path.join(RESULTS, `stage5_m201_a5_${label}.json`);
  if (!existsSync(file)) continue;
  const capture = JSON.parse(readFileSync(file, "utf8"));
  runs.push({
    label,
    loadAverage1m: capture.environment?.atStart?.loadAverage?.[0] ?? null,
    cpus: capture.environment?.atStart?.cpus ?? null,
    memPressurePercent: capture.environment?.atStart?.memPressurePercent ?? null,
    p90: Object.fromEntries(CORPORA.map((c) => [c, capture.p90ByCorpus?.[c] ?? null])),
    classification: capture.classification,
    deterministic: (capture.corpora ?? []).every((c: any) => c.deterministic !== false),
  });
}

const bindingCorpus = "C-LARGE";
const p90s = runs.map((r) => r.p90[bindingCorpus]).filter((v): v is number => typeof v === "number");
const loads = runs.map((r) => r.loadAverage1m).filter((v): v is number => typeof v === "number");

/**
 * The source question, answered mechanically: has any file under `src/` changed
 * between the commit M200 measured and the commit measured here? If not, a
 * different A5 number is a different machine state, not a different product.
 */
const m200Head = JSON.parse(readFileSync(path.join(RESULTS, "stage5_m200_authority.json"), "utf8")).git.head;
const head = execFileSync("git", ["-C", REPO, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const srcDiff = execFileSync("git", ["-C", REPO, "diff", "--name-only", `${m200Head}..${head}`, "--", "src"], { encoding: "utf8" })
  .split("\n").filter((l) => l.trim().length > 0);
const srcDirty = execFileSync("git", ["-C", REPO, "status", "--porcelain", "--", "src"], { encoding: "utf8" })
  .split("\n").filter((l) => l.trim().length > 0);

const allMatchOrBetter = runs.length > 0 && runs.every((r) => r.classification !== "VTRACE_BELOW_VEXP_CLAIM");
const verdict = runs.length === 0 ? "M201_NO_CAPTURES"
  : allMatchOrBetter && srcDiff.length === 0 && srcDirty.length === 0
    ? "M200_A5_BELOW_NOT_REPRODUCED_ON_AN_UNCHANGED_TREE"
    : allMatchOrBetter
      ? "M200_A5_BELOW_NOT_REPRODUCED"
      : "M201_A5_STRADDLES_THE_THRESHOLD";

const out = {
  milestone: "M201", instrument: "run_stage5_m201_reproduction.ts",
  question: "does the tree M200 classified A5 BELOW still reproduce BELOW under the frozen protocol",
  frozenRule: { metric: "get_code_context warm p90 per corpus", match: `<= ${MATCH_MS} ms on every corpus`, exceed: `<= ${EXCEED_MS} ms on every corpus` },
  m200: {
    head: m200Head, p90: m200P90, classification: m200A5?.verdict ?? null,
    loadAverageAtStart: m200.hardware?.loadAverageAtStart ?? null, cpus: m200.hardware?.cpus ?? null,
    measurement: m200A5?.measurement ?? null,
  },
  m201: { head, sourceFilesChangedSinceM200: srcDiff, sourceFilesDirty: srcDirty },
  runs,
  bindingCorpus,
  // The binding corpus is the one that decides the claim: C-SMALL and C-MED
  // clear by a wide margin in every capture, so A5 is a statement about C-LARGE.
  bindingCorpusSpread: p90s.length === 0 ? null : {
    n: p90s.length, min: +Math.min(...p90s).toFixed(2), max: +Math.max(...p90s).toFixed(2),
    median: +median(p90s).toFixed(2), thresholdMs: MATCH_MS,
    worstAsPercentOfThreshold: +(100 * Math.max(...p90s) / MATCH_MS).toFixed(1),
    m200AsPercentOfThreshold: m200P90[bindingCorpus] === null ? null
      : +(100 * m200P90[bindingCorpus] / MATCH_MS).toFixed(1),
  },
  loadRangeCovered: loads.length === 0 ? null
    : { min: Math.min(...loads), max: Math.max(...loads), m200: m200.hardware?.loadAverageAtStart?.[0] ?? null },
  runsClassified: Object.fromEntries(
    [...new Set(runs.map((r) => r.classification))].map((c) => [c, runs.filter((r) => r.classification === c).length])),
  allRunsDeterministic: runs.every((r) => r.deterministic),
  verdict,
};
writeFileSync(path.join(RESULTS, "stage5_m201_reproduction.json"), `${JSON.stringify(out, null, 2)}\n`);
console.log(`${"run".padEnd(8)} ${"load".padStart(6)}  ${CORPORA.map((c) => c.padStart(9)).join(" ")}  classification`);
for (const r of runs) {
  console.log(`${r.label.padEnd(8)} ${String(r.loadAverage1m).padStart(6)}  `
    + `${CORPORA.map((c) => String(r.p90[c]).padStart(9)).join(" ")}  ${r.classification}`);
}
console.log(`\nM200     ${String(out.m200.loadAverageAtStart?.[0]).padStart(6)}  `
  + `${CORPORA.map((c) => String(m200P90[c]).padStart(9)).join(" ")}  ${out.m200.classification}`);
console.log(`\nsrc files changed since M200: ${srcDiff.length}; dirty: ${srcDirty.length}`);
console.log(verdict);
