// Stage 5 M155-D — paired live-agent subset selection.
//
// WHY THIS SHAPE
// ---------------
// M155 §31-§34 require a subset frozen BEFORE live outcomes, selected only from
// pre-treatment metadata, stratified by repository and difficulty, and extensible
// to the full 100 without a second selection pass (§32).
//
// So this does not select 30 cases. It computes a deterministic stratified
// ORDERING of all 100, and the paired subset is a PREFIX of it. Any prefix is
// approximately repository- and difficulty-proportional, so extending from 30 to
// 100 means running the next 70 in a already-fixed order rather than choosing
// again after seeing results.
//
// Difficulty comes from SWE-bench Verified's own human-annotated `difficulty`
// field. It is pre-existing, treatment-independent, and not invented here — which
// matters because §34 forbids inventing a complexity metric after seeing the
// deterministic retrieval results, and §33 forbids conditioning on any VTRACE
// outcome (gold delivered/discarded/missing, Top-1, score).
//
// There is no random seed. The ordering is a pure function of the corpus and its
// metadata, so it is reproducible without recording one.

/** Ascending difficulty, as annotated by SWE-bench Verified. */
export const DIFFICULTY_ORDER: readonly string[] = [
  "<15 min fix",
  "15 min - 1 hour",
  "1-4 hours",
  ">4 hours",
];

export interface SelectionCase {
  readonly instance_id: string;
  readonly repo: string;
  readonly difficulty: string;
}

export interface OrderedCase extends SelectionCase {
  /** 1-based position in the frozen ordering. Prefix of length N = the paired-N set. */
  readonly order: number;
  readonly stratum: string;
}

function difficultyRank(difficulty: string): number {
  const index = DIFFICULTY_ORDER.indexOf(difficulty);
  // Unknown difficulties sort last but deterministically, rather than throwing and
  // making the whole selection depend on dataset vocabulary drift.
  return index < 0 ? DIFFICULTY_ORDER.length : index;
}

/**
 * Deterministic stratified ordering.
 *
 * Strata are (difficulty, repository). At each step the stratum with the largest
 * proportional DEFICIT — how far its emitted count has fallen behind its share of
 * what has been emitted so far — contributes its next case. Ties break on
 * difficulty rank, then repository name, then instance id, so the result depends on
 * nothing but the input.
 */
export function orderCases(cases: readonly SelectionCase[]): OrderedCase[] {
  const strata = new Map<string, { key: string; difficulty: string; repo: string; queue: string[] }>();
  for (const c of [...cases].sort((a, b) => a.instance_id.localeCompare(b.instance_id))) {
    const key = `${c.difficulty}|${c.repo}`;
    const existing = strata.get(key);
    if (existing === undefined) {
      strata.set(key, { key, difficulty: c.difficulty, repo: c.repo, queue: [c.instance_id] });
    } else {
      existing.queue.push(c.instance_id);
    }
  }

  const total = cases.length;
  const sizes = new Map([...strata].map(([key, s]) => [key, s.queue.length]));
  const emitted = new Map([...strata.keys()].map((key) => [key, 0]));
  const out: OrderedCase[] = [];

  for (let step = 0; step < total; step += 1) {
    const produced = step;
    let best: { key: string; deficit: number; difficulty: string; repo: string; id: string } | null = null;
    for (const [key, stratum] of strata) {
      if (stratum.queue.length === 0) continue;
      const share = (sizes.get(key)! / total) * produced;
      const deficit = share - emitted.get(key)!;
      const candidate = {
        key, deficit, difficulty: stratum.difficulty, repo: stratum.repo, id: stratum.queue[0]!,
      };
      if (best === null) { best = candidate; continue; }
      // Strictly ordered comparison: larger deficit, then larger stratum (so the
      // dominant strata are represented early), then easier difficulty, then repo,
      // then instance id.
      const better =
        candidate.deficit > best.deficit + 1e-12 ? true
        : Math.abs(candidate.deficit - best.deficit) <= 1e-12
          ? sizes.get(candidate.key)! !== sizes.get(best.key)!
            ? sizes.get(candidate.key)! > sizes.get(best.key)!
            : difficultyRank(candidate.difficulty) !== difficultyRank(best.difficulty)
              ? difficultyRank(candidate.difficulty) < difficultyRank(best.difficulty)
              : candidate.repo !== best.repo
                ? candidate.repo.localeCompare(best.repo) < 0
                : candidate.id.localeCompare(best.id) < 0
          : false;
      if (better) best = candidate;
    }
    if (best === null) break;
    const stratum = strata.get(best.key)!;
    const id = stratum.queue.shift()!;
    emitted.set(best.key, emitted.get(best.key)! + 1);
    // Take repo/difficulty from the STRATUM that owns this queue, never from an
    // instance-id lookup. An id lookup silently resolves a duplicate id to whichever
    // case was seen first, which mislabels the output and corrupts every downstream
    // proportionality check — and the mislabelling looks like a selection bug rather
    // than the identity collision it is.
    out.push({
      instance_id: id, repo: stratum.repo, difficulty: stratum.difficulty,
      order: out.length + 1, stratum: best.key,
    });
  }
  return out;
}

export interface StratumCoverage {
  readonly stratum: string;
  readonly corpusCases: number;
  readonly selectedCases: number;
  readonly corpusShare: number;
  readonly selectedShare: number;
}

export function coverage(ordered: readonly OrderedCase[], prefix: number, keyOf: (c: OrderedCase) => string): StratumCoverage[] {
  const selected = ordered.slice(0, prefix);
  const corpusCounts = new Map<string, number>();
  const selectedCounts = new Map<string, number>();
  for (const c of ordered) corpusCounts.set(keyOf(c), (corpusCounts.get(keyOf(c)) ?? 0) + 1);
  for (const c of selected) selectedCounts.set(keyOf(c), (selectedCounts.get(keyOf(c)) ?? 0) + 1);
  return [...corpusCounts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([stratum, corpusCases]) => ({
      stratum,
      corpusCases,
      selectedCases: selectedCounts.get(stratum) ?? 0,
      corpusShare: Math.round((corpusCases / ordered.length) * 10000) / 10000,
      selectedShare: Math.round(((selectedCounts.get(stratum) ?? 0) / Math.max(1, selected.length)) * 10000) / 10000,
    }));
}

/**
 * Arm order per task (§49). Alternating by position, so neither condition is
 * systematically run earlier and any environment/API drift over the run window is
 * spread across both arms instead of loading onto one.
 */
export function armOrder(order: number): readonly ["baseline", "vtrace"] | readonly ["vtrace", "baseline"] {
  return order % 2 === 1 ? ["baseline", "vtrace"] : ["vtrace", "baseline"];
}

// ---------------------------------------------------------------------------
// Manifest generation
// ---------------------------------------------------------------------------

/** M154 deterministic gold state, attached for ANALYSIS ONLY (§35). Never consumed
 *  by the ordering above — see the selection-independence test. */
export type GoldState = "GOLD_DELIVERED" | "GOLD_DISCOVERED_BUT_DISCARDED" | "GOLD_MISSING" | "UNKNOWN";

export function goldStateOf(role: string | undefined): GoldState {
  switch (role) {
    case "pivot":
    case "support":
      return "GOLD_DELIVERED";
    case "discarded":
      return "GOLD_DISCOVERED_BUT_DISCARDED";
    case "missing":
      return "GOLD_MISSING";
    default:
      return "UNKNOWN";
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const get = (flag: string): string => {
    const i = argv.indexOf(flag);
    if (i < 0 || argv[i + 1] === undefined) throw new Error(`${flag} is required.`);
    return argv[i + 1]!;
  };
  const { createHash } = await import("node:crypto");
  const { writeFile } = await import("node:fs/promises");

  const fixture = JSON.parse(await Bun.file(get("--fixture")).text()) as Array<{ instance_id: string; repo: string }>;
  const corpusIds = new Set(fixture.map((e) => e.instance_id));
  const prefix = Number.parseInt(get("--prefix"), 10);

  const difficulties = new Map<string, string>();
  for (const line of (await Bun.file(get("--dataset")).text()).split("\n")) {
    if (!line.trim()) continue;
    const row = JSON.parse(line) as { instance_id: string; difficulty?: string };
    if (corpusIds.has(row.instance_id)) difficulties.set(row.instance_id, row.difficulty ?? "unknown");
  }
  const missingDifficulty = [...corpusIds].filter((id) => !difficulties.has(id));
  if (missingDifficulty.length > 0) {
    throw new Error(`dataset lacks difficulty for ${missingDifficulty.length} corpus cases`);
  }

  const ledger = JSON.parse(await Bun.file(get("--case-ledger")).text()) as {
    cases: Array<{ instance_id: string; gold_file_role: string }>;
  };
  const roleById = new Map(ledger.cases.map((c) => [c.instance_id, c.gold_file_role]));

  const ordered = orderCases(fixture.map((e) => ({
    instance_id: e.instance_id, repo: e.repo, difficulty: difficulties.get(e.instance_id)!,
  })));
  const selected = ordered.slice(0, prefix);

  const cases = selected.map((c) => ({
    order: c.order,
    instance_id: c.instance_id,
    repo: c.repo,
    difficulty: c.difficulty,
    stratum: c.stratum,
    armOrder: armOrder(c.order),
    // Annotation only. Membership is already frozen by the ordering above.
    m154DeterministicGoldState: goldStateOf(roleById.get(c.instance_id)),
  }));

  const manifest = {
    schemaVersion: "stage5.m155.paired-manifest.v1",
    milestone: "M155-D",
    pairedSubsetSize: cases.length,
    broadCorpusSize: ordered.length,
    subsetOfBroadCorpus: true,
    extensionRule:
      "The ordering over all broad-corpus cases is frozen here. Extending to any larger N means running the "
      + "next cases in this same order; it is never a fresh selection (M155 §32).",
    selection: {
      method:
        "deterministic largest-deficit round robin over (difficulty, repository) strata; any prefix is "
        + "approximately proportional",
      seed: null,
      seedRationale: "none needed — the ordering is a pure function of the corpus and its metadata",
      difficultySource: "SWE-bench Verified human-annotated `difficulty` field (pre-existing, treatment-independent)",
      conditionedOnRetrievalOutcome: false,
      independenceNote:
        "Ordering consumes only instance id, repository and difficulty. Gold delivered/discarded/missing, Top-1 "
        + "and any VTRACE score are excluded (M155 §33), and a test asserts that adding them changes nothing.",
    },
    difficultyCoverage: coverage(ordered, prefix, (c) => c.difficulty),
    repositoryCoverage: coverage(ordered, prefix, (c) => c.repo),
    goldStateAnnotation: {
      note: "analysis-only cross-tab basis (§35/§60); did not affect membership",
      counts: cases.reduce<Record<string, number>>((acc, c) => {
        acc[c.m154DeterministicGoldState] = (acc[c.m154DeterministicGoldState] ?? 0) + 1;
        return acc;
      }, {}),
    },
    fullOrdering: ordered.map((c) => ({ order: c.order, instance_id: c.instance_id })),
    cases,
  };

  const body = JSON.stringify(manifest, null, 2);
  const hash = createHash("sha256").update(body).digest("hex");
  await writeFile(get("--out"), `${JSON.stringify({ ...manifest, manifestSha256: hash }, null, 2)}\n`);
  process.stdout.write(`paired-${prefix} frozen; manifestSha256=${hash.slice(0, 16)}\n`);
  for (const row of manifest.difficultyCoverage) {
    process.stdout.write(
      `  ${row.stratum.padEnd(20)} corpus ${String(row.corpusCases).padStart(3)} (${(row.corpusShare * 100).toFixed(0)}%)`
      + ` -> selected ${String(row.selectedCases).padStart(2)} (${(row.selectedShare * 100).toFixed(0)}%)\n`,
    );
  }
  process.stdout.write(`  gold-state annotation: ${JSON.stringify(manifest.goldStateAnnotation.counts)}\n`);
}

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}
