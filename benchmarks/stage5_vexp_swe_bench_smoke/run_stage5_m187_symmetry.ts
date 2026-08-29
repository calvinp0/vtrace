// M187 §18 — did M183's two arms have the SAME validation capability?
//
// The paired comparison only means anything if the treatment differs from the baseline in the
// treatment and nowhere else. Orientation content is allowed to differ; the ability to run a
// test is not. This reads the preserved `_run.meta.json` of all 60 arms and compares, per
// pair, every environment key that could change what a test command can do.
//
// Paths that legitimately embed the run label are normalized before comparison — otherwise
// every arm differs from every other arm for a reason that has nothing to do with capability.
// The orientation variable itself is expected to differ and is reported, not diffed away.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dir, "../..");
const RESULTS = path.join(REPO_ROOT, "benchmarks/stage5_vexp_swe_bench_smoke/results");

interface Arm {
  readonly label: string;
  readonly rawDir: string;
}
interface Pair {
  readonly instanceId: string;
  readonly baseline: Arm;
  readonly treatment: Arm;
}

const pairs: Pair[] = readFileSync(path.join(RESULTS, "stage5_m183_pair_records.jsonl"), "utf8")
  .split("\n")
  .filter((l) => l.trim())
  .map((l) => JSON.parse(l) as Pair);

const metaOf = (rawDir: string): Record<string, unknown> | null => {
  const p = path.join(REPO_ROOT, rawDir, "_run.meta.json");
  return existsSync(p) ? (JSON.parse(readFileSync(p, "utf8")) as Record<string, unknown>) : null;
};

/** Strip the per-run label so two arms of the same pair are comparable by shape. */
const normalize = (s: string, labels: readonly string[]): string => {
  let out = s;
  for (const l of labels) out = out.split(l).join("<RUN_LABEL>");
  return out.replace(/\/raw\/(baseline|vtrace|vexp)\b/g, "/raw/<CONDITION>");
};

/** The env keys that decide whether a test command can execute. */
const CAPABILITY_ENV_KEYS = [
  "PATH",
  "PYTHONPATH",
  "PYTHONHOME",
  "PYTHONNOUSERSITE",
  "VIRTUAL_ENV",
  "CONDA_PREFIX",
  "CONDA_DEFAULT_ENV",
  "CONDA_EXE",
  "PIP_REQUIRE_VIRTUALENV",
] as const;

/** The run-meta fields that record the harness's own validation-relevant configuration. */
const CAPABILITY_META_KEYS = [
  "stage5_env_guard_enabled",
  "stage5_env_guard_status",
  "stage5_agent_shell_guard_enabled",
  "stage5_agent_shell_guard_status",
  "stage5_agent_path_sanitized",
  "stage5_agent_conda_env_scrubbed",
  "stage5_host_pip_firewall_enabled",
  "stage5_agent_python_resolution",
  "stage5_agent_pip_resolution",
  "stage5_expected_testbed_prefix",
  "vtraceEffectiveCapsuleEngine",
] as const;

/** Keys whose difference IS the treatment and must not be counted as asymmetry. */
const TREATMENT_ENV_KEYS = /ORIENTATION|VTRACE_M183|TRIGGER/i;

interface PairReport {
  readonly instanceId: string;
  readonly comparable: boolean;
  readonly envDifferences: string[];
  readonly metaDifferences: string[];
  readonly treatmentOnlyEnvKeys: string[];
}

const reports: PairReport[] = [];
for (const pair of pairs) {
  const b = metaOf(pair.baseline.rawDir);
  const t = metaOf(pair.treatment.rawDir);
  if (b === null || t === null) {
    reports.push({
      instanceId: pair.instanceId,
      comparable: false,
      envDifferences: ["missing _run.meta.json"],
      metaDifferences: [],
      treatmentOnlyEnvKeys: [],
    });
    continue;
  }
  const labels = [pair.baseline.label, pair.treatment.label];
  const bEnv = (b.env ?? {}) as Record<string, string>;
  const tEnv = (t.env ?? {}) as Record<string, string>;

  const envDifferences: string[] = [];
  for (const k of CAPABILITY_ENV_KEYS) {
    const bv = normalize(bEnv[k] ?? "<absent>", labels);
    const tv = normalize(tEnv[k] ?? "<absent>", labels);
    if (bv !== tv) envDifferences.push(`${k}: baseline=${bv.slice(0, 160)} treatment=${tv.slice(0, 160)}`);
  }

  const metaDifferences: string[] = [];
  for (const k of CAPABILITY_META_KEYS) {
    const bv = normalize(JSON.stringify(b[k] ?? null), labels);
    const tv = normalize(JSON.stringify(t[k] ?? null), labels);
    if (bv !== tv) metaDifferences.push(`${k}: baseline=${bv.slice(0, 160)} treatment=${tv.slice(0, 160)}`);
  }

  const treatmentOnlyEnvKeys = Object.keys(tEnv).filter((k) => !(k in bEnv));
  reports.push({
    instanceId: pair.instanceId,
    comparable: true,
    envDifferences,
    metaDifferences,
    treatmentOnlyEnvKeys,
  });
}

const asymmetric = reports.filter(
  (r) => !r.comparable || r.envDifferences.length > 0 || r.metaDifferences.length > 0,
);
const allTreatmentOnlyKeys = [...new Set(reports.flatMap((r) => r.treatmentOnlyEnvKeys))].sort();
const unexpectedTreatmentKeys = allTreatmentOnlyKeys.filter((k) => !TREATMENT_ENV_KEYS.test(k));

const artifact = {
  schemaVersion: "stage5.m187.arm-symmetry.v1",
  milestone: "M187",
  question: "Did M183's baseline and treatment arms have equivalent validation capability?",
  method:
    "Per pair, compare every capability-bearing env var and run-meta field from the preserved _run.meta.json, with run-label path components normalized. Orientation-carrying env keys are the treatment and are reported separately rather than diffed.",
  pairsCompared: reports.filter((r) => r.comparable).length,
  pairsAsymmetric: asymmetric.length,
  capabilityEnvKeysCompared: CAPABILITY_ENV_KEYS,
  capabilityMetaKeysCompared: CAPABILITY_META_KEYS,
  treatmentOnlyEnvKeys: allTreatmentOnlyKeys,
  unexpectedTreatmentOnlyEnvKeys: unexpectedTreatmentKeys,
  asymmetries: asymmetric,
  scope:
    "The `env` block in _run.meta.json records the SHELL-GUARD OVERRIDE MAP (the sanitized PATH, the scrubbed conda/venv vars, the block-log path) — not the complete spawn environment. That is the right scope for this question, because those overrides are the whole of what the benchmark does to an agent's ability to run a command. It also means symmetry here is NOT a claim that the arms were identical: the treatment reached the agent by a different surface, and M183's own treatment witness records 30/30 orientation packets delivered with 30 distinct semantic hashes.",
  treatmentActuallyDiffered: {
    source: "stage5_m183_treatment_witness.json",
    delivered: 30,
    distinctSemanticHashes: 30,
    note: "cited so that VALIDATION_CAPABILITY_EQUIVALENT cannot be read as 'the two arms were the same run'",
  },
  sharedImplementationEvidence: [
    "Both arms are launched by run_stage5_m183_driver.sh from ONE `common=(...)` flag array; the only per-arm difference is the env assignment emitted by run_stage5_m183_arm_wiring.ts.",
    "Both arms run --protocol baseline, so both take the same runCondition() path and the same materializeAgentShellGuard() call.",
    "All 60 arms recorded `Cleaned 1 file(s)` from their own raw dir — 30 baseline, 30 treatment — so the wrapper-bin wipe applied equally to both.",
  ],
  verdict:
    asymmetric.length === 0 && unexpectedTreatmentKeys.length === 0
      ? "VALIDATION_CAPABILITY_EQUIVALENT"
      : "VALIDATION_CAPABILITY_DIFFERS",
};

writeFileSync(path.join(RESULTS, "stage5_m187_arm_symmetry.json"), `${JSON.stringify(artifact, null, 2)}\n`);

console.log(`pairs compared: ${artifact.pairsCompared}/30`);
console.log(`asymmetric pairs: ${artifact.pairsAsymmetric}`);
console.log(`treatment-only env keys: ${JSON.stringify(allTreatmentOnlyKeys)}`);
console.log(`unexpected treatment-only keys: ${JSON.stringify(unexpectedTreatmentKeys)}`);
for (const a of asymmetric.slice(0, 5)) console.log(`  ${a.instanceId}: ${[...a.envDifferences, ...a.metaDifferences].join(" | ").slice(0, 300)}`);
console.log(`verdict: ${artifact.verdict}`);
if (artifact.verdict !== "VALIDATION_CAPABILITY_EQUIVALENT") process.exitCode = 1;
