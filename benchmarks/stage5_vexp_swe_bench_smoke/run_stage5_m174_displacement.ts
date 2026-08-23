/**
 * M174-C — did the compact orientation eliminate repository work, or move it?
 *
 *   bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m174_displacement.ts
 *
 * M173 measured that the treatment's pre-edit investigation is CHEAPER and its
 * whole run is not. Two mechanisms produce that signature and they have opposite
 * product consequences:
 *
 *   ELIMINATION    the agent never needed the skipped work. The orientation
 *                  replaced it. Fewer pre-edit reads are a real saving.
 *   DISPLACEMENT   the agent needed it and did it later. Fewer pre-edit reads
 *                  are a rescheduling, and the premium is what rescheduling cost.
 *
 * A request count cannot tell them apart, which is why M173 could not answer it.
 * This can, by comparing WHAT was learned on either side of each arm's own first
 * meaningful edit (§21, §25).
 *
 * THRESHOLDS ARE INHERITED, NOT INVENTED (§54). M173 froze 0.8 / 1.25 as the
 * win / break-even ratio, itself inherited unchanged from M169. The same ratios
 * are applied here to whole-run cost. Authoring new thresholds after seeing the
 * cost deltas is how a null becomes a result.
 *
 * Offline. No agent, no Docker, no paid API.
 */

import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { ActionKind } from "./m169Economics";
import {
  EditClass, EditSurvival, Mechanism, TracePhase, comparePairInformation,
  firstEditSurvival, patchFiles, strengthOf,
} from "./m174Traces";
import {
  RESULTS, m173Labels, phaseCostsM174, rawDirOf, reconstruct,
  type Reconstructed,
} from "./m174Reconstruct";

const ROOT = path.resolve(".");

/** Inherited from M173, which inherited them from M169. Unchanged (§54). */
const ECONOMIC_THRESHOLDS = Object.freeze({ winAtOrBelow: 0.8, breakEvenAtOrBelow: 1.25 });

// ── authoritative outcome, from the harness result row ──────────────

interface Outcome {
  readonly resolved: boolean | null;
  readonly costUsd: number | null;
  readonly modelPatch: string;
}

function outcomeOf(label: string): Outcome {
  const dir = rawDirOf(label);
  if (dir === null) return { resolved: null, costUsd: null, modelPatch: "" };
  const file = readdirSync(dir).find((f) => f.startsWith("swebench-") && f.endsWith(".jsonl"));
  if (file === undefined) return { resolved: null, costUsd: null, modelPatch: "" };
  const first = readFileSync(path.join(dir, file), "utf8").trim().split("\n")[0] ?? "";
  try {
    const row = JSON.parse(first) as Record<string, unknown>;
    return {
      resolved: typeof row.resolved === "boolean" ? row.resolved : row.resolved === 1,
      costUsd: typeof row.costUsd === "number" ? row.costUsd : null,
      modelPatch: typeof row.modelPatch === "string" ? row.modelPatch : "",
    };
  } catch { return { resolved: null, costUsd: null, modelPatch: "" }; }
}

/** M173's censoring verdict, joined not recomputed. */
const m173Censoring = (() => {
  const file = path.join(RESULTS, "stage5_m173_paired_ledger.json");
  const out = new Map<string, string>();
  if (!existsSync(file)) return out;
  const ledger = JSON.parse(readFileSync(file, "utf8")) as { perRun: { label: string; censoring: string }[] };
  for (const row of ledger.perRun) out.set(row.label, row.censoring);
  return out;
})();

// ── information sets ────────────────────────────────────────────────

/** Keys known before the run's own first meaningful edit, orientation included. */
function preEditKeys(entry: Reconstructed, strongOnly: boolean): Set<string> {
  const first = entry.landmarks.firstMeaningfulEditRequest;
  const out = new Set<string>();
  const admit = (kind: string): boolean => !strongOnly || strengthOf(kind as never) === "STRONG";
  for (const unit of entry.units) {
    if (!admit(unit.kind)) continue;
    if (first === null || unit.requestIndex < first) out.add(unit.key);
  }
  // §28: the packet IS information the treatment arrived with.
  for (const unit of entry.orientation.units) {
    if (!admit(unit.kind)) continue;
    if (first === null || unit.requestIndex <= first) out.add(unit.key);
  }
  return out;
}

function postEditKeys(entry: Reconstructed, strongOnly: boolean): Set<string> {
  const first = entry.landmarks.firstMeaningfulEditRequest;
  const out = new Set<string>();
  if (first === null) return out;
  for (const unit of entry.units) {
    if (strongOnly && strengthOf(unit.kind as never) !== "STRONG") continue;
    if (unit.requestIndex >= first) out.add(unit.key);
  }
  return out;
}

/**
 * Keys the agent ACQUIRED BY ACTING, excluding what the packet handed it.
 *
 * Without this split, TREATMENT_ONLY is dominated by the orientation's own
 * conferred units and every treatment run looks like it did 11-23 units of extra
 * work it never performed. The §67 uniform-label check caught exactly that: on
 * eleven of twelve pairs the treatment-only count tracked the packet size, not
 * the agent's behaviour.
 */
function agentAcquiredKeys(entry: Reconstructed, strongOnly: boolean): Set<string> {
  const out = new Set<string>();
  for (const unit of entry.units) {
    if (strongOnly && strengthOf(unit.kind as never) !== "STRONG") continue;
    out.add(unit.key);
  }
  return out;
}

function allKeys(entry: Reconstructed, strongOnly: boolean): Set<string> {
  const out = new Set<string>();
  for (const unit of [...entry.units, ...entry.orientation.units]) {
    if (strongOnly && strengthOf(unit.kind as never) !== "STRONG") continue;
    out.add(unit.key);
  }
  return out;
}

// ── behaviour measures ──────────────────────────────────────────────

function firstMeaningfulEdit(entry: Reconstructed): { path: string | null; added: string | null; requestIndex: number | null } {
  for (const use of entry.uses) {
    const raw = typeof use.input.file_path === "string" ? use.input.file_path : null;
    if (raw === null) continue;
    const kind = use.name;
    if (kind !== "Edit" && kind !== "Write" && kind !== "MultiEdit") continue;
    if (path.isAbsolute(raw) && !raw.includes(".bench-repos")) continue;
    const added = typeof use.input.new_string === "string" ? use.input.new_string
      : typeof use.input.content === "string" ? use.input.content : null;
    const rel = raw.replace(/^.*?\.bench-repos\/[^/]+\//, "");
    return { path: rel, added, requestIndex: use.requestIndex };
  }
  return { path: null, added: null, requestIndex: null };
}

function testBehaviour(entry: Reconstructed): Record<string, number> {
  const first = entry.landmarks.firstMeaningfulEditRequest;
  let before = 0, after = 0, total = 0;
  const commands = new Set<string>();
  let repeats = 0;
  for (const action of entry.actions) {
    if (action.kind !== ActionKind.TestRun) continue;
    total += 1;
    if (first === null || action.requestIndex < first) before += 1; else after += 1;
    const signature = (action.query ?? "").slice(0, 120);
    if (commands.has(signature)) repeats += 1; else commands.add(signature);
  }
  return { total, before, after, repeats, distinct: commands.size };
}

function revisionBehaviour(entry: Reconstructed): Record<string, number> {
  const meaningful = entry.actions.filter((a) => a.editClass === EditClass.Meaningful);
  const scratch = entry.actions.filter((a) => a.editClass === EditClass.Scratch);
  const byFile = new Map<string, number>();
  for (const edit of meaningful) byFile.set(edit.targetPath ?? "", (byFile.get(edit.targetPath ?? "") ?? 0) + 1);
  return {
    meaningfulEdits: meaningful.length,
    scratchEdits: scratch.length,
    // Edits beyond the first to the SAME file: rework, not breadth.
    reworkEdits: [...byFile.values()].reduce((sum, n) => sum + Math.max(0, n - 1), 0),
    filesEdited: byFile.size,
  };
}

// ── the pair ────────────────────────────────────────────────────────

const labels = m173Labels();
const loaded = new Map<string, Reconstructed>();
for (const label of labels) {
  const entry = reconstruct(label);
  if (entry !== null) loaded.set(label, entry);
}

const instances = [...new Set([...loaded.values()].map((e) => e.instanceId))].sort();
const pairRows: Record<string, unknown>[] = [];

for (const instanceId of instances) {
  const a = loaded.get(`m173_baseline_${instanceId}`);
  const b = loaded.get(`m173_vtrace_compact_${instanceId}`);
  if (a === undefined || b === undefined) {
    pairRows.push({ instanceId, state: "NOT_COMPARABLE", detail: "missing arm" });
    continue;
  }

  const aOut = outcomeOf(a.label);
  const bOut = outcomeOf(b.label);
  const censored = m173Censoring.get(a.label) !== "UNCENSORED" || m173Censoring.get(b.label) !== "UNCENSORED";

  const strong = comparePairInformation(
    preEditKeys(a, true), allKeys(a, true),
    preEditKeys(b, true), postEditKeys(b, true), allKeys(b, true),
  );
  const all = comparePairInformation(
    preEditKeys(a, false), allKeys(a, false),
    preEditKeys(b, false), postEditKeys(b, false), allKeys(b, false),
  );

  const bAgentKeys = agentAcquiredKeys(b, true);

  const aEdit = firstMeaningfulEdit(a);
  const bEdit = firstMeaningfulEdit(b);
  const aSurvival = firstEditSurvival(aEdit.path, aEdit.added, aOut.modelPatch);
  const bSurvival = firstEditSurvival(bEdit.path, bEdit.added, bOut.modelPatch);

  const aFiles = patchFiles(aOut.modelPatch);
  const bFiles = patchFiles(bOut.modelPatch);
  const sharedFiles = aFiles.filter((f) => bFiles.includes(f));
  const patchJaccard = aFiles.length + bFiles.length === 0
    ? 1
    : sharedFiles.length / new Set([...aFiles, ...bFiles]).size;

  const ratio = aOut.costUsd !== null && bOut.costUsd !== null && aOut.costUsd > 0
    ? bOut.costUsd / aOut.costUsd : null;
  const economicClass = censored || ratio === null
    ? "NOT_MEASURABLE"
    : ratio <= ECONOMIC_THRESHOLDS.winAtOrBelow ? "ECONOMIC_WIN"
    : ratio <= ECONOMIC_THRESHOLDS.breakEvenAtOrBelow ? "ROUGH_NEUTRAL"
    : "ECONOMIC_LOSS";

  const aPreStrong = preEditKeys(a, true).size;
  const displacementRate = aPreStrong === 0 ? 0 : strong.displaced.length / aPreStrong;

  pairRows.push({
    instanceId,
    censored,
    resolvedA: aOut.resolved, resolvedB: bOut.resolved,
    costA: aOut.costUsd, costB: bOut.costUsd,
    costDeltaUsd: aOut.costUsd !== null && bOut.costUsd !== null
      ? Number((bOut.costUsd - aOut.costUsd).toFixed(6)) : null,
    costRatio: ratio === null ? null : Number(ratio.toFixed(4)),
    economicClass,
    requestsA: a.run.requests.length, requestsB: b.run.requests.length,
    firstEditA: a.landmarks.firstMeaningfulEditRequest,
    firstEditB: b.landmarks.firstMeaningfulEditRequest,
    firstEditDelta: a.landmarks.firstMeaningfulEditRequest !== null && b.landmarks.firstMeaningfulEditRequest !== null
      ? b.landmarks.firstMeaningfulEditRequest - a.landmarks.firstMeaningfulEditRequest : null,
    phaseCostsA: phaseCostsM174(a.run, a.landmarks),
    phaseCostsB: phaseCostsM174(b.run, b.landmarks),
    orientation: {
      delivered: b.orientation.delivered,
      focusFile: b.orientation.focusFile,
      focusAt: b.orientation.focusAt,
      relatedFiles: b.orientation.relatedFiles.length,
      unitsConferred: b.orientation.units.length,
      focusFileInGoldPatch: b.orientation.focusFile !== null
        && bFiles.concat(aFiles).some((f) => f === b.orientation.focusFile),
    },
    information: {
      baselinePreEditStrong: aPreStrong,
      treatmentPreEditStrong: preEditKeys(b, true).size,
      treatmentPostEditStrong: postEditKeys(b, true).size,
      displacedStrong: strong.displaced.length,
      eliminatedStrong: strong.eliminated.length,
      treatmentOnlyStrong: strong.treatmentOnly.length,
      // Split per §67: the packet's own units are not work the agent performed.
      treatmentOnlyAgentAcquired: strong.treatmentOnly.filter((k) => bAgentKeys.has(k)).length,
      treatmentOnlyPacketConferred: strong.treatmentOnly.filter((k) => !bAgentKeys.has(k)).length,
      treatmentOnlyAgentKeys: strong.treatmentOnly.filter((k) => bAgentKeys.has(k)).slice(0, 40),
      sharedPreEditStrong: strong.sharedPreEdit.length,
      displacementRate: Number(displacementRate.toFixed(4)),
      displacedKeys: strong.displaced.slice(0, 40),
      eliminatedKeys: strong.eliminated.slice(0, 40),
      allUnitsDisplaced: all.displaced.length,
      allUnitsEliminated: all.eliminated.length,
      allUnitsTreatmentOnly: all.treatmentOnly.length,
    },
    firstEdit: {
      aPath: aEdit.path, bPath: bEdit.path,
      aSurvival: aSurvival.survival, bSurvival: bSurvival.survival,
      aOverlap: Number(aSurvival.overlap.toFixed(3)), bOverlap: Number(bSurvival.overlap.toFixed(3)),
      sameFile: aEdit.path !== null && aEdit.path === bEdit.path,
    },
    revisionA: revisionBehaviour(a), revisionB: revisionBehaviour(b),
    testA: testBehaviour(a), testB: testBehaviour(b),
    patch: {
      filesA: aFiles, filesB: bFiles,
      sharedFiles, jaccard: Number(patchJaccard.toFixed(3)),
      sameFileSet: aFiles.length === bFiles.length && sharedFiles.length === aFiles.length,
    },
  });
}

// ── classifier controls (§66) ───────────────────────────────────────

const controls = (() => {
  const sample = loaded.get("m173_vtrace_compact_django__django_13658");
  if (sample === undefined) return { ran: false };
  // IDENTITY: a run compared with itself must displace, eliminate and add nothing.
  const identity = comparePairInformation(
    preEditKeys(sample, true), allKeys(sample, true),
    preEditKeys(sample, true), postEditKeys(sample, true), allKeys(sample, true),
  );
  // KNOWN POSITIVE: a synthetic pair where A learns a fact pre-edit and B learns
  // the same fact only after its edit. Must be exactly one displacement.
  const knownPositive = comparePairInformation(
    new Set(["RANGE_READ:x.py@3"]), new Set(["RANGE_READ:x.py@3"]),
    new Set<string>(), new Set(["RANGE_READ:x.py@3"]), new Set(["RANGE_READ:x.py@3"]),
  );
  // KNOWN NEGATIVE: B learns it BEFORE its edit. Must be zero displacement.
  const knownNegative = comparePairInformation(
    new Set(["RANGE_READ:x.py@3"]), new Set(["RANGE_READ:x.py@3"]),
    new Set(["RANGE_READ:x.py@3"]), new Set<string>(), new Set(["RANGE_READ:x.py@3"]),
  );
  return {
    ran: true,
    identity: {
      displaced: identity.displaced.length, eliminated: identity.eliminated.length,
      treatmentOnly: identity.treatmentOnly.length,
      pass: identity.displaced.length === 0 && identity.eliminated.length === 0 && identity.treatmentOnly.length === 0,
    },
    knownPositive: { displaced: knownPositive.displaced.length, pass: knownPositive.displaced.length === 1 },
    knownNegative: { displaced: knownNegative.displaced.length, pass: knownNegative.displaced.length === 0 },
    editRule: {
      knownPositive: "astropy vtrace_compact edits astropy/units/format/cds.py -> MEANINGFUL",
      knownNegative: "astropy vtrace_compact writes /tmp/test_cds_grammar.py -> SCRATCH",
      pass: (loaded.get("m173_vtrace_compact_astropy__astropy_14369")?.actions ?? [])
        .filter((a) => a.editClass === EditClass.Scratch).length === 3,
    },
  };
})();

const write = (name: string, value: unknown): void => {
  const target = path.join(RESULTS, name);
  writeFileSync(target, `${JSON.stringify(value, null, 1)}\n`);
  process.stdout.write(`wrote ${path.relative(ROOT, target)}\n`);
};

write("stage5_m174_pairwise_information.json", {
  schemaVersion: "stage5.m174.pairwise-information.v1",
  milestone: "M174", workstream: "M174-C",
  definitions: {
    DISPLACED: "A knew it before A's first meaningful edit; B did not know it before B's; B learned it after (§25)",
    ELIMINATED: "A acquired it; B never did (§26)",
    TREATMENT_ONLY: "B acquired it; A never did (§27)",
    strongUnits: "RANGE_READ, SYMBOL_SEEN, RELATION_SEEN, TEST_SEEN — content seen, not merely a path listed",
  },
  economicThresholds: { ...ECONOMIC_THRESHOLDS, inheritedFrom: "M173, which inherited from M169, unchanged" },
  classifierControls: controls,
  pairs: pairRows,
});

// ── console summary ─────────────────────────────────────────────────

process.stdout.write("\ncontrols: " + JSON.stringify(controls) + "\n\n");
process.stdout.write("instance                         Δ$       ratio  class          disp elim tOnlyW Bsurv            rework\n");
for (const row of pairRows as Record<string, any>[]) {
  process.stdout.write(
    `${String(row.instanceId).padEnd(30)} `
    + `${row.costDeltaUsd === null ? "    n/a" : String(row.costDeltaUsd.toFixed(4)).padStart(8)} `
    + `${row.costRatio === null ? "  n/a" : String(row.costRatio.toFixed(2)).padStart(6)}  `
    + `${String(row.economicClass).padEnd(14)} `
    + `${String(row.information.displacedStrong).padStart(4)} ${String(row.information.eliminatedStrong).padStart(4)} `
    + `${String(row.information.treatmentOnlyAgentAcquired).padStart(5)}  ${String(row.firstEdit.bSurvival).padEnd(18)}`
    + `${String(row.revisionB.reworkEdits)}\n`,
  );
}
