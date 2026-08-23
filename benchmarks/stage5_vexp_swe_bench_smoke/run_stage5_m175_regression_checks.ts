/**
 * M175 — the things that must not have moved.
 *
 *   bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m175_regression_checks.ts
 *
 * CLAUDE.md forbids changing scoring, candidate generation, Capsule v2 ranking or
 * retrieval as a side effect, and asks for a proof rather than an assurance. M175
 * edits one file, `src/mcp/responseEnvelope.ts`, and two independent structural
 * facts show that file cannot reach retrieval:
 *
 *   REACHABILITY   nothing on the retrieval path imports the envelope, directly or
 *                  transitively. Computed from the import graph, not asserted.
 *
 *   DERIVATION     mutating the file moves no index fingerprint, so no indexed
 *                  repository in the field is invalidated by this change. Measured
 *                  the way M146-A measures every such claim.
 *
 * A third check is empirical and lives in M175-E: across 200 cases the lead pivot
 * is unchanged on every delivered packet, and every after-packet is a superset of
 * its before-packet.
 *
 * Offline. No agent, no Docker, no paid API.
 */

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { computeIndexFingerprints, type IndexFingerprint } from "../../src/indexer/indexMeta";

const ROOT = path.resolve(".");
const RESULTS = path.join(ROOT, "benchmarks/stage5_vexp_swe_bench_smoke/results");

/** Every source file M175 touched. */
const TOUCHED = ["src/mcp/responseEnvelope.ts"];

/** The modules that decide what is retrieved and how it ranks. */
const RETRIEVAL_ROOTS = [
  "src/runPipeline/runPipelineOrchestrator.ts",
  "src/capsuleV2/buildCapsuleV2.ts",
  "src/retrieval/rerankGraph.ts",
  "src/runPipeline/orientationProjection.ts",
  "src/runPipeline/orientationDecline.ts",
];

const DERIVATION_FIELDS = [
  "index_format_version", "schema_version", "indexer_fingerprint", "parser_fingerprint", "config_hash",
] as const;

const derivationOnly = (fingerprint: IndexFingerprint): Record<string, unknown> =>
  Object.fromEntries(DERIVATION_FIELDS.map((field) => [field, (fingerprint as never)[field]]));

// ── reachability ──

/** Resolve a relative import to a repo-relative .ts path, if one exists. */
function resolveImport(fromFile: string, specifier: string): string | null {
  if (!specifier.startsWith(".")) return null;
  const base = path.join(path.dirname(fromFile), specifier);
  for (const candidate of [`${base}.ts`, path.join(base, "index.ts")]) {
    const relative = path.relative(ROOT, path.resolve(ROOT, candidate));
    try {
      readFileSync(path.join(ROOT, relative), "utf8");
      return relative;
    } catch { /* not this one */ }
  }
  return null;
}

function importsOf(file: string): readonly string[] {
  let source = "";
  try { source = readFileSync(path.join(ROOT, file), "utf8"); } catch { return []; }
  const specifiers: string[] = [];
  for (const match of source.matchAll(/(?:^|\n)\s*(?:import|export)[^;]*?from\s+["']([^"']+)["']/g)) {
    const resolved = resolveImport(file, match[1]!);
    if (resolved !== null) specifiers.push(resolved);
  }
  return specifiers;
}

/** Every module reachable from `roots` by following imports. */
function closure(roots: readonly string[]): ReadonlySet<string> {
  const seen = new Set<string>();
  const queue = [...roots];
  while (queue.length > 0) {
    const next = queue.pop()!;
    if (seen.has(next)) continue;
    seen.add(next);
    for (const dependency of importsOf(next)) if (!seen.has(dependency)) queue.push(dependency);
  }
  return seen;
}

const retrievalClosure = closure(RETRIEVAL_ROOTS);
const reachability = TOUCHED.map((file) => ({
  file,
  reachableFromRetrieval: retrievalClosure.has(file),
}));

// ── derivation ──

async function derivationUnchanged(): Promise<readonly Record<string, unknown>[]> {
  const rows: Record<string, unknown>[] = [];
  const before = derivationOnly(await computeIndexFingerprints());
  for (const file of TOUCHED) {
    const absolute = path.join(ROOT, file);
    const original = readFileSync(absolute, "utf8");
    try {
      writeFileSync(absolute, `${original}\n// m175 derivation probe\n`);
      const after = derivationOnly(await computeIndexFingerprints());
      rows.push({
        file,
        unchanged: JSON.stringify(before) === JSON.stringify(after),
        before, after,
      });
    } finally {
      writeFileSync(absolute, original);
    }
  }
  return rows;
}

const derivation = await derivationUnchanged();

// ── standard verification (§72) ──

function run(command: string, args: readonly string[]): { ok: boolean; tail: string } {
  try {
    const output = execFileSync(command, args, { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    return { ok: true, tail: output.trim().split("\n").slice(-3).join("\n") };
  } catch (cause) {
    const error = cause as { stdout?: string; stderr?: string };
    return { ok: false, tail: `${error.stdout ?? ""}${error.stderr ?? ""}`.trim().split("\n").slice(-6).join("\n") };
  }
}

const whitespace = run("git", ["diff", "--check"]);

const reachabilityClean = reachability.every((row) => !row.reachableFromRetrieval);
const derivationClean = derivation.every((row) => row.unchanged === true);

writeFileSync(path.join(RESULTS, "stage5_m175_regression_checks.json"), `${JSON.stringify({
  schemaVersion: "stage5.m175.regression-checks.v1",
  milestone: "M175",
  touchedSourceFiles: TOUCHED,
  reachability: {
    gate: "no retrieval or projection module may reach the changed file",
    retrievalRoots: RETRIEVAL_ROOTS,
    modulesInRetrievalClosure: retrievalClosure.size,
    rows: reachability,
    verdict: reachabilityClean ? "RETRIEVAL_CANNOT_REACH_THE_CHANGE" : "REACHABLE_INVESTIGATE",
  },
  derivation: {
    gate: "mutating the changed file must move no index fingerprint (M146-A model)",
    rows: derivation,
    verdict: derivationClean ? "OUTSIDE_DERIVATION_CLOSURE" : "INSIDE_CLOSURE_INVESTIGATE",
  },
  whitespaceCheck: { command: "git diff --check", clean: whitespace.ok, output: whitespace.tail },
  retrievalEvalNote:
    "run_stage5_m122_product_retrieval_eval.ts imports runReliableContextRetrieval and "
    + "buildCapsuleV2 directly and never constructs an MCP response, so it cannot observe this "
    + "change. The reachability proof above is the stronger statement: not that the eval agrees, "
    + "but that no execution path connects the edit to retrieval at all.",
  empiricalCorroboration:
    "M175-E: across 200 cases the lead pivot is unchanged on every delivered packet and every "
    + "after-packet is a superset of its before-packet.",
}, null, 2)}\n`);

console.log("reachability:");
for (const row of reachability) {
  console.log(`  ${row.reachableFromRetrieval ? "REACHABLE" : "unreachable"}  ${row.file}`
    + `  (retrieval closure: ${retrievalClosure.size} modules)`);
}
console.log("derivation:");
for (const row of derivation) console.log(`  ${row.unchanged ? "unchanged" : "MOVED"}  ${row.file}`);
console.log(`git diff --check: ${whitespace.ok ? "clean" : "ISSUES"}`);
console.log("");
console.log("wrote results/stage5_m175_regression_checks.json");
console.log(`REGRESSION CHECKS ${reachabilityClean && derivationClean && whitespace.ok ? "PASS" : "FAIL"}`);
if (!(reachabilityClean && derivationClean && whitespace.ok)) process.exitCode = 1;
