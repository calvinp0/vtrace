/**
 * M219 §4–§8, §11 — materialize the frozen SWE-bench image population.
 *
 *   --phase census   derive the required population from the frozen manifest,
 *                    census the local Docker store, snapshot Docker/root/tmp
 *                    capacity. Writes stage5_m219_image_census_before.json.
 *                    Deletes nothing, pulls nothing.
 *   --phase pull     pull exactly the required images the census found absent,
 *                    one `docker pull` per image, recording every result.
 *                    Writes stage5_m219_image_pulls.json (rewritten after each
 *                    image so progress is observable). Nothing unrelated is
 *                    pulled; nothing is pruned.
 *   --phase verify   census again; require every image present; record the
 *                    immutable identities (stage5_m219_image_identity.json);
 *                    run the no-pull image preflight over all 200 rows through
 *                    `docker image inspect` AND through the production
 *                    adapter's own lookup (docker SDK images.get in the bridge's
 *                    Python). Writes stage5_m219_image_census_after.json and
 *                    stage5_m219_image_preflight.json.
 *
 * No model, no provider, no frozen task run, no container started.
 */

import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";

import type { RunManifestRow } from "./m214Preregistration";
import { M215_MANIFEST_FILE } from "./m215LaunchExecutor";
import { M216_SUBSTRATE_PYTHON } from "./m216SubstrateBridge";
import { filesystemCapacity } from "./m218ScratchLifecycle";
import {
  type ImageCensus,
  type ImageIdentityRecord,
  M219_IMAGE_IDENTITY_FILE,
  M219_PREFLIGHT_VERSION,
  buildImageIdentityRecord,
  digestOnly,
  dockerImageInspector,
  dockerImageInventory,
  dockerStoreFacts,
  imageCensus,
  imagePreflight,
  requiredImagePopulation,
} from "./m219OperatorPreflight";

const RESULTS_DIR = join(import.meta.dir, "results");
const BEFORE = join(RESULTS_DIR, "stage5_m219_image_census_before.json");
const PULLS = join(RESULTS_DIR, "stage5_m219_image_pulls.json");
const AFTER = join(RESULTS_DIR, "stage5_m219_image_census_after.json");
const IDENTITY = join(RESULTS_DIR, M219_IMAGE_IDENTITY_FILE);
const PREFLIGHT = join(RESULTS_DIR, "stage5_m219_image_preflight.json");

interface ManifestDocument { readonly rows: RunManifestRow[]; readonly manifestHash: string }

function loadManifest(): ManifestDocument {
  return JSON.parse(readFileSync(join(RESULTS_DIR, M215_MANIFEST_FILE), "utf8")) as ManifestDocument;
}

function capacitySnapshot(dockerRoot: string) {
  return {
    at: new Date().toISOString(),
    dockerRoot: filesystemCapacity(dockerRoot),
    resultsDir: filesystemCapacity(RESULTS_DIR),
    sharedTmp: filesystemCapacity(tmpdir()),
  };
}

function censusDocument(label: "before" | "after", manifest: ManifestDocument) {
  const population = requiredImagePopulation(manifest.rows);
  if (population.issues.length > 0) throw new Error(`the frozen population does not derive cleanly: ${population.issues.join("; ")}`);
  const inventory = dockerImageInventory();
  const census = imageCensus(population, inventory);
  const store = dockerStoreFacts();
  return {
    schemaVersion: "stage5.m219.image-census.v1",
    milestone: "M219",
    preflightVersion: M219_PREFLIGHT_VERSION,
    label,
    generatedAt: new Date().toISOString(),
    manifestHash: manifest.manifestHash,
    population: { taskCount: population.taskCount, rowCount: population.rowCount, uniqueImages: population.images.length, issues: population.issues },
    census,
    dockerStore: store,
    capacity: capacitySnapshot(store.rootDir),
    localSwebenchImages: inventory.filter((image) => image.reference.includes("sweb.eval")).length,
    pulledAnything: false,
    deletedAnything: false,
  };
}

function phaseCensus(): void {
  const manifest = loadManifest();
  const document = censusDocument("before", manifest);
  mkdirSync(RESULTS_DIR, { recursive: true });
  writeFileSync(BEFORE, `${JSON.stringify(document, null, 2)}\n`);
  process.stdout.write(
    `population: ${document.population.taskCount} tasks / ${document.population.rowCount} rows / ${document.population.uniqueImages} unique images\n`
    + `present ${document.census.present} absent ${document.census.absent}; local swebench images not required: ${document.census.localNotRequired.length}\n`
    + `docker store ${document.dockerStore.rootDir}: images ${document.dockerStore.imageBytes} bytes; root free ${document.capacity.dockerRoot.freeBytes}; /tmp free ${document.capacity.sharedTmp.freeBytes}\n`
    + `wrote ${BEFORE}\n`,
  );
}

interface PullRecord {
  readonly containerImage: string;
  readonly instanceIds: readonly string[];
  readonly attempted: true;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly durationMs: number;
  readonly exitCode: number;
  readonly result: "PULLED" | "ALREADY_PRESENT" | "FAILED";
  readonly imageId: string | null;
  readonly repoDigest: string | null;
  readonly sizeBytes: number | null;
  readonly stderrTail: string;
}

function phasePull(concurrency: number): void {
  if (!existsSync(BEFORE)) throw new Error(`run --phase census first; ${BEFORE} is absent`);
  const before = JSON.parse(readFileSync(BEFORE, "utf8")) as { census: ImageCensus };
  const missing = before.census.entries.filter((entry) => !entry.present);
  const records: PullRecord[] = existsSync(PULLS)
    ? ((JSON.parse(readFileSync(PULLS, "utf8")) as { pulls: PullRecord[] }).pulls ?? [])
    : [];
  const done = new Set(records.filter((record) => record.result !== "FAILED").map((record) => record.containerImage));
  const queue = missing.filter((entry) => !done.has(entry.containerImage));
  const startedAt = new Date().toISOString();
  const persist = (): void => {
    writeFileSync(PULLS, `${JSON.stringify({
      schemaVersion: "stage5.m219.image-pulls.v1", milestone: "M219", startedAt, updatedAt: new Date().toISOString(),
      requestedImages: missing.map((entry) => entry.containerImage), concurrency,
      pulled: records.filter((record) => record.result === "PULLED").length,
      failed: records.filter((record) => record.result === "FAILED").map((record) => record.containerImage),
      remaining: queue.length,
      onlyRequiredImagesPulled: true,
      pruneOperationsPerformed: 0,
      pulls: records,
    }, null, 2)}\n`);
  };
  persist();
  process.stdout.write(`${queue.length} required image(s) to pull (${missing.length} absent at census, ${done.size} already recorded); concurrency ${concurrency}\n`);

  const pullOne = async (entry: ImageCensus["entries"][number]): Promise<PullRecord> => {
    const start = Date.now();
    const startedAtIso = new Date(start).toISOString();
    const pulled = await new Promise<{ status: number | null; stderr: string }>((resolve) => {
      const child = spawn("docker", ["pull", "--quiet", entry.containerImage], { stdio: ["ignore", "pipe", "pipe"] });
      let stderr = "";
      child.stdout.on("data", () => undefined);
      child.stderr.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-4000); });
      const timer = setTimeout(() => child.kill("SIGKILL"), 6 * 3_600_000);
      child.on("close", (status) => { clearTimeout(timer); resolve({ status, stderr }); });
      child.on("error", (error) => { clearTimeout(timer); resolve({ status: -1, stderr: String(error) }); });
    });
    const inspected = dockerImageInspector(entry.containerImage);
    let sizeBytes: number | null = null;
    try {
      sizeBytes = Number(execFileSync("docker", ["image", "inspect", "--format", "{{.Size}}", entry.containerImage], { encoding: "utf8", timeout: 60_000 }).trim());
    } catch {
      sizeBytes = null;
    }
    const ok = pulled.status === 0 && inspected !== null;
    return {
      containerImage: entry.containerImage, instanceIds: entry.instanceIds, attempted: true,
      startedAt: startedAtIso, finishedAt: new Date().toISOString(), durationMs: Date.now() - start,
      exitCode: pulled.status ?? -1, result: ok ? "PULLED" : "FAILED",
      imageId: inspected?.imageId ?? null, repoDigest: inspected?.repoDigests[0] ?? null, sizeBytes,
      stderrTail: pulled.stderr.trim().slice(-600),
    };
  };

  // Bounded concurrency: `docker pull` is itself parallel across layers and the
  // registry throttles, so two at a time is the default.
  let index = 0;
  const workers = Array.from({ length: Math.max(1, concurrency) }, async () => {
    while (index < queue.length) {
      const entry = queue[index]!;
      index += 1;
      const record = await pullOne(entry);
      records.push(record);
      persist();
      process.stdout.write(`${record.result} ${record.containerImage} ${record.sizeBytes ?? "?"} bytes in ${record.durationMs} ms${record.result === "FAILED" ? ` :: ${record.stderrTail.slice(-200)}` : ""}\n`);
    }
  });
  void Promise.all(workers).then(() => {
    const failed = records.filter((record) => record.result === "FAILED");
    persist();
    process.stdout.write(`pull phase complete: ${records.filter((record) => record.result === "PULLED").length} pulled, ${failed.length} failed\nwrote ${PULLS}\n`);
    if (failed.length > 0) process.exitCode = 1;
  });
}

/** The adapter's own lookup: docker SDK `images.get(image_key)` for every manifest image, in the bridge's Python. */
function adapterResolution(images: readonly string[]): { readonly python: string; readonly resolutions: Record<string, { id: string; repoDigests: string[] } | null> } {
  const script = [
    "import json,sys,docker",
    "client = docker.from_env()",
    "out = {}",
    "for key in json.load(sys.stdin):",
    "    try:",
    "        image = client.images.get(key)",
    "        out[key] = {'id': image.id, 'repoDigests': list(image.attrs.get('RepoDigests') or [])}",
    "    except docker.errors.ImageNotFound:",
    "        out[key] = None",
    "json.dump(out, sys.stdout)",
  ].join("\n");
  const result = spawnSync(M216_SUBSTRATE_PYTHON, ["-c", script], { input: JSON.stringify(images), encoding: "utf8", timeout: 600_000, maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`adapter resolution failed: ${result.stderr}`);
  return { python: M216_SUBSTRATE_PYTHON, resolutions: JSON.parse(result.stdout) as Record<string, { id: string; repoDigests: string[] } | null> };
}

function phaseVerify(): void {
  const manifest = loadManifest();
  const after = censusDocument("after", manifest);
  writeFileSync(AFTER, `${JSON.stringify(after, null, 2)}\n`);
  if (after.census.absent > 0) {
    process.stdout.write(`${after.census.absent} required image(s) still absent: ${after.census.missing.join(", ")}\nwrote ${AFTER}\n`);
    process.exitCode = 1;
    return;
  }
  const record: ImageIdentityRecord = buildImageIdentityRecord(after.census, manifest.manifestHash, hostname(), new Date().toISOString());
  writeFileSync(IDENTITY, `${JSON.stringify(record, null, 2)}\n`);

  const preflight = imagePreflight(manifest.rows, record, dockerImageInspector);
  const adapter = adapterResolution(record.images.map((entry) => entry.containerImage));
  const adapterIssues: string[] = [];
  for (const entry of record.images) {
    const resolved = adapter.resolutions[entry.containerImage] ?? null;
    if (resolved === null) adapterIssues.push(`${entry.containerImage}: the adapter's images.get found no image`);
    else if (resolved.id !== entry.imageId) adapterIssues.push(`${entry.containerImage}: adapter resolved ${resolved.id}, record has ${entry.imageId}`);
    else if (entry.repoDigest !== null && !resolved.repoDigests.map(digestOnly).includes(digestOnly(entry.repoDigest))) adapterIssues.push(`${entry.containerImage}: adapter digests ${resolved.repoDigests.join(",")} lack ${entry.repoDigest}`);
  }
  const document = {
    schemaVersion: "stage5.m219.image-preflight.v1",
    milestone: "M219",
    generatedAt: new Date().toISOString(),
    manifestHash: manifest.manifestHash,
    identityRecord: IDENTITY,
    identityRecordImages: record.images.length,
    cliPreflight: preflight,
    adapterResolution: {
      authority: "m193_container_adapter.M193Container.setup → docker.from_env().images.get(spec.image_key)",
      python: adapter.python,
      imagesResolved: Object.values(adapter.resolutions).filter((entry) => entry !== null).length,
      issues: adapterIssues,
    },
    verdict: preflight.verdict === "IMAGE_PREFLIGHT_PASS" && adapterIssues.length === 0 ? "IMAGE_PREFLIGHT_PASS" : "IMAGE_PREFLIGHT_FAIL",
    rowsResolved: `${preflight.rowsResolved} / ${preflight.rows}`,
    rowsIdentityVerified: `${preflight.rowsIdentityVerified} / ${preflight.rows}`,
    networkPullRequested: false,
  };
  writeFileSync(PREFLIGHT, `${JSON.stringify(document, null, 2)}\n`);
  process.stdout.write(
    `after: present ${after.census.present}/${after.census.required}\n`
    + `${document.verdict}: rows resolved ${document.rowsResolved}, identity verified ${document.rowsIdentityVerified}; adapter resolved ${document.adapterResolution.imagesResolved}/${record.images.length}\n`
    + `wrote ${AFTER}, ${IDENTITY}, ${PREFLIGHT}\n`,
  );
  if (document.verdict !== "IMAGE_PREFLIGHT_PASS") process.exitCode = 1;
}

function main(): void {
  const args = process.argv.slice(2);
  const phase = args[args.indexOf("--phase") + 1];
  const concurrencyIndex = args.indexOf("--concurrency");
  const concurrency = concurrencyIndex === -1 ? 2 : Number(args[concurrencyIndex + 1]);
  if (phase === "census") phaseCensus();
  else if (phase === "pull") phasePull(concurrency);
  else if (phase === "verify") phaseVerify();
  else throw new Error("usage: --phase census|pull|verify [--concurrency N]");
}

main();
