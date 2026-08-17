/**
 * M157-A §18/§19 — reproduce a no-pivot delivery decision EXACTLY and record the
 * per-candidate evidence behind it.
 *
 * The M155 report described `django__django-11740` as "33 candidates, 0 pivots,
 * 0 support, 33 discarded, 0 tokens". Three of those five numbers come from the
 * capsule's own diagnostics, and one of them (`support_count`) is written as a
 * literal `0` on the no-context path regardless of how many candidates the role
 * layer actually classified as support. So the published shape cannot answer the
 * question M157 has to answer first: did 33 candidates each individually fail to
 * earn support authority (candidate-local), or did some of them earn it and lose
 * it to a query-global "no pivot -> deliver nothing" rule?
 *
 * This runner answers that by re-deriving the roles from the same inputs rather
 * than trusting the summary: it reads the discard REASON strings, which the
 * global gate and the local gates write differently, and cross-checks them
 * against the scorecard each candidate carries.
 *
 * Reads a pinned, already-indexed workspace. NO Claude, NO Docker, NO agent run,
 * NO API calls, NO network, NO indexing, NO writes to the target.
 */

import { writeFile } from "node:fs/promises";
import path from "node:path";

import { buildCapsuleV2 } from "../../src/capsuleV2/buildCapsuleV2";
import { openIndexerDatabase } from "../../src/db/sqlite";
import { allocateBudget } from "../../src/capsuleV2/budgetAllocator";
import { CapsuleIntent } from "../../src/capsuleV2/types";
import type { CapsuleV2Result } from "../../src/capsuleV2/types";
// Gold matching uses the SCORER's equivalence, not a local reimplementation: the
// corpora are indexed at the package root, so a gold path is a suffix of nothing
// unless the boundary-aware rule is applied (M155 §8).
import { fileMatches, symbolMatches } from "./run_stage5_retrieval_eval";

/** The reason string the query-global no-pivot gate stamps on support candidates. */
const GLOBAL_SUPPORT_COLLAPSE_REASON = "support-only: no actionable edit target";

interface TraceCase {
  readonly instanceId: string;
  readonly workspace: string;
  readonly task: string;
  readonly intent: string;
  readonly budget: number;
  readonly expectedFiles: readonly string[];
  readonly expectedSymbols: readonly string[];
}

/**
 * One candidate as the delivery layer saw it. `authority` is the M157 reading of
 * the discard reason: `support` means the role layer DID grant support authority
 * and the global gate took it away; `role_denied` means the candidate never
 * earned it in the first place.
 */
interface CandidateTrace {
  readonly path: string;
  readonly symbol: string;
  readonly fqName: string;
  readonly kind: string;
  readonly finalScore: number;
  readonly scorecard: Record<string, number>;
  readonly evidence: readonly string[];
  readonly discardReason: string;
  /** The candidate-LOCAL role decision, kept apart from the discard reason. */
  readonly roleReason: string;
  readonly authority: "delivered_pivot" | "delivered_support" | "support" | "role_denied";
  readonly isGoldFile: boolean;
  readonly isGoldSymbol: boolean;
}

function classifyAuthority(reason: string): CandidateTrace["authority"] {
  return reason === GLOBAL_SUPPORT_COLLAPSE_REASON ? "support" : "role_denied";
}

function traceCandidates(result: CapsuleV2Result, kase: TraceCase): CandidateTrace[] {
  const isGold = (filePath: string, symbol: string, fqName: string) => {
    const inGoldFile = kase.expectedFiles.some((f) => fileMatches(f, filePath));
    return {
      isGoldFile: inGoldFile,
      // A gold SYMBOL only counts inside a gold FILE: a same-named helper
      // elsewhere is not the patched definition.
      isGoldSymbol: inGoldFile && kase.expectedSymbols.some((s) => symbolMatches(s, { symbol, fqName })),
    };
  };

  const fromItem = (
    item: CapsuleV2Result["pivots"][number],
    authority: "delivered_pivot" | "delivered_support",
  ): CandidateTrace => ({
    path: item.path,
    symbol: item.symbol,
    fqName: item.fq_name,
    kind: item.kind,
    finalScore: item.scorecard.final,
    scorecard: { ...item.scorecard } as unknown as Record<string, number>,
    evidence: [...(item.evidence ?? [])],
    discardReason: "",
    roleReason: item.role_reason ?? "",
    authority,
    ...isGold(item.path, item.symbol, item.fq_name),
  });

  return [
    ...result.pivots.map((item) => fromItem(item, "delivered_pivot")),
    ...result.support.map((item) => fromItem(item, "delivered_support")),
    // `CapsuleV2Discarded` carries no fq_name, so gold-symbol matching for a
    // discarded candidate runs on the bare local name (the scorer does the same).
    ...result.discarded.map((item) => ({
      path: item.path,
      symbol: item.symbol,
      fqName: "",
      kind: item.kind,
      finalScore: item.scorecard.final,
      scorecard: { ...item.scorecard } as unknown as Record<string, number>,
      evidence: [...item.evidence],
      discardReason: item.discard_reason,
      roleReason: item.role_reason ?? item.discard_reason,
      authority: classifyAuthority(item.discard_reason),
      ...isGold(item.path, item.symbol, ""),
    })),
  ];
}

export interface DeliveryTrace {
  readonly instanceId: string;
  readonly workspace: string;
  readonly task: string;
  readonly budget: number;
  readonly actualMode: string;
  readonly reason: string | undefined;
  /** What the capsule REPORTS (diagnostics as published). */
  readonly reported: {
    readonly candidateCount: number;
    readonly pivotCount: number;
    readonly supportCount: number;
    readonly discardedCount: number;
    readonly estimatedTokens: number;
    readonly tier: string;
  };
  /** What the roles ACTUALLY were, recovered from the discard reasons. */
  readonly actual: {
    readonly deliveredPivots: number;
    readonly deliveredSupport: number;
    readonly supportAuthorityGranted: number;
    readonly roleDenied: number;
  };
  readonly goldFileCandidates: number;
  readonly goldSymbolCandidates: number;
  readonly candidates: readonly CandidateTrace[];
  readonly noContextExplanations: unknown;
}

export function traceCase(kase: TraceCase): DeliveryTrace {
  const workspace = path.resolve(kase.workspace);
  const db = openIndexerDatabase(path.join(workspace, ".vtrace", "index.sqlite"));
  let result: CapsuleV2Result;
  try {
    result = buildCapsuleV2({
      db,
      repoRoot: workspace,
      task: kase.task,
      intent: kase.intent as CapsuleIntent,
      maxTokens: kase.budget,
    });
  } finally {
    db.close();
  }

  const candidates = traceCandidates(result, kase);
  const count = (authority: CandidateTrace["authority"]) =>
    candidates.filter((c) => c.authority === authority).length;

  return {
    instanceId: kase.instanceId,
    workspace: kase.workspace,
    task: kase.task,
    budget: kase.budget,
    actualMode: result.actual_mode,
    reason: result.reason,
    reported: {
      candidateCount: result.diagnostics.candidate_count,
      pivotCount: result.diagnostics.pivot_count,
      supportCount: result.diagnostics.support_count,
      discardedCount: result.diagnostics.discarded_count,
      estimatedTokens: result.budget.estimated_tokens,
      tier: result.diagnostics.tier,
    },
    actual: {
      deliveredPivots: count("delivered_pivot"),
      deliveredSupport: count("delivered_support"),
      supportAuthorityGranted: count("support"),
      roleDenied: count("role_denied"),
    },
    goldFileCandidates: candidates.filter((c) => c.isGoldFile).length,
    goldSymbolCandidates: candidates.filter((c) => c.isGoldSymbol).length,
    candidates,
    noContextExplanations: result.diagnostics.no_context_explanations ?? [],
  };
}

interface FixtureRow {
  readonly instance_id: string;
  readonly repo: string;
  readonly task: string;
  readonly intent: string;
  readonly budget: number;
  readonly expected_files: string[];
  readonly expected_symbols: string[];
}

/**
 * Pivot slots for this case. Taken from the real allocator rather than the
 * reported tier: the no-context path reports `tier: no_context`, which would
 * otherwise hide the leak on exactly the cases it matters most for.
 */
const maxPivotsFor = (budget: number): number => allocateBudget(budget).maxPivots;

/** The per-case line of the population sweep (§33: how many no-pivot cases exist). */
function summarizeTrace(trace: DeliveryTrace, repo: string) {
  const supportAuthority = trace.candidates.filter((c) => c.authority === "support");
  // Actionability is the role layer's OWN kind test (function/method/class): the
  // one structural axis that already separates an editable definition from a
  // module variable. Counted here as an observation, not yet as a policy.
  const actionable = supportAuthority.filter((c) => c.scorecard.actionability === 1);

  // Where the gold file ended up. M157 can only ever help the `global_gate`
  // bucket; everything else is a different defect and must not be attributed to
  // delivery policy (§72).
  const goldCandidates = trace.candidates.filter((c) => c.isGoldFile);
  const goldFate = ((): string => {
    if (goldCandidates.length === 0) return "not_retrieved";
    if (goldCandidates.some((c) => c.authority === "delivered_pivot")) return "delivered_pivot";
    if (goldCandidates.some((c) => c.authority === "delivered_support")) return "delivered_support";
    if (goldCandidates.some((c) => c.authority === "support")) return "withheld_by_global_gate";
    return "role_denied_or_evicted";
  })();

  // Pivot-slot leak (M157-A): a candidate demoted out of the pivot role AFTER
  // the cap was applied never releases the slot it consumed, so a candidate that
  // met the pivot bar and lost only to the budget stays demoted even when the
  // budget is no longer full. Detected structurally: the role layer said "beyond
  // the pivot budget" while the budget is demonstrably not full.
  const budgetDemoted = trace.candidates.filter((c) => c.roleReason.includes("beyond the pivot budget"));
  const maxPivots = maxPivotsFor(trace.budget);
  const pivotSlotLeak = budgetDemoted.length > 0 && trace.actual.deliveredPivots < maxPivots;

  return {
    goldFate,
    tier: trace.reported.tier,
    maxPivots,
    budgetDemotedCandidates: budgetDemoted.length,
    pivotSlotLeak,
    pivotSlotsUnused: Math.max(0, maxPivots - trace.actual.deliveredPivots),
    budgetDemotedGold: budgetDemoted.filter((c) => c.isGoldFile).length,
    goldDiscardReasons: [...new Set(goldCandidates.filter((c) => c.discardReason !== "").map((c) => c.discardReason))],
    instanceId: trace.instanceId,
    repo,
    mode: trace.actualMode,
    noPivot: trace.actualMode === "no_context",
    candidateCount: trace.reported.candidateCount,
    supportAuthorityGranted: trace.actual.supportAuthorityGranted,
    roleDenied: trace.actual.roleDenied,
    actionableSupportAuthority: actionable.length,
    goldFileCandidates: trace.goldFileCandidates,
    goldSymbolCandidates: trace.goldSymbolCandidates,
    goldFileHeldByGlobalGate: supportAuthority.some((c) => c.isGoldFile),
    goldFileActionableHeld: actionable.some((c) => c.isGoldFile),
    estimatedTokens: trace.reported.estimatedTokens,
  };
}

async function main(): Promise<void> {
  const argv = Bun.argv.slice(2);
  const get = (flag: string, fallback?: string): string => {
    const index = argv.indexOf(flag);
    const value = index < 0 ? undefined : argv[index + 1];
    if (value === undefined) {
      if (fallback !== undefined) return fallback;
      throw new Error(`${flag} is required.`);
    }
    return value;
  };

  const fixturePath = get("--fixture");
  const corpusRoot = get("--corpus-root");
  const outPath = get("--out");
  const instanceId = argv.includes("--instance") ? get("--instance") : undefined;
  const sweep = argv.includes("--sweep");

  const fixture = (await Bun.file(fixturePath).json()) as readonly FixtureRow[];
  const toCase = (entry: FixtureRow): TraceCase => ({
    instanceId: entry.instance_id,
    workspace: path.join(corpusRoot, entry.instance_id),
    task: entry.task,
    intent: entry.intent,
    budget: entry.budget,
    expectedFiles: entry.expected_files,
    expectedSymbols: entry.expected_symbols,
  });

  if (sweep) {
    const rows: ReturnType<typeof summarizeTrace>[] = [];
    const failures: { instanceId: string; error: string }[] = [];
    for (const entry of fixture) {
      try {
        rows.push(summarizeTrace(traceCase(toCase(entry)), entry.repo));
      } catch (error) {
        failures.push({ instanceId: entry.instance_id, error: String(error) });
      }
    }
    const noPivot = rows.filter((r) => r.noPivot);
    const artifact = {
      schemaVersion: "stage5.m157.delivery-population.v1",
      corpusRoot,
      fixture: fixturePath,
      cases: rows.length,
      failures,
      population: {
        noPivotCases: noPivot.length,
        pivotCases: rows.length - noPivot.length,
        noPivotRepos: [...new Set(noPivot.map((r) => r.repo))].sort(),
        noPivotWithGoldFileHeld: noPivot.filter((r) => r.goldFileHeldByGlobalGate).length,
        noPivotWithActionableSupport: noPivot.filter((r) => r.actionableSupportAuthority > 0).length,
        noPivotWithNoActionableSupport: noPivot.filter((r) => r.actionableSupportAuthority === 0).length,
        noPivotWithZeroCandidates: noPivot.filter((r) => r.candidateCount === 0).length,
      },
      // The whole corpus by gold fate: the denominator M157's reach must be
      // judged against. `withheld_by_global_gate` is the only bucket a delivery
      // policy change can move.
      pivotSlotLeak: {
        cases: rows.filter((r) => r.pivotSlotLeak).length,
        noPivotCases: rows.filter((r) => r.pivotSlotLeak && r.noPivot).length,
        pivotPresentCases: rows.filter((r) => r.pivotSlotLeak && !r.noPivot).length,
        withGoldDemotedByBudget: rows.filter((r) => r.pivotSlotLeak && r.budgetDemotedGold > 0).length,
        repos: [...new Set(rows.filter((r) => r.pivotSlotLeak).map((r) => r.repo))].sort(),
      },
      goldFate: rows.reduce<Record<string, number>>((acc, row) => {
        acc[row.goldFate] = (acc[row.goldFate] ?? 0) + 1;
        return acc;
      }, {}),
      rows,
    };
    await writeFile(outPath, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
    console.log(JSON.stringify({ ...artifact, rows: `<${rows.length} rows>` }, null, 2));
    return;
  }

  if (instanceId === undefined) throw new Error("--instance is required without --sweep.");
  const entry = fixture.find((row) => row.instance_id === instanceId);
  if (entry === undefined) throw new Error(`instance not in fixture: ${instanceId}`);
  const trace = traceCase(toCase(entry));
  await writeFile(outPath, `${JSON.stringify(trace, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({ ...trace, candidates: `<${trace.candidates.length} candidates>` }, null, 2));
}

if (import.meta.main) {
  await main();
}
