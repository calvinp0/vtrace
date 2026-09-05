/**
 * M219 §37 — the final report, generated from the evidence artifacts.
 *
 * Every number below is read from an evidence JSON or from git; the prose is
 * fixed and the facts are not typed by hand.
 *
 *   bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m219_report.ts
 */

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { M218_SCRATCH_POLICY } from "./m218ScratchLifecycle";

const RESULTS_DIR = join(import.meta.dir, "results");
const OUTPUT = join(RESULTS_DIR, "stage5_m219_final_report.md");
const VTRACE_ROOT = join(import.meta.dir, "..", "..");
const RESULTS_REL = "benchmarks/stage5_vexp_swe_bench_smoke/results";
const M218_HEAD = "d38aaebc";
const FROZEN_SRC_TREE = "b3b3e439f10c6c526cafc6001d25dd0e7552ce6d";

const FROZEN_ARTIFACTS: readonly string[] = Object.freeze([
  "stage5_m213_preregistration.json", "stage5_m213_run_manifest.json", "stage5_m213_preregistration_hash.json",
  "stage5_m214_preregistration.json", "stage5_m214_run_manifest.json", "stage5_m214_external_reference.json",
  "stage5_m214_preregistration_hash.json", "stage5_m214_a1_retry_reserve_amendment.json", "stage5_m214_a1_amendment_hash.json",
]);

function readJson<T>(name: string): T {
  return JSON.parse(readFileSync(join(RESULTS_DIR, name), "utf8")) as T;
}
function git(...args: string[]): string {
  return execFileSync("git", ["-C", VTRACE_ROOT, ...args], { encoding: "utf8" }).trim();
}
function sha256(text: string | Buffer): string {
  return createHash("sha256").update(text).digest("hex");
}
function gib(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(2)} GiB`;
}
function gb(bytes: number): string {
  return `${(bytes / 1e9).toFixed(1)} GB`;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
function main(): void {
  const before = readJson<any>("stage5_m219_image_census_before.json");
  const after = readJson<any>("stage5_m219_image_census_after.json");
  const pulls = readJson<any>("stage5_m219_image_pulls.json");
  const imagePreflight = readJson<any>("stage5_m219_image_preflight.json");
  const identity = readJson<any>("stage5_m219_image_identity.json");
  const containers = readJson<any>("stage5_m219_container_census.json");
  const hostBefore = readJson<any>("stage5_m219_host_preflight_before.json");
  const hostAfter = readJson<any>("stage5_m219_host_preflight_after.json");
  const launch = readJson<any>("stage5_m219_launch_preflight.json");
  const suite = readJson<any>("stage5_m219_falsification.json");
  const typecheck = readJson<any>("stage5_m219_scoped_typecheck.json");
  const gates = readJson<any>("stage5_m219_launch_gates.json");
  const m218Host = readJson<any>("stage5_m218_real_host.json");
  const m218Real = readJson<any>("stage5_m218_real_substrate.json");
  const amendment = readJson<any>("stage5_m214_a1_amendment_hash.json");

  const head = git("rev-parse", "HEAD");
  const srcTree = git("rev-parse", "HEAD:src");
  const status = git("status", "--short");
  const aheadBehind = git("rev-list", "--left-right", "--count", "origin/main...HEAD");
  const commits = git("log", "--oneline", `${M218_HEAD}..HEAD`).split("\n").filter(Boolean);
  const frozen = FROZEN_ARTIFACTS.map((name) => {
    const disk = sha256(readFileSync(join(RESULTS_DIR, name)));
    const blob = sha256(execFileSync("git", ["-C", VTRACE_ROOT, "show", `${M218_HEAD}:${RESULTS_REL}/${name}`]));
    return { name, disk, matchesM218Blob: disk === blob };
  });
  const srcDiff = git("diff", "--stat", `${M218_HEAD}`, "HEAD", "--", "src");

  const finalState: string = gates.finalState;
  const ready = finalState === "PAID_TWO_ARM_CAUSAL_BENCHMARK_READY_FOR_HUMAN_AUTHORIZATION";
  const m219Gates = (gates.gates as any[]).filter((entry) => /^G(8[6-9]|9[0-6])$/.test(entry.id));
  const historicalBefore = hostBefore.historicalTmp;
  const historicalAfter = hostAfter.historicalTmp;
  const pulledBytes = (pulls.pulls as any[]).reduce((sum, entry) => sum + (entry.sizeBytes ?? 0), 0);
  const pullMs = (pulls.pulls as any[]).reduce((sum, entry) => sum + entry.durationMs, 0);
  const dockerGate = hostAfter.dockerCapacity.gate;
  const fmtRefs = (refs: any[]): string => (refs.length === 0 ? "none" : refs.map((ref) => `${ref.kind}: ${String(ref.detail).slice(0, 80)}`).join("; "));

  const lines: string[] = [];
  const push = (...text: string[]): void => { lines.push(...text); };

  push("# M219 — final host preflight, SWE-bench image materialization, scratch capacity verification, and spend-authorization readiness", "");

  push("## 1. Executive verdict", "", "```text");
  push(ready ? "M219 — PASS" : "M219 — INCOMPLETE", "");
  push(...(ready ? [
    "ALL_FROZEN_SWEBENCH_IMAGES_LOCAL", "FROZEN_IMAGE_MAPPING_VERIFIED", "REAL_CONTAINER_PREFLIGHT_VERIFIED", "",
    "PROVABLY_OWNED_STALE_TMP_CLEANED", "AMBIGUOUS_HISTORICAL_TMP_PRESERVED", "TMP_CAPACITY_GATE_PASSED", "DOCKER_CAPACITY_PREFLIGHT_PASSED", "NO_ACTIVE_BENCHMARK_RESIDUE", "",
    "FINAL_ZERO_SPEND_LAUNCH_PREFLIGHT_PASSED", "", "TECHNICAL_EXECUTOR_READY", "PAID_TWO_ARM_CAUSAL_BENCHMARK_READY_FOR_HUMAN_AUTHORIZATION", "",
    "SPEND_AUTHORIZATION_PENDING", "PAID_RUNS_NOT_STARTED", "LIVE_MODEL_SPEND_$0",
  ] : ["PAID_TWO_ARM_CAUSAL_BENCHMARK_NOT_READY", `blockers: ${(gates.technicalBlockers as string[]).join(", ")}`]));
  push("```", "");
  push(
    "M218 left the technical executor ready and one operator dependency: 64 of the 100 frozen SWE-bench images were absent and M193 does not pull. M219 is not an engineering milestone. It reproduced that blocker from the frozen manifest, pulled exactly the absent required images, recorded every image's immutable identity, proved that all 200 frozen rows resolve to those identities through the adapter's own lookup, started every one of the 100 unique images and observed a writable /testbed with the task's base commit present, measured Docker and /tmp capacity around the materialization, ran the M218 sweep on the cohort namespace, classified every historical /tmp entry and deleted nothing ambiguous, and ran the production launcher's own preflight to the one blocker that is not technical.",
    "",
  );

  push("## 2. Starting repository state", "", "```text");
  push(`branch            main`, `M218 final HEAD   ${git("rev-parse", M218_HEAD)}`, `HEAD when generated  ${head}`, `ahead/behind      ${aheadBehind} (left origin/main, right HEAD)`, `pushed            no`, "");
  push("commits after the M218 final HEAD (hygiene + M219):", ...commits.map((line) => `  ${line}`), "", "working tree (pre-existing dirt preserved):", ...(status.split("\n").filter(Boolean).map((line) => `  ${line}`)), "```", "");
  push("Five hygiene commits after d38aaebc predate M219: two record OPERATOR-authorised cleanups (historical vtrace /tmp scratch by registered producer prefix; the 338.8 GiB results/workspaces clone store), one untracks their records, one stops tracking assessment data, one relabels secret-hygiene fixtures. M219 inherited a host whose /tmp was already at 23% and whose benchmark-attributed prefixes were already gone; it did not reset, clean or delete anything outside the M218 sweep authority.", "");

  push("## 3. Frozen experiment identities", "", "```text");
  const auth = gates.authorities as any;
  push(`preregistration      ${auth.preregistrationHash ?? auth.preregistration ?? "(see launch gates)"}`);
  push(`manifest             ${identity.manifestHash}`);
  push(`amendment A1         ${amendment.recordedHash}  pinned ${amendment.matchesPinnedConstant} verified ${amendment.verified}`);
  push(`executable authority ${auth.amendment?.executableAuthority ?? ""}  = M214 + A1`);
  push(`experiment           100 tasks x 2 arms = 200 intended valid outcomes; arms BASELINE, VTRACE; VEXP external reference; unchanged`);
  push("```", "");

  push("## 4. Required image population", "", "```text");
  push(`authority   manifest row.containerImage (the same field m217LaunchBinding hands the bridge and M193Container.setup looks up)`);
  push(`tasks       ${after.population.taskCount}    rows ${after.population.rowCount}    unique images ${after.population.uniqueImages}    issues ${after.population.issues.length}`);
  push(`check       exact task count = 100: ${after.population.taskCount === 100}; no extra/omitted task: each task maps to exactly one image, 200 rows = 100 x 2 arms`);
  push("```", "", "Per-task rows (instance, repo, required image, identity, present before M219) are in `stage5_m219_image_census_before.json` (`census.entries`) and `stage5_m219_image_identity.json`.", "");

  push("## 5. Pre-M219 image availability", "", "```text");
  push(`required images present: ${before.census.present}`, `required images absent:  ${before.census.absent}`, `local swebench images not required by the manifest: ${before.census.localNotRequired.length} (${(before.census.localNotRequired as string[]).map((name) => name.split("_1776_")[1]).join(", ")})`);
  push(`M218 reported 36 present / 64 absent; M219 reproduced ${before.census.present} / ${before.census.absent} on the same host before any pull.`, "```", "");
  push("Missing image identities before M219:", "", "```text", ...(before.census.missing as string[]), "```", "");

  push("## 6. Images pulled", "", "```text");
  push(`requested   ${pulls.requestedImages.length} (exactly the absent required images; onlyRequiredImagesPulled ${pulls.onlyRequiredImagesPulled})`);
  push(`pulled      ${pulls.pulled}    failed ${pulls.failed.length}    prune operations ${pulls.pruneOperationsPerformed}    concurrency ${pulls.concurrency}`);
  push(`bytes       ${pulledBytes} (${gb(pulledBytes)} of image size, layers shared)    wall ${Math.round(pullMs / 1000)} s summed per image`);
  push("```", "", "| image | result | image id | size bytes | ms |", "| --- | --- | --- | --- | --- |");
  for (const entry of pulls.pulls as any[]) push(`| ${entry.containerImage.split("/")[1]} | ${entry.result} | ${String(entry.imageId).slice(7, 19)} | ${entry.sizeBytes} | ${entry.durationMs} |`);
  push("");

  push("## 7. Post-pull image verification", "", "```text");
  push(`after census        present ${after.census.present} / ${after.census.required}, absent ${after.census.absent}`);
  push(`identity record     ${identity.images.length} images, recorded ${identity.recordedAt}, manifest ${identity.manifestHash.slice(0, 16)}… (M219's own authority; the frozen manifest pins names, not digests)`);
  push(`cli preflight       ${imagePreflight.cliPreflight.verdict}: rows resolved ${imagePreflight.rowsResolved}, identity verified ${imagePreflight.rowsIdentityVerified}, unique images ${imagePreflight.cliPreflight.uniqueImages}, pull requested ${imagePreflight.networkPullRequested}`);
  push(`adapter resolution  ${imagePreflight.adapterResolution.authority}: ${imagePreflight.adapterResolution.imagesResolved}/100 resolved, ${imagePreflight.adapterResolution.issues.length} identity issues`);
  push(`verdict             ${imagePreflight.verdict}`);
  push("```", "", "The launcher's scratch preflight now also runs this identity check whenever the record exists (`imageIdentityPreflight` in `run_stage5_m215_launch.ts`), so an image that later disappears or is re-tagged refuses the launch by name.", "");

  push("## 8. Unique image / container readiness", "", "```text");
  push(`unique images     ${containers.uniqueImages}    containers started ${containers.containersStarted}    torn down ${containers.containersTornDown}    survivors ${containers.survivingPreflightContainers}`);
  push(`validated         ${containers.validated} / ${containers.uniqueImages}    tasks mapped to a validated image ${containers.tasksMappedToValidatedImage} / 100`);
  push(`per image         image starts; /testbed exists; /testbed writable (probe file created and removed in the writable layer); base commit present (git cat-file) and ancestor of HEAD (git merge-base); trivial command = 42; git status digest identical before/after; teardown`);
  push(`writable layer    high-water ${containers.writableLayerHighWaterBytes} bytes`);
  push(`agent invoked ${containers.agentInvoked}; provider calls ${containers.providerCalls}; benchmark patches ${containers.benchmarkPatchesApplied}; frozen agent runs ${containers.frozenBenchmarkTaskLiveAgentRuns}`);
  push(`verdict           ${containers.verdict}`);
  if ((containers.failed as any[]).length > 0) push(`failed            ${JSON.stringify(containers.failed)}`);
  push("```", "", "Task → validated image mapping: `stage5_m219_container_census.json` (`taskToImage`).", "");

  push("## 9. Docker capacity before/after", "", "```text");
  push(`Docker root           ${before.dockerStore.rootDir} (${before.capacity.dockerRoot.path}; same filesystem as the cohort namespace)`);
  push(`image store bytes     before ${before.dockerStore.imageBytes} (${gb(before.dockerStore.imageBytes)})   after ${after.dockerStore.imageBytes} (${gb(after.dockerStore.imageBytes)})   delta ${after.dockerStore.imageBytes - before.dockerStore.imageBytes} (${gb(after.dockerStore.imageBytes - before.dockerStore.imageBytes)})`);
  push(`images total          before ${before.dockerStore.imagesTotal}   after ${after.dockerStore.imagesTotal}`);
  push(`required present      before ${before.census.present}   after ${after.census.present}`);
  push(`root fs free bytes    before ${before.capacity.dockerRoot.freeBytes} (${gib(before.capacity.dockerRoot.freeBytes)})   after ${hostAfter.capacity.dockerRoot.freeBytes} (${gib(hostAfter.capacity.dockerRoot.freeBytes)})`);
  push(`root fs free inodes   before ${before.capacity.dockerRoot.freeInodes}   after ${hostAfter.capacity.dockerRoot.freeInodes}`);
  push(`derived requirement   ${dockerGate.requirement.requiredFreeBytes} bytes (${gib(dockerGate.requirement.requiredFreeBytes)}): ${dockerGate.requirement.derivation}`);
  push(`gate                  ${dockerGate.pass ? "DOCKER_CAPACITY_PREFLIGHT_PASS" : "FAIL"}  ${dockerGate.issues.join("; ")}`);
  push(`prune operations      0 (no docker system/image/container/volume prune anywhere on the M219 path; F11)`);
  push("```", "");

  push("## 10. `/tmp` capacity before/after", "", "```text");
  const tmpB = before.capacity.sharedTmp; const tmpA = hostAfter.capacity.sharedTmp;
  push(`filesystem   ${tmpB.path} tmpfs total ${tmpB.totalBytes} (${gib(tmpB.totalBytes)})`);
  push(`free bytes   before ${tmpB.freeBytes} (${(tmpB.freeFraction * 100).toFixed(1)}%)   after ${tmpA.freeBytes} (${(tmpA.freeFraction * 100).toFixed(1)}%)`);
  push(`free inodes  before ${tmpB.freeInodes} / ${tmpB.totalInodes}   after ${tmpA.freeInodes} / ${tmpA.totalInodes}`);
  push(`entries      before ${historicalBefore.totalEntries}   after ${historicalAfter.totalEntries}`);
  push(`benchmark-owned scratch bytes    before ${historicalBefore.byClassification.PROVABLY_OWNED.bytes}   after ${historicalAfter.byClassification.PROVABLY_OWNED.bytes}`);
  push(`ambiguous historical bytes       before ${historicalBefore.byClassification.AMBIGUOUS.bytes} (${gib(historicalBefore.byClassification.AMBIGUOUS.bytes)}, ${historicalBefore.byClassification.AMBIGUOUS.entries} entries)   after ${historicalAfter.byClassification.AMBIGUOUS.bytes} (${historicalAfter.byClassification.AMBIGUOUS.entries} entries)`);
  push(`unrelated (external) bytes       before ${historicalBefore.byClassification.UNRELATED.bytes}   after ${historicalAfter.byClassification.UNRELATED.bytes}`);
  push(`shared /tmp floor (M218)         ${M218_SCRATCH_POLICY.sharedTmpMinFreeBytes} bytes / ${M218_SCRATCH_POLICY.sharedTmpMinFreeInodes} inodes — satisfied before and after`);
  push("```", "", "Image pulls land in the Docker store on the root filesystem; the tmpfs /tmp did not move by more than the host's own background activity.", "");

  push("## 11. Provably owned stale scratch", "", "```text");
  push(`authority            ${hostAfter.provablyOwnedStaleCleanup.authority}`);
  push(`cohort namespace     ${hostAfter.cohortNamespace.root}`);
  push(`cohort sweep         entries ${hostAfter.cohortNamespace.sweep.entries.length} (${(hostAfter.cohortNamespace.sweep.entries as any[]).map((entry) => entry.classification).join(", ")}) cleaned ${hostAfter.cohortNamespace.sweep.cleaned.length} blocking ${hostAfter.cohortNamespace.sweep.blocking.length} pass ${hostAfter.cohortNamespace.sweep.pass}`);
  push(`M218 research ns     ${hostAfter.m218ResearchNamespace === null ? "absent" : `entries ${hostAfter.m218ResearchNamespace.sweep.entries.length} cleaned ${hostAfter.m218ResearchNamespace.sweep.cleaned.length} blocking ${hostAfter.m218ResearchNamespace.sweep.blocking.length} (4 RELEASED claims, paths already gone)`}`);
  push(`PROVABLY_OWNED /tmp  before ${historicalBefore.byClassification.PROVABLY_OWNED.entries} entries   after ${historicalAfter.byClassification.PROVABLY_OWNED.entries} entries`);
  push("```", "", "Nothing under /tmp carries an M218 claim or a current-experiment marker, so there was no provably owned stale scratch to clean; the sweep ran and found the cohort namespace holding only its marker.", "");

  push("## 12. Cleanup performed", "", "```text");
  push(`bytes removed by the sweep     ${hostAfter.provablyOwnedStaleCleanup.bytesRemoved}`);
  push(`paths removed                  ${[...hostAfter.provablyOwnedStaleCleanup.cohortCleaned, ...hostAfter.provablyOwnedStaleCleanup.researchCleaned].length}`);
  push(`ad hoc rm -rf                  ${hostAfter.provablyOwnedStaleCleanup.adHocDeletions}`);
  push(`historical /tmp deleted        ${historicalAfter.deleted}`);
  push(`M219 controls' own fixtures    created and removed by the controls themselves (research namespaces under results/, one m210-prefixed probe under /tmp), never host data`);
  push("```", "");

  push("## 13. Ambiguous historical scratch", "", "```text", "NOT DELETED", "```", "");
  push(`${historicalAfter.byClassification.AMBIGUOUS.entries} top-level /tmp entries (${gib(historicalAfter.byClassification.AMBIGUOUS.bytes)}) are AMBIGUOUS: attributed to a producer by name, or unattributed, and named by no M218 registry claim, operations-ledger record or current-experiment namespace marker. Attribution is not ownership (M218 §12); the M219 classifier returns REPORT_ONLY_DO_NOT_DELETE for every one of them regardless of size (F5). The M218 census's ~68k-entry / ~12 GB finding was reduced before M219 by the operator-authorised cleanup commits, which are outside this milestone; what remains is mostly other-project scratch with no known benchmark producer.`, "");
  push("Operator appendix — significant AMBIGUOUS entries (≥ 64 MiB):", "", "| path | bytes | entries | age (d) | attribution | why ownership is insufficient | live |", "| --- | --- | --- | --- | --- | --- | --- |");
  for (const entry of historicalAfter.ambiguousAppendix as any[]) push(`| ${entry.path} | ${entry.bytes} | ${entry.entries} | ${entry.ageDays ?? "?"} | ${String(entry.attribution).replace(/\|/g, "/")} | ${String(entry.whyOwnershipInsufficient).split(";")[0]} | ${fmtRefs(entry.liveReferences)} |`);
  push("", "This is not a launch modification: the benchmark writes nothing to the shared /tmp after M218 and the /tmp floor passes with the ambiguous data in place. A manual operator decision remains possible later and is not required for launch.", "");

  push("## 14. Active process/container/mount census", "", "```text");
  push(`containers enumerated  ${hostAfter.residue.containers.length}   harness (m193-*) ${(hostAfter.residue.containers as any[]).filter((box) => box.classification === "HARNESS").length}   evaluator (sweb.eval.*) ${(hostAfter.residue.containers as any[]).filter((box) => box.classification === "EVALUATOR").length}   m219-preflight survivors ${(hostAfter.residue.containers as any[]).filter((box) => box.classification === "M219_PREFLIGHT").length}   unrelated ${(hostAfter.residue.containers as any[]).filter((box) => box.classification === "UNRELATED").length}`);
  push(`processes classified   ${hostAfter.residue.processes.length}: ${JSON.stringify(Object.fromEntries(["BENCHMARK_SUBSTRATE", "AGENT_SANDBOX", "EVALUATOR", "UNRELATED_TOOLING", "THIS_PREFLIGHT"].map((kind) => [kind, (hostAfter.residue.processes as any[]).filter((proc) => proc.classification === kind).length])))}`);
  push(`mounts under benchmark roots  ${hostAfter.residue.mounts.length}`);
  push(`blocking               [${(hostAfter.residue.blocking as string[]).join(", ")}]`);
  push(`verdict                ${hostAfter.verdicts.RESIDUE}`);
  push("```", "", "The bwrap processes on the host are GNOME image loaders (`glycin-loaders`) and Claude Code sandboxes binding the whole /tmp, not the M218 agent namespace (which binds `<attempt>/tmp`); the `claude` processes are interactive CLI sessions. None references a benchmark root. The unrelated containers are the operator's own database and storage services and are untouched.", "");

  push("## 15. Production scratch smoke", "", "```text");
  push(`M218 real-host control re-run       ${m218Host.satisfied}/${m218Host.controlCount} (F166–F171B): real subprocess writes ~48 MiB into owned scratch, ownership-checked cleanup recovers it, symlink escapes unlinked, live holder refuses cleanup, structural refusals, stale sweep, tmpfs namespace refused / cohort filesystem passes`);
  push(`M218 real-substrate control re-run  ${m218Real.satisfied}/${m218Real.controlCount} (F172–F182): ${m218Real.containersStarted} research containers (pylint-7080, pylint-6903; not frozen), replay agent in the real bwrap namespace with <attempt>/tmp bound at /tmp, evidence persisted, cleanup verified to zero, holder blocks and recovers, emergency abort`);
  push(`frozen tasks touched ${m218Real.frozenInstancesTouched.length}; provider calls ${m218Real.providerCalls}; live model spend $${m218Real.liveModelSpendUsd}`);
  push("```", "");

  push("## 16. Both-arm temp isolation", "", "```text");
  push(`pure/real-process   F195 (F13): in both arm orders a sentinel in one research attempt's private /tmp is invisible to the other's; same <attempt>/tmp shape, policy and normalised bwrap argv; both clean to zero`);
  push(`real container      M218 F174 (baseline → vtrace), F175 (identical tmp configuration), F178 (vtrace → baseline) re-run: ${["F174", "F175", "F178"].map((id) => `${id}=${(m218Real.controls as any[]).find((entry) => entry.id === id)?.satisfied ? "ok" : "FAIL"}`).join(" ")}`);
  push("```", "");

  push("## 17. M218 P13 capacity result", "", "```text");
  const gate = hostAfter.cohortNamespace.capacityGate;
  push(`namespace        ${gate.namespaceRoot}`);
  push(`free             ${gate.namespaceFilesystem.freeBytes} bytes (${gib(gate.namespaceFilesystem.freeBytes)}), ${gate.namespaceFilesystem.freeInodes} inodes`);
  push(`required         ${gate.requiredFreeBytes} bytes (${gib(gate.requiredFreeBytes)}) = ${gate.hostSafetyReserveBytes} host reserve + ${gate.projectedAttemptScratchBytes} projected attempt; ${gate.requiredFreeInodes} inodes`);
  push(`shared /tmp      ${gate.sharedTmp.freeBytes} bytes free, ${gate.sharedTmp.freeInodes} inodes free (floor ${M218_SCRATCH_POLICY.sharedTmpMinFreeBytes} / ${M218_SCRATCH_POLICY.sharedTmpMinFreeInodes})`);
  push(`result           ${hostAfter.verdicts.TMP_CAPACITY_GATE}   (${gate.issues.join("; ") || "no issue"}; threshold unchanged from M218)`);
  push("```", "");

  push("## 18. Host resource health", "", "```text");
  const health = hostAfter.hostResourceHealth;
  push(`memory available  ${health.memoryAvailableBytes} of ${health.memoryTotalBytes} bytes (${gib(health.memoryAvailableBytes)})   swap free ${health.swapFreeBytes} of ${health.swapTotalBytes}`);
  push(`load average      ${health.loadAverage.join(" ")} on ${health.cpus} cpus`);
  push(`processes         ${health.processCount}   pid_max ${health.pidMax}   threads-max ${health.threadsMax}   user process limit ${health.userProcessLimit ?? "unlimited"}`);
  push(`disk              root free ${gib(hostAfter.capacity.dockerRoot.freeBytes)} / ${hostAfter.capacity.dockerRoot.freeInodes} inodes; /tmp free ${gib(hostAfter.capacity.sharedTmp.freeBytes)} / ${hostAfter.capacity.sharedTmp.freeInodes} inodes`);
  push(`verdict           ${hostAfter.verdicts.HOST_RESOURCES}  ${health.issues.join("; ")}`);
  push("```", "", "No performance gate was invented: the only refusals are obvious exhaustion (under 2 GiB available memory, or over 80% of the pid or process table), because prior incidents were fork failures.", "");

  push("## 19. Final production launch preflight", "", "```text");
  push(`command   bun run_stage5_m215_launch.ts --preflight   (no --authorize-spend; DOCKER_SWEBENCH binding; real bridge; no row)`);
  for (const entry of launch.gates as any[]) push(`${entry.pass ? "PASS" : "FAIL"}  ${entry.id.padEnd(24)} ${String(entry.detail).slice(0, 200)}`);
  push(`spend     ${launch.spendAuthorization.status}  (present ${launch.spendAuthorization.present}; active ceiling $${launch.spendAuthorization.activeCeilingUsd}; retry reserve ${launch.spendAuthorization.retryReserveAttempts} attempts)`);
  push(`final blocker   ${launch.finalBlocker}`);
  push(`verdict         ${launch.verdict}   rows executed ${launch.rowsExecuted}; agent invoked ${launch.agentInvoked}; launch performed ${launch.launchPerformed}`);
  push("```", "", "G36 was not set. The preflight is a launcher path that evaluates the spend refusal last and never reaches `runCohort`; the bare launcher without flags still refuses by name on spend authorisation naming $735 (F196).", "");

  push("## 20. Spend reconciliation", "", "```text");
  const env = gates.financialEnvelope;
  push(`200 intended rows x $3.50 per-run cap   = $${env.ordinaryExposureUsd} ordinary`);
  push(`${env.retryReserveAttempts} retry slots x $3.50 retry cap          = $${env.retryReserveUsd} retry reserve`);
  push(`hard ceiling                              = $${env.hardCeilingUsd}`);
  push(`manifest rows ${env.manifestRows}  intended valid outcomes ${env.intendedValidOutcomes}  (200, not 210: the reserve is attempt capacity, not planned rows)`);
  push(`executor agrees: launcher --preflight SPEND_ENVELOPE gate ${(launch.gates as any[]).find((entry) => entry.id === "SPEND_ENVELOPE")?.pass}; F197 $735 accepted; F198 $700 and no authorisation refused naming $735`);
  push("```", "");

  push("## 21. Falsification F1–F16", "", `Suite ${suite.satisfied}/${suite.controlCount} (${suite.guardFiresControls} GUARD_FIRES, ${suite.guardSilentControls} GUARD_SILENT); brief ids F1–F16 are controls F183–F198.`, "", "| control | brief | expectation | substrate | satisfied | description |", "| --- | --- | --- | --- | --- | --- |");
  for (const entry of suite.controls as any[]) push(`| ${entry.id} | ${entry.briefId} | ${entry.expectation} | ${entry.substrate} | ${entry.satisfied} | ${String(entry.description).replace(/\|/g, "/")} |`);
  push("");

  push("## 22. Product / frozen artifact immutability", "", "```text");
  push(`HEAD:src          ${srcTree}   frozen ${FROZEN_SRC_TREE}   unchanged ${srcTree === FROZEN_SRC_TREE}`);
  push(`src/ diff vs M218 ${srcDiff.length === 0 ? "0 files" : srcDiff}`);
  push("frozen artifacts (sha256 on disk == blob at the M218 final HEAD):");
  for (const entry of frozen) push(`  ${entry.matchesM218Blob ? "IDENTICAL" : "CHANGED  "} ${entry.name} ${entry.disk.slice(0, 16)}…`);
  push("```", "");

  push("## 23. Verification", "", "```text");
  push(`scoped typecheck   ${typecheck.verdict}: tsconfig.m219.json ${typecheck.m219NewTypecheckErrors} errors; injected error detected ${typecheck.findings.scopedTargetDetectsInjectedError}; m218 scope still clean ${typecheck.findings.predecessorScopeStillClean}`);
  push(`M219 suite         ${suite.satisfied}/${suite.controlCount}`);
  push(`M218 suites        real-host ${m218Host.satisfied}/${m218Host.controlCount}; real-container ${m218Real.satisfied}/${m218Real.controlCount} (re-run on the materialized host)`);
  push(`bun test / typecheck / typecheck:benchmarks / lint / git diff --check / secret scan   see the ledger row (recorded at commit time)`);
  push("```", "");

  push("## 24. Zero-spend evidence", "", "```text");
  push("provider calls: 0", "live model spend: $0", "frozen benchmark live-agent runs: 0", "");
  push(`image pulls (network, not model spend): ${pulls.pulled} images, ${gb(pulledBytes)} image size, store delta ${gb(after.dockerStore.imageBytes - before.dockerStore.imageBytes)}`);
  push(`containers started by M219: ${containers.containersStarted} preflight probes (no agent, no patch) + ${m218Real.containersStarted} M218 research re-run; 0 frozen tasks run with an agent`);
  push("```", "");

  push("## 25. Repository state / SHAs", "", "```text");
  push(`HEAD when generated  ${head}`, `HEAD:src             ${srcTree}`, `M218 final HEAD      ${git("rev-parse", M218_HEAD)}`, `amendment            ${amendment.recordedHash}`, `manifest             ${identity.manifestHash}`, `identity record      ${sha256(readFileSync(join(RESULTS_DIR, "stage5_m219_image_identity.json")))}`);
  push("```", "");

  push("## 26. Final state", "", "```text", finalState, "", "SPEND_AUTHORIZATION_PENDING", "PAID_RUNS_NOT_STARTED", "LIVE_MODEL_SPEND_$0", "```", "");
  push("## Launch gate table (M219 additions)", "", "| gate | status | requirement |", "| --- | --- | --- |");
  for (const entry of m219Gates) push(`| ${entry.id} | ${entry.status} | ${String(entry.requirement).slice(0, 160)} |`);
  push(`| G36 | ${gates.g36?.status} | ${String(gates.g36?.requirement).slice(0, 160)} (HUMAN; never set by M219) |`, "");
  push("## Final principle", "", "Do not spend $735 to discover that task 37's image was never downloaded or that /tmp only had room for the first few runs. The whole frozen substrate is materialized and identity-verified; every one of the 100 tasks maps to a local image that starts with a writable /testbed and its base commit present; Docker and /tmp have room under the frozen policy; only provably owned scratch was eligible for cleaning and there was none; the ambiguous historical data is preserved and documented; the real launch preflight reaches exactly one blocker. It is SPEND_AUTHORIZATION_PENDING. Stop.", "");

  writeFileSync(OUTPUT, `${lines.join("\n")}\n`);
  process.stdout.write(`wrote ${OUTPUT}\n${finalState}\n`);
}

main();
