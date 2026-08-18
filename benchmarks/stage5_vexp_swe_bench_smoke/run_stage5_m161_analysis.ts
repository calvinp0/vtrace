/**
 * M161-D §35-§37, §52-§60, §62-§68, §86 — build the paired outcome ledger and
 * every derived count from the captured runs.
 *
 * OFFLINE. Reads run artifacts and writes JSON. It never re-runs anything, and it
 * must not be edited after outcomes are read (§50) — the classifiers it calls all
 * live in tested modules for exactly that reason.
 *
 *   bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m161_analysis.ts
 */

import { writeFile } from "node:fs/promises";
import path from "node:path";

import { hashStable } from "./benchmarkProvenance";
import {
  buildMatrix,
  classifyPair,
  computeOrientation,
  crossTab,
  discordantExactP,
  gradeArm,
  pairedDelta,
  stats,
  type CrossTabCase,
  type Grade,
  type Orientation,
  type ToolCall,
} from "./m161Analysis";
import { classifyLeadQuality, classifyTreatmentState, type TreatmentState } from "./m161Treatment";

const RESULTS = path.join(import.meta.dir, "results");

interface ArmRun {
  readonly instanceId: string;
  readonly repo: string;
  readonly arm: "baseline" | "vtrace";
  readonly label: string;
  readonly ran: boolean;
  readonly grade: Grade;
  readonly patchProduced: boolean;
  readonly model: string | null;
  readonly costUsd: number | null;
  readonly numTurns: number | null;
  readonly durationMs: number | null;
  readonly totalTokens: number | null;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly cacheReadTokens: number | null;
  readonly cacheCreationTokens: number | null;
  readonly orientation: Orientation | null;
  readonly treatmentState: TreatmentState | null;
  readonly injectedContextTokensApprox: number | null;
  readonly deliveredItems: number | null;
  readonly pivotCount: number | null;
  readonly supportCount: number | null;
  readonly indexBuildMs: number | null;
  readonly evaluationRan: boolean;
}

const num = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);

async function readJson(filePath: string): Promise<Record<string, unknown> | null> {
  return (await Bun.file(filePath).json().catch(() => null)) as Record<string, unknown> | null;
}

function labelFor(arm: string, instanceId: string): string {
  return `m161_${arm}_${instanceId.replaceAll("-", "_")}`;
}

async function loadArm(
  arm: "baseline" | "vtrace",
  instanceId: string,
  repo: string,
  goldFiles: readonly string[],
): Promise<ArmRun> {
  const label = labelFor(arm, instanceId);
  const dir = path.join(RESULTS, "runs", label, "raw", arm);
  // A missing directory is a run that never happened, not an error: the analysis
  // must be able to describe an incomplete sweep (§35 forbids shrinking the
  // denominator, so an absent arm has to become an UNGRADED row rather than a throw).
  const rows: Record<string, unknown>[] = [];
  try {
    for await (const file of new Bun.Glob("swebench-*.jsonl").scan({ cwd: dir, absolute: true })) {
      for (const line of (await Bun.file(file).text()).split("\n")) {
        if (line.trim().length > 0) rows.push(JSON.parse(line));
      }
    }
  } catch {
    // directory absent — leaves rows empty, which classifies as UNGRADED below
  }
  const row = rows.find((r) => r.instanceId === instanceId) ?? rows[0] ?? null;
  const meta = (await readJson(path.join(dir, "_run.meta.json"))) ?? {};
  const evalMeta = await readJson(path.join(dir, "_eval.meta.json"));
  const calls = ((await readJson(path.join(dir, "_tool_calls.json"))) as unknown as ToolCall[] | null) ?? null;

  // §51 — patch produced, agent claim and grader verdict are kept separate; only
  // the grader decides. A run with no _eval.meta.json is UNGRADED, never a FAIL.
  const evaluationRan = evalMeta?.evaluationRan === true;
  const patchProduced = typeof row?.modelPatch === "string" && (row.modelPatch as string).length > 0;
  const grade: Grade = gradeArm({ ran: row !== null, evaluationRan, resolved: row?.resolved, patchProduced });

  const tokenParts = [row?.inputTokens, row?.outputTokens, row?.cacheReadTokens, row?.cacheCreationTokens].map(num);
  const treatment = arm === "vtrace" ? classifyTreatmentState(meta, { ran: row !== null }) : null;
  const instructionsBytes = num(meta.vtraceInstructionsFileSize);

  return {
    instanceId, repo, arm, label,
    ran: row !== null,
    grade,
    patchProduced,
    model: typeof row?.model === "string" ? row.model : null,
    costUsd: num(row?.costUsd),
    numTurns: num(row?.numTurns),
    durationMs: num(row?.durationMs),
    totalTokens: tokenParts.every((p) => p !== null) ? tokenParts.reduce((sum, p) => (sum ?? 0) + (p ?? 0), 0) : null,
    inputTokens: num(row?.inputTokens),
    outputTokens: num(row?.outputTokens),
    cacheReadTokens: num(row?.cacheReadTokens),
    cacheCreationTokens: num(row?.cacheCreationTokens),
    orientation: Array.isArray(calls) ? computeOrientation(calls, goldFiles) : null,
    treatmentState: treatment?.state ?? null,
    // §56 — the injected block's size, reported on its own and NEVER called a
    // token saving. A ~4 chars/token rule is enough to keep it comparable to the
    // agent totals without pretending to a tokenizer we do not run here.
    injectedContextTokensApprox: arm === "vtrace" && instructionsBytes !== null ? Math.round(instructionsBytes / 4) : null,
    deliveredItems: treatment?.deliveredItems ?? null,
    pivotCount: treatment?.pivotCount ?? null,
    supportCount: treatment?.supportCount ?? null,
    indexBuildMs: num(meta.vtraceIndexDurationMs) ?? num(meta.vtraceIndexElapsedMs),
    evaluationRan,
  };
}

async function main(): Promise<void> {
  const manifest = await Bun.file(path.join(RESULTS, "stage5_m161_paired30_manifest.json")).json();
  const cases = manifest.cases as { instanceId: string; repo: string; expectedFiles: string[]; order: number }[];

  const baselineRuns: ArmRun[] = [];
  const vtraceRuns: ArmRun[] = [];
  for (const kase of cases) {
    baselineRuns.push(await loadArm("baseline", kase.instanceId, kase.repo, kase.expectedFiles));
    vtraceRuns.push(await loadArm("vtrace", kase.instanceId, kase.repo, kase.expectedFiles));
  }

  // -- treatment availability, over the ORIGINAL 30 (§35, §132) -------------
  const byState: Record<string, number> = {};
  for (const run of vtraceRuns) {
    const key = run.treatmentState ?? (run.ran ? "UNCLASSIFIED" : "NOT_RUN");
    byState[key] = (byState[key] ?? 0) + 1;
  }
  const availability = {
    schemaVersion: "stage5.m161.treatment-availability.v1",
    denominatorRule:
      "Availability is reported over the ORIGINAL frozen 30 (§35). The paired agent matrix is " +
      "conditional on both arms having run and being gradable (§36) and is a DIFFERENT denominator. " +
      "Neither is silently shrunk.",
    selectedTasks: cases.length,
    byState,
    validTreatmentRate: Number(
      ((vtraceRuns.filter((r) => r.treatmentState === "VALID_NONEMPTY" || r.treatmentState === "DEGRADED_VALID" || r.treatmentState === "VALID_DELIVERY_EMPTY").length) / cases.length).toFixed(4),
    ),
    // §69 — reported prominently: the treatment agent never ran, so this is an
    // end-to-end product availability failure, NOT an ordinary unique loss.
    baselinePassWithTreatmentUnavailable: cases
      .map((kase, i) => ({ kase, b: baselineRuns[i]!, v: vtraceRuns[i]! }))
      .filter(({ b, v }) => b.grade === "PASS" && (v.treatmentState === "TREATMENT_UNAVAILABLE" || !v.ran))
      .map(({ kase, v }) => ({ instanceId: kase.instanceId, repo: kase.repo, treatmentState: v.treatmentState })),
  };

  // -- paired outcomes (§52) ------------------------------------------------
  const pairs = cases.map((kase, i) => {
    const b = baselineRuns[i]!;
    const v = vtraceRuns[i]!;
    const delta = (pick: (r: ArmRun) => number | null): number | null => {
      const bv = pick(b);
      const vv = pick(v);
      return bv === null || vv === null ? null : vv - bv;
    };
    return {
      order: kase.order,
      instanceId: kase.instanceId,
      repo: kase.repo,
      baselineGrade: b.grade,
      vtraceGrade: v.grade,
      classification: classifyPair(b.grade, v.grade),
      treatmentState: v.treatmentState,
      leadQuality: null as string | null,
      tokenDelta: delta((r) => r.totalTokens),
      costDelta: delta((r) => r.costUsd),
      turnDelta: delta((r) => r.numTurns),
      wallDelta: delta((r) => r.durationMs),
      searchDelta: delta((r) => r.orientation?.searches ?? null),
      readDelta: delta((r) => r.orientation?.reads ?? null),
      firstEditDelta: delta((r) => r.orientation?.firstEditIndex ?? null),
    };
  });

  // -- lead quality (§62-§63) ----------------------------------------------
  const leadRows = await Promise.all(cases.map(async (kase, i) => {
    const v = vtraceRuns[i]!;
    const meta = (await readJson(path.join(RESULTS, "runs", v.label, "raw", "vtrace", "_run.meta.json"))) ?? {};
    const pivots = (meta.vtraceCapsulePivots ?? []) as { path: string; symbol?: string }[];
    const support = (meta.vtraceCapsuleSupport ?? []) as { path: string; symbol?: string }[];
    const lead = classifyLeadQuality({
      state: v.treatmentState ?? "TREATMENT_UNAVAILABLE",
      pivots, support, goldFiles: kase.expectedFiles,
    });
    // Carry the treatment state alongside the lead label so the two are never
    // conflated: NOT_RUN and TREATMENT_UNAVAILABLE both map to the same lead label
    // (neither may claim gold state), and only the treatment state tells them apart.
    return { instanceId: kase.instanceId, repo: kase.repo, goldFiles: kase.expectedFiles, treatmentState: v.treatmentState, ...lead };
  }));
  const leadById = new Map(leadRows.map((r) => [r.instanceId, r]));
  for (const pair of pairs) pair.leadQuality = leadById.get(pair.instanceId)?.quality ?? null;

  const crossTabCases: CrossTabCase[] = pairs.map((p) => ({
    instanceId: p.instanceId,
    leadQuality: (p.leadQuality ?? "TREATMENT_UNAVAILABLE") as CrossTabCase["leadQuality"],
    treatmentState: (p.treatmentState ?? "TREATMENT_UNAVAILABLE") as TreatmentState,
    classification: p.classification,
    baselineGrade: p.baselineGrade,
    vtraceGrade: p.vtraceGrade,
    tokenDelta: p.tokenDelta,
    searchDelta: p.searchDelta,
    turnDelta: p.turnDelta,
    wallDelta: p.wallDelta,
    firstEditDelta: p.firstEditDelta,
  }));

  const matrix = buildMatrix(pairs);
  const validPairs = pairs.filter((p) => p.classification !== "incomplete");
  const wins = matrix["VTRACE unique win"];
  const losses = matrix["VTRACE unique loss"];
  const baselinePass = validPairs.filter((p) => p.baselineGrade === "PASS").length;
  const vtracePass = validPairs.filter((p) => p.vtraceGrade === "PASS").length;

  const outcomes = {
    schemaVersion: "stage5.m161.paired-outcomes.v1",
    selectedTasks: cases.length,
    validPairs: validPairs.length,
    matrix,
    netUniqueWins: wins - losses,
    passRates: {
      baseline: validPairs.length === 0 ? null : Number((baselinePass / validPairs.length).toFixed(4)),
      vtrace: validPairs.length === 0 ? null : Number((vtracePass / validPairs.length).toFixed(4)),
      absoluteDelta: validPairs.length === 0 ? null : Number(((vtracePass - baselinePass) / validPairs.length).toFixed(4)),
      baselinePassCount: baselinePass,
      vtracePassCount: vtracePass,
    },
    uncertainty: {
      discordantPairs: wins + losses,
      exactTwoSidedP: discordantExactP(wins, losses),
      note:
        "The paired information lives in the DISCORDANT pairs, not in the pass-rate delta. " +
        "At n=30 even a 4-0 discordant sweep is only p=0.125, so a small delta is not a result (§54).",
    },
    uniqueWinInstances: pairs.filter((p) => p.classification === "VTRACE unique win").map((p) => p.instanceId),
    uniqueLossInstances: pairs.filter((p) => p.classification === "VTRACE unique loss").map((p) => p.instanceId),
    incompleteInstances: pairs.filter((p) => p.classification === "incomplete").map((p) => p.instanceId),
    pairs,
  };

  // -- token / cost (§55-§59) ----------------------------------------------
  const armStats = (runs: readonly ArmRun[]) => ({
    tokens: stats(runs.map((r) => r.totalTokens).filter((v): v is number => v !== null)),
    cost: stats(runs.map((r) => r.costUsd).filter((v): v is number => v !== null)),
    turns: stats(runs.map((r) => r.numTurns).filter((v): v is number => v !== null)),
    wallMs: stats(runs.map((r) => r.durationMs).filter((v): v is number => v !== null)),
  });
  const tokenCost = {
    schemaVersion: "stage5.m161.token-cost.v1",
    claimDiscipline:
      "The injected context size is reported on its own and is NEVER called a token saving or a " +
      "context reduction (§56). A token-reduction claim requires LOWER TOTAL model token usage across " +
      "the complete agent workflow (§57).",
    baseline: armStats(baselineRuns),
    vtrace: armStats(vtraceRuns),
    pairedDeltas: {
      tokens: pairedDelta(pairs.map((p) => ({ baseline: 0, vtrace: p.tokenDelta }))),
      cost: pairedDelta(pairs.map((p) => ({ baseline: 0, vtrace: p.costDelta }))),
      turns: pairedDelta(pairs.map((p) => ({ baseline: 0, vtrace: p.turnDelta }))),
      wallMs: pairedDelta(pairs.map((p) => ({ baseline: 0, vtrace: p.wallDelta }))),
    },
    vtracePreparation: {
      note: "kept DISTINCT from agent API cost (§58, §59)",
      injectedContextTokensApprox: stats(vtraceRuns.map((r) => r.injectedContextTokensApprox).filter((v): v is number => v !== null)),
      indexBuildMs: stats(vtraceRuns.map((r) => r.indexBuildMs).filter((v): v is number => v !== null)),
    },
  };

  // -- agent work (§60-§61) -------------------------------------------------
  const workStats = (runs: readonly ArmRun[]) => ({
    toolCalls: stats(runs.map((r) => r.orientation?.toolCalls).filter((v): v is number => typeof v === "number")),
    searches: stats(runs.map((r) => r.orientation?.searches).filter((v): v is number => typeof v === "number")),
    reads: stats(runs.map((r) => r.orientation?.reads).filter((v): v is number => typeof v === "number")),
    edits: stats(runs.map((r) => r.orientation?.edits).filter((v): v is number => typeof v === "number")),
    firstEditIndex: stats(runs.map((r) => r.orientation?.firstEditIndex).filter((v): v is number => typeof v === "number")),
    firstGoldTouchIndex: stats(runs.map((r) => r.orientation?.firstGoldTouchIndex).filter((v): v is number => typeof v === "number")),
    goldTouchedBeforeFirstEdit: runs.filter((r) => r.orientation?.goldTouchedBeforeFirstEdit === true).length,
  });
  const work = {
    schemaVersion: "stage5.m161.agent-work.v1",
    unavailableUnderThisProtocol: {
      note: "§61 — marked UNAVAILABLE, never zero. VTRACE is injected, not callable.",
      metrics: ["VTRACE MCP calls", "get_code_context calls", "get_impact_graph calls", "voluntary invocation", "VTRACE-vs-grep sequencing"],
    },
    interpretationCaution:
      "Fewer searches is not automatically better (§114) and a faster first edit is not automatically " +
      "better (§115); both are read alongside the grader outcome, never instead of it.",
    baseline: workStats(baselineRuns),
    vtrace: workStats(vtraceRuns),
  };

  const write = async (name: string, value: unknown): Promise<void> => {
    await writeFile(path.join(RESULTS, name), `${JSON.stringify(value, null, 2)}\n`);
  };
  await write("stage5_m161_baseline_runs.json", { schemaVersion: "stage5.m161.arm-runs.v1", arm: "baseline", runs: baselineRuns });
  await write("stage5_m161_vtrace_runs.json", { schemaVersion: "stage5.m161.arm-runs.v1", arm: "vtrace", runs: vtraceRuns });
  await write("stage5_m161_grades.json", {
    schemaVersion: "stage5.m161.grades.v1",
    rule: "grader authority only; patch produced and agent claims are recorded separately and never substituted (§51, §87)",
    grades: cases.map((kase, i) => ({
      instanceId: kase.instanceId,
      baseline: { grade: baselineRuns[i]!.grade, patchProduced: baselineRuns[i]!.patchProduced, evaluationRan: baselineRuns[i]!.evaluationRan },
      vtrace: { grade: vtraceRuns[i]!.grade, patchProduced: vtraceRuns[i]!.patchProduced, evaluationRan: vtraceRuns[i]!.evaluationRan },
    })),
  });
  await write("stage5_m161_treatment_availability.json", availability);
  await write("stage5_m161_paired_outcomes.json", outcomes);
  await write("stage5_m161_token_cost.json", tokenCost);
  await write("stage5_m161_agent_work_metrics.json", work);
  await write("stage5_m161_lead_quality.json", {
    schemaVersion: "stage5.m161.lead-quality.v1",
    goldUse: "gold paths are EVALUATION ONLY and were never fed to retrieval (§20)",
    rows: leadRows,
    distribution: leadRows.reduce<Record<string, number>>((acc, r) => { acc[r.quality] = (acc[r.quality] ?? 0) + 1; return acc; }, {}),
  });
  await write("stage5_m161_lead_outcome_cross_tab.json", {
    schemaVersion: "stage5.m161.lead-cross-tab.v1",
    centralQuestion:
      "LEAD_WRONG_GOLD_ELSEWHERE is the row M161 exists to read (§64): does a wrong lead materially hurt " +
      "when useful evidence is elsewhere in the injected context?",
    rows: crossTab(crossTabCases),
    casesHash: hashStable(crossTabCases.map((c) => `${c.instanceId}:${c.leadQuality}:${c.classification}`)),
  });

  console.log(`pairs            ${validPairs.length} valid of ${cases.length} selected`);
  console.log(`matrix           ${JSON.stringify(matrix)}`);
  console.log(`net unique wins  ${wins - losses}  (wins ${wins}, losses ${losses}, exact p ${discordantExactP(wins, losses)})`);
  console.log(`pass rates       baseline ${baselinePass}/${validPairs.length}  vtrace ${vtracePass}/${validPairs.length}`);
  console.log(`availability     ${JSON.stringify(byState)}`);
  console.log(`lead quality     ${JSON.stringify(leadRows.reduce<Record<string, number>>((a, r) => { a[r.quality] = (a[r.quality] ?? 0) + 1; return a; }, {}))}`);
}

if (import.meta.main) {
  await main();
}
