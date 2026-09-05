/**
 * M219 §28 — the operator-preflight falsification suite.
 *
 * Brief ids F1–F16 are realised as controls F183–F198 (M218 ended at F182),
 * with the brief id on each control. Pure controls drive the M219 functions
 * with injected facts; REAL_PROCESS controls exercise the real filesystem, the
 * real Docker inventory and the real launcher as a subprocess. No model, no
 * provider, no frozen task, no container started by this suite (the launcher's
 * preflight starts the substrate bridge, not a container).
 */

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { RunManifestRow } from "./m214Preregistration";
import { M215_MANIFEST_FILE, auditSpendAuthorization } from "./m215LaunchExecutor";
import { type M217Control, control, suitePasses } from "./m217Falsification";
import {
  HostLivenessProbe,
  M218_SCRATCH_POLICY,
  ScratchAuthority,
  ScratchRegistry,
  ScratchSafetyError,
  SyntheticLivenessProbe,
  auditArmTmpEquivalence,
  capacityGate,
  establishNamespace,
  forbiddenRootReason,
  removeTreeNoFollow,
  sweepNamespace,
} from "./m218ScratchLifecycle";
import { loadActiveSpendAuthority } from "./m218SpendAuthority";
import {
  type ImageIdentityRecord,
  type InspectedImage,
  M219_IMAGE_IDENTITY_FILE,
  M219_TMP_ATTRIBUTIONS,
  classifyHistoricalEntry,
  dockerImageInspector,
  imagePreflight,
  requiredImagePopulation,
  scanForForbiddenOperations,
} from "./m219OperatorPreflight";

export const M219_SUITE_VERSION = "stage5.m219.falsification.v1" as const;
export { control, suitePasses };

const RESEARCH_EXPERIMENT = "M219_RESEARCH_NON_EVALUATION";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** The production-path sources F11 scans: the M219 runners plus every authority they call into. */
export function productionPathFiles(benchmarkDir: string): readonly string[] {
  return [
    "m219OperatorPreflight.ts", "run_stage5_m219_image_materialization.ts", "run_stage5_m219_host_preflight.ts",
    "run_stage5_m219_container_census.ts", "run_stage5_m215_launch.ts", "m218ScratchLifecycle.ts", "m218IsolationProbe.ts",
    "m217LaunchBinding.ts", "m216ProductionAdapters.ts", "m216_substrate_bridge.py", "m193_container_adapter.py", "m215LaunchExecutor.ts",
  ].map((name) => join(benchmarkDir, name));
}

export interface M219SuiteInput {
  readonly benchmarkDir: string;
  readonly resultsDir: string;
  readonly cohortDir: string;
}

export async function runM219FalsificationSuite(input: M219SuiteInput): Promise<readonly M217Control[]> {
  const controls: M217Control[] = [];
  const manifest = (JSON.parse(readFileSync(join(input.resultsDir, M215_MANIFEST_FILE), "utf8")) as { rows: RunManifestRow[] }).rows;
  const record = JSON.parse(readFileSync(join(input.resultsDir, M219_IMAGE_IDENTITY_FILE), "utf8")) as ImageIdentityRecord;
  const recordInspector = (reference: string): InspectedImage | null => {
    const entry = record.images.find((image) => image.containerImage === reference);
    return entry === undefined ? null : { imageId: entry.imageId, repoDigests: entry.repoDigest === null ? [] : [entry.repoDigest] };
  };

  // ── F1 (F183): one required image missing → launch preflight fails ──
  {
    const victim = record.images[37]!.containerImage;
    const result = imagePreflight(manifest, record, (reference) => (reference === victim ? null : recordInspector(reference)));
    const fired: string[] = [];
    if (result.verdict === "IMAGE_PREFLIGHT_FAIL") fired.push("verdict IMAGE_PREFLIGHT_FAIL");
    if (result.issues.some((issue) => issue.includes(victim) && issue.includes("absent locally"))) fired.push(`the missing image ${victim} is named`);
    if (result.rowsResolved === manifest.length - 2) fired.push("exactly the two rows of that task fail to resolve");
    controls.push(control("F183", "F1", "with one required image absent from the local store (task 37's), the image preflight fails, names the image, and exactly that task's two rows do not resolve", "GUARD_FIRES", fired.length >= 3 ? fired : []));
  }

  // ── F2 (F184): all required images present → pass, on the REAL store ──
  {
    const real = imagePreflight(manifest, record, dockerImageInspector);
    const issues: string[] = [];
    if (real.verdict !== "IMAGE_PREFLIGHT_PASS") issues.push(`verdict ${real.verdict}: ${real.issues.slice(0, 3).join("; ")}`);
    if (real.rowsResolved !== 200 || real.rowsIdentityVerified !== 200) issues.push(`resolved ${real.rowsResolved} identity-verified ${real.rowsIdentityVerified}`);
    if (real.uniqueImages !== 100) issues.push(`unique images ${real.uniqueImages}`);
    if (real.networkPullRequested !== false) issues.push("a pull was requested");
    controls.push(control("F184", "F2", "against the real Docker store, all 200 frozen rows resolve without a pull to a local image whose id and registry digest match the identity record", "GUARD_SILENT", issues, "REAL_PROCESS"));
  }

  // ── F3 (F185): same name, wrong immutable identity → fail ──
  {
    const mutated: ImageIdentityRecord = { ...record, images: record.images.map((image, index) => (index === 5 ? { ...image, imageId: "sha256:" + "0".repeat(64) } : image)) };
    const byId = imagePreflight(manifest, mutated, recordInspector);
    const mutatedDigest: ImageIdentityRecord = { ...record, images: record.images.map((image, index) => (index === 6 ? { ...image, repoDigest: `${image.containerImage.split(":")[0]}@sha256:${"1".repeat(64)}` } : image)) };
    const byDigest = imagePreflight(manifest, mutatedDigest, recordInspector);
    const fired: string[] = [];
    if (byId.verdict === "IMAGE_PREFLIGHT_FAIL" && byId.issues.some((issue) => issue.includes("image id differs"))) fired.push("an image-id mismatch under the same name is refused");
    if (byDigest.verdict === "IMAGE_PREFLIGHT_FAIL" && byDigest.issues.some((issue) => issue.includes("registry digest"))) fired.push("a registry-digest mismatch under the same name is refused");
    if (byId.rowsIdentityVerified === manifest.length - 2 && byDigest.rowsIdentityVerified === manifest.length - 2) fired.push("only the mutated image's two rows lose identity verification");
    controls.push(control("F185", "F3", "an image whose name is present but whose immutable id, or whose registry digest, differs from the recorded identity fails the preflight for exactly its rows", "GUARD_FIRES", fired.length >= 3 ? fired : []));
  }

  // ── F4 (F186): frozen task→image mapping mutated → fail ──
  {
    const swapped = manifest.map((row, index) => (index === 10 ? { ...row, containerImage: manifest[20]!.containerImage } : row));
    const swappedResult = imagePreflight(swapped, record, recordInspector);
    const renamed = manifest.map((row, index) => (index === 11 ? { ...row, containerImage: "swebench/sweb.eval.x86_64.django_1776_django-99999:latest" } : row));
    const renamedResult = imagePreflight(renamed, record, recordInspector);
    const population = requiredImagePopulation(swapped);
    const fired: string[] = [];
    if (swappedResult.verdict === "IMAGE_PREFLIGHT_FAIL" && swappedResult.issues.some((issue) => issue.includes("not for task"))) fired.push("a row re-pointed at another task's image is refused because the image is recorded for a different task");
    if (swappedResult.rowsIdentityVerified === manifest.length - 1) fired.push("exactly the re-pointed row loses identity verification");
    if (population.issues.some((issue) => issue.includes("maps to 2 images"))) fired.push("the population derivation sees the task mapped to two images");
    if (renamedResult.verdict === "IMAGE_PREFLIGHT_FAIL" && renamedResult.issues.some((issue) => issue.includes("not in the identity record"))) fired.push("a row naming an unrecorded image is refused as a mapping change");
    controls.push(control("F186", "F4", "a mutation of the frozen task→image mapping (a row re-pointed at another task's image, or at an unrecorded image) is refused by the preflight and by the population derivation", "GUARD_FIRES", fired.length >= 4 ? fired : []));
  }

  // ── F5 (F187): an ambiguous /tmp path is classified AMBIGUOUS and never deleted ──
  {
    const probe = mkdtempSync(join(tmpdir(), "m210-m219-ambiguous-probe-"));
    writeFileSync(join(probe, "corpus.bin"), Buffer.alloc(1 << 20, 7));
    const research = mkdtempSync(join(input.resultsDir, "_m219_f5_"));
    const issues: string[] = [];
    try {
      const namespace = establishNamespace(join(research, "_work"), { experiment: RESEARCH_EXPERIMENT, cohortDir: research });
      const registry = new ScratchRegistry(join(research, "_scratch_registry"));
      const liveness = new HostLivenessProbe({ docker: false });
      const entry = classifyHistoricalEntry(probe, probe.split("/").pop()!, M219_TMP_ATTRIBUTIONS, { registries: [registry], namespaceRoots: [namespace.canonicalRoot] }, liveness, { bytes: 1 << 20, entries: 2, ageDays: 0 });
      if (entry.classification !== "AMBIGUOUS") issues.push(`classified ${entry.classification}`);
      if (entry.disposition !== "REPORT_ONLY_DO_NOT_DELETE") issues.push(`disposition ${entry.disposition}`);
      if (entry.whyOwnershipInsufficient === null || !entry.whyOwnershipInsufficient.includes("attribution, not ownership")) issues.push("no ownership-insufficiency reason");
      // The only deletion authority M219 runs is the sweep; run it and the direct removal path against the probe.
      const sweep = sweepNamespace(namespace, registry, liveness);
      if (!sweep.pass) issues.push("sweep blocked on a fresh namespace");
      let refused = false;
      try {
        removeTreeNoFollow(namespace, probe);
      } catch (error) {
        refused = error instanceof ScratchSafetyError;
      }
      if (!refused) issues.push("removeTreeNoFollow did not refuse the ambiguous /tmp path");
      if (!existsSync(join(probe, "corpus.bin"))) issues.push("the ambiguous path was deleted");
    } finally {
      rmSync(research, { recursive: true, force: true });
      rmSync(probe, { recursive: true, force: true }); // ours: created by this control
    }
    controls.push(control("F187", "F5", "a benchmark-prefixed /tmp directory with no ownership record is classified AMBIGUOUS / REPORT_ONLY, the sweep does not touch it, the removal authority refuses it, and it survives", "GUARD_SILENT", issues, "REAL_PROCESS"));
  }

  // ── F6 (F188): provably owned stale scratch is safely deleted by the sweep ──
  // ── F7 (F189): owned scratch with a live process is not deleted and blocks ──
  {
    const research = mkdtempSync(join(input.resultsDir, "_m219_f6f7_"));
    const f6: string[] = [];
    const f7: string[] = [];
    let holder: ReturnType<typeof spawn> | null = null;
    try {
      const namespace = establishNamespace(join(research, "_work"), { experiment: RESEARCH_EXPERIMENT, cohortDir: research });
      const authority = new ScratchAuthority({
        namespace, registry: new ScratchRegistry(join(research, "_scratch_registry")), evidenceDir: join(research, "evidence"),
        liveness: new HostLivenessProbe({ docker: false }), experiment: RESEARCH_EXPERIMENT, executorVersion: "m219-falsification",
      });
      const row = manifest[0]!;
      const stale = authority.claim(row, `${row.runId}#f6#stale`, 1);
      writeFileSync(join(stale.agentTmp, "leftover.bin"), Buffer.alloc(2 << 20, 3));
      authority.registry.update(stale.claimId, { creator: { ...stale.creator, pid: 999_999_991 } });
      const sweep = authority.sweep();
      const entry = sweep.entries.find((candidate) => candidate.path === stale.path);
      if (entry?.classification !== "STALE_CLEANABLE" || !entry.cleaned) f6.push(`sweep ${entry?.classification} cleaned ${entry?.cleaned}`);
      if (!entry?.ownershipEvidence.some((line) => line.startsWith("claim "))) f6.push("no ownership proof recorded");
      if (existsSync(stale.path)) f6.push("stale owned path survived");
      if (authority.registry.read(stale.claimId)?.state !== "RELEASED") f6.push("claim not released");
      if (!sweep.pass) f6.push(`sweep blocked: ${sweep.blocking.join(", ")}`);

      const held = authority.claim(row, `${row.runId}#f7#held`, 2);
      writeFileSync(join(held.agentTmp, "in-use"), "held");
      holder = spawn("python3", ["-c", "import time; time.sleep(600)", held.path], { cwd: held.agentTmp, detached: true, stdio: "ignore" });
      holder.unref();
      await sleep(400);
      authority.registry.update(held.claimId, { creator: { ...held.creator, pid: 999_999_992 } });
      const blocked = authority.sweep();
      const heldEntry = blocked.entries.find((candidate) => candidate.path === held.path);
      if (heldEntry?.classification !== "STALE_UNSAFE") f7.push(`classified ${heldEntry?.classification}`);
      if (heldEntry?.cleaned !== false || !existsSync(join(held.agentTmp, "in-use"))) f7.push("held scratch was deleted");
      if (!blocked.blocking.includes(held.path) || blocked.pass) f7.push("sweep did not block");
      if (!heldEntry?.liveChecks.some((line) => line.includes(String(holder.pid)))) f7.push(`holder pid ${holder.pid} not listed`);
      const cleanup = authority.cleanup(authority.registry.read(held.claimId)!, { containerRemoved: true });
      if (cleanup.status !== "REFUSED_LIVE_OWNER") f7.push(`direct cleanup ${cleanup.status}`);
      process.kill(holder.pid!, "SIGKILL");
      await sleep(400);
      const after = authority.sweep();
      if (!after.pass) f7.push(`after the holder died the sweep still blocks: ${after.blocking.join(", ")}`);
    } finally {
      if (holder?.pid !== undefined) { try { process.kill(holder.pid, "SIGKILL"); } catch { /* gone */ } }
      rmSync(research, { recursive: true, force: true });
    }
    controls.push(control("F188", "F6", "scratch owned by a registered claim whose creator is dead and which nothing references is classified STALE_CLEANABLE by ownership facts, removed by the production sweep, and its claim released", "GUARD_SILENT", f6, "REAL_PROCESS"));
    controls.push(control("F189", "F7", "owned scratch held by a live process is STALE_UNSAFE: not deleted, listed with the holder's pid, blocking; direct cleanup is REFUSED_LIVE_OWNER; after the holder dies the sweep clears", "GUARD_SILENT", f7, "REAL_PROCESS"));
  }

  // ── F8 (F190): owned scratch referenced by a live container / mount → no deletion + block ──
  {
    const research = mkdtempSync(join(input.resultsDir, "_m219_f8_"));
    const issues: string[] = [];
    try {
      const namespace = establishNamespace(join(research, "_work"), { experiment: RESEARCH_EXPERIMENT, cohortDir: research });
      const liveness = new SyntheticLivenessProbe();
      const authority = new ScratchAuthority({
        namespace, registry: new ScratchRegistry(join(research, "_scratch_registry")), evidenceDir: join(research, "evidence"),
        liveness, experiment: RESEARCH_EXPERIMENT, executorVersion: "m219-falsification",
      });
      for (const [kind, rowIndex] of [["CONTAINER", 1], ["MOUNT", 3]] as const) {
        const row = manifest[rowIndex]!;
        const claim = authority.claim(row, `${row.runId}#f8#${kind}`, 1);
        writeFileSync(join(claim.path, "testbed-marker"), kind);
        liveness.references.set(claim.path, [{ kind, detail: kind === "CONTAINER" ? `m193-${row.instanceId} (running) binds ${claim.path}/testbed` : `mount at ${claim.path}/testbed` }]);
        authority.registry.update(claim.claimId, { creator: { ...claim.creator, pid: 999_999_993 } });
        const sweep = authority.sweep();
        const entry = sweep.entries.find((candidate) => candidate.path === claim.path);
        if (entry?.classification !== "STALE_UNSAFE" || entry.cleaned) issues.push(`${kind}: classified ${entry?.classification} cleaned ${entry?.cleaned}`);
        if (!existsSync(join(claim.path, "testbed-marker"))) issues.push(`${kind}: deleted under a live reference`);
        if (sweep.pass || !sweep.blocking.includes(claim.path)) issues.push(`${kind}: did not block`);
        const cleanup = authority.cleanup(authority.registry.read(claim.claimId)!, { containerRemoved: kind !== "CONTAINER" });
        if (cleanup.verified) issues.push(`${kind}: direct cleanup verified despite the live reference`);
      }
    } finally {
      rmSync(research, { recursive: true, force: true });
    }
    controls.push(control("F190", "F8", "owned scratch still bound into a live container, or under a live mount, is STALE_UNSAFE: not deleted, blocking, and direct cleanup does not verify (real-container form: M218 F176/F132 re-run)", "GUARD_SILENT", issues));
  }

  // ── F9 (F191) / F10 (F192): capacity below / at the M218 threshold ──
  {
    const research = mkdtempSync(join(input.resultsDir, "_m219_f9_"));
    const fired: string[] = [];
    const silent: string[] = [];
    try {
      const namespace = establishNamespace(join(research, "_work"), { experiment: RESEARCH_EXPERIMENT, cohortDir: research });
      const required = M218_SCRATCH_POLICY.hostSafetyReserveBytes + M218_SCRATCH_POLICY.projectedAttemptScratchBytes;
      const reader = (free: number) => (path: string) => ({ path, totalBytes: 2 * required, freeBytes: free, freeFraction: free / (2 * required), totalInodes: 10_000_000, freeInodes: 5_000_000, measuredAt: "2026-09-05T00:00:00.000Z" });
      const below = capacityGate(namespace, M218_SCRATCH_POLICY, reader(required - 1), () => "2026-09-05T00:00:00.000Z", null);
      if (!below.pass && below.issues.some((issue) => issue.includes("the policy requires"))) fired.push(`one byte below ${required} refused`);
      const lowInodes = capacityGate(namespace, M218_SCRATCH_POLICY, (path) => ({ ...reader(10 * required)(path), freeInodes: 1000 }), () => "2026-09-05T00:00:00.000Z", null);
      if (!lowInodes.pass && lowInodes.issues.some((issue) => issue.includes("inodes"))) fired.push("low inodes refused with ample bytes");
      const at = capacityGate(namespace, M218_SCRATCH_POLICY, reader(required), () => "2026-09-05T00:00:00.000Z", null);
      if (!at.pass) silent.push(`at threshold refused: ${at.issues.join("; ")}`);
      // The real cohort namespace on the real filesystem, through the launcher's own authority.
      const { buildScratchAuthority } = await import("./run_stage5_m215_launch");
      const realGate = buildScratchAuthority(input.cohortDir, () => new Date().toISOString()).capacityGate();
      if (!realGate.pass) silent.push(`the real cohort namespace fails P13: ${realGate.issues.join("; ")}`);
      if (realGate.requiredFreeBytes !== required) silent.push("the real gate uses a different threshold than the frozen policy");
    } finally {
      rmSync(research, { recursive: true, force: true });
    }
    controls.push(control("F191", "F9", "with free space one byte below the M218 threshold, or with too few inodes, P13 refuses before any claim", "GUARD_FIRES", fired.length >= 2 ? fired : []));
    controls.push(control("F192", "F10", "at the threshold the gate passes, and the real cohort namespace on the real filesystem passes the same frozen policy through the launcher's own scratch authority", "GUARD_SILENT", silent, "REAL_PROCESS"));
  }

  // ── F11 (F193): no global Docker prune / rmi / tmp-root deletion on the production path ──
  {
    const scan = scanForForbiddenOperations(productionPathFiles(input.benchmarkDir));
    const positive = scanForForbiddenOperations(["synthetic.sh"], () => "set -e\ndocker system prune -a -f\nrm -rf /tmp/*\n");
    const issues: string[] = [];
    if (!scan.pass) issues.push(`forbidden operations found: ${scan.hits.map((hit) => `${hit.file}:${hit.line} ${hit.text}`).join(" | ")}`);
    if (scan.files.some((file) => !existsSync(file))) issues.push("a production-path file is missing from the scan");
    if (positive.pass || positive.hits.length < 2) issues.push("the scanner does not detect a deliberate prune / tmp wipe");
    controls.push(control("F193", "F11", "the M219 runners, the launcher, the scratch authority, the adapters and the bridge contain no docker system/image/container/volume prune, no rmi and no /tmp-root deletion, and the scanner detects a deliberate one", "GUARD_SILENT", issues, "REAL_PROCESS"));
  }

  // ── F12 (F194): /tmp root deletion is structurally impossible ──
  {
    const research = mkdtempSync(join(input.resultsDir, "_m219_f12_"));
    const fired: string[] = [];
    try {
      const namespace = establishNamespace(join(research, "_work"), { experiment: RESEARCH_EXPERIMENT, cohortDir: research });
      for (const target of ["/tmp", tmpdir(), "/", "", "/tmp/"]) {
        if (forbiddenRootReason(target) !== null) fired.push(`${JSON.stringify(target)} is a forbidden root`);
        try {
          removeTreeNoFollow(namespace, target);
        } catch (error) {
          if (error instanceof ScratchSafetyError) fired.push(`removal of ${JSON.stringify(target)} refused`);
        }
      }
      try {
        establishNamespace("/tmp", { experiment: RESEARCH_EXPERIMENT, cohortDir: research });
      } catch (error) {
        if (error instanceof ScratchSafetyError) fired.push("a namespace at /tmp itself is refused");
      }
    } finally {
      rmSync(research, { recursive: true, force: true });
    }
    controls.push(control("F194", "F12", "/tmp, the host tmpdir, /, an empty path and a trailing-slash /tmp are forbidden roots, their removal is refused by the authority, and a namespace cannot be established at /tmp", "GUARD_FIRES", fired.length >= 11 ? fired : [], "REAL_PROCESS"));
  }

  // ── F13 (F195): baseline / vtrace research attempts cannot see each other's sentinel ──
  {
    const research = mkdtempSync(join(input.resultsDir, "_m219_f13_"));
    const issues: string[] = [];
    try {
      const namespace = establishNamespace(join(research, "_work"), { experiment: RESEARCH_EXPERIMENT, cohortDir: research });
      const authority = new ScratchAuthority({
        namespace, registry: new ScratchRegistry(join(research, "_scratch_registry")), evidenceDir: join(research, "evidence"),
        liveness: new HostLivenessProbe({ docker: false }), experiment: RESEARCH_EXPERIMENT, executorVersion: "m219-falsification",
      });
      const baseline = manifest.find((row) => row.arm === "baseline")!;
      const vtrace = manifest.find((row) => row.arm === "vtrace" && row.instanceId === baseline.instanceId)!;
      for (const order of [[baseline, vtrace], [vtrace, baseline]] as const) {
        const first = authority.claim(order[0], `${order[0].runId}#f13#${order[0].arm}-first`, 1);
        writeFileSync(join(first.agentTmp, "m219-sentinel"), order[0].arm);
        const second = authority.claim(order[1], `${order[1].runId}#f13#${order[1].arm}-second`, 1);
        if (existsSync(join(second.agentTmp, "m219-sentinel"))) issues.push(`${order[0].arm} → ${order[1].arm}: sentinel visible`);
        if (first.agentTmp === second.agentTmp || !first.agentTmp.endsWith("/tmp") || !second.agentTmp.endsWith("/tmp")) issues.push("private /tmp shape differs or is shared");
        const argv = (attempt: string) => ["bwrap", "--unshare-all", "--bind", `${attempt}/tmp`, "/tmp", "--", "agent"];
        const equivalence = auditArmTmpEquivalence(
          { sandboxArgv: argv(first.path), attemptPath: first.path, envNames: ["TMPDIR", "PATH"] },
          { sandboxArgv: argv(second.path), attemptPath: second.path, envNames: ["PATH", "TMPDIR"] },
        );
        if (equivalence.length > 0) issues.push(`arms not equivalent: ${equivalence.join("; ")}`);
        for (const claim of [first, second]) {
          const cleanup = authority.cleanup(authority.registry.read(claim.claimId)!, { containerRemoved: true });
          if (!cleanup.verified) issues.push(`cleanup of ${claim.attemptId} ${cleanup.status}`);
        }
      }
      if (!authority.sweep().pass) issues.push("residue after both orders");
    } finally {
      rmSync(research, { recursive: true, force: true });
    }
    controls.push(control("F195", "F13", "in both arm orders a sentinel written into one research attempt's private /tmp is invisible to the other arm's, both receive the same <attempt>/tmp shape, policy and normalised sandbox argv, and both clean to zero (real-container form: M218 F174/F175/F178 re-run)", "GUARD_SILENT", issues, "REAL_PROCESS"));
  }

  // ── F14 (F196): every technical gate passes, no spend authorisation → refused ONLY on spend ──
  {
    const launcher = join(input.benchmarkDir, "run_stage5_m215_launch.ts");
    const preflight = spawnSync("bun", [launcher, "--preflight", "--cohort-dir", input.cohortDir], { encoding: "utf8", timeout: 900_000, maxBuffer: 64 * 1024 * 1024 });
    const issues: string[] = [];
    let document: Record<string, unknown> | null = null;
    try {
      document = JSON.parse(preflight.stdout) as Record<string, unknown>;
    } catch {
      issues.push(`preflight did not print a JSON document (exit ${preflight.status}): ${preflight.stderr.slice(-400)}`);
    }
    if (document !== null) {
      if (document.verdict !== "FINAL_ZERO_SPEND_LAUNCH_PREFLIGHT_PASSED") issues.push(`verdict ${String(document.verdict)}: ${JSON.stringify(document.technicalBlockers)}`);
      if (document.finalBlocker !== "SPEND_AUTHORIZATION_PENDING") issues.push(`final blocker ${String(document.finalBlocker)}`);
      if (document.launchPerformed !== false || document.rowsExecuted !== 0 || document.agentInvoked !== false || document.providerCalls !== 0) issues.push("the preflight performed work it must not");
      if (preflight.status !== 0) issues.push(`preflight exit ${preflight.status}`);
    }
    // The bare launcher, with no flags, must still refuse by name on spend authorisation.
    const bare = spawnSync("bun", [launcher, "--cohort-dir", input.cohortDir], { encoding: "utf8", timeout: 300_000 });
    if (bare.status === 0) issues.push("the bare launcher exited 0 without authorisation");
    if (!/refusing to launch: no spend authorisation/.test(bare.stderr)) issues.push(`the bare launcher did not refuse on spend authorisation: ${bare.stderr.slice(-300)}`);
    if (!/\$735/.test(bare.stderr)) issues.push("the refusal does not name the active $735 ceiling");
    controls.push(control("F196", "F14", "the production launcher's --preflight passes every technical gate and stops at SPEND_AUTHORIZATION_PENDING without running a row; the bare launcher refuses by name on spend authorisation naming $735", "GUARD_SILENT", issues, "REAL_PROCESS"));
  }

  // ── F15 (F197) / F16 (F198): the active authority is $735; a $700 authorisation is refused ──
  {
    const authority = loadActiveSpendAuthority(input.resultsDir);
    const base = { authorized: true as const, authorizedByOperator: "m219-control", authorizedAt: "2026-09-05T00:00:00.000Z", statement: "falsification control; never used for a launch" };
    const silent: string[] = [];
    if (authority.hardCeilingUsd !== 735 || authority.retryReserveAttempts !== 10 || authority.retryReserveUsd !== 35 || authority.ordinaryExposureUsd !== 700) silent.push(`authority ${authority.ordinaryExposureUsd}+${authority.retryReserveUsd}=${authority.hardCeilingUsd} / ${authority.retryReserveAttempts}`);
    const ok = auditSpendAuthorization({ ...base, authorizedCeilingUsd: 735 }, "COHORT", authority.hardCeilingUsd);
    if (ok.length > 0) silent.push(`a $735 authorisation is refused: ${ok.join("; ")}`);
    controls.push(control("F197", "F15", "the active spend authority is $700 + $35 = $735 for 10 retry attempts, and an authorisation of exactly $735 passes P7", "GUARD_SILENT", silent));
    const old = auditSpendAuthorization({ ...base, authorizedCeilingUsd: 700 }, "COHORT", authority.hardCeilingUsd);
    const fired: string[] = [];
    if (old.some((issue) => issue.includes("$700") && issue.includes("$735"))) fired.push("a $700 authorisation is refused against the active $735");
    const none = auditSpendAuthorization(null, "COHORT", authority.hardCeilingUsd);
    if (none.some((issue) => issue.includes("$735"))) fired.push("no authorisation is refused naming $735");
    controls.push(control("F198", "F16", "an authorisation of the original $700 ceiling is refused by P7 against the M214 + A1 active authority, as is no authorisation, both naming $735", "GUARD_FIRES", fired.length >= 2 ? fired : []));
  }

  return controls;
}

/** Write the suite document the readiness derivation reads. */
export function suiteDocument(controls: readonly M217Control[], extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: M219_SUITE_VERSION,
    milestone: "M219",
    generatedAt: new Date().toISOString(),
    controlCount: controls.length,
    satisfied: controls.filter((entry) => entry.satisfied).length,
    failures: controls.filter((entry) => !entry.satisfied).map((entry) => entry.id),
    guardFiresControls: controls.filter((entry) => entry.expectation === "GUARD_FIRES").length,
    guardSilentControls: controls.filter((entry) => entry.expectation === "GUARD_SILENT").length,
    suitePasses: suitePasses(controls),
    liveModelSpendUsd: 0,
    providerCalls: 0,
    frozenBenchmarkTaskLiveAgentRuns: 0,
    frozenInstancesTouched: [],
    containersStarted: 0,
    controls,
    ...extra,
  };
}

export function ensureResultsDir(dir: string): void {
  mkdirSync(dir, { recursive: true });
}
