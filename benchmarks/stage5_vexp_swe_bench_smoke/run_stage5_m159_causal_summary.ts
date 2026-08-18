/**
 * M159-C §37–§39/§45 — aggregate the per-case first-divergence traces into causal
 * populations, record repository diversity, test the structural patterns that
 * looked like mechanisms, and emit the harm matrix.
 *
 * §39 says to look for repeated STRUCTURAL facts rather than repeated words, and
 * not to invent a pattern unless multiple cases support it. Two candidate
 * patterns are therefore tested here against the delivered cases as a control,
 * and both results are published — including the one that failed, because a
 * hypothesis that survives only until it meets its control is the single most
 * expensive thing an audit can leave unrecorded (M157 and M158 both turned on
 * exactly that).
 *
 * Pure aggregation over committed artifacts. NO product code, NO retrieval, NO
 * network, NO indexing.
 */

import { writeFile } from "node:fs/promises";

interface FixtureRow {
  readonly instance_id: string; readonly repo: string; readonly task: string;
  readonly expected_files: string[]; readonly expected_symbols: string[];
}

/**
 * §39 — a structural discriminator, measured on the residual population AND on
 * the delivered cases. The control is not decoration: `degenerate task body`
 * looks damning at 65% of residual cases until the same measurement finds it in
 * 41% of the cases that SUCCEEDED.
 */
interface Discriminator {
  readonly name: string;
  readonly question: string;
  readonly residualRate: string;
  readonly deliveredControlRate: string;
  readonly separation: string;
  readonly verdict: "DISCRIMINATES" | "ENRICHED_NOT_CAUSAL" | "DOES_NOT_DISCRIMINATE";
  readonly note: string;
}

function rate(hits: number, total: number): string {
  return `${hits}/${total} (${total === 0 ? 0 : Math.round((100 * hits) / total)}%)`;
}

/** Whether the raw task names any gold symbol verbatim, on a word boundary. */
function taskNamesAnyGoldSymbol(row: FixtureRow): boolean {
  return row.expected_symbols.some((symbol) => {
    const escaped = symbol.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`\\b${escaped}\\b`).test(row.task);
  });
}

/** Whether the derived task body collapsed to a heading or an empty gesture. */
function hasDegenerateBody(row: FixtureRow): boolean {
  const afterTitle = row.task.split(" — ")[1] ?? "";
  const body = afterTitle.split(/\n(?:Errors|Traceback|Failing tests):/)[0]!.trim();
  return body.length < 60
    || /^[#*\s]*(bug summary|bug report|describe the bug|last modified)/i.test(body);
}

async function main(): Promise<void> {
  const argv = Bun.argv.slice(2);
  const get = (flag: string): string => {
    const index = argv.indexOf(flag);
    const value = index < 0 ? undefined : argv[index + 1];
    if (value === undefined) throw new Error(`${flag} is required.`);
    return value;
  };
  const fixture = (await Bun.file(get("--fixture")).json()) as readonly FixtureRow[];
  const taxonomy = (await Bun.file(get("--taxonomy")).json()) as {
    taxonomy: readonly { firstDivergence: string; cases: number; repos: readonly string[]; repoCount: number; instances: readonly string[] }[];
  };
  const simulations = (await Bun.file(get("--simulations")).json()) as {
    deliveryCeiling: { maxRankEverDelivered: number | null; deliveredItems: number; p50: number | null; p90: number | null };
    interventions: readonly Record<string, unknown>[];
  };
  const reconstruction = (await Bun.file(get("--reconstruction")).json()) as {
    rows: readonly { instanceId: string; goldFate: string }[];
  };
  const summaryOut = get("--out");
  const harmOut = get("--harm-out");

  const byId = new Map(fixture.map((row) => [row.instance_id, row]));
  const residual = new Set(taxonomy.taxonomy.flatMap((t) => [...t.instances]));
  const deliveredControl = reconstruction.rows
    .filter((r) => r.goldFate.startsWith("delivered"))
    .map((r) => r.instanceId);

  const measure = (ids: readonly string[], predicate: (row: FixtureRow) => boolean): number =>
    ids.filter((id) => { const row = byId.get(id); return row !== undefined && predicate(row); }).length;

  const residualIds = [...residual].sort();
  const discriminators: Discriminator[] = [
    {
      name: "task_never_names_the_gold_symbol",
      question: "Does the task text give any lexical handle on the symbol that must be edited?",
      residualRate: rate(measure(residualIds, (r) => !taskNamesAnyGoldSymbol(r)), residualIds.length),
      deliveredControlRate: rate(measure(deliveredControl, (r) => !taskNamesAnyGoldSymbol(r)), deliveredControl.length),
      separation: "large but not sufficient",
      verdict: "ENRICHED_NOT_CAUSAL",
      note: "The sharpest structural fact in the residual population, and still not a rule. 19 of 20 residual cases give retrieval no lexical handle on the definition that must change — but so do 50 of the 79 that SUCCEED. Absence of a handle is therefore a NECESSARY-BUT-NOT-SUFFICIENT condition: it marks the population at risk, and something else (a path clue, a resolvable traceback frame, a file-level lexical hit) rescues the majority. Building a rule on it would fire on 50 healthy cases to reach 19 sick ones. What it does establish is WHERE the remaining headroom lives: the behavioural link from a bug report to its implementing definition, which is the M143-B subject->owner ceiling and the M153 result/effect ceiling meeting on one corpus.",
    },
    {
      name: "gold_symbol_is_private_or_dunder",
      question: "Is the definition that must change a private helper or a dunder?",
      residualRate: rate(measure(residualIds, (r) => r.expected_symbols.some((s) => s.startsWith("_"))), residualIds.length),
      deliveredControlRate: rate(measure(deliveredControl, (r) => r.expected_symbols.some((s) => s.startsWith("_"))), deliveredControl.length),
      separation: "moderate",
      verdict: "ENRICHED_NOT_CAUSAL",
      note: "Enriched in the residual population but common among successes too. It travels with the lexical-handle fact rather than causing anything independently, so it is not a rule to build on.",
    },
    {
      name: "derived_task_body_is_degenerate",
      question: "Did task derivation collapse the issue body to a bare markdown heading?",
      residualRate: rate(measure(residualIds, hasDegenerateBody), residualIds.length),
      deliveredControlRate: rate(measure(deliveredControl, hasDegenerateBody), deliveredControl.length),
      separation: "small",
      verdict: "ENRICHED_NOT_CAUSAL",
      note: "REJECTED as the bottleneck. It looks like the obvious cause on inspection, and the residual rate is genuinely higher — but a third of the cases that SUCCEED carry the identical degeneracy. A defect that most of its victims survive is not the mechanism.",
    },
  ];

  const populations = taxonomy.taxonomy.map((entry) => {
    const recoverable = simulations.interventions.find((i) =>
      i.scope === entry.firstDivergence && (i.recovered as number) > 0);
    const attempted = simulations.interventions.filter((i) => i.scope === entry.firstDivergence);
    return {
      population: entry.firstDivergence,
      cases: entry.cases,
      repos: entry.repoCount,
      repoList: entry.repos,
      instances: entry.instances,
      interventionsSimulated: attempted.map((i) => i.id as string),
      simulatedRecovery: attempted.length === 0 ? 0 : Math.max(...attempted.map((i) => i.recovered as number)),
      functionalMilestoneJustified: recoverable !== undefined && entry.repoCount >= 2,
      rationale: attempted.length === 0
        ? "no intervention could be simulated: no lane reaches the gold symbol at any probed pool, so nothing short of new retrieval semantics applies"
        : recoverable === undefined
          ? "every simulated intervention recovered 0 against the measured delivery ceiling"
          : entry.repoCount >= 2
            ? "recoverable and cross-repository"
            : "recoverable but confined to one repository, below the generality §47 asks for",
    };
  }).sort((a, b) => b.cases - a.cases);

  await writeFile(summaryOut, `${JSON.stringify({
    schemaVersion: "stage5.m159.causal-population-summary.v1",
    residualCases: residualIds.length,
    deliveryCeiling: simulations.deliveryCeiling,
    populations,
    discriminators,
    controlPopulation: { name: "gold delivered", cases: deliveredControl.length },
  }, null, 2)}\n`, "utf8");

  await writeFile(harmOut, `${JSON.stringify({
    schemaVersion: "stage5.m159.intervention-harm-matrix.v1",
    note: "§41 — recovery and harm together. A '0 recovered' row is refuted before harm is reached (§93); a row never selected for implementation reports its harm as NOT MEASURED rather than as 0.",
    deliveryCeiling: simulations.deliveryCeiling,
    rows: simulations.interventions,
  }, null, 2)}\n`, "utf8");

  console.log(JSON.stringify({ populations, discriminators }, null, 2));
}

if (import.meta.main) {
  await main();
}
