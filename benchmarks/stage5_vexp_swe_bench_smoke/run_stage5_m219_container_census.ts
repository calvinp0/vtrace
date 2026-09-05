/**
 * M219 §9, §10 — the deterministic container readiness census.
 *
 * For every unique image the frozen manifest requires (each of the 100 tasks
 * has its own image, so 100 containers): create a container from the exact
 * image the adapter would use, start it, and OBSERVE:
 *
 *   image starts; /testbed exists; /testbed is writable (a probe file in the
 *   container's writable layer, removed before teardown); the task's base
 *   commit is present in the image's repository and is an ancestor of the
 *   checked-out HEAD (recoverable by `git checkout`, as M193 does at setup);
 *   a trivial command executes; `git status --porcelain` is byte-identical
 *   before and after the probe (source identity unchanged); the container
 *   tears down cleanly.
 *
 * No coding agent, no model, no benchmark patch, no bind mount, no VTRACE. The
 * writable-layer size of each probe container is recorded for the Docker
 * capacity derivation. Containers are named `m219-preflight-<instance>` so the
 * residue census can classify a survivor.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { RunManifestRow } from "./m214Preregistration";
import { M215_MANIFEST_FILE } from "./m215LaunchExecutor";
import { type ImageIdentityRecord, M219_IMAGE_IDENTITY_FILE, requiredImagePopulation } from "./m219OperatorPreflight";

const RESULTS_DIR = join(import.meta.dir, "results");
const OUTPUT = join(RESULTS_DIR, "stage5_m219_container_census.json");

interface ProbeResult {
  readonly instanceId: string;
  readonly containerImage: string;
  readonly imageId: string | null;
  readonly imageIdMatchesRecord: boolean;
  readonly containerName: string;
  readonly started: boolean;
  readonly testbedExists: boolean;
  readonly testbedWritable: boolean;
  readonly headBefore: string | null;
  readonly baseCommit: string;
  readonly baseCommitPresent: boolean;
  readonly baseCommitIsAncestorOfHead: boolean;
  readonly trivialCommandOk: boolean;
  readonly statusBeforeDigest: string | null;
  readonly statusAfterDigest: string | null;
  readonly sourceIdentityUnchanged: boolean;
  readonly probeFileRemoved: boolean;
  readonly writableLayerBytes: number | null;
  readonly tornDown: boolean;
  readonly durationMs: number;
  readonly ok: boolean;
  readonly errors: readonly string[];
}

function docker(args: readonly string[], timeoutMs = 120_000): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync("docker", args, { encoding: "utf8", timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

const PROBE = [
  "set -u",
  "cd /testbed || { echo TESTBED_MISSING; exit 3; }",
  "echo TESTBED_OK",
  "git config --global --add safe.directory /testbed >/dev/null 2>&1 || true",
  "echo HEAD_BEFORE=$(git rev-parse HEAD 2>/dev/null || echo NONE)",
  "echo STATUS_BEFORE=$(git status --porcelain 2>/dev/null | sha256sum | cut -d' ' -f1)",
  "if git cat-file -e \"$BASE^{commit}\" 2>/dev/null; then echo BASE_PRESENT=yes; else echo BASE_PRESENT=no; fi",
  "if git merge-base --is-ancestor \"$BASE\" HEAD 2>/dev/null; then echo BASE_ANCESTOR=yes; else echo BASE_ANCESTOR=no; fi",
  "P=/testbed/.m219-preflight-probe-$$",
  "if echo m219 > \"$P\" 2>/dev/null; then echo WRITABLE=yes; rm -f \"$P\"; else echo WRITABLE=no; fi",
  "if [ -e \"$P\" ]; then echo PROBE_REMOVED=no; else echo PROBE_REMOVED=yes; fi",
  "echo STATUS_AFTER=$(git status --porcelain 2>/dev/null | sha256sum | cut -d' ' -f1)",
  "echo TRIVIAL=$(( 20 + 22 ))",
].join("; ");

function probe(row: RunManifestRow, recorded: Map<string, string>): ProbeResult {
  const start = Date.now();
  const errors: string[] = [];
  const containerName = `m219-preflight-${row.instanceId.replace(/[^a-zA-Z0-9_.-]/g, "-")}`;
  const imageId = (() => {
    const out = docker(["image", "inspect", "--format", "{{.Id}}", row.containerImage]);
    return out.status === 0 ? out.stdout.trim() : null;
  })();
  const imageIdMatchesRecord = imageId !== null && recorded.get(row.containerImage) === imageId;
  if (!imageIdMatchesRecord) errors.push(`image id ${imageId} does not match the identity record`);
  docker(["rm", "-f", containerName]);
  const fields = new Map<string, string>();
  let started = false;
  let tornDown = false;
  let writableLayerBytes: number | null = null;
  const created = docker(["create", "--name", containerName, "--label", "vtrace.stage5.m219=preflight", "-e", `BASE=${row.baseCommit}`, row.containerImage, "tail", "-f", "/dev/null"]);
  if (created.status !== 0) {
    errors.push(`create failed: ${created.stderr.trim().slice(0, 300)}`);
  } else {
    const startResult = docker(["start", containerName]);
    started = startResult.status === 0;
    if (!started) errors.push(`start failed: ${startResult.stderr.trim().slice(0, 300)}`);
    else {
      const exec = docker(["exec", containerName, "bash", "-lc", PROBE], 300_000);
      if (exec.status !== 0 && !exec.stdout.includes("TESTBED_OK")) errors.push(`probe failed (${exec.status}): ${exec.stderr.trim().slice(0, 300)} ${exec.stdout.trim().slice(0, 300)}`);
      for (const line of exec.stdout.split("\n")) {
        const eq = line.indexOf("=");
        if (eq > 0) fields.set(line.slice(0, eq).trim(), line.slice(eq + 1).trim());
        else if (line.trim().length > 0) fields.set(line.trim(), "yes");
      }
      const size = docker(["inspect", "--size", "--format", "{{.SizeRw}}", containerName]);
      writableLayerBytes = size.status === 0 && size.stdout.trim().length > 0 ? Number(size.stdout.trim()) : null;
    }
    const removed = docker(["rm", "-f", containerName]);
    tornDown = removed.status === 0 && docker(["inspect", containerName]).status !== 0;
    if (!tornDown) errors.push("container did not tear down");
  }
  const testbedExists = fields.get("TESTBED_OK") === "yes";
  const testbedWritable = fields.get("WRITABLE") === "yes";
  const baseCommitPresent = fields.get("BASE_PRESENT") === "yes";
  const baseCommitIsAncestorOfHead = fields.get("BASE_ANCESTOR") === "yes";
  const trivialCommandOk = fields.get("TRIVIAL") === "42";
  const statusBeforeDigest = fields.get("STATUS_BEFORE") ?? null;
  const statusAfterDigest = fields.get("STATUS_AFTER") ?? null;
  const sourceIdentityUnchanged = statusBeforeDigest !== null && statusBeforeDigest === statusAfterDigest;
  const probeFileRemoved = fields.get("PROBE_REMOVED") === "yes";
  if (started) {
    if (!testbedExists) errors.push("/testbed absent");
    if (!testbedWritable) errors.push("/testbed not writable");
    if (!baseCommitPresent) errors.push(`base commit ${row.baseCommit} absent from the image repository`);
    if (!baseCommitIsAncestorOfHead) errors.push("base commit is not an ancestor of the image HEAD");
    if (!trivialCommandOk) errors.push("trivial command did not execute");
    if (!sourceIdentityUnchanged) errors.push("git status changed across the probe");
    if (!probeFileRemoved) errors.push("probe file survived");
  }
  return {
    instanceId: row.instanceId, containerImage: row.containerImage, imageId, imageIdMatchesRecord, containerName,
    started, testbedExists, testbedWritable, headBefore: fields.get("HEAD_BEFORE") ?? null, baseCommit: row.baseCommit,
    baseCommitPresent, baseCommitIsAncestorOfHead, trivialCommandOk, statusBeforeDigest, statusAfterDigest,
    sourceIdentityUnchanged, probeFileRemoved, writableLayerBytes, tornDown, durationMs: Date.now() - start,
    ok: errors.length === 0, errors: Object.freeze(errors),
  };
}

function main(): void {
  const manifest = (JSON.parse(readFileSync(join(RESULTS_DIR, M215_MANIFEST_FILE), "utf8")) as { rows: RunManifestRow[] }).rows;
  const population = requiredImagePopulation(manifest);
  if (population.issues.length > 0) throw new Error(population.issues.join("; "));
  const record = JSON.parse(readFileSync(join(RESULTS_DIR, M219_IMAGE_IDENTITY_FILE), "utf8")) as ImageIdentityRecord;
  const recorded = new Map(record.images.map((entry) => [entry.containerImage, entry.imageId] as const));
  const byInstance = new Map(manifest.map((row) => [row.instanceId, row] as const));
  const results: ProbeResult[] = [];
  const startedAt = new Date().toISOString();
  for (const image of population.images) {
    // One probe per unique image; every task sharing it (here exactly one) maps to the validated substrate.
    const row = byInstance.get(image.instanceIds[0]!)!;
    const result = probe(row, recorded);
    results.push(result);
    process.stdout.write(`${result.ok ? "OK  " : "FAIL"} ${row.instanceId} head=${result.headBefore?.slice(0, 12)} base_present=${result.baseCommitPresent} ancestor=${result.baseCommitIsAncestorOfHead} rw=${result.writableLayerBytes} ${result.durationMs}ms${result.ok ? "" : ` :: ${result.errors.join("; ")}`}\n`);
  }
  const survivors = execFileSync("docker", ["ps", "-aq", "--filter", "name=m219-preflight-"], { encoding: "utf8" }).trim().split("\n").filter(Boolean);
  const taskToImage = manifest.filter((row) => row.arm === "baseline").map((row) => {
    const validated = results.find((result) => result.containerImage === row.containerImage);
    return { instanceId: row.instanceId, containerImage: row.containerImage, imageId: validated?.imageId ?? null, validated: validated?.ok ?? false };
  });
  const document = {
    schemaVersion: "stage5.m219.container-census.v1",
    milestone: "M219",
    startedAt,
    generatedAt: new Date().toISOString(),
    uniqueImages: population.images.length,
    containersStarted: results.filter((result) => result.started).length,
    containersTornDown: results.filter((result) => result.tornDown).length,
    survivingPreflightContainers: survivors.length,
    validated: results.filter((result) => result.ok).length,
    failed: results.filter((result) => !result.ok).map((result) => ({ instanceId: result.instanceId, errors: result.errors })),
    writableLayerHighWaterBytes: Math.max(0, ...results.map((result) => result.writableLayerBytes ?? 0)),
    tasksMappedToValidatedImage: taskToImage.filter((entry) => entry.validated).length,
    taskToImage,
    verdict: results.every((result) => result.ok) && survivors.length === 0 && taskToImage.every((entry) => entry.validated) ? "REAL_CONTAINER_PREFLIGHT_VERIFIED" : "REAL_CONTAINER_PREFLIGHT_FAILED",
    agentInvoked: false,
    providerCalls: 0,
    liveModelSpendUsd: 0,
    frozenBenchmarkTaskLiveAgentRuns: 0,
    benchmarkPatchesApplied: 0,
    results,
  };
  writeFileSync(OUTPUT, `${JSON.stringify(document, null, 2)}\n`);
  process.stdout.write(`${document.verdict}: ${document.validated}/${document.uniqueImages} images validated; ${document.tasksMappedToValidatedImage}/${taskToImage.length} tasks mapped; writable high-water ${document.writableLayerHighWaterBytes}; survivors ${survivors.length}\nwrote ${OUTPUT}\n`);
  if (document.verdict !== "REAL_CONTAINER_PREFLIGHT_VERIFIED") process.exitCode = 1;
}

main();
