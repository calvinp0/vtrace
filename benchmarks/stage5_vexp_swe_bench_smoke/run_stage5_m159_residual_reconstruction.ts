/**
 * M159-A §12–§15 — rebuild the post-M158 residual population MECHANICALLY, from
 * the product's own build, rather than inheriting it from a milestone summary.
 *
 * M157 and M158 each corrected an inherited count (M157: the no-pivot population
 * was 2, not the framing's larger guess; M158: the support-loss population was 9
 * across 5 repos, not 8 across 6). Two corrections in two milestones is enough to
 * make recomputation the protocol rather than a courtesy. So this runner takes
 * only the immutable fixture and the pinned corpus, runs `buildCapsuleV2`, and
 * derives every bucket from the capsule the product actually returns.
 *
 * The bucket boundaries are deliberately EARLIEST-LOSS ordered, not
 * severity-ordered: a gold file that was delivered is delivered no matter what
 * else happened to its siblings, and a gold file with NO candidate at all is
 * `never_retrieved` regardless of which downstream rule would have rejected it.
 * That ordering is what makes the output a first-divergence input for M159-B
 * instead of a restatement of the delivery layer's opinion.
 *
 * Reads pinned, already-indexed workspaces. NO agent, NO Docker, NO network, NO
 * indexing, NO writes to any target workspace or index.
 */

import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import path from "node:path";

import { buildCapsuleV2 } from "../../src/capsuleV2/buildCapsuleV2";
import { openIndexerDatabase } from "../../src/db/sqlite";
import { CapsuleIntent } from "../../src/capsuleV2/types";
import type { CapsuleV2Result } from "../../src/capsuleV2/types";
// The scorer's own boundary-aware equivalence. NOT re-implemented here: the
// corpora are indexed at the package root, so `django/db/models/base.py` is a
// suffix of nothing under naive equality and a local matcher would report a
// perfectly plausible zero (M158 standing finding).
import { fileMatches, symbolMatches } from "./run_stage5_retrieval_eval";

/** The role layer's reason when support authority was granted and then collapsed. */
const GLOBAL_SUPPORT_COLLAPSE_REASON = "support-only: no actionable edit target";
/** The packer's reason when the item-count bound was already spent. */
const PACKED_OUT_PREFIX = /^beyond (\w+) support budget \(max (\d+)\)$/;
/** The packer's reason when the item fit the count but not the token envelope. */
const TOKEN_STARVED_REASON = "over budget: no room for this support item";

export type GoldFate =
  | "delivered_pivot"
  | "delivered_support"
  | "support_packed_out"
  | "support_token_starved"
  | "no_pivot_withheld"
  | "role_denied"
  | "never_retrieved";

/** The two residual populations M159 was convened to localize. */
export type ResidualGroup = "DEEP_RANKED_OR_PREDELIVERY_LOSS" | "NEVER_RETRIEVED_CAUSE_UNKNOWN";

export interface ReconstructionCase {
  readonly instanceId: string;
  readonly repo: string;
  readonly workspace: string;
  readonly task: string;
  readonly intent: string;
  readonly budget: number;
  readonly expectedFiles: readonly string[];
  readonly expectedSymbols: readonly string[];
}

/** One gold-file candidate, wherever in the capsule it ended up. */
export interface GoldCandidateRecord {
  readonly path: string;
  readonly symbol: string;
  readonly fqName: string;
  readonly kind: string;
  readonly finalScore: number;
  readonly isGoldSymbol: boolean;
  readonly placement: "pivot" | "support" | "discarded";
  /** 1-based position in `diagnostics.candidate_scores`, the pre-role order. */
  readonly ordinaryRank: number | null;
  readonly roleReason: string;
  readonly discardReason: string;
  readonly evidence: readonly string[];
}

export interface ReconstructionRow {
  readonly instanceId: string;
  readonly repo: string;
  readonly mode: string;
  readonly tier: string;
  readonly candidateCount: number;
  readonly deliveredPivots: number;
  readonly deliveredSupport: number;
  readonly goldFate: GoldFate;
  readonly residualGroup: ResidualGroup | null;
  readonly expectedFiles: readonly string[];
  readonly expectedSymbols: readonly string[];
  readonly goldFileCandidates: number;
  readonly goldSymbolCandidates: number;
  /** Best (lowest) ordinary rank any gold-file candidate reached, if any. */
  readonly bestGoldOrdinaryRank: number | null;
  readonly bestGoldScore: number | null;
  /** Every discard reason stamped on a gold candidate, deduped. */
  readonly goldDiscardReasons: readonly string[];
  readonly goldCandidates: readonly GoldCandidateRecord[];
}

/**
 * Assign the EARLIEST stage at which the gold file stopped being available.
 *
 * Order matters and is not negotiable. `never_retrieved` outranks every delivery
 * reason because a rule cannot reject what was never offered to it, and
 * `delivered_*` outranks every rejection because a delivered gold file is a
 * success even when three of its siblings were discarded. Both readings are the
 * ones M157 and M158 had to correct their inherited numbers back to.
 */
export function classifyGoldFate(gold: readonly GoldCandidateRecord[]): GoldFate {
  if (gold.length === 0) return "never_retrieved";
  if (gold.some((c) => c.placement === "pivot")) return "delivered_pivot";
  if (gold.some((c) => c.placement === "support")) return "delivered_support";
  if (gold.some((c) => PACKED_OUT_PREFIX.test(c.discardReason))) return "support_packed_out";
  if (gold.some((c) => c.discardReason === TOKEN_STARVED_REASON)) return "support_token_starved";
  if (gold.some((c) => c.discardReason === GLOBAL_SUPPORT_COLLAPSE_REASON)) return "no_pivot_withheld";
  return "role_denied";
}

const RESIDUAL_GROUPS: Partial<Record<GoldFate, ResidualGroup>> = {
  support_packed_out: "DEEP_RANKED_OR_PREDELIVERY_LOSS",
  never_retrieved: "NEVER_RETRIEVED_CAUSE_UNKNOWN",
};

export function reconstructCase(kase: ReconstructionCase): ReconstructionRow {
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

  // The pre-role order, keyed so a placed item can report the rank it held
  // BEFORE any lane reordered it. Keyed on fq_name where the diagnostic carries
  // one, else on path::symbol — the discarded records carry no fq_name.
  const ordinaryRankByKey = new Map<string, number>();
  for (const entry of result.diagnostics.candidate_scores ?? []) {
    const rank = entry.rank;
    for (const key of [entry.fq_name, `${entry.path}::${entry.symbol}`]) {
      if (key !== undefined && key !== "" && !ordinaryRankByKey.has(key)) ordinaryRankByKey.set(key, rank);
    }
  }

  const goldSymbolIn = (filePath: string, symbol: string, fqName: string): boolean =>
    kase.expectedFiles.some((f) => fileMatches(f, filePath))
    && kase.expectedSymbols.some((s) => symbolMatches(s, { symbol, fqName }));

  const gold: GoldCandidateRecord[] = [];
  const collect = (
    items: readonly {
      path: string; symbol: string; kind: string; evidence: readonly string[];
      scorecard: { final: number }; fq_name?: string; role_reason?: string; discard_reason?: string;
    }[],
    placement: GoldCandidateRecord["placement"],
  ): void => {
    for (const item of items) {
      if (!kase.expectedFiles.some((f) => fileMatches(f, item.path))) continue;
      const fqName = item.fq_name ?? "";
      gold.push({
        path: item.path,
        symbol: item.symbol,
        fqName,
        kind: item.kind,
        finalScore: item.scorecard.final,
        isGoldSymbol: goldSymbolIn(item.path, item.symbol, fqName),
        placement,
        ordinaryRank: ordinaryRankByKey.get(fqName) ?? ordinaryRankByKey.get(`${item.path}::${item.symbol}`) ?? null,
        roleReason: item.role_reason ?? "",
        discardReason: item.discard_reason ?? "",
        evidence: [...item.evidence],
      });
    }
  };
  collect(result.pivots, "pivot");
  collect(result.support, "support");
  collect(result.discarded, "discarded");

  const goldFate = classifyGoldFate(gold);
  const ranked = gold.map((c) => c.ordinaryRank).filter((r): r is number => r !== null);
  const scores = gold.map((c) => c.finalScore);

  return {
    instanceId: kase.instanceId,
    repo: kase.repo,
    mode: result.actual_mode,
    tier: result.diagnostics.tier,
    candidateCount: result.diagnostics.candidate_count,
    deliveredPivots: result.pivots.length,
    deliveredSupport: result.support.length,
    goldFate,
    residualGroup: RESIDUAL_GROUPS[goldFate] ?? null,
    expectedFiles: [...kase.expectedFiles],
    expectedSymbols: [...kase.expectedSymbols],
    goldFileCandidates: gold.length,
    goldSymbolCandidates: gold.filter((c) => c.isGoldSymbol).length,
    bestGoldOrdinaryRank: ranked.length === 0 ? null : Math.min(...ranked),
    bestGoldScore: scores.length === 0 ? null : Math.max(...scores),
    goldDiscardReasons: [...new Set(gold.map((c) => c.discardReason).filter((r) => r !== ""))].sort(),
    goldCandidates: gold,
  };
}

/**
 * §14 — a path matcher that silently reports zero is worse than one that throws.
 * These controls are run on EVERY invocation and the artifact is refused if any
 * fails, so a future refactor of `fileMatches` cannot quietly re-invert an
 * M159 conclusion the way it nearly inverted M157-A's.
 */
export interface PathControl {
  readonly name: string;
  readonly expected: string;
  readonly candidate: string;
  readonly want: boolean;
  readonly got: boolean;
  readonly naiveEquality: boolean;
  readonly pass: boolean;
}

export function runPathControls(): readonly PathControl[] {
  const cases: readonly { name: string; expected: string; candidate: string; want: boolean }[] = [
    // POSITIVE: the package-root case the whole audit depends on.
    { name: "package_root_stripped", expected: "django/db/models/base.py", candidate: "db/models/base.py", want: true },
    { name: "package_root_stripped_nested", expected: "sympy/core/numbers.py", candidate: "core/numbers.py", want: true },
    { name: "identical_path", expected: "lib/matplotlib/axes/_axes.py", candidate: "lib/matplotlib/axes/_axes.py", want: true },
    // NEGATIVE: a suffix that is not a PATH-BOUNDARY suffix must not match, or
    // the audit would count `.../models/base.py` as `.../notbase.py`.
    { name: "non_boundary_suffix", expected: "django/db/models/base.py", candidate: "db/models/notbase.py", want: false },
    { name: "same_leaf_other_tree", expected: "django/db/models/base.py", candidate: "contrib/gis/base.py", want: false },
    { name: "unrelated_file", expected: "sphinx/ext/autodoc/__init__.py", candidate: "sphinx/util/inspect.py", want: false },
  ];
  return cases.map((c) => {
    const got = fileMatches(c.expected, c.candidate);
    return { ...c, got, naiveEquality: c.expected === c.candidate, pass: got === c.want };
  });
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

function stableHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
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
  const manifestPath = get("--manifest-out");
  const controlsPath = get("--controls-out");

  const controls = runPathControls();
  const failedControls = controls.filter((c) => !c.pass);
  await writeFile(controlsPath, `${JSON.stringify({
    schemaVersion: "stage5.m159.path-controls.v1",
    matcher: "run_stage5_retrieval_eval.fileMatches",
    controls,
    passed: controls.length - failedControls.length,
    failed: failedControls.length,
  }, null, 2)}\n`, "utf8");
  if (failedControls.length > 0) {
    throw new Error(`path matcher controls failed: ${failedControls.map((c) => c.name).join(", ")}`);
  }

  const fixture = (await Bun.file(fixturePath).json()) as readonly FixtureRow[];
  const rows: ReconstructionRow[] = [];
  const failures: { instanceId: string; error: string }[] = [];
  for (const entry of fixture) {
    try {
      rows.push(reconstructCase({
        instanceId: entry.instance_id,
        repo: entry.repo,
        workspace: path.join(corpusRoot, entry.instance_id),
        task: entry.task,
        intent: entry.intent,
        budget: entry.budget,
        expectedFiles: entry.expected_files,
        expectedSymbols: entry.expected_symbols,
      }));
    } catch (error) {
      failures.push({ instanceId: entry.instance_id, error: String(error) });
    }
  }

  const fates = [...new Set(rows.map((r) => r.goldFate))].sort();
  const counts = Object.fromEntries(fates.map((f) => [f, rows.filter((r) => r.goldFate === f).length]));
  const byFate = Object.fromEntries(fates.map((f) => [f, rows.filter((r) => r.goldFate === f).map((r) => r.instanceId).sort()]));

  const residual = rows.filter((r) => r.residualGroup !== null);
  const manifestEntries = residual
    .map((r) => ({
      instanceId: r.instanceId,
      repo: r.repo,
      group: r.residualGroup,
      goldFate: r.goldFate,
      expectedFiles: r.expectedFiles,
      expectedSymbols: r.expectedSymbols,
      goldFileCandidates: r.goldFileCandidates,
      goldSymbolCandidates: r.goldSymbolCandidates,
      bestGoldOrdinaryRank: r.bestGoldOrdinaryRank,
      bestGoldScore: r.bestGoldScore,
      candidateCount: r.candidateCount,
      mode: r.mode,
      tier: r.tier,
    }))
    .sort((a, b) => a.instanceId.localeCompare(b.instanceId));

  await writeFile(outPath, `${JSON.stringify({
    schemaVersion: "stage5.m159.gold-fate-reconstruction.v1",
    corpusRoot,
    fixture: fixturePath,
    cases: rows.length,
    failures,
    counts,
    byFate,
    rows,
  }, null, 2)}\n`, "utf8");

  await writeFile(manifestPath, `${JSON.stringify({
    schemaVersion: "stage5.m159.residual-manifest.v1",
    corpusRoot,
    fixture: fixturePath,
    totalCases: rows.length,
    residualCases: manifestEntries.length,
    groups: {
      DEEP_RANKED_OR_PREDELIVERY_LOSS: manifestEntries.filter((e) => e.group === "DEEP_RANKED_OR_PREDELIVERY_LOSS").length,
      NEVER_RETRIEVED_CAUSE_UNKNOWN: manifestEntries.filter((e) => e.group === "NEVER_RETRIEVED_CAUSE_UNKNOWN").length,
    },
    repos: [...new Set(manifestEntries.map((e) => e.repo))].sort(),
    entries: manifestEntries,
    manifestHash: stableHash(manifestEntries),
  }, null, 2)}\n`, "utf8");

  console.log(JSON.stringify({ counts, byFate, failures, residual: manifestEntries.length }, null, 2));
}

if (import.meta.main) {
  await main();
}
