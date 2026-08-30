/**
 * M192 falsification control — verdict.
 *
 * Feeds the wrong-source control's evidence through the SAME classifier the
 * readiness sweep uses. If arm B were also accepted, the sweep's 12/12 would be
 * an artefact of an instrument that cannot say no, and the milestone would have
 * to report that instead.
 *
 *   bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m192_control_verify.ts
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { assessRepository, classifyProvenance, type ReadinessChecks } from "./m192Substrate";

const RESULTS = join(import.meta.dir, "results");
const control = JSON.parse(
  readFileSync(join(RESULTS, "stage5_m192_wrong_source_control.json"), "utf8"),
) as {
  checkoutRoot: string;
  cases: Array<{
    instanceId: string;
    package: string;
    error: string | null;
    locatedModule?: string;
    armA?: { cwd: string; moduleFile: string | null; sentinelFired: boolean };
    armB?: { cwd: string; moduleFile: string | null; sentinelFired: boolean };
  }>;
};

/** Everything else green, so only provenance can decide the verdict. */
function checksWith(prov: ReadinessChecks["v8SourceProvenance"], mutationRan: boolean): ReadinessChecks {
  return {
    v1EnvironmentStarts: true,
    v2SourceReadable: true,
    v3SourceWritable: true,
    v4MutationPersists: true,
    v5TestRunnerStarts: true,
    v6PassingObservable: true,
    v7FailingObservable: true,
    v8SourceProvenance: prov,
    v9MutationAffectsValidation: mutationRan,
    v10SourceRestored: true,
    v11TelemetryTruthful: true,
    v12NoPrivilegedBypass: true,
  };
}

const rows = control.cases.map((c) => {
  const arm = (a?: { moduleFile: string | null; sentinelFired: boolean }) =>
    classifyProvenance({
      moduleFile: a?.moduleFile ?? null,
      checkoutRoot: control.checkoutRoot,
      mutationExecuted: a ? a.sentinelFired : null,
      runnerStarted: true,
    });
  const provA = arm(c.armA);
  const provB = arm(c.armB);
  return {
    instanceId: c.instanceId,
    package: c.package,
    error: c.error,
    armA: { moduleFile: c.armA?.moduleFile ?? null, sentinelFired: c.armA?.sentinelFired ?? null, provenance: provA, state: assessRepository(checksWith(provA, c.armA?.sentinelFired ?? false)) },
    armB: { moduleFile: c.armB?.moduleFile ?? null, sentinelFired: c.armB?.sentinelFired ?? null, provenance: provB, state: assessRepository(checksWith(provB, c.armB?.sentinelFired ?? false)) },
  };
});

const aConfirmed = rows.filter((r) => r.armA.provenance === "EDITED_CHECKOUT_CONFIRMED").length;
const bRejected = rows.filter(
  (r) => r.armB.provenance === "INSTALLED_COPY_CONFIRMED" && r.armB.state === "WRONG_SOURCE",
).length;
const controlHolds = rows.length > 0 && aConfirmed === rows.length && bRejected === rows.length;

const payload = {
  milestone: "M192",
  cases: rows.length,
  armAConfirmed: aConfirmed,
  armBRejectedAsWrongSource: bRejected,
  controlHolds,
  interpretation: controlHolds
    ? "The instrument discriminates: identical command text, same container, one repository — only the resolved source differs, and the wrong one is rejected."
    : "The instrument failed its own control; the readiness sweep must not be believed.",
  rows,
};
writeFileSync(join(RESULTS, "stage5_m192_control_verdict.json"), `${JSON.stringify(payload, null, 2)}\n`);

for (const r of rows) {
  console.log(
    `${r.instanceId}\n  A ${r.armA.provenance} (${r.armA.state}) fired=${r.armA.sentinelFired} ${r.armA.moduleFile}\n  B ${r.armB.provenance} (${r.armB.state}) fired=${r.armB.sentinelFired} ${r.armB.moduleFile}`,
  );
}
console.log(`\ncontrolHolds=${controlHolds}  A confirmed ${aConfirmed}/${rows.length}  B rejected ${bRejected}/${rows.length}`);
if (!controlHolds) process.exitCode = 1;
