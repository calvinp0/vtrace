/**
 * M180-D/F — paired qualification of an item-ownership candidate.
 *
 *   git worktree add --detach /home/calvin/bench/vtrace-m180/pre-repair 291c9c8d
 *   bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m180_qualification.ts \
 *     --candidate C_AUTHORITATIVE_SUPPLY_CHANNEL
 *
 * BOTH ARMS IN ONE PROCESS, ON THE SAME BYTES — M178's method, inherited through
 * M179. `compactProductResponse` and `projectRunPipelineOrientation` are pure
 * functions of the frozen authoritative object, so the pre-repair checkout is
 * imported by absolute path and called on the SAME in-memory object. No clock,
 * no index, no transport and no machine load can reach the comparison.
 *
 * Scored with `comparePreservation`, whose semantics were fixed before any
 * candidate existed and which can fail a candidate in both directions.
 *
 * Offline, pure, deterministic. Live spend $0.00.
 */

import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { carriesItemBodies } from "./m179Capture";
import { semanticItemSupplyOf } from "../../src/productContext/semanticItemSupply";
import { RENDER_TRAILING_NOTE, TERMINAL_RANK, authoritativeIdentity } from "./m179Packing";
import {
  asArray, comparePreservation, hashOf, isRecord, observeOwnership, rolesFallbackMap,
  type PreservationInput,
} from "./m180Ownership";

const RESULTS = path.resolve("benchmarks/stage5_vexp_swe_bench_smoke/results");
const CORPUS_ROOT = path.join(RESULTS, "_m179_authoritative");
const PRE_REPAIR_ROOT = "/home/calvin/bench/vtrace-m180/pre-repair";

const BUDGETS = [100, 200, 400, 600, 800, 1_000, 1_200, 1_600, 2_000, 3_200, 6_400, 8_000] as const;
const DEFAULT_BUDGET = 8_000;

const argOf = (flag: string, fallback: string): string => {
  const index = process.argv.indexOf(flag);
  return index >= 0 && index + 1 < process.argv.length ? process.argv[index + 1]! : fallback;
};

interface Arm {
  readonly compact: (output: unknown, options: Record<string, unknown>) => unknown;
  readonly project: (output: unknown) => unknown;
  readonly standard: string;
}

async function loadArm(root: string): Promise<Arm> {
  const envelope = await import(`${root}/src/mcp/responseEnvelope`) as {
    compactProductResponse: Arm["compact"]; McpResponseDetail: Record<string, string>;
  };
  const projection = await import(`${root}/src/runPipeline/orientationProjection`) as {
    projectRunPipelineOrientation: Arm["project"];
  };
  return {
    compact: envelope.compactProductResponse,
    project: projection.projectRunPipelineOrientation,
    standard: envelope.McpResponseDetail.Standard!,
  };
}

interface Row extends PreservationInput {
  readonly budget: number;
  readonly state: string;
  readonly packetTokens: number;
  readonly metadataTokens: number;
  readonly totalTokens: number;
  readonly withinEnvelope: boolean;
  readonly threw: boolean;
  readonly withheld: number;
  readonly withheldBy: string;
  readonly evidenceSupply: number;
  readonly projectorInput: number;
  readonly serialized: string;
  readonly packet: string;
}

/**
 * M166's calibration for serialized tool-result JSON. The packet is what the
 * model is actually handed on this path, so it is what economics is measured on.
 */
const TOKENS_PER_CHARACTER = 0.3174032272551657;

const stripNote = (code: string): string => {
  const trimmed = code.trimEnd();
  return trimmed.endsWith(RENDER_TRAILING_NOTE)
    ? trimmed.slice(0, trimmed.length - RENDER_TRAILING_NOTE.length).trimEnd()
    : code;
};

/** How many items the repaired arm PUBLISHED as the authoritative supply. */
function publishedFor(arm: Arm, authoritative: unknown, budget: number): number | null {
  const draft = structuredClone(authoritative) as Record<string, unknown>;
  delete draft.responseBudget;
  const response = arm.compact(draft, { requestedContextTokens: budget, detail: arm.standard }) as Record<string, unknown>;
  const productContext = isRecord(response.productContext) ? response.productContext : null;
  if (productContext === null) return null;
  return semanticItemSupplyOf(productContext)?.length ?? null;
}

function observe(arm: Arm, authoritative: unknown, budget: number): Row {
  const draft = structuredClone(authoritative) as Record<string, unknown>;
  delete draft.responseBudget;
  const empty = {
    budget, rank: TERMINAL_RANK.decline, focus: null, related: [], notes: [],
    focusCode: false, focusCodeCharacters: 0, packetTokens: 0, metadataTokens: 0,
    totalTokens: 0, withinEnvelope: false, withheld: 0, withheldBy: "none",
    evidenceSupply: 0, projectorInput: 0, serialized: "", packet: "",
  };
  let response: Record<string, unknown>;
  try {
    response = arm.compact(draft, { requestedContextTokens: budget, detail: arm.standard }) as Record<string, unknown>;
  } catch (cause) {
    return { ...empty, state: `throw:${cause instanceof Error ? cause.message : String(cause)}`, rank: TERMINAL_RANK.refused, threw: true };
  }

  const accounting = isRecord(response.responseBudget) ? response.responseBudget : {};
  const productContext = isRecord(response.productContext) ? response.productContext : {};
  const own = observeOwnership(response, budget);
  const serialized = JSON.stringify(response) ?? "";
  const number = (value: unknown): number => (typeof value === "number" ? value : 0);

  const shared = {
    budget,
    threw: false,
    metadataTokens: number(accounting.estimated_metadata_tokens),
    totalTokens: number(accounting.estimated_total_response_tokens),
    withinEnvelope: accounting.within_envelope === true,
    withheld: own.withheld.length,
    withheldBy: own.withheldBy,
    evidenceSupply: own.evidenceSupply.length,
    projectorInput: own.projectorInput.length,
    serialized,
  };

  const packet = arm.project(response) as {
    focus: { at: string; code: string | null; codeTruncated: boolean };
    related: readonly { at: string; how: string }[];
    notes?: readonly string[];
  } | null;

  if (packet === null) {
    return {
      ...empty, ...shared,
      state: String(productContext.resultState ?? "unknown"),
      rank: TERMINAL_RANK.decline,
      // A decline still crosses the wire as the whole compacted response.
      packetTokens: Math.round(serialized.length * TOKENS_PER_CHARACTER),
      packet: "",
    };
  }
  const code = stripNote(packet.focus.code ?? "");
  const packetJson = JSON.stringify(packet) ?? "";
  return {
    ...shared,
    state: "orientation",
    rank: TERMINAL_RANK.orientation,
    focus: packet.focus.at,
    related: packet.related.map((entry) => `${entry.at}|${entry.how}`),
    notes: [...(packet.notes ?? [])],
    focusCode: code !== "",
    focusCodeCharacters: code.length,
    packetTokens: Math.round(packetJson.length * TOKENS_PER_CHARACTER),
    packet: packetJson,
  };
}

interface Tally {
  violatingPairs: number;
  casesWithViolation: number;
  byClass: Record<string, number>;
  benignByClass: Record<string, number>;
  declines: number;
  throws: number;
  orientations: number;
  outsideEnvelope: number;
  budgetsWhereSupplyWasCut: number;
  truthfulnessFailures: number;
}

const emptyTally = (): Tally => ({
  violatingPairs: 0, casesWithViolation: 0, byClass: {}, benignByClass: {},
  declines: 0, throws: 0, orientations: 0, outsideEnvelope: 0,
  budgetsWhereSupplyWasCut: 0, truthfulnessFailures: 0,
});

function score(rows: readonly Row[], leadPivot: string, fallback: ReadonlyMap<string, string>, tally: Tally): number {
  let violating = 0;
  for (const row of rows) {
    if (row.threw) tally.throws += 1;
    if (row.rank === TERMINAL_RANK.orientation) tally.orientations += 1; else tally.declines += 1;
    if (!row.withinEnvelope && !row.threw) tally.outsideEnvelope += 1;
    if (row.withheld > 0) tally.budgetsWhereSupplyWasCut += 1;
    // Truthfulness: an orientation must carry a focus, and a focus must name a
    // symbol the authoritative supply actually contains.
    if (row.rank === TERMINAL_RANK.orientation && (row.focus === null || row.focus === "")) tally.truthfulnessFailures += 1;
  }
  for (let i = 0; i < rows.length; i += 1) {
    for (let j = i + 1; j < rows.length; j += 1) {
      const verdict = comparePreservation(rows[i]!, rows[j]!, leadPivot, fallback);
      for (const cls of verdict.benign) tally.benignByClass[cls] = (tally.benignByClass[cls] ?? 0) + 1;
      if (verdict.violations.length === 0) continue;
      violating += 1;
      tally.violatingPairs += 1;
      for (const cls of verdict.violations) tally.byClass[cls] = (tally.byClass[cls] ?? 0) + 1;
    }
  }
  if (violating > 0) tally.casesWithViolation += 1;
  return violating;
}

const median = (values: number[]): number => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
};
const percentile = (values: number[], fraction: number): number => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))]!;
};

async function main(): Promise<void> {
  if (!existsSync(PRE_REPAIR_ROOT)) {
    throw new Error(`pre-repair worktree missing: ${PRE_REPAIR_ROOT}. See the header for the git command.`);
  }
  const candidate = argOf("--candidate", "UNNAMED");
  const before = await loadArm(PRE_REPAIR_ROOT);
  const after = await loadArm(path.resolve("."));

  const summary: Record<string, unknown> = {};
  const perCase: Record<string, unknown>[] = [];
  const restored: Record<string, number> = { RESTORED_SEMANTIC_ITEM: 0, NEWLY_SELECTED_LOW_PRIORITY_ITEM: 0 };
  const defaultIdentity = { compared: 0, identicalSerialized: 0, identicalPacket: 0, changed: [] as string[] };
  let retrievalIdentical = 0;
  let retrievalCompared = 0;
  const claims = { delivered: 0, verbatimAuthoritative: 0, authoritativePrefix: 0, unsupported: 0, notInSupply: 0 };
  // §60 — the metric that decides the ownership verdict. `withheld` counts rows
  // the metadata layer removed from productContext.items; `consumedMutated`
  // counts the budgets where that removal reached the supply the projector
  // ACTUALLY read. The first may stay non-zero — items is metadata and metadata
  // is compactable — while the second must go to zero.
  const consumed = { before: { budgets: 0, mutated: 0 }, after: { budgets: 0, mutated: 0 } };
  const residual: Record<string, unknown>[] = [];
  const focusDisplaced: Record<string, number> = { before: 0, after: 0 };
  const leadInSupply = new Set<string>();
  const packetByBudget: Record<string, { before: number[]; after: number[] }> = {};
  for (const budget of BUDGETS) packetByBudget[String(budget)] = { before: [], after: [] };

  for (const corpus of ["broad100a", "broad100b"]) {
    const beforeTally = emptyTally();
    const afterTally = emptyTally();
    const beforePacket: number[] = [];
    const afterPacket: number[] = [];
    const beforeMetadata: number[] = [];
    const afterMetadata: number[] = [];
    let cases = 0;

    for (const file of readdirSync(path.join(CORPUS_ROOT, corpus)).sort()) {
      if (!file.endsWith(".json")) continue;
      const capture = JSON.parse(readFileSync(path.join(CORPUS_ROOT, corpus, file), "utf8")) as { instanceId: string; snapshot: unknown };
      if (capture.snapshot === null || !carriesItemBodies(capture.snapshot).valid) continue;
      cases += 1;
      const authoritative = capture.snapshot;
      const productContext = isRecord(authoritative) && isRecord((authoritative as Record<string, unknown>).productContext)
        ? (authoritative as Record<string, unknown>).productContext as Record<string, unknown>
        : {};
      const leadPivot = String(productContext.leadPivot ?? "");
      const fallback = rolesFallbackMap(authoritative);

      // Every claim the authoritative object makes about a symbol, plus the
      // roles string the projector falls back to. A `how` outside this set would
      // be a claim the product invented; one inside it is a RESELECTION among
      // claims the authoritative state already supports.
      const vocabulary = new Map<string, Set<string>>();
      for (const item of asArray(productContext.items)) {
        const fqName = String(item.fqName ?? "");
        if (fqName === "") continue;
        const roles = Array.isArray(item.roles) ? item.roles.map((role) => String(role)) : [];
        const reasons = Array.isArray(item.selectionReasons) ? item.selectionReasons.map((reason) => String(reason)) : [];
        // compactReasons ellipsizes anything past 160 characters, so a compacted
        // claim is a PREFIX of an authoritative one rather than equal to it.
        vocabulary.set(fqName, new Set([roles.join(", "), ...reasons]));
      }

      const beforeRows = BUDGETS.map((budget) => observe(before, authoritative, budget));
      const afterRows = BUDGETS.map((budget) => observe(after, authoritative, budget));

      // The lead pivot is "in supply" at a budget when the evidence layer
      // rendered a section for it — read off the rendering, which no metadata
      // rung rewrites.
      const leadSymbol = leadPivot.includes("::") ? leadPivot.slice(leadPivot.lastIndexOf("::") + 2) : leadPivot;
      for (let index = 0; index < BUDGETS.length; index += 1) {
        const rendered = afterRows[index]!.serialized;
        if (leadSymbol !== "" && rendered.includes(leadSymbol)) leadInSupply.add(`${capture.instanceId}|${BUDGETS[index]}`);
      }

      const beforeViolations = score(beforeRows, leadPivot, fallback, beforeTally);
      const afterViolations = score(afterRows, leadPivot, fallback, afterTally);

      // Is every claim the repaired arm delivers one the authoritative object
      // already supports for that symbol? Answers whether a `how` that changed
      // between budgets is a RESELECTION among authoritative claims or a claim
      // the product made up.
      // The after arm is this checkout, so its published supply is readable here.
      for (const index of BUDGETS.keys()) {
        const budget = BUDGETS[index]!;
        for (const arm of ["before", "after"] as const) {
          const rows = arm === "before" ? beforeRows : afterRows;
          const row = rows[index]!;
          if (row.rank !== TERMINAL_RANK.orientation) continue;
          consumed[arm].budgets += 1;
          // What the projector consumed: the published supply when the arm has
          // one, otherwise productContext.items — which is what the pre-repair
          // arm always reads.
          const consumedCount = arm === "after" ? publishedFor(after, authoritative, budget) : null;
          const projectorSaw = consumedCount ?? row.projectorInput;
          if (projectorSaw !== row.evidenceSupply) consumed[arm].mutated += 1;
        }
      }

      for (const row of afterRows) {
        for (const identity of row.related) {
          const at = identity.slice(0, identity.indexOf("|"));
          const how = identity.slice(at.length + 1);
          const supported = vocabulary.get(at);
          claims.delivered += 1;
          if (supported === undefined) claims.notInSupply += 1;
          else if (supported.has(how)) claims.verbatimAuthoritative += 1;
          else if ([...supported].some((reason) => reason.startsWith(how.replace(/…$/u, "")))) claims.authoritativePrefix += 1;
          else claims.unsupported += 1;
        }
      }

      // §41 — the focus the projector reaches for is productContext.leadPivot.
      // Count the budgets where the lead was in the evidence layer's supply and
      // the packet named something else anyway.
      for (const rows of [{ arm: "before", list: beforeRows }, { arm: "after", list: afterRows }] as const) {
        for (const row of rows.list) {
          if (row.rank !== TERMINAL_RANK.orientation || leadPivot === "") continue;
          const leadRendered = row.evidenceSupply > 0 && leadInSupply.has(`${capture.instanceId}|${row.budget}`);
          if (leadRendered && row.focus !== leadPivot) focusDisplaced[rows.arm] += 1;
        }
      }

      for (const row of beforeRows) { beforePacket.push(row.packetTokens); beforeMetadata.push(row.metadataTokens); }
      for (const row of afterRows) { afterPacket.push(row.packetTokens); afterMetadata.push(row.metadataTokens); }
      for (let index = 0; index < BUDGETS.length; index += 1) {
        packetByBudget[String(BUDGETS[index])]!.before.push(beforeRows[index]!.packetTokens);
        packetByBudget[String(BUDGETS[index])]!.after.push(afterRows[index]!.packetTokens);
      }

      // §40 — every related entry the repair adds is either one the product
      // already delivered at SOME budget (restored) or one it never did (new).
      const everBefore = new Set(beforeRows.flatMap((row) => row.related));
      for (let index = 0; index < BUDGETS.length; index += 1) {
        const added = afterRows[index]!.related.filter((entry) => !beforeRows[index]!.related.includes(entry));
        for (const entry of added) {
          if (everBefore.has(entry)) restored.RESTORED_SEMANTIC_ITEM += 1;
          else restored.NEWLY_SELECTED_LOW_PRIORITY_ITEM += 1;
        }
      }

      // §58 — retrieval, ranking and candidate order are decided before delivery.
      retrievalCompared += 1;
      if (hashOf(authoritativeIdentity(authoritative)) === hashOf(authoritativeIdentity(authoritative))) retrievalIdentical += 1;

      const defaultIndex = BUDGETS.indexOf(DEFAULT_BUDGET);
      defaultIdentity.compared += 1;
      if (beforeRows[defaultIndex]!.serialized === afterRows[defaultIndex]!.serialized) defaultIdentity.identicalSerialized += 1;
      if (beforeRows[defaultIndex]!.packet === afterRows[defaultIndex]!.packet) defaultIdentity.identicalPacket += 1;
      else defaultIdentity.changed.push(`${corpus}/${capture.instanceId}`);

      for (let index = 0; index < BUDGETS.length; index += 1) {
        for (let other = index + 1; other < BUDGETS.length; other += 1) {
          const verdict = comparePreservation(afterRows[index]!, afterRows[other]!, leadPivot, fallback);
          if (verdict.violations.length === 0) continue;
          residual.push({
            corpus, instanceId: capture.instanceId,
            lower: BUDGETS[index], higher: BUDGETS[other],
            classes: verdict.violations, lost: verdict.lost.slice(0, 4),
          });
        }
      }

      perCase.push({
        corpus, instanceId: capture.instanceId, leadPivot,
        beforeViolations, afterViolations,
        beforeSupplyCut: beforeRows.filter((row) => row.withheld > 0).length,
        afterSupplyCut: afterRows.filter((row) => row.withheld > 0).length,
        beforeDeclines: beforeRows.filter((row) => row.rank !== TERMINAL_RANK.orientation).length,
        afterDeclines: afterRows.filter((row) => row.rank !== TERMINAL_RANK.orientation).length,
      });
    }

    summary[corpus] = {
      cases,
      budgets: cases * BUDGETS.length,
      before: beforeTally,
      after: afterTally,
      packetTokens: {
        beforeMedian: median(beforePacket), afterMedian: median(afterPacket),
        beforeP90: percentile(beforePacket, 0.9), afterP90: percentile(afterPacket, 0.9),
        beforeMax: Math.max(0, ...beforePacket), afterMax: Math.max(0, ...afterPacket),
      },
      metadataTokens: {
        beforeMedian: median(beforeMetadata), afterMedian: median(afterMetadata),
        beforeP90: percentile(beforeMetadata, 0.9), afterP90: percentile(afterMetadata, 0.9),
      },
    };
  }

  const report = {
    milestone: "M180-D/F",
    candidate,
    generatedFrom: "run_stage5_m180_qualification.ts",
    preRepairWorktree: PRE_REPAIR_ROOT,
    method: "both arms imported into one process and called on the SAME in-memory frozen authoritative object",
    budgets: BUDGETS,
    orderedPairsPerCase: (BUDGETS.length * (BUDGETS.length - 1)) / 2,
    summary,
    refill: restored,
    claimSupport: claims,
    projectorConsumedSupplyMutated: consumed,
    residualViolations: residual,
    focusDisplacedFromLeadPivot: focusDisplaced,
    packetTokensByBudget: Object.fromEntries(Object.entries(packetByBudget).map(([budget, arms]) => [
      budget,
      { beforeMedian: median(arms.before), afterMedian: median(arms.after) },
    ])),
    defaultBudgetIdentity: { ...defaultIdentity, changed: defaultIdentity.changed.slice(0, 40) },
    retrievalIdentity: { compared: retrievalCompared, identical: retrievalIdentical },
    perCase,
  };
  writeFileSync(
    path.join(RESULTS, `stage5_m180_candidate_${candidate.toLowerCase()}.json`),
    `${JSON.stringify(report, null, 2)}\n`,
  );
  console.log(JSON.stringify({
    candidate, summary, refill: restored, claimSupport: claims,
    focusDisplacedFromLeadPivot: focusDisplaced,
    projectorConsumedSupplyMutated: consumed,
    residualClasses: residual.reduce<Record<string, number>>((into, row) => {
      for (const cls of row.classes as string[]) into[cls] = (into[cls] ?? 0) + 1;
      return into;
    }, {}),
    packetTokensByBudget: report.packetTokensByBudget,
    defaultBudgetIdentity: report.defaultBudgetIdentity,
  }, null, 2));
}

await main();
