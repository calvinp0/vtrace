/**
 * M158-A §19–§26 — reproduce the bounded support-packing decision EXACTLY and
 * record the evidence set it built, item by item, against the evidence it left
 * behind.
 *
 * M157 closed with a standing finding it deliberately did not act on: 8 of the
 * 100 broad cases lose the gold file to the discard reason `beyond <tier>
 * support budget (max N)`. The gold there is NOT role-denied — it earned support
 * authority and lost a packing SLOT. That is a set-selection question, and the
 * summary table cannot answer it, because it says only that gold ranked past the
 * cut. It does not say what the four winners were, whether they say four
 * different things or the same thing four times, or whether the omitted item
 * would even have fit.
 *
 * So this runner records the whole bounded decision: every packed winner in
 * selection order with its token cost and lane, every candidate pushed past the
 * bound in the order the packer rejected them, and the structural overlap
 * between them. It deliberately reports position IN THE PACKED ORDER rather
 * than ordinary rank — the two differ, because the co-edit, file-evidence,
 * path-completion and mechanism lanes all reorder support before the cut, and
 * an audit that read ordinary rank would be auditing a decision the product
 * does not make (§24).
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
// unless the boundary-aware rule is applied (M155 §8, M157 standing finding).
import { fileMatches, symbolMatches } from "./run_stage5_retrieval_eval";

/**
 * The reason the bounded packer stamps on a candidate it never rendered because
 * the item-count bound was already spent. Matched as a PREFIX because the tier
 * and the slot count are interpolated into it, and parsed for the bound itself —
 * the reason string is the only authoritative report of the effective bound,
 * which differs from the tier allocation whenever an anchored pivot-cap
 * exemption (M101) converted a support slot.
 */
const PACKED_OUT_PREFIX = /^beyond (\w+) support budget \(max (\d+)\)$/;

/** The reason the packer stamps when the item fit the COUNT but not the tokens. */
const TOKEN_STARVED_REASON = "over budget: no room for this support item";

interface TraceCase {
  readonly instanceId: string;
  readonly repo: string;
  readonly workspace: string;
  readonly task: string;
  readonly intent: string;
  readonly budget: number;
  readonly expectedFiles: readonly string[];
  readonly expectedSymbols: readonly string[];
}

interface GoldFlags {
  readonly isGoldFile: boolean;
  readonly isGoldSymbol: boolean;
}

/** A support item that WON a slot, as the model sees it. */
interface PackedItem extends GoldFlags {
  /** 1-based position in the packed support order (the model-visible order). */
  readonly slot: number;
  readonly path: string;
  readonly symbol: string;
  readonly fqName: string;
  readonly kind: string;
  readonly finalScore: number;
  readonly estimatedTokens: number;
  readonly contentMode: string;
  readonly roleReason: string;
  readonly evidence: readonly string[];
  /** Set only for a lane that selected the item beyond its ordinary ranking. */
  readonly selectionRole?: string;
  readonly ordinaryRank?: number;
}

/** A support-authorized candidate the bound pushed out, in rejection order. */
interface PackedOutItem extends GoldFlags {
  /**
   * 1-based position in the packed order. The first rejected item sits at
   * `bound + 1`: the packer walks one ordering and stops rendering once the
   * bound is spent, so rejection order IS packed order past the cut.
   */
  readonly position: number;
  readonly path: string;
  readonly symbol: string;
  readonly kind: string;
  readonly finalScore: number;
  readonly roleReason: string;
  readonly evidence: readonly string[];
  readonly discardReason: string;
}

export interface SupportPackingTrace {
  readonly instanceId: string;
  readonly repo: string;
  readonly task: string;
  readonly budget: number;
  readonly mode: string;
  readonly tier: string;
  /** The tier's nominal support allocation, before any slot conversion. */
  readonly allocatedMaxSupport: number;
  /** The bound the packer ACTUALLY enforced, read off its own reason string. */
  readonly effectiveBound: number | null;
  readonly pivots: readonly PackedItem[];
  readonly support: readonly PackedItem[];
  readonly packedOut: readonly PackedOutItem[];
  /** Support-authorized items rejected for TOKENS rather than item count. */
  readonly tokenStarved: readonly PackedOutItem[];
  readonly tokens: {
    readonly maxTokens: number;
    readonly estimated: number;
    readonly usedPercent: number;
    /** Headroom left inside the global envelope after the capsule was built. */
    readonly headroom: number;
  };
  readonly gold: {
    readonly expectedFiles: readonly string[];
    readonly expectedSymbols: readonly string[];
    readonly deliveredAsPivot: boolean;
    readonly deliveredAsSupport: boolean;
    /** 1-based packed position of the best-placed gold candidate past the cut. */
    readonly bestPackedOutPosition: number | null;
    readonly packedOutCount: number;
  };
}

function goldFlagsFor(kase: TraceCase, filePath: string, symbol: string, fqName: string): GoldFlags {
  const isGoldFile = kase.expectedFiles.some((f) => fileMatches(f, filePath));
  return {
    isGoldFile,
    // A gold SYMBOL only counts inside a gold FILE: a same-named helper
    // elsewhere is not the patched definition.
    isGoldSymbol: isGoldFile && kase.expectedSymbols.some((s) => symbolMatches(s, { symbol, fqName })),
  };
}

function toPackedItem(
  item: CapsuleV2Result["support"][number],
  slot: number,
  kase: TraceCase,
): PackedItem {
  return {
    slot,
    path: item.path,
    symbol: item.symbol,
    fqName: item.fq_name,
    kind: item.kind,
    finalScore: item.scorecard.final,
    estimatedTokens: item.estimated_tokens,
    contentMode: item.content_mode,
    roleReason: item.role_reason,
    evidence: [...item.evidence],
    ...(item.selection_role === undefined ? {} : { selectionRole: item.selection_role }),
    ...(item.ordinary_rank === undefined ? {} : { ordinaryRank: item.ordinary_rank }),
    ...goldFlagsFor(kase, item.path, item.symbol, item.fq_name),
  };
}

export function traceCase(kase: TraceCase): SupportPackingTrace {
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

  let effectiveBound: number | null = null;
  const packedOut: PackedOutItem[] = [];
  const tokenStarved: PackedOutItem[] = [];
  for (const item of result.discarded) {
    const bound = PACKED_OUT_PREFIX.exec(item.discard_reason);
    const starved = item.discard_reason === TOKEN_STARVED_REASON;
    if (bound === null && !starved) continue;
    if (bound !== null) effectiveBound = Number(bound[2]);
    const entry: PackedOutItem = {
      // Filled in below once the bound is known for the whole case.
      position: 0,
      path: item.path,
      symbol: item.symbol,
      kind: item.kind,
      finalScore: item.scorecard.final,
      roleReason: item.role_reason ?? item.discard_reason,
      evidence: [...item.evidence],
      discardReason: item.discard_reason,
      // A discarded record carries no fq_name, so gold-symbol matching runs on
      // the bare local name — the scorer does the same.
      ...goldFlagsFor(kase, item.path, item.symbol, ""),
    };
    (starved ? tokenStarved : packedOut).push(entry);
  }

  const base = effectiveBound ?? result.support.length;
  const positioned = packedOut.map((entry, index) => ({ ...entry, position: base + index + 1 }));
  const goldPastCut = positioned.filter((entry) => entry.isGoldFile);

  return {
    instanceId: kase.instanceId,
    repo: kase.repo,
    task: kase.task,
    budget: kase.budget,
    mode: result.actual_mode,
    tier: result.diagnostics.tier,
    allocatedMaxSupport: allocateBudget(kase.budget).maxSupport,
    effectiveBound,
    pivots: result.pivots.map((item, index) => toPackedItem(item, index + 1, kase)),
    support: result.support.map((item, index) => toPackedItem(item, index + 1, kase)),
    packedOut: positioned,
    tokenStarved: tokenStarved.map((entry, index) => ({ ...entry, position: base + index + 1 })),
    tokens: {
      maxTokens: result.budget.max_tokens,
      estimated: result.budget.estimated_tokens,
      usedPercent: result.budget.used_percent,
      headroom: result.budget.max_tokens - result.budget.estimated_tokens,
    },
    gold: {
      expectedFiles: [...kase.expectedFiles],
      expectedSymbols: [...kase.expectedSymbols],
      deliveredAsPivot: result.pivots.some((item) => goldFlagsFor(kase, item.path, item.symbol, item.fq_name).isGoldFile),
      deliveredAsSupport: result.support.some((item) => goldFlagsFor(kase, item.path, item.symbol, item.fq_name).isGoldFile),
      bestPackedOutPosition: goldPastCut[0]?.position ?? null,
      packedOutCount: goldPastCut.length,
    },
  };
}

/**
 * The population row (§19/§20). `supportPackedOut` is the M158 target bucket:
 * the gold file reached candidate generation, earned support authority, and lost
 * to the item-count bound. It is deliberately kept apart from `roleDenied`,
 * which M157 could only report as one combined bucket.
 */
function summarize(trace: SupportPackingTrace) {
  const goldDelivered = trace.gold.deliveredAsPivot || trace.gold.deliveredAsSupport;
  const goldPackedOut = !goldDelivered && trace.gold.packedOutCount > 0;
  return {
    instanceId: trace.instanceId,
    repo: trace.repo,
    mode: trace.mode,
    tier: trace.tier,
    effectiveBound: trace.effectiveBound,
    supportSelected: trace.support.length,
    packedOutCount: trace.packedOut.length,
    tokenStarvedCount: trace.tokenStarved.length,
    goldDelivered,
    goldDeliveredAsPivot: trace.gold.deliveredAsPivot,
    goldDeliveredAsSupport: trace.gold.deliveredAsSupport,
    /** The M158 primary population flag. */
    goldSupportPackedOut: goldPackedOut,
    goldBestPackedOutPosition: trace.gold.bestPackedOutPosition,
    goldPackedOutCount: trace.gold.packedOutCount,
    distinctSupportFiles: new Set(trace.support.map((item) => item.path)).size,
    supportTokens: trace.support.reduce((sum, item) => sum + item.estimatedTokens, 0),
    estimatedTokens: trace.tokens.estimated,
    headroom: trace.tokens.headroom,
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
  const only = argv.includes("--cases")
    ? new Set(get("--cases").split(",").map((id) => id.trim()).filter((id) => id !== ""))
    : undefined;
  const sweep = argv.includes("--sweep");

  const fixture = (await Bun.file(fixturePath).json()) as readonly FixtureRow[];
  const toCase = (entry: FixtureRow): TraceCase => ({
    instanceId: entry.instance_id,
    repo: entry.repo,
    workspace: path.join(corpusRoot, entry.instance_id),
    task: entry.task,
    intent: entry.intent,
    budget: entry.budget,
    expectedFiles: entry.expected_files,
    expectedSymbols: entry.expected_symbols,
  });

  const selected = fixture.filter((entry) => only === undefined || only.has(entry.instance_id));
  if (only !== undefined && selected.length !== only.size) {
    const found = new Set(selected.map((entry) => entry.instance_id));
    throw new Error(`instances not in fixture: ${[...only].filter((id) => !found.has(id)).join(", ")}`);
  }

  const traces: SupportPackingTrace[] = [];
  const failures: { instanceId: string; error: string }[] = [];
  for (const entry of selected) {
    try {
      traces.push(traceCase(toCase(entry)));
    } catch (error) {
      failures.push({ instanceId: entry.instance_id, error: String(error) });
    }
  }

  const rows = traces.map(summarize);
  const target = rows.filter((row) => row.goldSupportPackedOut);
  const artifact = {
    schemaVersion: "stage5.m158.support-packing.v1",
    corpusRoot,
    fixture: fixturePath,
    cases: rows.length,
    failures,
    population: {
      goldSupportPackedOut: target.length,
      repos: [...new Set(target.map((row) => row.repo))].sort(),
      instances: target.map((row) => row.instanceId).sort(),
      goldDelivered: rows.filter((row) => row.goldDelivered).length,
      goldDeliveredAsPivot: rows.filter((row) => row.goldDeliveredAsPivot).length,
      goldDeliveredAsSupport: rows.filter((row) => row.goldDeliveredAsSupport).length,
      casesWithPackedOutSupport: rows.filter((row) => row.packedOutCount > 0).length,
      casesWithTokenStarvedSupport: rows.filter((row) => row.tokenStarvedCount > 0).length,
    },
    rows,
    // Full traces only when a bounded case list was named: the sweep exists to
    // fix the population, and 100 whole traces would bury it.
    ...(sweep ? {} : { traces }),
  };
  await writeFile(outPath, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({ ...artifact, rows: `<${rows.length} rows>`, traces: `<${traces.length} traces>` }, null, 2));
}

if (import.meta.main) {
  await main();
}
