/**
 * M177-E — paired qualification of the impact-envelope totality repair.
 *
 * BOTH IMPLEMENTATIONS RUN IN ONE PROCESS OVER ONE AUTHORITATIVE SNAPSHOT.
 * M176 initially recorded 11 of 200 output differences that turned out to be
 * nothing but its two arms having run minutes apart under different machine
 * load; re-run interleaved, all 11 were byte-identical. §55 makes that lesson a
 * rule, and the strongest form of it is available here: the pre-repair envelope
 * is a pure function of an `ImpactGraphOutput`, so it can be imported from a
 * detached worktree and called on the SAME in-memory object as the repaired one.
 * No scheduling, no load, and no clock separates the arms.
 *
 *   git worktree add --detach /home/calvin/bench/vtrace-m177/pre-repair ab0384fc
 *   bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m177_corpus.ts \
 *     --out benchmarks/stage5_vexp_swe_bench_smoke/results
 *
 * Deterministic, offline, no paid API, no Docker.
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

// The repaired envelope, from this checkout.
import { compactImpactProductResponse as compactAfter } from "../../src/impact/impactResponseEnvelope";
// The pre-repair envelope, from a detached worktree at the M176 HEAD.
import { compactImpactProductResponse as compactBefore } from "/home/calvin/bench/vtrace-m177/pre-repair/src/impact/impactResponseEnvelope";

import type { ImpactGraphOutput } from "../../src/impact/getImpactGraph";
import {
  authoritativeImpact,
  billedTokens,
  canonicalize,
  envelopeTokens,
  IMPACT_UNREACHABLE_MESSAGE,
  openWorkspace,
  responseIdentity,
} from "./m177ImpactEnvelope";

const PRE_REPAIR_WORKTREE = "/home/calvin/bench/vtrace-m177/pre-repair";
const REPO = path.resolve(import.meta.dir, "results/workspaces/m160_broad_b/pytest-dev__pytest-10081");

/**
 * The budgets each corpus request is evaluated at.
 *
 * `1200` is the tool's own default and is the only one that speaks to production
 * frequency; the rest are deliberate pressure and speak only to correctness. §33
 * requires the two never to be reported as the same number.
 */
const BUDGETS = [1, 50, 200, 400, 1_200] as const;
const DEFAULT_BUDGET = 1_200;

/** How many symbols to qualify over. §39's range, at the low-cost end. */
const CORPUS_SIZE = 60;

interface Outcome {
  readonly reachable: boolean;
  readonly unreachable: boolean;
  readonly unexpectedError: string | null;
  readonly response: Record<string, unknown> | null;
}

function runEnvelope(
  compact: (output: ImpactGraphOutput) => unknown,
  output: ImpactGraphOutput,
): Outcome {
  try {
    return { reachable: true, unreachable: false, unexpectedError: null, response: compact(structuredClone(output)) as Record<string, unknown> };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message === IMPACT_UNREACHABLE_MESSAGE) {
      return { reachable: false, unreachable: true, unexpectedError: null, response: null };
    }
    return { reachable: false, unreachable: false, unexpectedError: message, response: null };
  }
}

const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

const count = (value: unknown): number | null => typeof value === "number" ? value : null;

/**
 * The truthfulness audit, run on every delivered response in both arms.
 *
 * A fabricated absence is the failure this milestone exists to avoid, and it has
 * a precise definition here: the response asserts an absence that the
 * AUTHORITATIVE result contradicts. Each check names the authoritative fact it
 * compares against, so a violation says which claim was invented.
 */
function auditTruthfulness(authoritative: ImpactGraphOutput, response: Record<string, unknown>): readonly string[] {
  const violations: string[] = [];
  const budget = record(response.responseBudget);
  const callerCoverage = record(response.callerCoverage);
  const summary = record(response.summary);
  const consumers = record(summary?.consumers);
  const richSummary = record(response.richSummary);

  const authoritativeEdges = new Set([
    ...authoritative.edges.map((edge) => edge.edgeId),
    ...authoritative.directRelations.map((relation) => relation.edgeId ?? relation.id),
  ]).size;
  const delivered = count(budget?.retainedEdges) ?? 0;
  const omitted = count(budget?.omittedEdges) ?? 0;

  // 1. Evidence that existed and did not travel must be COUNTED as omitted, not
  //    silently absent. This is the single check that separates a truthful
  //    decline from a fabricated empty graph.
  if (authoritativeEdges > 0 && delivered === 0 && omitted === 0) {
    violations.push(`fabricated_absence: ${authoritativeEdges} authoritative edges, 0 delivered, 0 reported omitted`);
  }
  // 2. `complete` is a certainty claim. Nothing that dropped evidence may make it.
  if (delivered < authoritativeEdges && budget?.resultState === "complete") {
    violations.push(`false_exhaustive: resultState=complete with ${authoritativeEdges - delivered} edges not delivered`);
  }
  // 3. Caller coverage may only ever get LESS certain under budget pressure.
  if (callerCoverage?.status === "complete" && authoritative.callerCoverage?.status !== "complete") {
    violations.push("ownership_strengthening: callerCoverage.status strengthened to complete");
  }
  // 4. Discovered populations are facts about the repository, not the response.
  //    Shrinking one would convert "you did not receive them" into "they do not exist".
  if (count(callerCoverage?.exactCallerCount) !== authoritative.callerCoverage?.exactCallerCount) {
    violations.push(`discovered_count_altered: callerCoverage.exactCallerCount ${String(callerCoverage?.exactCallerCount)} != ${String(authoritative.callerCoverage?.exactCallerCount)}`);
  }
  if (count(consumers?.exactCallerCount) !== authoritative.summary.consumers.exactCallerCount) {
    violations.push(`discovered_count_altered: summary.consumers.exactCallerCount ${String(consumers?.exactCallerCount)} != ${String(authoritative.summary.consumers.exactCallerCount)}`);
  }
  if (count(consumers?.potentialCallerCount) !== authoritative.summary.consumers.potentialCallerCount) {
    violations.push("discovered_count_altered: summary.consumers.potentialCallerCount");
  }
  // 5. A delivered potential-caller count may never exceed what was discovered.
  const deliveredPotential = count(callerCoverage?.deliveredPotentialCallerCount) ?? 0;
  if (deliveredPotential > (authoritative.callerCoverage?.potentialCallerCount ?? 0)) {
    violations.push("delivery_exceeds_discovery: deliveredPotentialCallerCount");
  }
  // 6. `truncated: false` beside omitted edges is the same lie as (2), one field over.
  if (richSummary?.truncated === false && omitted > 0) {
    violations.push("false_exhaustive: richSummary.truncated=false with omitted edges");
  }
  return violations;
}

function argOf(flag: string, fallback: string): string {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? (process.argv[index + 1] ?? fallback) : fallback;
}

async function main(): Promise<void> {
  if (!existsSync(PRE_REPAIR_WORKTREE)) {
    throw new Error(`pre-repair worktree missing: ${PRE_REPAIR_WORKTREE}. Create it with: git worktree add --detach ${PRE_REPAIR_WORKTREE} ab0384fc`);
  }
  const out = argOf("--out", path.resolve(import.meta.dir, "results"));
  mkdirSync(out, { recursive: true });
  const db = openWorkspace(REPO);

  try {
    // Deterministic corpus: ordered by symbol id so the selection is a property
    // of the index and not of query planning. No sampling, no randomness.
    const rows = db.query(
      "SELECT fq_name FROM symbols WHERE fq_name LIKE 'src/_pytest/%' ORDER BY fq_name LIMIT ?",
    ).all(CORPUS_SIZE * 6) as Array<{ fq_name: string }>;

    // STRATIFIED, not first-N. Ordering `src/_pytest/%` by name and taking the
    // head yields almost entirely large graphs, which would qualify the repair on
    // the one shape whose evidence the ladder can shed most of. §38 wants the
    // small and empty graphs too — and the empty ones are where a careless repair
    // turns an honest zero into a delivery loss. Selection stays deterministic:
    // fixed scan order, fixed per-class quota, first come.
    const PER_CLASS = Math.ceil(CORPUS_SIZE / 4);
    const buckets = new Map<string, Array<{ symbolFqn: string; authoritativeEdges: number; sizeClass: string }>>(
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
      bucket.push({ symbolFqn: row.fq_name, authoritativeEdges: edges, sizeClass });
    }
    const corpus = [...buckets.values()].flat();

    interface Row {
      readonly symbolFqn: string;
      readonly sizeClass: string;
      readonly maxTokens: number;
      readonly authoritativeIdentity: string;
      readonly beforeState: string;
      readonly afterState: string;
      readonly normalIdentityMatch: boolean | null;
      readonly afterEnvelopeDecline: boolean;
      readonly afterRetainedEdges: number | null;
      readonly afterOmittedEdges: number | null;
      readonly afterResultState: string | null;
      readonly afterTruthfulnessViolations: readonly string[];
      readonly beforeTruthfulnessViolations: readonly string[];
      readonly afterBilledTokens: number | null;
    }

    const results: Row[] = [];
    for (const entry of corpus) {
      for (const maxTokens of BUDGETS) {
        const authoritative = await authoritativeImpact(db, REPO, { symbolFqn: entry.symbolFqn, maxTokens });
        if (!authoritative.ok || authoritative.output === null) continue;
        const snapshot = authoritative.output;

        // Same object, both arms, back to back.
        const before = runEnvelope(compactBefore as never, snapshot);
        const after = runEnvelope(compactAfter, snapshot);

        const bothDelivered = before.response !== null && after.response !== null;
        const afterDiagnostics = record(after.response?.diagnostics);
        const afterBudget = record(after.response?.responseBudget);

        results.push({
          symbolFqn: entry.symbolFqn,
          sizeClass: entry.sizeClass,
          maxTokens,
          authoritativeIdentity: authoritative.identity!,
          beforeState: before.unreachable ? "envelope_unreachable" : before.reachable ? "response" : `unexpected:${before.unexpectedError}`,
          afterState: after.unreachable ? "envelope_unreachable" : after.reachable ? "response" : `unexpected:${after.unexpectedError}`,
          // §31: where the pre-repair path delivered, the delivered bytes must be
          // identical. Clock fields are stripped by `responseIdentity`; nothing
          // else is.
          normalIdentityMatch: bothDelivered
            ? responseIdentity(before.response as never) === responseIdentity(after.response as never)
            : null,
          afterEnvelopeDecline: afterDiagnostics?.envelopeDecline === true,
          afterRetainedEdges: count(afterBudget?.retainedEdges),
          afterOmittedEdges: count(afterBudget?.omittedEdges),
          afterResultState: typeof afterBudget?.resultState === "string" ? afterBudget.resultState : null,
          afterTruthfulnessViolations: after.response === null ? [] : auditTruthfulness(snapshot, after.response),
          beforeTruthfulnessViolations: before.response === null ? [] : auditTruthfulness(snapshot, before.response),
          afterBilledTokens: after.response === null ? null : billedTokens(after.response),
        });
      }
    }

    const atDefault = results.filter((row) => row.maxTokens === DEFAULT_BUDGET);
    const pressured = results.filter((row) => row.maxTokens !== DEFAULT_BUDGET);
    const declines = results.filter((row) => row.afterEnvelopeDecline);

    const summary = {
      schemaVersion: "stage5.m177.corpus-results.v1",
      milestone: "M177",
      workstream: "E",
      method: "both envelope implementations imported into ONE process and called on the SAME authoritative snapshot (§55)",
      preRepairWorktree: { path: PRE_REPAIR_WORKTREE, commit: "ab0384fc534426b485599e28ed1bf901ad61c170" },
      repoRoot: REPO,
      corpusSize: corpus.length,
      sizeClasses: corpus.reduce<Record<string, number>>((acc, entry) => {
        acc[entry.sizeClass] = (acc[entry.sizeClass] ?? 0) + 1;
        return acc;
      }, {}),
      budgets: BUDGETS,
      defaultBudget: DEFAULT_BUDGET,
      validRequests: results.length,
      before: {
        envelopeInducedHandlerFailures: results.filter((row) => row.beforeState === "envelope_unreachable").length,
        unexpectedErrors: results.filter((row) => row.beforeState.startsWith("unexpected")).length,
        responses: results.filter((row) => row.beforeState === "response").length,
        truthfulnessViolations: results.flatMap((row) => row.beforeTruthfulnessViolations).length,
      },
      after: {
        envelopeInducedHandlerFailures: results.filter((row) => row.afterState === "envelope_unreachable").length,
        unexpectedErrors: results.filter((row) => row.afterState.startsWith("unexpected")).length,
        responses: results.filter((row) => row.afterState === "response").length,
        boundedDeclines: declines.length,
        truthfulnessViolations: results.flatMap((row) => row.afterTruthfulnessViolations).length,
      },
      defaultBudgetBehaviour: {
        note: "§33 — production frequency, kept separate from adversarial correctness",
        requests: atDefault.length,
        boundedDeclines: atDefault.filter((row) => row.afterEnvelopeDecline).length,
        handlerFailuresBefore: atDefault.filter((row) => row.beforeState === "envelope_unreachable").length,
        handlerFailuresAfter: atDefault.filter((row) => row.afterState === "envelope_unreachable").length,
      },
      pressuredBudgetBehaviour: {
        requests: pressured.length,
        handlerFailuresBefore: pressured.filter((row) => row.beforeState === "envelope_unreachable").length,
        handlerFailuresAfter: pressured.filter((row) => row.afterState === "envelope_unreachable").length,
        boundedDeclines: pressured.filter((row) => row.afterEnvelopeDecline).length,
      },
      normalResponseIdentity: {
        note: "§31 — rows where the PRE-REPAIR path already delivered. Clock fields (timing, accounting.latencyMs) stripped; everything else compared.",
        comparable: results.filter((row) => row.normalIdentityMatch !== null).length,
        identical: results.filter((row) => row.normalIdentityMatch === true).length,
        different: results.filter((row) => row.normalIdentityMatch === false).length,
        differingRows: results.filter((row) => row.normalIdentityMatch === false)
          .map((row) => ({ symbolFqn: row.symbolFqn, maxTokens: row.maxTokens })),
      },
      declineShape: {
        note: "§47 — the envelope's own model-visible channel is edges/nodes/view/directRelations/paths; the WHOLE record is larger because the impact output schema requires eleven top-level fields.",
        maxBilledTokens: declines.length === 0 ? null : Math.max(...declines.map((row) => row.afterBilledTokens ?? 0)),
        maxEnvelopeTokens: declines.length === 0 ? null : Math.max(...declines.map((row) => Math.ceil((row.afterBilledTokens ?? 0) / 0.3174032272551657 / 4))),
        evidenceExistsDeclines: declines.filter((row) => (row.afterOmittedEdges ?? 0) > 0).length,
        emptyImpactDeclines: declines.filter((row) => (row.afterOmittedEdges ?? 0) === 0).length,
        allReportZeroRetained: declines.every((row) => row.afterRetainedEdges === 0),
        resultStates: [...new Set(declines.map((row) => row.afterResultState))],
      },
      rows: results,
    };

    writeFileSync(path.join(out, "stage5_m177_corpus_results.json"), `${JSON.stringify(summary, null, 2)}\n`);
    writeFileSync(path.join(out, "stage5_m177_corpus_manifest.json"), `${JSON.stringify({
      schemaVersion: "stage5.m177.corpus-manifest.v1",
      repoRoot: REPO,
      selection: "symbols WHERE fq_name LIKE 'src/_pytest/%' ORDER BY fq_name, first 60 that the engine resolves",
      budgets: BUDGETS,
      corpus,
    }, null, 2)}\n`);

    console.log(`corpus=${corpus.length} requests=${results.length} classes=${JSON.stringify(summary.sizeClasses)}`);
    console.log(`handler failures  before=${summary.before.envelopeInducedHandlerFailures}  after=${summary.after.envelopeInducedHandlerFailures}`);
    console.log(`unexpected errors before=${summary.before.unexpectedErrors}  after=${summary.after.unexpectedErrors}`);
    console.log(`bounded declines after=${summary.after.boundedDeclines} (default budget: ${summary.defaultBudgetBehaviour.boundedDeclines}/${summary.defaultBudgetBehaviour.requests})`);
    console.log(`truthfulness violations before=${summary.before.truthfulnessViolations} after=${summary.after.truthfulnessViolations}`);
    console.log(`normal identity: ${summary.normalResponseIdentity.identical}/${summary.normalResponseIdentity.comparable} identical, ${summary.normalResponseIdentity.different} different`);
    console.log(`decline shape: evidence-exists=${summary.declineShape.evidenceExistsDeclines} empty-impact=${summary.declineShape.emptyImpactDeclines} states=${JSON.stringify(summary.declineShape.resultStates)} maxBilled=${summary.declineShape.maxBilledTokens}`);
    void canonicalize;
    void envelopeTokens;
  } finally {
    db.close();
  }
}

await main();
