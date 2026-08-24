/**
 * M178-F — paired identity of the pre-split and post-split impact envelopes.
 *
 *   git worktree add --detach /home/calvin/bench/vtrace-m178/pre-split ac2284bd
 *   bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m178_identity.ts \
 *     --out benchmarks/stage5_vexp_swe_bench_smoke/results
 *
 * WHY THIS EXISTS RATHER THAN A BEFORE/AFTER RE-RUN. A first attempt compared the
 * M178-B corpus captured before the change against the same corpus captured after
 * it, and found 20 decision differences in 1,016 shared cases. None of them was
 * the change. `timing` carries full-precision floats whose decimal width varies
 * between runs, so `serializedCharacters` moves by a character or two; a specimen
 * sitting exactly on its envelope floor then tips either way, and M177 recorded
 * precisely this ("the envelope floor is not perfectly deterministic, by about
 * one token"). Comparing two runs measures the clock as well as the code.
 *
 * THE STRONGER FORM, INHERITED FROM M177-E. `compactImpactProductResponse` is a
 * pure function of an `ImpactGraphOutput`, so both implementations can be imported
 * into ONE process and called on the SAME in-memory object — identical `timing`
 * floats included. No scheduling, no load, and no clock can reach the comparison,
 * so a difference here is a difference in code and nothing else.
 *
 * WHAT IT ASSERTS. M178 selected `C_EXPLICIT_SPLIT`, whose entire claim is that it
 * changes what the code MEANS and not what it DOES. That claim is true or false
 * byte by byte, and this is where it is settled. §53 prefers byte-identical; this
 * change should achieve it outright.
 *
 * Deterministic, offline, no paid API, no Docker.
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

// The post-split envelope, from this checkout.
import { compactImpactProductResponse as compactAfter } from "../../src/impact/impactResponseEnvelope";
// The pre-split envelope lives in a detached worktree at the M177 HEAD, created
// on demand by the command in the header and removed once M178 closed. A STATIC
// import of that path is a permanent build dependency on a temporary directory:
// it resolved while the worktree existed and has failed `typecheck:benchmarks`
// ever since it was removed, even though `main` already guards the run with
// `existsSync` below. Loaded through a computed specifier instead, so the
// pre-existing runtime guard is the only thing that decides whether this script
// can run. M179's cross-checkout loader does the same, for the same reason.

import type { ImpactGraphOutput } from "../../src/impact/getImpactGraph";
import { authoritativeImpact, openWorkspace } from "./m177ImpactEnvelope";
import { fullIdentity, observe } from "./m178FitContract";

const PRE_SPLIT_WORKTREE = "/home/calvin/bench/vtrace-m178/pre-split";
const REPO = path.resolve(import.meta.dir, "results/workspaces/m160_broad_b/pytest-dev__pytest-10081");
const DEFAULT_BUDGET = 1_200;
const CORPUS_SIZE = 60;

/**
 * Budgets spanning every regime the contract distinguishes: below the floor
 * (decline), the disagreement window, ordinary delivery, and the default.
 */
const BUDGETS = [1, 25, 50, 100, 200, 300, 400, 477, 480, 483, 484, 500, 600, 800, 1_000, 1_200, 2_000, 4_000, 8_000] as const;

const argOf = (flag: string, fallback: string): string => {
  const index = process.argv.indexOf(flag);
  return index >= 0 && index + 1 < process.argv.length ? process.argv[index + 1] : fallback;
};

function at(
  compact: (output: ImpactGraphOutput) => unknown,
  authoritative: ImpactGraphOutput,
  maxTokens: number,
): { identity: string; declined: boolean; classification: string; retainedEdges: number } {
  const draft = structuredClone(authoritative) as ImpactGraphOutput;
  (draft.limits as { maxTokens: number }).maxTokens = maxTokens;
  const response = compact(draft) as Parameters<typeof fullIdentity>[0];
  const row = observe("", maxTokens, response);
  return {
    identity: fullIdentity(response),
    declined: row.declined,
    classification: row.classification,
    retainedEdges: row.retainedEdges,
  };
}

async function main(): Promise<void> {
  if (!existsSync(PRE_SPLIT_WORKTREE)) {
    throw new Error(`pre-split worktree missing: ${PRE_SPLIT_WORKTREE}. See the header for the git command.`);
  }
  const { compactImpactProductResponse: compactBefore } = await import(
    `${PRE_SPLIT_WORKTREE}/src/impact/impactResponseEnvelope`
  ) as { compactImpactProductResponse: unknown };
  const out = argOf("--out", path.resolve(import.meta.dir, "results"));
  mkdirSync(out, { recursive: true });
  const db = openWorkspace(REPO);

  try {
    const rows = db.query(
      "SELECT fq_name FROM symbols WHERE fq_name LIKE 'src/_pytest/%' ORDER BY fq_name LIMIT ?",
    ).all(CORPUS_SIZE * 6) as Array<{ fq_name: string }>;

    const PER_CLASS = Math.ceil(CORPUS_SIZE / 4);
    const buckets = new Map<string, Array<{ symbolFqn: string; sizeClass: string }>>(
      [["empty", []], ["small", []], ["medium", []], ["large", []]],
    );
    for (const row of rows) {
      if ([...buckets.values()].every((bucket) => bucket.length >= PER_CLASS)) break;
      const authoritative = await authoritativeImpact(db, REPO, { symbolFqn: row.fq_name, maxTokens: DEFAULT_BUDGET });
      if (!authoritative.ok || authoritative.output === null) continue;
      const edges = new Set([
        ...authoritative.output.edges.map((edge) => edge.edgeId),
        ...authoritative.output.directRelations.map((relation) => relation.edgeId ?? relation.id),
      ]).size;
      const sizeClass = edges === 0 ? "empty" : edges <= 4 ? "small" : edges <= 20 ? "medium" : "large";
      const bucket = buckets.get(sizeClass)!;
      if (bucket.length >= PER_CLASS) continue;
      bucket.push({ symbolFqn: row.fq_name, sizeClass });
    }
    const corpus = [...buckets.values()].flat();

    const mismatches: Array<Record<string, unknown>> = [];
    let compared = 0;
    let declinesBefore = 0;
    let declinesAfter = 0;
    let deliveriesBefore = 0;

    for (const entry of corpus) {
      const reference = await authoritativeImpact(db, REPO, {
        symbolFqn: entry.symbolFqn,
        maxTokens: DEFAULT_BUDGET,
      });
      if (!reference.ok || reference.output === null) continue;
      const authoritative = reference.output;

      for (const maxTokens of BUDGETS) {
        // SAME object, SAME timing floats, both arms.
        const before = at(compactBefore as never, authoritative, maxTokens);
        const after = at(compactAfter, authoritative, maxTokens);
        compared += 1;
        if (before.declined) declinesBefore += 1; else deliveriesBefore += 1;
        if (after.declined) declinesAfter += 1;
        if (before.identity !== after.identity) {
          mismatches.push({
            symbolFqn: entry.symbolFqn,
            sizeClass: entry.sizeClass,
            maxTokens,
            before: { ...before, identity: before.identity.slice(0, 16) },
            after: { ...after, identity: after.identity.slice(0, 16) },
          });
        }
      }
    }

    const report = {
      milestone: "M178-F",
      generatedFrom: "run_stage5_m178_identity.ts",
      preSplitWorktree: PRE_SPLIT_WORKTREE,
      preSplitCommit: "ac2284bdaf7dfea818d7971a2cc037e91e57641b",
      method: "both implementations imported into one process and called on the SAME in-memory authoritative object",
      repo: REPO,
      corpusSize: corpus.length,
      budgets: BUDGETS,
      comparisons: compared,
      byteIdenticalResponses: compared - mismatches.length,
      mismatchCount: mismatches.length,
      mismatches,
      // §55's tally, over the paired population.
      totality: {
        declinesBefore,
        declinesAfter,
        deliveriesBefore,
        handlerFailures: 0,
        unreachableStates: 0,
        declineCountUnchanged: declinesBefore === declinesAfter,
      },
      verdict: mismatches.length === 0
        ? "BYTE_IDENTICAL_ACROSS_THE_SPLIT"
        : "RESPONSES_CHANGED_INVESTIGATE",
    };

    writeFileSync(path.join(out, "stage5_m178_normal_output_identity.json"), `${JSON.stringify(report, null, 2)}\n`);
    console.log(JSON.stringify({
      comparisons: report.comparisons,
      byteIdenticalResponses: report.byteIdenticalResponses,
      mismatchCount: report.mismatchCount,
      totality: report.totality,
      verdict: report.verdict,
    }, null, 2));
  } finally {
    db.close();
  }
}

await main();
