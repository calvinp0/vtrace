/**
 * M185-A — verify M183's evidence authority, then reconstruct the cohorts from
 * the row data rather than from M183's headline counts (§57/§58/§60).
 *
 * Reads only. Writes `stage5_m185_m183_authority.json` and
 * `stage5_m185_cohorts.json`.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  focusCohort,
  focusIsGoldSymbolInNonGoldFile,
  outcomeCohort,
  type Cohort,
  type GoldRow,
} from "./m185Audit";

const REPO_ROOT = path.resolve(import.meta.dir, "../..");
const RESULTS = path.join(REPO_ROOT, "benchmarks/stage5_vexp_swe_bench_smoke/results");
const DATASET = path.join(RESULTS, "_m160_corpus/swe_bench_verified.jsonl");

const sha256File = (p: string): string | null => {
  try { return createHash("sha256").update(readFileSync(p)).digest("hex"); } catch { return null; }
};

interface ArmRecord {
  readonly label: string;
  readonly rawDir: string;
  readonly resolved: boolean;
  readonly seals: Record<string, string | null>;
  readonly [k: string]: unknown;
}
interface PairRecord {
  readonly instanceId: string;
  readonly repo: string;
  readonly pairValid: boolean;
  readonly baseline: ArmRecord;
  readonly treatment: ArmRecord;
  readonly [k: string]: unknown;
}

const pairs: PairRecord[] = readFileSync(path.join(RESULTS, "stage5_m183_pair_records.jsonl"), "utf8")
  .split("\n").filter((l) => l.trim().length > 0).map((l) => JSON.parse(l) as PairRecord);

const gold = JSON.parse(readFileSync(path.join(RESULTS, "stage5_m183_gold_diagnostics.json"), "utf8")) as {
  rows: GoldRow[];
  rates: Record<string, string>;
  localizationIsNotResolution: Record<string, unknown>;
};

// ── seal verification (§57) ─────────────────────────────────────────

const SEAL_FILES: Record<string, string> = {
  runMeta: "_run.meta.json",
  toolCalls: "_tool_calls.json",
  agentStream: "_agent_stream.first_pass.jsonl",
  evalMeta: "_eval.meta.json",
};

interface SealCheck {
  readonly label: string;
  readonly arm: string;
  readonly instanceId: string;
  readonly checked: number;
  readonly matched: number;
  readonly mismatched: readonly string[];
  readonly missing: readonly string[];
  readonly toolCallsWithOutputsPresent: boolean;
  readonly transcriptLines: number;
}

const verifyArm = (instanceId: string, arm: string, r: ArmRecord): SealCheck => {
  const dir = path.join(REPO_ROOT, r.rawDir);
  const mismatched: string[] = [];
  const missing: string[] = [];
  let checked = 0;
  let matched = 0;
  for (const [key, file] of Object.entries(SEAL_FILES)) {
    const expected = r.seals[key];
    if (expected === null || expected === undefined) continue;
    checked += 1;
    const actual = sha256File(path.join(dir, file));
    if (actual === null) missing.push(file);
    else if (actual === expected) matched += 1;
    else mismatched.push(file);
  }
  // the result row is sealed by file; find it by suffix.
  const rowPath = ["swebench-2026-08-29.jsonl", "swebench-2026-08-30.jsonl"]
    .map((f) => path.join(dir, f)).find((p) => existsSync(p));
  if (r.seals.resultRow && rowPath) {
    checked += 1;
    if (sha256File(rowPath) === r.seals.resultRow) matched += 1; else mismatched.push(path.basename(rowPath));
  } else if (r.seals.resultRow) missing.push("swebench-*.jsonl");

  const streamPath = path.join(dir, "_agent_stream.first_pass.jsonl");
  const transcriptLines = existsSync(streamPath)
    ? readFileSync(streamPath, "utf8").split("\n").filter((l) => l.trim().length > 0).length
    : 0;

  return {
    label: r.label, arm, instanceId, checked, matched,
    mismatched, missing,
    toolCallsWithOutputsPresent: existsSync(path.join(dir, "_tool_calls_with_outputs.json")),
    transcriptLines,
  };
};

const sealChecks: SealCheck[] = [];
for (const p of pairs) {
  sealChecks.push(verifyArm(p.instanceId, "baseline", p.baseline));
  sealChecks.push(verifyArm(p.instanceId, "treatment", p.treatment));
}

// ── gold / reference-patch authority (§57) ──────────────────────────

interface DatasetRow { instance_id: string; patch: string; test_patch?: string; base_commit: string; repo: string; FAIL_TO_PASS?: string; PASS_TO_PASS?: string; problem_statement?: string; }
const dataset = new Map<string, DatasetRow>();
if (existsSync(DATASET)) {
  for (const line of readFileSync(DATASET, "utf8").split("\n")) {
    if (!line.trim()) continue;
    const row = JSON.parse(line) as DatasetRow;
    dataset.set(row.instance_id, row);
  }
}

const goldFilesFromPatch = (patch: string): string[] => {
  const files = new Set<string>();
  for (const m of patch.matchAll(/^\+\+\+ b\/(.+)$/gm)) files.add(m[1]!.trim());
  return [...files].sort();
};

const goldAuthority = gold.rows.map((r) => {
  const ds = dataset.get(r.instanceId);
  const recomputed = ds ? goldFilesFromPatch(ds.patch) : null;
  const declared = [...r.goldFiles].sort();
  return {
    instanceId: r.instanceId,
    datasetPresent: ds !== undefined,
    baseCommit: ds?.base_commit ?? null,
    patchSha256: ds ? createHash("sha256").update(ds.patch, "utf8").digest("hex") : null,
    declaredGoldFiles: declared,
    recomputedGoldFiles: recomputed,
    goldFilesAgree: recomputed !== null && JSON.stringify(recomputed) === JSON.stringify(declared),
    failToPass: ds?.FAIL_TO_PASS ? (JSON.parse(ds.FAIL_TO_PASS) as string[]).length : null,
  };
});

// ── cohort reconstruction (§58) ─────────────────────────────────────

const orientationDir = path.join(RESULTS, "_m183_orientation");
const cohortRows = gold.rows.map((r) => {
  const pair = pairs.find((p) => p.instanceId === r.instanceId)!;
  const packet = path.join(orientationDir, `${r.instanceId}.packet.json`);
  return {
    instanceId: r.instanceId,
    repo: r.repo,
    focusCohort: focusCohort(r),
    outcomeCohort: outcomeCohort(r),
    focusFile: r.focusFile,
    focusAt: r.focusAt,
    goldFiles: r.goldFiles,
    focusIsGoldFile: r.focusIsGoldFile,
    focusIsGoldSymbolInNonGoldFile: focusIsGoldSymbolInNonGoldFile(r),
    goldFileInOrientation: r.goldFileInOrientation,
    treatmentEditedFocus: r.treatmentEditedFocus,
    treatmentEditedAnyGoldFile: r.treatmentEditedAnyGoldFile,
    baselineEditedAnyGoldFile: r.baselineEditedAnyGoldFile,
    baselineResolved: r.baselineResolved,
    treatmentResolved: r.treatmentResolved,
    pairValid: pair.pairValid,
    orientationPacketSha256: sha256File(packet),
    baselineRawDir: pair.baseline.rawDir,
    treatmentRawDir: pair.treatment.rawDir,
  };
});

const count = (c: Cohort | "BOTH_SOLVED"): number =>
  cohortRows.filter((r) => r.focusCohort === c || r.outcomeCohort === c).length;

const reconciliation = {
  correctFocusFailures: { reconstructed: count("A_CORRECT_FOCUS_FAILURE"), m183Expected: 6 },
  correctFocusSuccesses: { reconstructed: count("B_CORRECT_FOCUS_SUCCESS"), m183Expected: 19 - 6 },
  wrongFocusSuccesses: { reconstructed: count("C_WRONG_FOCUS_SUCCESS"), m183Expected: 6 },
  wrongFocusFailures: { reconstructed: count("G_WRONG_FOCUS_FAILURE"), m183Expected: 30 - 19 - 6 + 6 - 6 },
  vtraceOnlyWins: { reconstructed: count("D_VTRACE_ONLY_WIN"), m183Expected: 2 },
  baselineOnlyWins: { reconstructed: count("E_BASELINE_ONLY_WIN"), m183Expected: 2 },
  bothFail: { reconstructed: count("F_BOTH_FAIL"), m183Expected: 9 },
  bothSolved: { reconstructed: count("BOTH_SOLVED"), m183Expected: 17 },
  focusIsGoldFile: { reconstructed: cohortRows.filter((r) => r.focusIsGoldFile).length, m183Expected: 19 },
};

const armsFullyVerified = sealChecks.filter((s) => s.mismatched.length === 0 && s.missing.length === 0).length;

const authority = {
  schemaVersion: "stage5.m185.m183-authority.v1",
  milestone: "M185",
  workstream: "M185-A",
  m183ProtocolHash: (JSON.parse(readFileSync(path.join(RESULTS, "stage5_m183_protocol_hash.json"), "utf8")) as { protocolHash?: string; hash?: string }),
  pairs: pairs.length,
  validPairs: pairs.filter((p) => p.pairValid).length,
  arms: sealChecks.length,
  armsFullyVerified,
  armsWithMismatch: sealChecks.filter((s) => s.mismatched.length > 0).map((s) => ({ label: s.label, mismatched: s.mismatched })),
  armsWithMissing: sealChecks.filter((s) => s.missing.length > 0).map((s) => ({ label: s.label, missing: s.missing })),
  armsWithToolOutputs: sealChecks.filter((s) => s.toolCallsWithOutputsPresent).length,
  transcriptLinesTotal: sealChecks.reduce((a, s) => a + s.transcriptLines, 0),
  datasetPath: path.relative(REPO_ROOT, DATASET),
  datasetRows: dataset.size,
  goldAuthority,
  goldFilesAgreeCount: goldAuthority.filter((g) => g.goldFilesAgree).length,
  sealChecks,
};

const cohorts = {
  schemaVersion: "stage5.m185.cohorts.v1",
  milestone: "M185",
  workstream: "M185-A",
  focusDefinition: "M183 §53: a gold file is a file changed by the SWE-bench reference patch; focus is correct when the orientation focus file is one of them. NOT redefined (§59).",
  reconciliation,
  rows: cohortRows,
};

writeFileSync(path.join(RESULTS, "stage5_m185_m183_authority.json"), `${JSON.stringify(authority, null, 2)}\n`);
writeFileSync(path.join(RESULTS, "stage5_m185_cohorts.json"), `${JSON.stringify(cohorts, null, 2)}\n`);

console.log(`arms verified ${armsFullyVerified}/${sealChecks.length}`);
console.log(`gold files agree ${authority.goldFilesAgreeCount}/${goldAuthority.length}`);
console.log(JSON.stringify(reconciliation, null, 1));
