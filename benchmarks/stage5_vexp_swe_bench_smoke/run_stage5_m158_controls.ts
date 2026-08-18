/**
 * M158-E §106–§109/§112 — the named preservation controls, measured rather than
 * asserted.
 *
 * M158 changes which candidates occupy the bounded support slots. That is a
 * narrow change, but "narrow" is a claim about the code, not about the output,
 * so the states earlier milestones fought for are re-measured directly:
 *
 *   `sphinx-9320`   — M157's pivot-slot refill must hold; a return to
 *                     `no_context` would mean the refill lost its slots again.
 *   `django-11740`  — the no-pivot capsule must be untouched. M157 deliberately
 *                     did NOT build support-only delivery, and a support-packing
 *                     change must not smuggle one in.
 *   `xarray-6599`   — M157's neutral role movement must stay non-harmful.
 *   `<module>`      — never a delivered item, in any role, anywhere (M140).
 *   index writes    — a read-only retrieval probe writes nothing (M152 §112).
 *
 * Reads pinned, already-indexed workspaces. NO Claude, NO Docker, NO agent run,
 * NO API calls, NO network, NO indexing, NO writes to the target.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import path from "node:path";

import { buildCapsuleV2 } from "../../src/capsuleV2/buildCapsuleV2";
import { openIndexerDatabase } from "../../src/db/sqlite";
import { CapsuleIntent } from "../../src/capsuleV2/types";
import type { CapsuleV2Result } from "../../src/capsuleV2/types";

/** The instances whose exact delivery state a prior milestone established. */
const NAMED_CONTROLS = [
  "sphinx-doc__sphinx-9320",
  "django__django-11740",
  "pydata__xarray-6599",
];

interface FixtureRow {
  readonly instance_id: string;
  readonly repo: string;
  readonly task: string;
  readonly intent: string;
  readonly budget: number;
}

function digestOf(file: string): string {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function stateOf(result: CapsuleV2Result) {
  return {
    mode: result.actual_mode,
    tier: result.diagnostics.tier,
    candidateCount: result.diagnostics.candidate_count,
    pivotCount: result.pivots.length,
    supportCount: result.support.length,
    discardedCount: result.discarded.length,
    estimatedTokens: result.budget.estimated_tokens,
    withinEnvelope: result.budget.estimated_tokens <= result.budget.max_tokens,
    leadPivot: result.pivots[0] === undefined
      ? null
      : `${result.pivots[0].path}::${result.pivots[0].symbol}`,
    supportIdentities: result.support.map((item) => `${item.path}::${item.symbol}`),
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
  const controls: Record<string, unknown> = {};
  let moduleDeliveries = 0;
  const moduleInstances: string[] = [];
  let indexWrites = 0;
  const indexWriteInstances: string[] = [];

  for (const row of fixture) {
    const workspace = path.join(corpusRoot, row.instance_id);
    const indexPath = path.join(workspace, ".vtrace", "index.sqlite");
    const named = NAMED_CONTROLS.includes(row.instance_id);
    // §112: hash the index around the read so "no writes" is measured, not
    // assumed. Only for the named controls — hashing 100 large indexes twice
    // would cost more than the check is worth.
    const before = named ? digestOf(indexPath) : undefined;

    const db = openIndexerDatabase(indexPath);
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

    if (named) {
      if (before !== digestOf(indexPath)) {
        indexWrites += 1;
        indexWriteInstances.push(row.instance_id);
      }
      controls[row.instance_id] = { repo: row.repo, ...stateOf(result) };
    }

    // §109: `<module>` is a structural graph node, never a delivered item.
    const delivered = [...result.pivots, ...result.support];
    if (delivered.some((item) => item.symbol === "<module>" || item.fq_name.endsWith("::<module>"))) {
      moduleDeliveries += 1;
      moduleInstances.push(row.instance_id);
    }
  }

  const artifact = {
    schemaVersion: "stage5.m158.controls.v1",
    label,
    corpusRoot,
    fixture: fixturePath,
    cases: fixture.length,
    namedControls: controls,
    moduleDeliveries: { count: moduleDeliveries, instances: moduleInstances },
    indexWritesDuringRetrieval: { count: indexWrites, instances: indexWriteInstances },
  };
  await writeFile(outPath, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
  console.log(JSON.stringify(artifact, null, 2));
}

if (import.meta.main) { await main(); }
