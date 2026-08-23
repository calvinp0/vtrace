/**
 * M174-D — what actually happened in the expensive treatment runs.
 *
 *   bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m174_tail_audit.ts
 *
 * Two pairs carry 62.8% of the whole positive premium. M173 could see that and
 * could not explain it; §41 and §42 required each to be reconstructed rather than
 * characterised, because a two-case tail is exactly where a narrative will fit
 * whatever it is asked to fit.
 *
 * The tail is selected MECHANICALLY (§39) from the paired cost deltas before any
 * trace is read, and each case is then classified against evidence rather than
 * chronology (§31).
 *
 * The omitted-context test (§43) is the one that could have licensed product work:
 * information the treatment needed later, which the authoritative state HELD and
 * the compact packet did not show, and which the baseline had before it edited.
 * It is applied to every pair, not only the tail.
 *
 * Offline. No agent, no Docker, no paid API.
 */

import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { ActionKind } from "./m169Economics";
import { EditClass, Mechanism, normalizePath } from "./m174Traces";
import { RESULTS, m173Labels, rawDirOf, reconstruct, type Reconstructed } from "./m174Reconstruct";

const ROOT = path.resolve(".");

const economics = JSON.parse(
  readFileSync(path.join(RESULTS, "stage5_m174_economic_reconciliation.json"), "utf8"),
) as {
  tailConcentration: { tail: string[]; rule: string; shareTop1: number; shareTop2: number; shareTop3: number };
  rows: Record<string, any>[];
};
const pairwise = JSON.parse(
  readFileSync(path.join(RESULTS, "stage5_m174_pairwise_information.json"), "utf8"),
) as { pairs: Record<string, any>[] };

const loaded = new Map<string, Reconstructed>();
for (const label of m173Labels()) {
  const entry = reconstruct(label);
  if (entry !== null) loaded.set(label, entry);
}

// ── first-edit content divergence ───────────────────────────────────

function firstRepoEditContent(entry: Reconstructed): string | null {
  for (const use of entry.uses) {
    if (use.name !== "Edit" && use.name !== "Write" && use.name !== "MultiEdit") continue;
    const raw = typeof use.input.file_path === "string" ? use.input.file_path : "";
    if (!normalizePath(raw).inRepo) continue;
    const added = typeof use.input.new_string === "string" ? use.input.new_string
      : typeof use.input.content === "string" ? use.input.content : null;
    return added;
  }
  return null;
}

/**
 * How much of one arm's first edit the other arm also wrote.
 *
 * Two agents fixing the same bug the same way write substantially the same lines.
 * Two agents choosing different repairs do not — and that difference is
 * IMPLEMENTATION_STRATEGY_DIVERGENCE (§32), which a shared patch FILE set hides:
 * astropy's arms both patch `astropy/units/format/cds.py` and disagree completely
 * about what the grammar rule should be.
 */
function editOverlap(a: string | null, b: string | null): number | null {
  if (a === null || b === null) return null;
  const norm = (s: string): Set<string> =>
    new Set(s.split("\n").map((l) => l.trim()).filter((l) => l.length >= 8));
  const left = norm(a); const right = norm(b);
  if (left.size === 0 || right.size === 0) return null;
  const shared = [...left].filter((l) => right.has(l)).length;
  return shared / Math.max(left.size, right.size);
}

// ── environment friction ────────────────────────────────────────────

const FRICTION = /command not found|No such file or directory|ModuleNotFoundError|No space left|ENOSPC|Disk quota|Creating virtual environment|error: |Exit code (1|2|127)/;

/**
 * Requests spent fighting the toolchain rather than the repository.
 *
 * This is not a judgement about the agent. The external harness runs each task in
 * a freshly cloned repository with no guaranteed interpreter, and whether `pip`
 * exists on PATH is not a property of the orientation under test. M173 already
 * lost four baseline arms to `ENOSPC` on the same tmpfs. Counting it separately is
 * what keeps infrastructure variance from being attributed to the product.
 */
function environmentFriction(entry: Reconstructed): { requests: number; failures: number; venvRebuilds: number } {
  const requests = new Set<number>();
  let failures = 0; let venvRebuilds = 0;
  for (const use of entry.uses) {
    const command = typeof use.input.command === "string" ? use.input.command : "";
    const result = use.resultText;
    if (/rm -rf .*\.venv|uv run --with/.test(command)) venvRebuilds += 1;
    if (FRICTION.test(result)) {
      failures += 1;
      requests.add(use.requestIndex);
    }
    if (/pip install|which python|uv run|\.venv|virtualenv|conda/.test(command)) requests.add(use.requestIndex);
  }
  return { requests: requests.size, failures, venvRebuilds };
}

// ── omitted-context test (§43) ──────────────────────────────────────

/**
 * Did the compact packet withhold something the treatment later had to go and get,
 * which the baseline knew before it edited?
 *
 * All five conditions must hold before `COMPACT_ORIENTATION_OMISSION_CAUSAL` may
 * be written down. The one this evidence can decide is whether the information was
 * DISPLACED and whether its file was one the packet named: a file the packet
 * already pointed at was not omitted, whatever the agent did with it afterwards.
 */
function omittedContext(pair: Record<string, any>, treatment: Reconstructed): Record<string, unknown> {
  const displaced = (pair.information.displacedKeys ?? []) as string[];
  const named = new Set<string>([
    ...(treatment.orientation.focusFile === null ? [] : [treatment.orientation.focusFile]),
    ...treatment.orientation.relatedFiles,
  ]);
  const pathOf = (key: string): string => (key.split(":")[1] ?? "").split("@")[0] ?? "";
  const inPacket = displaced.filter((k) => named.has(pathOf(k)));
  const notInPacket = displaced.filter((k) => !named.has(pathOf(k)));
  return {
    displacedUnits: displaced.length,
    displacedInFilesThePacketNamed: inPacket.length,
    displacedInFilesThePacketDidNotName: notInPacket.length,
    candidateOmittedFiles: [...new Set(notInPacket.map(pathOf))].filter((p) => p !== ""),
    verdict: displaced.length === 0
      ? "NO_DISPLACEMENT_TO_EXPLAIN"
      : notInPacket.length === 0
        ? "DISPLACED_BUT_PACKET_NAMED_IT"
        : "CANDIDATE_OMISSION",
  };
}

// ── mechanism classification (§30, §31) ─────────────────────────────

/**
 * One primary mechanism per pair, from evidence, in a fixed order.
 *
 * The order encodes what counts as an explanation. Displacement is tested first
 * because it is the hypothesis with a product consequence; divergence next
 * because a different repair explains a different cost without any orientation
 * defect; environment friction before "stochastic" because "we could not explain
 * it" should not absorb a case whose transcript shows ten requests of `uv run`.
 */
function classify(pair: Record<string, any>, row: Record<string, any>, treatment: Reconstructed, overlap: number | null, friction: { requests: number; failures: number; venvRebuilds: number }): {
  mechanism: string; secondary: string[]; because: string;
} {
  const secondary: string[] = [];
  const displaced = pair.information.displacedStrong as number;
  const rate = pair.information.displacementRate as number;
  const treatmentOnly = pair.information.treatmentOnlyAgentAcquired as number;
  const eliminated = pair.information.eliminatedStrong as number;

  if (pair.censored) return { mechanism: Mechanism.NotMeasurable, secondary, because: "M173 censored an arm of this pair" };

  if (friction.requests >= 5) secondary.push("ENVIRONMENT_FRICTION");
  if (overlap !== null && overlap < 0.5) secondary.push("DIFFERENT_REPAIR");
  if (eliminated > 0) secondary.push("PRE_EDIT_WORK_ELIMINATED");

  // §31: displacement needs concrete matching units, not a chronology.
  if (displaced >= 5 && rate >= 0.15) {
    return { mechanism: Mechanism.WorkDisplacement, secondary, because: `${displaced} strong units crossed the edit boundary (${(rate * 100).toFixed(0)}% of the baseline's pre-edit knowledge)` };
  }
  if (overlap !== null && overlap < 0.5 && (row.costRatio ?? 1) > 1.25) {
    return { mechanism: Mechanism.ImplementationDivergence, secondary, because: `the arms' first repo edits share only ${(overlap * 100).toFixed(0)}% of their lines; the treatment implemented a different repair` };
  }
  if (treatmentOnly >= 10 && (row.costRatio ?? 1) > 1.25) {
    return { mechanism: Mechanism.OrientationInducedDownstream, secondary, because: `${treatmentOnly} strong units acquired only by the treatment` };
  }
  if (eliminated > 0 && (row.costRatio ?? 1) <= 1.25) {
    return { mechanism: Mechanism.WorkElimination, secondary, because: `${eliminated} strong units the baseline acquired and the treatment never needed, at no cost premium` };
  }
  if (friction.requests >= 5 && (row.costRatio ?? 1) > 1.25) {
    return { mechanism: Mechanism.StochasticOrUnattributable, secondary, because: `${friction.requests} requests spent on interpreter/venv/disk friction, ${friction.venvRebuilds} environment rebuilds — not repository work` };
  }
  return { mechanism: Mechanism.StochasticOrUnattributable, secondary, because: "no displacement, no divergent repair, no orientation-traceable extra work" };
}

// ── build ───────────────────────────────────────────────────────────

const audited = pairwise.pairs.map((pair) => {
  const instanceId = pair.instanceId as string;
  const a = loaded.get(`m173_baseline_${instanceId}`);
  const b = loaded.get(`m173_vtrace_compact_${instanceId}`);
  const row = economics.rows.find((r) => r.instanceId === instanceId) ?? {};
  if (a === undefined || b === undefined) return { instanceId, mechanism: Mechanism.NotMeasurable };

  const overlap = editOverlap(firstRepoEditContent(a), firstRepoEditContent(b));
  const frictionA = environmentFriction(a);
  const frictionB = environmentFriction(b);
  const verdict = classify(pair, row, b, overlap, frictionB);

  return {
    instanceId,
    isTail: economics.tailConcentration.tail.includes(instanceId),
    mechanism: verdict.mechanism,
    secondary: verdict.secondary,
    because: verdict.because,
    costDeltaUsd: row.costDeltaUsd ?? null,
    costRatio: row.costRatio ?? null,
    deltaPreEdit: row.deltaPreEdit ?? null,
    deltaImplementation: row.deltaImplementation ?? null,
    deltaVerification: row.deltaVerification ?? null,
    firstEditOverlap: overlap === null ? null : Number(overlap.toFixed(3)),
    environmentFrictionA: frictionA,
    environmentFrictionB: frictionB,
    orientationFocusFile: b.orientation.focusFile,
    orientationUsedByFirstEdit: b.orientation.focusFile !== null
      && (pair.firstEdit?.bPath ?? null) === b.orientation.focusFile,
    omittedContext: omittedContext(pair, b),
    displacedStrong: pair.information.displacedStrong,
    eliminatedStrong: pair.information.eliminatedStrong,
    treatmentOnlyAgentAcquired: pair.information.treatmentOnlyAgentAcquired,
  };
});

const tally: Record<string, number> = {};
for (const row of audited) tally[String(row.mechanism)] = (tally[String(row.mechanism)] ?? 0) + 1;

const report = {
  schemaVersion: "stage5.m174.tail-audit.v1",
  milestone: "M174", workstream: "M174-D",
  tailRule: economics.tailConcentration.rule,
  tail: economics.tailConcentration.tail,
  tailShare: {
    top1: economics.tailConcentration.shareTop1,
    top2: economics.tailConcentration.shareTop2,
    top3: economics.tailConcentration.shareTop3,
  },
  mechanismTally: tally,
  uniformLabelCheck: {
    rule: "§67 — a single label across all twelve is a detector smell until validated",
    distinctMechanisms: Object.keys(tally).length,
    pass: Object.keys(tally).length > 1,
  },
  omittedContextSummary: {
    pairsWithCandidateOmission: audited.filter((r) => (r.omittedContext as any)?.verdict === "CANDIDATE_OMISSION").length,
    pairsWithNoDisplacement: audited.filter((r) => (r.omittedContext as any)?.verdict === "NO_DISPLACEMENT_TO_EXPLAIN").length,
    note: "COMPACT_ORIENTATION_OMISSION_CAUSAL requires all five §43 conditions; a candidate is not a finding",
  },
  pairs: audited,
};

const target = path.join(RESULTS, "stage5_m174_tail_case_audit.json");
writeFileSync(target, `${JSON.stringify(report, null, 1)}\n`);
process.stdout.write(`wrote ${path.relative(ROOT, target)}\n\n`);

process.stdout.write("instance                        tail Δ$       mechanism                          overlap frictB because\n");
for (const r of audited as any[]) {
  process.stdout.write(
    `${String(r.instanceId).padEnd(30)} ${r.isTail ? " * " : "   "} `
    + `${String(r.costDeltaUsd?.toFixed(4) ?? "n/a").padStart(8)} ${String(r.mechanism).padEnd(34)} `
    + `${String(r.firstEditOverlap ?? "n/a").padStart(6)} ${String(r.environmentFrictionB?.requests ?? "-").padStart(5)}  ${r.because}\n`,
  );
}
process.stdout.write(`\ntally ${JSON.stringify(tally)}\n`);
process.stdout.write(`omitted-context: ${JSON.stringify(report.omittedContextSummary)}\n`);
