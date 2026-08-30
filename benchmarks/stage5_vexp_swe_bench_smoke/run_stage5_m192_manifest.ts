/**
 * M192 step 1 — freeze the probe manifest.
 *
 * Emits results/stage5_m192_probe_manifest.json from the Stage 5 fixture using
 * the preregistered selection rule. Deterministic: same fixture -> same hash.
 * Committed BEFORE any substantive probe is run, so that §8/§42 blindness is
 * demonstrable from git history rather than asserted.
 *
 *   bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m192_manifest.ts
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  breadthGate,
  selectPreregisteredInstances,
  type BenchmarkRow,
} from "./m192Substrate";

const DATASET =
  process.env.M192_DATASET ?? "/home/calvin/code/vexp-swe-bench/data/swe-bench-100.jsonl";
const OUT = join(import.meta.dir, "results", "stage5_m192_probe_manifest.json");

function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

const raw = readFileSync(DATASET, "utf8");
const rows: BenchmarkRow[] = raw
  .split("\n")
  .filter((l) => l.trim().length > 0)
  .map((l) => JSON.parse(l) as BenchmarkRow);

const selected = selectPreregisteredInstances(rows);
const gate = breadthGate(selected.length);

const instances = selected.map((s) => {
  const row = rows.find((r) => r.instance_id === s.instanceId)!;
  return {
    ...s,
    testPatchSha256: sha256(row.test_patch),
    // The F-probe is only meaningful once the benchmark's own test patch is
    // applied on top of base; recorded explicitly so the probe cannot silently
    // change which state it measured.
    fProbeRequiresTestPatch: true,
  };
});

const manifest = {
  milestone: "M192",
  purpose:
    "Audit whether SWE-bench per-instance Docker environments can serve as an interactive edit-and-validate substrate.",
  frozenBeforeResults: true,
  dataset: DATASET,
  datasetSha256: sha256(raw),
  selectionRule:
    "For every repository represented in the fixture, the lexicographically first instance_id. Blind to Docker state, image size, gold topology and probe outcome.",
  probeSelectionRule:
    "P-probe = lexicographically first PASS_TO_PASS id; F-probe = lexicographically first FAIL_TO_PASS id.",
  substrate: {
    harness: "swebench==4.1.0 (/home/calvin/code/vexp-swe-bench/.venv)",
    imageNamespace: "swebench",
    instanceImageTag: "latest",
    checkoutRoot: "/testbed",
    containerUser: "root",
    containerCommand: "tail -f /dev/null",
    executionPath: "docker exec (same substrate as swebench container.exec_run)",
  },
  breadthGate: gate,
  wrongSourceRule:
    "A repository whose validation demonstrably executes an installed copy rather than the edited checkout cannot count as READY, regardless of P/F outcome.",
  probeMatrix: [
    "V1 environment starts",
    "V2 source checkout readable at base_commit",
    "V3 source writable",
    "V4 mutation persists across a separate command",
    "V5 test runner starts",
    "V6 P-probe observably passes",
    "V7 F-probe observably fails (base + test patch)",
    "V8 module provenance resolves under the checkout root",
    "V9 controlled mutation is executed by the validation process",
    "V10 source restored to a clean state / environment destroyed",
    "V11 telemetry truthful and independently distinguishable",
    "V12 no privileged bypass (same exec path a future agent would have)",
  ],
  instanceCount: instances.length,
  instances,
};

const body = JSON.stringify(manifest, null, 2);
writeFileSync(OUT, `${body}\n`);

console.log(`M192 manifest: ${instances.length} instances across ${gate.representedRepositories} repositories`);
console.log(`gate: ${gate.rule}`);
console.log(`manifest sha256: ${sha256(`${body}\n`)}`);
console.log(`written: ${OUT}`);
