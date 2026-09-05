/**
 * M218 §49 — the real-host scratch control, on the real shared /tmp.
 *
 * A uniquely owned M218 research namespace is created beneath the host's own
 * temporary directory; a REAL subprocess writes real bytes into a claimed
 * attempt path; cleanup runs through the ownership-checked, symlink-safe
 * authority; free space is measured by statfs before and after; an unrelated
 * sentinel beside the namespace must survive; a real detached process holding
 * the path must make cleanup refuse until it is gone. No container, no
 * provider, no frozen task, no directory that M218 does not own.
 *
 *   bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m218_real_host.ts
 */

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import type { RunManifestRow } from "./m214Preregistration";
import { M215_MANIFEST_FILE } from "./m215LaunchExecutor";
import { type M217Control, control, suitePasses } from "./m217Falsification";
import {
  HostLivenessProbe,
  ScratchAuthority,
  ScratchRegistry,
  ScratchSafetyError,
  establishNamespace,
  filesystemCapacity,
  forbiddenRootReason,
  measureTree,
  removeTreeNoFollow,
} from "./m218ScratchLifecycle";

const RESULTS_DIR = join(import.meta.dir, "results");
const OUTPUT = join(RESULTS_DIR, "stage5_m218_real_host.json");

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  const controls: M217Control[] = [];
  const notes: Record<string, unknown> = {};
  const manifest = (JSON.parse(readFileSync(join(RESULTS_DIR, M215_MANIFEST_FILE), "utf8")) as { rows: RunManifestRow[] }).rows;
  const row = manifest[0]!;

  // The namespace and its registry live in ONE research base directory that is
  // itself under /tmp; the registry is a sibling of the namespace, never inside it.
  const base = mkdtempSync(join(tmpdir(), "vtrace-stage5-m218-research-"));
  const sentinel = join(tmpdir(), `m218-unrelated-sentinel-${process.pid}-${Date.now()}`);
  writeFileSync(sentinel, "unrelated host temp; must survive\n");
  const sentinelDir = mkdtempSync(join(tmpdir(), "m218-unrelated-dir-"));
  writeFileSync(join(sentinelDir, "keep.txt"), "keep");
  let holder: ReturnType<typeof spawn> | null = null;
  try {
    const namespace = establishNamespace(join(base, "_work"), { experiment: "M218_RESEARCH_NON_EVALUATION", cohortDir: base });
    const liveness = new HostLivenessProbe({ docker: false });
    const authority = new ScratchAuthority({
      namespace,
      registry: new ScratchRegistry(join(base, "_scratch_registry")),
      evidenceDir: join(base, "evidence"),
      liveness,
      experiment: "M218_RESEARCH_NON_EVALUATION",
      executorVersion: "m218-real-host",
    });
    notes.namespace = namespace.canonicalRoot;
    notes.sharedTmp = filesystemCapacity(tmpdir());
    if (forbiddenRootReason(namespace.canonicalRoot) !== null) throw new Error("the research namespace is on a forbidden root");

    // ── R1: a real subprocess writes real bytes; cleanup recovers them ──
    const claim = authority.claim(row, `${row.runId}#a1#real-host`, 1);
    const before = filesystemCapacity(namespace.canonicalRoot);
    const written = spawnSync("python3", ["-c",
      "import os,sys\n"
      + "p=sys.argv[1]\n"
      + "os.makedirs(os.path.join(p,'nested','deeper'),exist_ok=True)\n"
      + "with open(os.path.join(p,'nested','deeper','payload.bin'),'wb') as f:\n"
      + "  [f.write(os.urandom(1<<20)) for _ in range(48)]\n"
      + "open(os.path.join(p,'agent-created-file'),'w').write('agent\\n')\n"
      + "print(sum(os.path.getsize(os.path.join(d,n)) for d,_,fs in os.walk(p) for n in fs))",
      claim.agentTmp], { encoding: "utf8" });
    const bytesWritten = Number((written.stdout ?? "0").trim());
    authority.checkpoint(claim, "AFTER_SUBPROCESS_WRITE");
    const during = filesystemCapacity(namespace.canonicalRoot);
    const measuredBefore = measureTree(claim.path);
    const report = authority.cleanup(claim, { containerRemoved: true });
    const after = filesystemCapacity(namespace.canonicalRoot);
    const r1: string[] = [];
    if (written.status !== 0 || bytesWritten < 48 * (1 << 20)) r1.push(`subprocess wrote ${bytesWritten} bytes (status ${written.status})`);
    if (during.freeBytes >= before.freeBytes) r1.push("free space did not drop while the payload existed");
    if (!report.verified || report.status !== "CLEANED") r1.push(`cleanup ${report.status}: ${report.errors.join("; ")}`);
    if (existsSync(claim.path)) r1.push("attempt path survived");
    if (after.freeBytes - during.freeBytes < 40 * (1 << 20)) r1.push(`free space not recovered: during ${during.freeBytes} after ${after.freeBytes}`);
    if (report.scratchHighWaterBytes < 48 * (1 << 20)) r1.push(`high-water ${report.scratchHighWaterBytes}`);
    if (!existsSync(sentinel) || !existsSync(join(sentinelDir, "keep.txt"))) r1.push("the unrelated sentinel did not survive");
    notes.r1 = { bytesWritten, measuredBefore, freeBefore: before.freeBytes, freeDuring: during.freeBytes, freeAfter: after.freeBytes, report };
    controls.push(control("F166", "T1", "on the real shared /tmp filesystem, owned scratch is created, a real subprocess writes ~48 MiB into it, cleanup executes through the ownership-checked path, free space is recovered, and an unrelated temp sentinel remains", "GUARD_SILENT", r1, "REAL_PROCESS"));

    // ── R2: symlink escape on the real filesystem ─────────────────────
    const precious = mkdtempSync(join(base, "precious-"));
    writeFileSync(join(precious, "data.txt"), "must survive");
    const claim2 = authority.claim(row, `${row.runId}#a2#real-host-symlink`, 2);
    symlinkSync(precious, join(claim2.agentTmp, "escape-dir"));
    symlinkSync(join(precious, "data.txt"), join(claim2.rawDir, "escape-file"));
    symlinkSync(homedir(), join(claim2.agentTmp, "escape-home"));
    symlinkSync(sentinelDir, join(claim2.path, "escape-tmp-dir"));
    const report2 = authority.cleanup(claim2, { containerRemoved: true });
    const r2: string[] = [];
    if (!report2.verified) r2.push(`cleanup ${report2.status} ${report2.errors.join("; ")}`);
    if (report2.symlinksUnlinked !== 4) r2.push(`symlinks unlinked ${report2.symlinksUnlinked}`);
    if (readFileSync(join(precious, "data.txt"), "utf8") !== "must survive") r2.push("symlink target deleted");
    if (!existsSync(join(sentinelDir, "keep.txt"))) r2.push("the /tmp sibling behind a symlink was deleted");
    if (!existsSync(homedir())) r2.push("home directory gone");
    controls.push(control("F167", "T21", "on the real filesystem, symlinks from owned scratch to a sibling directory, a file, the home directory and an unrelated /tmp directory are unlinked and their targets untouched", "GUARD_SILENT", r2, "REAL_PROCESS"));

    // ── R3: a real detached process holds the path; cleanup refuses; kill; cleanup ─
    const claim3 = authority.claim(row, `${row.runId}#a3#real-host-holder`, 3);
    holder = spawn("python3", ["-c", "import sys,time; time.sleep(600)", claim3.path], { cwd: claim3.agentTmp, detached: true, stdio: "ignore" });
    holder.unref();
    await sleep(400);
    const refused = authority.cleanup(claim3, { containerRemoved: true });
    const r3: string[] = [];
    if (refused.status !== "REFUSED_LIVE_OWNER") r3.push(`cleanup ${refused.status}`);
    if (!refused.liveReferences.some((reference) => reference.kind === "PROCESS" && reference.detail.includes(String(holder.pid)))) r3.push(`holder pid ${holder.pid} not listed: ${JSON.stringify(refused.liveReferences)}`);
    if (!existsSync(claim3.path)) r3.push("path deleted under a live holder");
    process.kill(holder.pid!, "SIGKILL");
    await sleep(400);
    if (alive(holder.pid!)) r3.push("holder still alive after SIGKILL");
    const cleaned = authority.cleanup(claim3, { containerRemoved: true });
    if (!cleaned.verified) r3.push(`post-kill cleanup ${cleaned.status} ${cleaned.errors.join("; ")}`);
    notes.r3 = { holderPid: holder.pid, refused: refused.liveReferences, cleaned: cleaned.status };
    controls.push(control("F168", "T6", "a real detached process whose cwd and argv hold the owned path makes the real liveness probe refuse cleanup; once the process is killed, cleanup completes", "GUARD_SILENT", r3, "REAL_PROCESS"));

    // ── R4: structural refusals against the real roots ────────────────
    const fired: string[] = [];
    for (const target of ["/", "/tmp", tmpdir(), "", homedir(), namespace.canonicalRoot, sentinelDir]) {
      try {
        removeTreeNoFollow(namespace, target);
      } catch (error) {
        if (error instanceof ScratchSafetyError) fired.push(`${JSON.stringify(target)} refused`);
      }
    }
    if (!existsSync(sentinel) || !existsSync(join(sentinelDir, "keep.txt")) || !existsSync(homedir())) fired.length = 0;
    controls.push(control("F169", "T22", "cleanup of /, /tmp, an empty path, the home directory, the namespace root and an unrelated /tmp directory is refused on the real host and nothing is touched", "GUARD_FIRES", fired.length >= 7 ? fired : [], "REAL_PROCESS"));

    // ── R5: the startup sweep on the real namespace after a simulated crash ─
    const crashed = authority.claim(row, `${row.runId}#a4#real-host-crash`, 4);
    writeFileSync(join(crashed.agentTmp, "half"), Buffer.alloc(1 << 20, 1));
    authority.registry.update(crashed.claimId, { creator: { ...crashed.creator, pid: 999_999_995 } });
    const sweep = authority.sweep();
    const r5: string[] = [];
    const entry = sweep.entries.find((candidate) => candidate.path === crashed.path);
    if (entry?.classification !== "STALE_CLEANABLE" || !entry.cleaned) r5.push(`sweep ${entry?.classification} cleaned ${entry?.cleaned}`);
    if (existsSync(crashed.path)) r5.push("stale path survived");
    if (!sweep.pass) r5.push(`sweep blocked on ${sweep.blocking.join(", ")}`);
    notes.r5 = sweep;
    controls.push(control("F170", "T9", "on the real host, scratch left by a dead creator with no live reference is recognised by the registry and the real pid check, recorded, and removed by the startup sweep", "GUARD_SILENT", r5, "REAL_PROCESS"));

    // ── R6: capacity gate on the real host ────────────────────────────
    //
    // The research namespace sits on the shared tmpfs /tmp (32 GB); the frozen
    // host reserve alone is larger than that filesystem, so the gate must
    // REFUSE a namespace there. The cohort's real namespace is under the results
    // directory on the root filesystem, where the same policy must pass.
    const gate = authority.capacityGate();
    notes.capacityGateOnSharedTmpNamespace = gate;
    controls.push(control("F171", "T12", "the frozen capacity policy refuses a namespace hosted on the shared tmpfs /tmp: its whole size is below the host reserve plus one projected attempt", "GUARD_FIRES",
      gate.pass ? [] : gate.issues, "REAL_PROCESS"));
    const cohortBase = mkdtempSync(join(RESULTS_DIR, "_m218_real_host_"));
    try {
      const cohortNamespace = establishNamespace(join(cohortBase, "_work"), { experiment: "M218_RESEARCH_NON_EVALUATION", cohortDir: cohortBase });
      const cohortAuthority = new ScratchAuthority({
        namespace: cohortNamespace, registry: new ScratchRegistry(join(cohortBase, "_scratch_registry")),
        evidenceDir: join(cohortBase, "evidence"), liveness, experiment: "M218_RESEARCH_NON_EVALUATION", executorVersion: "m218-real-host",
      });
      const cohortGate = cohortAuthority.capacityGate();
      notes.capacityGateOnCohortNamespace = cohortGate;
      controls.push(control("F171B", "T13", "the same policy passes for a namespace on the cohort's real filesystem (the results directory), with the shared /tmp floor also satisfied", "GUARD_SILENT", cohortGate.issues, "REAL_PROCESS"));
    } finally {
      rmSync(cohortBase, { recursive: true, force: true });
    }
  } finally {
    if (holder !== null && holder.pid !== undefined && alive(holder.pid)) {
      try { process.kill(holder.pid, "SIGKILL"); } catch { /* best effort */ }
    }
    rmSync(base, { recursive: true, force: true });
    rmSync(sentinel, { force: true });
    rmSync(sentinelDir, { recursive: true, force: true });
    mkdirSync(RESULTS_DIR, { recursive: true });
  }

  const document = {
    schemaVersion: "stage5.m218.real-host.v1",
    milestone: "M218",
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
    researchNamespaceRemoved: true,
    controls,
    notes,
  };
  writeFileSync(OUTPUT, `${JSON.stringify(document, null, 2)}\n`);
  process.stdout.write(`${document.satisfied}/${document.controlCount} controls satisfied; failures [${document.failures.join(", ") || "none"}]\nwrote ${OUTPUT}\n`);
  if (!document.suitePasses) process.exitCode = 1;
}

await main();
