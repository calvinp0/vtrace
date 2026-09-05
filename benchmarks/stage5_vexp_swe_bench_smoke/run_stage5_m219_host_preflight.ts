/**
 * M219 §11–§21 — the host preflight: capacity, scratch, residue, resources.
 *
 *   --phase before|after
 *
 * Records, through the M218 authorities wherever one exists:
 *
 *   - Docker store facts and the Docker-root / results / shared-/tmp capacity;
 *   - the M218 host /tmp prefix census (measured, nothing deleted) and the M219
 *     ownership classification of every top-level /tmp entry
 *     (PROVABLY_OWNED / AMBIGUOUS / UNRELATED / ACTIVE), with the operator
 *     appendix for the significant AMBIGUOUS entries;
 *   - the production stale sweep on the COHORT namespace (the launcher's own
 *     `buildScratchAuthority`) and on the M218 research namespace — the only
 *     deletion authority M219 uses — plus the P13 capacity gate on the cohort
 *     namespace, unchanged;
 *   - the live residue census (containers, processes, mounts) classified;
 *   - host resource health;
 *   - (after) the derived Docker capacity gate, fed by the container census.
 *
 * No model, no provider, no frozen task, no container started here.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { M214_EXPERIMENT_NAME } from "./m214Preregistration";
import {
  HostLivenessProbe,
  M218_REGISTRY_DIRNAME,
  M218_SCRATCH_POLICY,
  ScratchAuthority,
  ScratchRegistry,
  filesystemCapacity,
  openNamespace,
} from "./m218ScratchLifecycle";
import { hostTmpCensus } from "./run_stage5_m218_tmp_census";
import { buildScratchAuthority, workRootFor } from "./run_stage5_m215_launch";
import {
  M219_PREFLIGHT_VERSION,
  M219_TMP_ATTRIBUTIONS,
  SnapshotLivenessProbe,
  dockerCapacityGate,
  dockerCapacityRequirement,
  dockerStoreFacts,
  historicalTmpCensus,
  hostResidueFacts,
  hostResourceHealth,
  markedNamespaceRoots,
  residueCensus,
} from "./m219OperatorPreflight";

const RESULTS_DIR = join(import.meta.dir, "results");
const COHORT_DIR = join(RESULTS_DIR, "_m215_cohort");
const M218_RESEARCH_DIR = join(RESULTS_DIR, "_m218_work");
const CONTAINER_CENSUS = join(RESULTS_DIR, "stage5_m219_container_census.json");
const IMAGE_BEFORE = join(RESULTS_DIR, "stage5_m219_image_census_before.json");
const IMAGE_AFTER = join(RESULTS_DIR, "stage5_m219_image_census_after.json");

function main(): void {
  const args = process.argv.slice(2);
  const phase = args[args.indexOf("--phase") + 1];
  if (phase !== "before" && phase !== "after") throw new Error("usage: --phase before|after");
  const output = join(RESULTS_DIR, `stage5_m219_host_preflight_${phase}.json`);
  const now = (): string => new Date().toISOString();

  // ── §11 Docker store and filesystems ──────────────────────────────
  const store = dockerStoreFacts();
  const capacity = {
    dockerRoot: filesystemCapacity(store.rootDir),
    resultsDir: filesystemCapacity(RESULTS_DIR),
    sharedTmp: filesystemCapacity(tmpdir()),
  };

  // ── §16 the production stale sweep + §19 the P13 gate, unchanged ──
  const cohort = buildScratchAuthority(COHORT_DIR, now);
  const cohortSweep = cohort.sweep();
  const cohortGate = cohort.capacityGate();
  let researchSweep: ReturnType<ScratchAuthority["sweep"]> | null = null;
  if (existsSync(join(M218_RESEARCH_DIR, "_work"))) {
    const research = new ScratchAuthority({
      namespace: openNamespace(join(M218_RESEARCH_DIR, "_work"), "M218_RESEARCH_NON_EVALUATION"),
      registry: new ScratchRegistry(join(M218_RESEARCH_DIR, M218_REGISTRY_DIRNAME)),
      evidenceDir: join(M218_RESEARCH_DIR, "evidence"),
      liveness: new HostLivenessProbe(),
      experiment: "M218_RESEARCH_NON_EVALUATION",
      executorVersion: "m219-host-preflight",
      now,
    });
    researchSweep = research.sweep();
  }

  // ── §18 live residue, §21 resources ───────────────────────────────
  const facts = hostResidueFacts();
  const residue = residueCensus([RESULTS_DIR, workRootFor(COHORT_DIR)], facts, now());
  const health = hostResourceHealth(now());

  // ── §12–§17 host /tmp: the M218 prefix census + the M219 classification ──
  const m218Census = hostTmpCensus();
  const namespaceRoots = markedNamespaceRoots([cohort.namespace.canonicalRoot, join(M218_RESEARCH_DIR, "_work"), join(RESULTS_DIR, "_m217_work")]);
  const historical = historicalTmpCensus(
    tmpdir(), M219_TMP_ATTRIBUTIONS,
    { registries: [cohort.registry, new ScratchRegistry(join(M218_RESEARCH_DIR, M218_REGISTRY_DIRNAME))], namespaceRoots },
    new SnapshotLivenessProbe(facts), { now },
  );

  // ── §20 Docker capacity (after: fed by the census; before: recorded only) ──
  let dockerGate: ReturnType<typeof dockerCapacityGate> | null = null;
  let materializationDeltaBytes: number | null = null;
  if (existsSync(IMAGE_BEFORE) && existsSync(IMAGE_AFTER)) {
    const before = JSON.parse(readFileSync(IMAGE_BEFORE, "utf8")) as { dockerStore: { imageBytes: number } };
    const after = JSON.parse(readFileSync(IMAGE_AFTER, "utf8")) as { dockerStore: { imageBytes: number }; census: { entries: { sizeBytes: number | null }[] } };
    materializationDeltaBytes = after.dockerStore.imageBytes - before.dockerStore.imageBytes;
    const largest = Math.max(0, ...after.census.entries.map((entry) => entry.sizeBytes ?? 0));
    let writableHighWater = 0;
    if (existsSync(CONTAINER_CENSUS)) {
      const census = JSON.parse(readFileSync(CONTAINER_CENSUS, "utf8")) as { writableLayerHighWaterBytes?: number };
      writableHighWater = census.writableLayerHighWaterBytes ?? 0;
    }
    dockerGate = dockerCapacityGate(store.rootDir, capacity.dockerRoot, dockerCapacityRequirement({
      materializationDeltaBytes, largestRequiredImageBytes: largest, containerWritableHighWaterBytes: writableHighWater,
      // M215's concurrency policy runs one row at a time: one harness container
      // plus the staging container it extracts from, plus one evaluator container.
      concurrentContainers: 3,
    }), now());
  }

  const ambiguous = historical.significant.filter((entry) => entry.classification === "AMBIGUOUS");
  const document = {
    schemaVersion: "stage5.m219.host-preflight.v1",
    milestone: "M219",
    preflightVersion: M219_PREFLIGHT_VERSION,
    phase,
    generatedAt: now(),
    dockerStore: store,
    capacity,
    cohortNamespace: {
      root: cohort.namespace.canonicalRoot, experiment: M214_EXPERIMENT_NAME,
      sweep: cohortSweep,
      capacityGate: cohortGate,
      policy: M218_SCRATCH_POLICY.version,
    },
    m218ResearchNamespace: researchSweep === null ? null : { root: join(M218_RESEARCH_DIR, "_work"), sweep: researchSweep },
    provablyOwnedStaleCleanup: {
      authority: "M218 ScratchAuthority.sweep (registry ownership + live-reference check + symlink-safe strict-descendant removal)",
      cohortCleaned: cohortSweep.cleaned,
      researchCleaned: researchSweep?.cleaned ?? [],
      bytesRemoved: [...cohortSweep.entries, ...(researchSweep?.entries ?? [])].reduce((sum, entry) => sum + entry.bytesRemoved, 0),
      adHocDeletions: 0,
    },
    residue,
    hostResourceHealth: health,
    hostTmpPrefixCensus: { ...m218Census, authority: "run_stage5_m218_tmp_census.hostTmpCensus (M218)" },
    historicalTmp: {
      ...historical,
      ambiguousAppendix: ambiguous.map((entry) => ({
        path: entry.path, bytes: entry.bytes, entries: entry.entries, ageDays: entry.ageDays === null ? null : Number(entry.ageDays.toFixed(1)),
        attribution: `${entry.attributionLabel}: ${entry.attributionProducer}`,
        whyOwnershipInsufficient: entry.whyOwnershipInsufficient,
        liveReferences: entry.liveReferences,
        disposition: entry.disposition,
      })),
      verdict: historical.byClassification.ACTIVE.entries === 0 ? "AMBIGUOUS_HISTORICAL_TMP_PRESERVED" : "ACTIVE_HISTORICAL_TMP_ENTRIES_NEED_CLASSIFICATION",
    },
    dockerCapacity: dockerGate === null ? { evaluated: false, reason: "materialization not yet complete; derived after the image and container censuses" } : { evaluated: true, materializationDeltaBytes, gate: dockerGate },
    verdicts: {
      TMP_CAPACITY_GATE: cohortGate.pass ? "TMP_CAPACITY_GATE_PASS" : "TMP_CAPACITY_GATE_FAIL",
      SCRATCH_NAMESPACE: cohortSweep.pass ? "SCRATCH_NAMESPACE_CLEAN" : "STALE_OR_UNKNOWN_SCRATCH",
      RESIDUE: residue.pass ? "NO_ACTIVE_BENCHMARK_RESIDUE" : "ACTIVE_BENCHMARK_RESIDUE",
      HOST_RESOURCES: health.pass ? "HOST_RESOURCES_HEALTHY" : "HOST_RESOURCES_EXHAUSTED",
      DOCKER_CAPACITY: dockerGate === null ? "NOT_EVALUATED" : dockerGate.pass ? "DOCKER_CAPACITY_PREFLIGHT_PASS" : "DOCKER_CAPACITY_PREFLIGHT_FAIL",
    },
  };
  writeFileSync(output, `${JSON.stringify(document, null, 2)}\n`);
  process.stdout.write(
    `${phase}: ${Object.entries(document.verdicts).map(([key, value]) => `${key}=${value}`).join(" ")}\n`
    + `/tmp: ${historical.totalEntries} entries; ${JSON.stringify(historical.byClassification)}; significant ambiguous ${ambiguous.length}\n`
    + `cohort sweep entries ${cohortSweep.entries.length} cleaned ${cohortSweep.cleaned.length} blocking ${cohortSweep.blocking.length}; research sweep cleaned ${researchSweep?.cleaned.length ?? "n/a"}\n`
    + `residue containers ${residue.containers.length} (blocking ${residue.blocking.length}); processes classified ${residue.processes.length}\n`
    + `docker root free ${capacity.dockerRoot.freeBytes}; /tmp free ${capacity.sharedTmp.freeBytes}\n`
    + `wrote ${output}\n`,
  );
}

main();
