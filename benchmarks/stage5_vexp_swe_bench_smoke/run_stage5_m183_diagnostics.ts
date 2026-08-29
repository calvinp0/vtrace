/**
 * M183-E — post-hoc mechanism diagnostics.
 *
 *   bun run_stage5_m183_diagnostics.ts
 *
 * THE ONLY M183 SCRIPT THAT READS A GOLD PATCH, AND IT RUNS LAST.
 *
 * §61 keeps gold out of the prompt, the query, the orientation and the ranking.
 * §52 permits it as an explanatory diagnostic afterwards. The separation is
 * enforced by ordering and by file: the orientation generator does not open the
 * dataset's `patch` field, the outcomes script does not open this one's inputs,
 * and this script cannot influence either because both have already run and
 * sealed their hashes (§85).
 *
 * WHAT A DIAGNOSTIC IS NOT. Gold-file localization is not solving. A run whose
 * focus was the gold file and whose patch failed the grader is a localization
 * success and a resolution failure, and M183 reports it as both (§53/§147).
 *
 * CAUSAL LANGUAGE IS RATIONED (§105/§106). A unique win is classified
 * VTRACE_CAUSALLY_PLAUSIBLE only when the orientation named evidence, the agent
 * edited within that evidence, and the baseline did not reach it. Everything
 * else is STOCHASTIC_AGENT_DIVERGENCE or NOT_DETERMINABLE. "Treatment won" is
 * not by itself a reason to say VTRACE caused it.
 */

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const RESULTS = path.resolve("benchmarks/stage5_vexp_swe_bench_smoke/results");
const CORPUS = path.join(RESULTS, "_m160_corpus/swe_bench_verified.jsonl");

interface ArmSide {
  valid: boolean; resolved: boolean; costUsd: number | null; numTurns: number | null;
  totalAgentTokens: number; toolCallCount: number; toolCallsBeforeFirstEdit: number;
  toolCallsByCategory: Record<string, number>; rawDir?: string;
}
interface PairRecord {
  instanceId: string; repo: string; stratum: string; m173Overlap: boolean;
  pairValid: boolean; baseline: ArmSide; treatment: ArmSide;
  orientation: { focusAt: string | null; focusFile: string | null; relatedFiles: string[]; relatedAt: string[]; deliveryState: string; orientationTokens: number } | null;
}
interface ToolCall { index: number; tool: string; category: string | null; path: string | null }

/** §53 — the files the reference patch changes. Nothing else counts as gold. */
function goldFiles(patch: string): readonly string[] {
  const files = new Set<string>();
  for (const m of patch.matchAll(/^diff --git a\/(\S+) b\/(\S+)$/gmu)) files.add(m[2]!);
  return [...files].sort();
}

/** Identifier-shaped tokens on the patch's own changed lines — a coarse symbol proxy. */
function goldSymbols(patch: string): ReadonlySet<string> {
  const out = new Set<string>();
  for (const line of patch.split("\n")) {
    if (!/^[+-]/u.test(line) || /^[+-][+-]/u.test(line)) continue;
    for (const m of line.matchAll(/\b(?:def|class)\s+([A-Za-z_][A-Za-z0-9_]*)/gu)) out.add(m[1]!);
  }
  return out;
}

/** Repository-relative edit targets, from the ordered tool log. */
function editedPaths(rawDir: string | undefined): readonly string[] {
  if (rawDir === undefined) return [];
  let calls: ToolCall[];
  try { calls = JSON.parse(readFileSync(path.join(path.resolve("."), rawDir, "_tool_calls.json"), "utf8")) as ToolCall[]; }
  catch { return []; }
  const out = new Set<string>();
  for (const c of calls) {
    if (c.category !== "edit" || typeof c.path !== "string") continue;
    // The harness logs absolute paths inside its own checkout; keep the tail
    // after the repository directory so it compares with a gold path.
    const m = /\.bench-repos\/[^/]+\/(.+)$/u.exec(c.path);
    out.add(m === null ? c.path : m[1]!);
  }
  return [...out].sort();
}

const symbolOf = (at: string | null): string | null =>
  at === null ? null : (at.split("::").at(-1) ?? "").split(".").at(-1) ?? null;

function main(): void {
  const corpus = new Map<string, { patch: string }>();
  for (const line of readFileSync(CORPUS, "utf8").split("\n")) {
    if (line.trim() === "") continue;
    const row = JSON.parse(line) as { instance_id: string; patch: string };
    corpus.set(row.instance_id, { patch: row.patch });
  }

  const records = (readFileSync(path.join(RESULTS, "stage5_m183_pair_records.jsonl"), "utf8")
    .split("\n").filter((l) => l.trim() !== "").map((l) => JSON.parse(l) as PairRecord))
    .filter((r) => r.pairValid);

  const rows = records.map((r) => {
    const gold = goldFiles(corpus.get(r.instanceId)?.patch ?? "");
    const symbols = goldSymbols(corpus.get(r.instanceId)?.patch ?? "");
    const o = r.orientation;
    const focusFile = o?.focusFile ?? null;
    const focusSymbol = symbolOf(o?.focusAt ?? null);
    const orientationFiles = [...new Set([focusFile, ...(o?.relatedFiles ?? [])].filter((f): f is string => f !== null))];
    const baselineEdits = editedPaths(r.baseline.rawDir);
    const treatmentEdits = editedPaths(r.treatment.rawDir);

    return {
      instanceId: r.instanceId, repo: r.repo, stratum: r.stratum, m173Overlap: r.m173Overlap,
      goldFiles: gold, goldFileCount: gold.length,
      orientationDelivered: o?.deliveryState === "ORIENTATION_DELIVERED",
      focusAt: o?.focusAt ?? null, focusFile,
      // §52's five diagnostics, each computed and none of them a grade.
      goldFileInOrientation: orientationFiles.some((f) => gold.includes(f)),
      goldSymbolInOrientation: [focusSymbol, ...(o?.relatedAt ?? []).map(symbolOf)]
        .some((s) => s !== null && symbols.has(s)),
      focusIsGoldFile: focusFile !== null && gold.includes(focusFile),
      treatmentEditedFocus: focusFile !== null && treatmentEdits.includes(focusFile),
      treatmentEditedAnyGoldFile: treatmentEdits.some((f) => gold.includes(f)),
      baselineEditedAnyGoldFile: baselineEdits.some((f) => gold.includes(f)),
      baselineReachedOrientationEvidence: baselineEdits.some((f) => orientationFiles.includes(f)),
      baselineEdits, treatmentEdits,
      orientationFiles,
      baselineResolved: r.baseline.resolved, treatmentResolved: r.treatment.resolved,
      outcome: r.baseline.resolved && r.treatment.resolved ? "BOTH"
        : r.treatment.resolved ? "TREATMENT_ONLY"
        : r.baseline.resolved ? "BASELINE_ONLY" : "NEITHER",
    };
  });

  const rate = (fn: (row: typeof rows[number]) => boolean): string => {
    const n = rows.filter(fn).length;
    return `${n}/${rows.length}`;
  };

  const discordant = rows.filter((r) => r.outcome === "TREATMENT_ONLY" || r.outcome === "BASELINE_ONLY");

  /**
   * §104/§105/§106 — the classification, applied identically in both directions.
   * The strongest label requires three facts, not one outcome.
   */
  const classify = (row: typeof rows[number]): { classification: string; mechanism: string; causal: string } => {
    if (row.outcome === "TREATMENT_ONLY") {
      if (!row.orientationDelivered) {
        return { classification: "STOCHASTIC_MODEL_DIVERGENCE", mechanism: "the treatment arm won without a delivered orientation", causal: "NO_CLEAR_VTRACE_CAUSALITY" };
      }
      if (row.focusIsGoldFile && row.treatmentEditedFocus && !row.baselineEditedAnyGoldFile) {
        return { classification: "LOCALIZATION_DIFFERENCE", mechanism: "the orientation named the gold file, the treatment arm edited it, and the baseline never edited a gold file", causal: "VTRACE_CAUSALLY_PLAUSIBLE" };
      }
      if (row.goldFileInOrientation && row.treatmentEditedAnyGoldFile && row.baselineEditedAnyGoldFile) {
        return { classification: "REPAIR_STRATEGY_DIFFERENCE", mechanism: "both arms edited a gold file; only the treatment arm's edit passed the grader", causal: "VTRACE_CONTRIBUTORY" };
      }
      return { classification: "NOT_DETERMINABLE", mechanism: "the treatment arm won without a traceable evidence advantage", causal: "NO_CLEAR_VTRACE_CAUSALITY" };
    }
    if (!row.orientationDelivered) {
      return { classification: "STOCHASTIC_MODEL_DIVERGENCE", mechanism: "the baseline won and no orientation was delivered to compare against", causal: "NO_CLEAR_VTRACE_CAUSALITY" };
    }
    if (!row.focusIsGoldFile && row.treatmentEditedFocus && row.baselineEditedAnyGoldFile) {
      return { classification: "LOCALIZATION_DIFFERENCE", mechanism: "the orientation focused a non-gold file, the treatment arm edited it, and the baseline reached a gold file instead", causal: "VTRACE_HARM_EVIDENCE" };
    }
    if (row.goldFileInOrientation && row.treatmentEditedAnyGoldFile) {
      return { classification: "REPAIR_STRATEGY_DIFFERENCE", mechanism: "the orientation named the gold file and the treatment arm edited it; the repair, not the localization, failed", causal: "NO_CLEAR_VTRACE_CAUSALITY" };
    }
    return { classification: "NOT_DETERMINABLE", mechanism: "the baseline won without a traceable orientation defect", causal: "NO_CLEAR_VTRACE_CAUSALITY" };
  };

  const discordantRows = discordant.map((row) => ({
    instanceId: row.instanceId, repo: row.repo,
    winner: row.outcome === "TREATMENT_ONLY" ? "VTRACE" : "BASELINE",
    focusCorrect: row.focusIsGoldFile,
    orientationUsed: row.treatmentEditedFocus,
    goldFileInOrientation: row.goldFileInOrientation,
    baselineEditedAnyGoldFile: row.baselineEditedAnyGoldFile,
    treatmentEditedAnyGoldFile: row.treatmentEditedAnyGoldFile,
    ...classify(row),
  }));

  const goldDiagnostics = {
    schemaVersion: "stage5.m183.gold-diagnostics.v1", milestone: "M183", workstream: "M183-E",
    computedAfterGrading: true,
    goldFileDefinition: "a file changed by the SWE-bench reference patch (§53). It does not mean solved.",
    goldSymbolProxy: "an identifier introduced by a `def`/`class` line inside the reference patch's own changed lines. Coarse by construction and labelled as a proxy.",
    pairs: rows.length,
    rates: {
      goldFileInOrientation: rate((r) => r.goldFileInOrientation),
      goldSymbolInOrientation: rate((r) => r.goldSymbolInOrientation),
      focusIsGoldFile: rate((r) => r.focusIsGoldFile),
      treatmentEditedFocus: rate((r) => r.treatmentEditedFocus),
      treatmentEditedAnyGoldFile: rate((r) => r.treatmentEditedAnyGoldFile),
      baselineEditedAnyGoldFile: rate((r) => r.baselineEditedAnyGoldFile),
    },
    localizationIsNotResolution: {
      focusWasGoldAndTreatmentStillFailed: rows.filter((r) => r.focusIsGoldFile && !r.treatmentResolved).length,
      focusWasNotGoldAndTreatmentSolvedAnyway: rows.filter((r) => !r.focusIsGoldFile && r.treatmentResolved).length,
      note: "§147 — these two counts are why the headline metric is `resolved` and not `focusIsGoldFile`.",
    },
    rows,
  };

  const uniqueWins = discordantRows.filter((r) => r.winner === "VTRACE");
  const uniqueLosses = discordantRows.filter((r) => r.winner === "BASELINE");

  // §129 — the historical replication table, from M173's own committed ledger.
  let replication: unknown = { available: false, reason: "stage5_m173_paired_ledger.json not readable" };
  try {
    const m173 = JSON.parse(readFileSync(path.join(RESULTS, "stage5_m173_paired_ledger.json"), "utf8")) as {
      pairs: { instanceId: string; resolvedBaseline: boolean; resolvedCompact: boolean; costBaselineUsd: number | null; costCompactUsd: number | null }[];
    };
    const byId = new Map(m173.pairs.map((p) => [p.instanceId, p]));
    const overlap = records.filter((r) => r.m173Overlap);
    replication = {
      available: true,
      instances: overlap.length,
      note: "§129 — M173's arm B carried a mandate and an MCP tool inventory and a ~629-token packet; M183's carries none of those and a larger packet. A changed outcome is not thereby caused by the product change: the model is stochastic and the treatment shape differs in more than one way.",
      rows: overlap.map((r) => {
        const h = byId.get(r.instanceId);
        return {
          instanceId: r.instanceId,
          m173BaselineResolved: h?.resolvedBaseline ?? null, m173TreatmentResolved: h?.resolvedCompact ?? null,
          m183BaselineResolved: r.baseline.resolved, m183TreatmentResolved: r.treatment.resolved,
          m173BaselineCost: h?.costBaselineUsd ?? null, m173TreatmentCost: h?.costCompactUsd ?? null,
          m183BaselineCost: r.baseline.costUsd, m183TreatmentCost: r.treatment.costUsd,
        };
      }),
    };
  } catch { /* left as unavailable */ }

  const repoBreakdown: Record<string, unknown> = {};
  for (const repo of [...new Set(records.map((r) => r.repo))].sort()) {
    const subset = records.filter((r) => r.repo === repo);
    repoBreakdown[repo] = {
      pairs: subset.length,
      baselineResolved: subset.filter((r) => r.baseline.resolved).length,
      treatmentResolved: subset.filter((r) => r.treatment.resolved).length,
      aggregateBaselineCost: subset.reduce((a, r) => a + (r.baseline.costUsd ?? 0), 0),
      aggregateTreatmentCost: subset.reduce((a, r) => a + (r.treatment.costUsd ?? 0), 0),
    };
  }

  const write = (name: string, doc: unknown): void =>
    writeFileSync(path.join(RESULTS, name), `${JSON.stringify(doc, null, 2)}\n`);
  write("stage5_m183_gold_diagnostics.json", goldDiagnostics);
  write("stage5_m183_unique_vtrace_wins.json", { schemaVersion: "stage5.m183.unique-wins.v1", milestone: "M183", count: uniqueWins.length, attributionStandard: "§105 — a unique win is labelled VTRACE_CAUSALLY_PLAUSIBLE only when the orientation named the gold file, the treatment arm edited it, and the baseline never reached a gold file. Winning is not evidence of causation.", wins: uniqueWins });
  write("stage5_m183_unique_baseline_wins.json", { schemaVersion: "stage5.m183.unique-baseline-wins.v1", milestone: "M183", count: uniqueLosses.length, attributionStandard: "§106 — symmetric. VTRACE is blamed only when the orientation demonstrably misdirected the arm; an ignored orientation beside an independent divergence is stochastic.", losses: uniqueLosses });
  write("stage5_m183_causal_attribution.json", { schemaVersion: "stage5.m183.causal-attribution.v1", milestone: "M183", workstream: "M183-E", discordantPairs: discordantRows.length, classifications: discordantRows, taxonomy: ["LOCALIZATION_DIFFERENCE", "EVIDENCE_DIFFERENCE_AFTER_LOCALIZATION", "REPAIR_STRATEGY_DIFFERENCE", "VALIDATION_DIFFERENCE", "ENVIRONMENTAL_DIFFERENCE", "STOCHASTIC_MODEL_DIVERGENCE", "NOT_DETERMINABLE"] });
  write("stage5_m183_m173_replication.json", { schemaVersion: "stage5.m183.m173-replication.v1", milestone: "M183", ...(replication as Record<string, unknown>) });
  write("stage5_m183_repo_breakdown.json", { schemaVersion: "stage5.m183.repo-breakdown.v1", milestone: "M183", note: "§128 — every participating repository with its pair count, so no single repository can carry the headline silently.", repositories: repoBreakdown });

  console.log(`M183 diagnostics over ${rows.length} valid pairs`);
  console.log(`  focus is gold file        ${goldDiagnostics.rates.focusIsGoldFile}`);
  console.log(`  gold file in orientation  ${goldDiagnostics.rates.goldFileInOrientation}`);
  console.log(`  treatment edited focus    ${goldDiagnostics.rates.treatmentEditedFocus}`);
  console.log(`  discordant pairs: ${discordantRows.length} (VTRACE-only ${uniqueWins.length}, baseline-only ${uniqueLosses.length})`);
}

main();
