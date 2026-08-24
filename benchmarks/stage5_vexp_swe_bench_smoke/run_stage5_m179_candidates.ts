/**
 * M179-D — candidate repairs, simulated on frozen authority BEFORE any product
 * code is changed (§46, §90's "no code changed before diagnosis").
 *
 *   bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m179_candidates.ts --corpus broad100a
 *
 * HOW A CANDIDATE IS SIMULATED WITHOUT IMPLEMENTING IT. The response the packer
 * produces is a function of the EVIDENCE budget alone; the ceiling decides only
 * whether that response may be shipped. So packing the same frozen object at an
 * evidence budget E and reading back its total gives the exact packet a candidate
 * would emit if it chose E — and testing that total against `ceiling(B)` answers
 * whether the candidate could ship it at the caller's budget B. No product change
 * is needed to know what these policies would do.
 *
 * Offline, pure, deterministic.
 */

import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { responseTokenCeiling } from "../../src/mcp/responseEnvelope";
import { comparePair, deliver, TERMINAL_RANK, type Delivered } from "./m179Packing";

const ROOT = path.resolve(".");
const RESULTS = path.join(ROOT, "benchmarks/stage5_vexp_swe_bench_smoke/results");
const CORPUS_ROOT = path.join(RESULTS, "_m179_authoritative");

const BUDGETS = [100, 200, 400, 600, 800, 1_000, 1_200, 1_600, 2_000, 3_200, 6_400, 8_000] as const;
const DEFAULT_BUDGET = 8_000;

/**
 * The evidence budgets a candidate may consider, as a FIXED global grid.
 *
 * Budget-relative probes (a fraction of B) would make the candidate set itself
 * move with the budget, and a policy choosing "the largest option that fits" from
 * a moving set is not monotone however monotone its criterion is. That is an
 * artifact of the simulation, not of the policy, so the grid is global and only
 * intersected with `<= B`: as B grows the option set can only grow, and the
 * selection is monotone by construction.
 */
const EVIDENCE_GRID = [
  50, 100, 150, 200, 300, 400, 500, 600, 800, 1_000, 1_200, 1_600, 2_000, 2_400,
  3_200, 4_000, 4_800, 6_400, 8_000,
] as const;

const evidenceProbes = (budget: number): number[] =>
  [...new Set<number>([budget, ...EVIDENCE_GRID.filter((value) => value < budget)])]
    .sort((a, b) => b - a);

interface Case { readonly instanceId: string; readonly authoritative: unknown }

function loadCorpus(dir: string): Case[] {
  if (!existsSync(dir)) return [];
  const cases: Case[] = [];
  for (const file of readdirSync(dir).filter((name) => name.endsWith(".json")).sort()) {
    const captured = JSON.parse(readFileSync(path.join(dir, file), "utf8")) as {
      instanceId: string; snapshot: unknown; error: string | null;
    };
    if (captured.snapshot === null || captured.error !== null) continue;
    cases.push({ instanceId: captured.instanceId, authoritative: captured.snapshot });
  }
  return cases;
}

type Policy = (authoritative: unknown, budget: number, packAt: (evidence: number) => Delivered) => Delivered;

/** What ships today: pack at B, and if the total will not fit, discard everything. */
const C_CURRENT: Policy = (_authoritative, budget, packAt) => packAt(budget);

/**
 * C_NESTED_RUNG — the caller's budget sets the CEILING; the evidence budget may be
 * reduced beneath it until the packet the packer chose is one the envelope can
 * actually ship. The ladder is descended, never restarted, so the packet emitted
 * is always one the current packer would itself have emitted at some smaller
 * budget — no new representation is invented and no claim changes.
 */
const C_NESTED_RUNG: Policy = (_authoritative, budget, packAt) => {
  const ceiling = responseTokenCeiling(budget);
  const first = packAt(budget);
  if (first.rank === TERMINAL_RANK.orientation) return first;
  for (const evidence of evidenceProbes(budget)) {
    if (evidence >= budget) continue;
    const attempt = packAt(evidence);
    // The packet must clear BOTH M178 contracts at the caller's budget: its
    // evidence within max_tokens, its complete response within the ceiling.
    if (attempt.rank === TERMINAL_RANK.orientation
      && attempt.modelVisibleTokens <= budget
      && attempt.totalTokens <= ceiling) return attempt;
  }
  return first;
};

/**
 * C_RAISE_ALLOWANCE — the rejected shape, simulated so the rejection is measured
 * rather than asserted (§14). Modelled as "the ceiling is whatever it needs to
 * be", which is what raising the metadata allowance amounts to.
 */
const C_RAISE_ALLOWANCE: Policy = (_authoritative, budget, packAt) => packAt(budget);

const CANDIDATES: Array<{ id: string; policy: Policy; note: string }> = [
  { id: "C_CURRENT", policy: C_CURRENT, note: "ships today" },
  { id: "C_NESTED_RUNG", policy: C_NESTED_RUNG, note: "reduce the evidence budget beneath a fixed ceiling until the chosen rung is deliverable" },
  { id: "C_RAISE_ALLOWANCE", policy: C_RAISE_ALLOWANCE, note: "rejected by §14; identical to C_CURRENT on the packet it selects, and only moves which budgets fail" },
];

function main(): void {
  const argv = process.argv.slice(2);
  const corpus = argv[argv.indexOf("--corpus") + 1] ?? "broad100a";
  const cases = loadCorpus(path.join(CORPUS_ROOT, corpus));
  if (cases.length === 0) throw new Error(`no frozen authoritative objects in ${path.join(CORPUS_ROOT, corpus)}`);

  const summaries: Array<Record<string, unknown>> = [];
  const perCandidateRows: Record<string, Array<Record<string, unknown>>> = {};

  for (const candidate of CANDIDATES) {
    let orientationToDecline = 0;
    let itemLoss = 0;
    let priorityInversion = 0;
    let representationDowngrade = 0;
    let qualifierEvicted = 0;
    let totalViolations = 0;
    let casesWithViolations = 0;
    let defaultOutputChanges = 0;
    let declineStates = 0;
    let refillSuspects = 0;
    const tokenDeltas: number[] = [];
    const rows: Array<Record<string, unknown>> = [];

    for (const item of cases) {
      // One memo per case: packing is pure, so an evidence budget is packed once.
      const memo = new Map<number, Delivered>();
      const packAt = (evidence: number): Delivered => {
        const hit = memo.get(evidence);
        if (hit !== undefined) return hit;
        const value = deliver(item.authoritative, evidence);
        memo.set(evidence, value);
        return value;
      };

      const ladder = BUDGETS.map((budget) => ({ budget, ...candidate.policy(item.authoritative, budget, packAt) }));
      const baseline = BUDGETS.map((budget) => ({ budget, ...packAt(budget) }));

      let caseViolations = 0;
      for (let i = 0; i < ladder.length; i += 1) {
        for (let j = i + 1; j < ladder.length; j += 1) {
          const violation = comparePair(ladder[i]!.budget, ladder[i]!, ladder[j]!.budget, ladder[j]!);
          if (violation === null) continue;
          caseViolations += 1;
          totalViolations += 1;
          for (const klass of violation.classes) {
            if (klass === "ORIENTATION_TO_DECLINE") orientationToDecline += 1;
            else if (klass === "ITEM_LOSS_WITH_NORMAL_RESPONSE") itemLoss += 1;
            else if (klass === "PRIORITY_INVERSION") priorityInversion += 1;
            else if (klass === "REPRESENTATION_DOWNGRADE") representationDowngrade += 1;
            else if (klass === "QUALIFIER_EVICTED") qualifierEvicted += 1;
          }
        }
      }
      if (caseViolations > 0) casesWithViolations += 1;
      declineStates += ladder.filter((entry) => entry.rank !== TERMINAL_RANK.orientation).length;

      for (let index = 0; index < ladder.length; index += 1) {
        const after = ladder[index]!;
        const before = baseline[index]!;
        tokenDeltas.push(after.modelVisibleTokens - before.modelVisibleTokens);
        // §48 — a repair must never ADD evidence at a budget that already worked.
        if (before.rank === TERMINAL_RANK.orientation && after.modelVisibleTokens > before.modelVisibleTokens) refillSuspects += 1;
        if (after.budget === DEFAULT_BUDGET
          && JSON.stringify({ ...after, budget: 0 }) !== JSON.stringify({ ...before, budget: 0 })) defaultOutputChanges += 1;
      }

      rows.push({
        instanceId: item.instanceId,
        violations: caseViolations,
        ladder: ladder.map((entry) => ({
          budget: entry.budget, state: entry.state,
          modelVisibleTokens: entry.modelVisibleTokens, totalTokens: entry.totalTokens,
          ceilingTokens: responseTokenCeiling(entry.budget), relatedCount: entry.related.length,
        })),
      });
    }

    const sorted = [...tokenDeltas].sort((a, b) => a - b);
    const median = sorted.length === 0 ? 0 : sorted[Math.floor(sorted.length / 2)]!;
    summaries.push({
      candidate: candidate.id,
      note: candidate.note,
      totalViolations,
      casesWithViolations,
      orientationToDecline,
      itemLoss,
      priorityInversion,
      representationDowngrade,
      qualifierEvicted,
      declineStatesAcrossLadders: declineStates,
      defaultBudgetOutputChanges: defaultOutputChanges,
      refillSuspects,
      medianModelVisibleTokenChange: median,
    });
    perCandidateRows[candidate.id] = rows;
  }

  const report = {
    schemaVersion: "stage5.m179.candidate-comparison.v1",
    milestone: "M179",
    workstream: "D",
    corpus,
    cases: cases.length,
    budgets: BUDGETS,
    defaultBudget: DEFAULT_BUDGET,
    method:
      "Each candidate is a POLICY over the same pure packing function. A packet is "
      + "obtained by packing the frozen object at an evidence budget; the candidate "
      + "decides which evidence budget to ship and is judged against the ceiling of "
      + "the CALLER's budget. No product code is changed to produce this table.",
    selectionPriority: ["truthfulness", "totality", "monotone preservation", "semantic priority", "minimal product behaviour change", "compactness/no refill", "implementation simplicity", "economics"],
    candidates: summaries,
    rows: perCandidateRows,
  };
  const outPath = path.join(RESULTS, `stage5_m179_candidate_comparison.${corpus}.json`);
  writeFileSync(outPath, `${JSON.stringify(report, null, 1)}\n`);

  console.log(`corpus=${corpus} cases=${cases.length}\n`);
  console.log("candidate           | viol | cases | o->d | loss | inv | downgr | declines | dflt chg | refill | med tok");
  for (const row of summaries) {
    console.log(
      `${String(row.candidate).padEnd(19)} | ${String(row.totalViolations).padStart(4)} | ${String(row.casesWithViolations).padStart(5)}`
      + ` | ${String(row.orientationToDecline).padStart(4)} | ${String(row.itemLoss).padStart(4)} | ${String(row.priorityInversion).padStart(3)}`
      + ` | ${String(row.representationDowngrade).padStart(6)} | ${String(row.declineStatesAcrossLadders).padStart(8)}`
      + ` | ${String(row.defaultBudgetOutputChanges).padStart(8)} | ${String(row.refillSuspects).padStart(6)} | ${String(row.medianModelVisibleTokenChange).padStart(7)}`,
    );
  }
  console.log(`\n-> ${path.relative(ROOT, outPath)}`);
}

main();
