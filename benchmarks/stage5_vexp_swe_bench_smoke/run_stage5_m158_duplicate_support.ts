/**
 * M158-B/E — the duplicate-support population, its negative controls, and the
 * before/after evidence for the canonical delivered-identity rule.
 *
 * The M158-A audit rejected the milestone's central hypothesis: no bounded
 * packing rule recovers the gold that ranks past `max 4`. What it DID prove is
 * unrelated to gold — that a scarce support slot can be spent restating evidence
 * the capsule already delivered, because support renders signature-only and two
 * genuinely distinct candidates (a method overridden in four classes of one
 * file, a flag assigned in ten) then deliver byte-identical text.
 *
 * This runner measures that population, and it measures the NEGATIVE control in
 * the same pass: entries sharing a file AND a symbol name whose delivered text
 * DIFFERS. Those carry different facts and must survive. Reporting them together
 * is deliberate — a rule that deduped by `(file, symbol)` would look identical
 * on the positives and silently destroy the controls, so the two counts are the
 * only honest way to read the result.
 *
 * Reads pinned, already-indexed workspaces. NO Claude, NO Docker, NO agent run,
 * NO API calls, NO network, NO indexing, NO writes to the target.
 */

import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import path from "node:path";

import { buildCapsuleV2 } from "../../src/capsuleV2/buildCapsuleV2";
import { openIndexerDatabase } from "../../src/db/sqlite";
import { CapsuleIntent } from "../../src/capsuleV2/types";
import type { CapsuleV2Item, CapsuleV2Result } from "../../src/capsuleV2/types";
import { fileMatches } from "./run_stage5_retrieval_eval";

/** The reason the M158 rule stamps on a restatement it refused a slot to. */
const REDUNDANT_PREFIX = "redundant support: identical delivered evidence to ";

/**
 * What the model is actually shown for a support item. This is the identity the
 * product rule keys on, reproduced here so the benchmark measures the SAME
 * notion rather than a plausible-looking proxy (M157's standing finding: a
 * matcher that silently disagrees with the product is worse than none).
 */
function deliveredIdentity(item: CapsuleV2Item): string {
  return [item.path, item.content_mode, item.source ?? item.signature ?? item.symbol].join(" | ");
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

function analyse(result: CapsuleV2Result, row: FixtureRow) {
  const support = result.support;
  const identities = support.map(deliveredIdentity);

  // Positives: slots spent on evidence already delivered.
  const seen = new Set<string>();
  const duplicateSlots: string[] = [];
  for (let index = 0; index < support.length; index += 1) {
    const identity = identities[index]!;
    if (seen.has(identity)) duplicateSlots.push(`${support[index]!.path}::${support[index]!.symbol}`);
    seen.add(identity);
  }

  // Negative control: same file AND same symbol name, DIFFERENT delivered text.
  // A `(file, symbol)` dedupe would collapse these; the canonical-identity rule
  // must not.
  const byFileSymbol = new Map<string, string[]>();
  for (let index = 0; index < support.length; index += 1) {
    const key = `${support[index]!.path}::${support[index]!.symbol}`;
    byFileSymbol.set(key, [...(byFileSymbol.get(key) ?? []), identities[index]!]);
  }
  const distinctSameNameSlots = [...byFileSymbol.entries()]
    .filter(([, group]) => group.length > 1 && new Set(group).size === group.length)
    .map(([key]) => key);

  // Negative control: same FILE, distinct evidence. §34/§45 — these must all
  // survive, which is why no file-level rule is used.
  const filesWithMultipleDistinctSlots = [...new Set(
    support.map((item) => item.path).filter(
      (candidate, _index, all) => all.filter((other) => other === candidate).length > 1))];

  const goldDelivered = [...result.pivots, ...result.support].some(
    (item) => row.expected_files.some((expected) => fileMatches(expected, item.path)));

  return {
    instanceId: row.instance_id,
    repo: row.repo,
    supportCount: support.length,
    distinctDeliveredIdentities: new Set(identities).size,
    duplicateSlots,
    duplicateSlotCount: duplicateSlots.length,
    distinctSameNameSlots,
    filesWithMultipleDistinctSlots,
    goldDelivered,
    estimatedTokens: result.budget.estimated_tokens,
    supportTokens: support.reduce((sum, item) => sum + item.estimated_tokens, 0),
    withinEnvelope: result.budget.estimated_tokens <= result.budget.max_tokens,
    // Present only after the rule ships: what it actually refused, and to whom.
    redundantDiscards: result.discarded
      .filter((item) => item.discard_reason.startsWith(REDUNDANT_PREFIX))
      .map((item) => ({
        path: item.path,
        symbol: item.symbol,
        duplicateOf: item.discard_reason.slice(REDUNDANT_PREFIX.length),
      })),
    supportItems: support.map((item) => ({
      path: item.path,
      symbol: item.symbol,
      contentMode: item.content_mode,
      tokens: item.estimated_tokens,
      delivered: (item.source ?? item.signature ?? item.symbol).slice(0, 120),
    })),
  };
}

async function main(): Promise<void> {
  const argv = Bun.argv.slice(2);
  const get = (flag: string): string => {
    const index = argv.indexOf(flag);
    const value = index < 0 ? undefined : argv[index + 1];
    if (value === undefined) throw new Error(`${flag} is required.`);
    return value;
  };
  const fixturePath = get("--fixture");
  const corpusRoot = get("--corpus-root");
  const outPath = get("--out");
  const label = get("--label");

  const fixture = (await Bun.file(fixturePath).json()) as readonly FixtureRow[];
  const rows: ReturnType<typeof analyse>[] = [];
  const failures: Array<{ instanceId: string; error: string }> = [];
  for (const row of fixture) {
    const workspace = path.join(corpusRoot, row.instance_id);
    try {
      const db = openIndexerDatabase(path.join(workspace, ".vtrace", "index.sqlite"));
      let result: CapsuleV2Result;
      try {
        result = buildCapsuleV2({
          db,
          repoRoot: workspace,
          task: row.task,
          intent: row.intent as CapsuleIntent,
          maxTokens: row.budget,
        });
      } finally { db.close(); }
      rows.push(analyse(result, row));
    } catch (error) {
      failures.push({ instanceId: row.instance_id, error: String(error) });
    }
  }

  const positives = rows.filter((row) => row.duplicateSlotCount > 0);
  const sameNameControls = rows.filter((row) => row.distinctSameNameSlots.length > 0);
  const sameFileControls = rows.filter((row) => row.filesWithMultipleDistinctSlots.length > 0);
  const artifact = {
    schemaVersion: "stage5.m158.duplicate-support.v1",
    label,
    corpusRoot,
    fixture: fixturePath,
    cases: rows.length,
    failures,
    population: {
      casesWithDuplicateSlots: positives.length,
      duplicateSlotsWasted: positives.reduce((sum, row) => sum + row.duplicateSlotCount, 0),
      instances: positives.map((row) => row.instanceId),
      repos: [...new Set(positives.map((row) => row.repo))].sort(),
    },
    negativeControls: {
      // Same (file, symbol) but DIFFERENT delivered evidence: must be preserved.
      casesWithDistinctSameNameSupport: sameNameControls.length,
      instances: sameNameControls.map((row) => row.instanceId),
      slots: sameNameControls.flatMap((row) => row.distinctSameNameSlots),
      // Same file, distinct evidence: must be preserved (§34/§45).
      casesWithMultipleDistinctSlotsInOneFile: sameFileControls.length,
    },
    aggregates: {
      goldDelivered: rows.filter((row) => row.goldDelivered).length,
      withinEnvelope: rows.filter((row) => row.withinEnvelope).length,
      supportCountTotal: rows.reduce((sum, row) => sum + row.supportCount, 0),
      supportTokensTotal: rows.reduce((sum, row) => sum + row.supportTokens, 0),
      redundantDiscardsTotal: rows.reduce((sum, row) => sum + row.redundantDiscards.length, 0),
    },
    manifestHash: createHash("sha256").update(JSON.stringify(
      rows.map((row) => [row.instanceId, row.duplicateSlots, row.distinctSameNameSlots]))).digest("hex"),
    rows,
  };
  await writeFile(outPath, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({ ...artifact, rows: `<${rows.length} rows>` }, null, 2));
}

if (import.meta.main) { await main(); }
