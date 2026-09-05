/**
 * M219 — the final zero-model-spend host / materialization preflight.
 *
 * M218 left one operator dependency: 64 of the 100 frozen SWE-bench images
 * were absent and M193 does not pull. M219 is not an engineering milestone; it
 * materializes the frozen substrate, verifies that every frozen manifest row
 * resolves to a local image with a recorded immutable identity, checks Docker
 * and /tmp capacity around that materialization, cleans ONLY scratch the M218
 * registry proves owned, and runs the production launch preflight up to the one
 * blocker that is not technical: spend authorisation.
 *
 * Everything here is pure over injected facts (the Docker inventory, an
 * inspect function, a capacity reader, liveness facts) so the falsification
 * suite can break each guard without touching the real host; the runners bind
 * the real `docker` CLI and the real filesystem.
 *
 * Nothing in this module deletes anything. The only deletion authority M219
 * uses is M218's `ScratchAuthority.sweep()`, which deletes exactly what its
 * registry owns and nothing else.
 */

import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, readdirSync, readlinkSync } from "node:fs";
import { sep } from "node:path";

import type { RunManifestRow } from "./m214Preregistration";
import {
  type FilesystemCapacity,
  type LiveReference,
  type LivenessProbe,
  type ScratchRegistry,
  M218_NAMESPACE_MARKER,
  M218_SCRATCH_POLICY,
  measureTree,
} from "./m218ScratchLifecycle";

export const M219_PREFLIGHT_VERSION = "stage5.m219.operator-preflight.v1" as const;
export const M219_IMAGE_IDENTITY_SCHEMA = "stage5.m219.image-identity.v1" as const;
export const M219_IMAGE_IDENTITY_FILE = "stage5_m219_image_identity.json" as const;

/** The frozen population: exactly this many tasks, this many rows. */
export const M219_EXPECTED_TASKS = 100 as const;
export const M219_EXPECTED_ROWS = 200 as const;

// ── §4 — the required image population, derived from the manifest ────

export interface RequiredImage {
  readonly containerImage: string;
  readonly instanceIds: readonly string[];
  readonly repos: readonly string[];
  readonly rowCount: number;
}

export interface RequiredImagePopulation {
  readonly taskCount: number;
  readonly rowCount: number;
  readonly images: readonly RequiredImage[];
  readonly issues: readonly string[];
}

/**
 * The executor's own authority for a row's image is `row.containerImage`
 * (m217LaunchBinding.productionBinding → instanceFacts → bridge params["image"]
 * → M193Container.spec.image_key). The population is derived from exactly that
 * field, never from the repository name.
 */
export function requiredImagePopulation(manifest: readonly RunManifestRow[]): RequiredImagePopulation {
  const issues: string[] = [];
  const byImage = new Map<string, { instances: Set<string>; repos: Set<string>; rows: number }>();
  const byInstance = new Map<string, Set<string>>();
  for (const row of manifest) {
    if (typeof row.containerImage !== "string" || row.containerImage.length === 0) {
      issues.push(`${row.runId}: no containerImage`);
      continue;
    }
    const entry = byImage.get(row.containerImage) ?? { instances: new Set<string>(), repos: new Set<string>(), rows: 0 };
    entry.instances.add(row.instanceId);
    entry.repos.add(row.repo);
    entry.rows += 1;
    byImage.set(row.containerImage, entry);
    const images = byInstance.get(row.instanceId) ?? new Set<string>();
    images.add(row.containerImage);
    byInstance.set(row.instanceId, images);
  }
  for (const [instanceId, images] of byInstance) {
    if (images.size !== 1) issues.push(`${instanceId} maps to ${images.size} images: ${[...images].join(", ")}`);
  }
  if (byInstance.size !== M219_EXPECTED_TASKS) issues.push(`manifest names ${byInstance.size} tasks, not ${M219_EXPECTED_TASKS}`);
  if (manifest.length !== M219_EXPECTED_ROWS) issues.push(`manifest has ${manifest.length} rows, not ${M219_EXPECTED_ROWS}`);
  const images = [...byImage.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([containerImage, entry]) => ({
    containerImage,
    instanceIds: Object.freeze([...entry.instances].sort()),
    repos: Object.freeze([...entry.repos].sort()),
    rowCount: entry.rows,
  }));
  return { taskCount: byInstance.size, rowCount: manifest.length, images: Object.freeze(images), issues: Object.freeze(issues) };
}

// ── §5–§7 — the local inventory, the census and the identity record ──

export interface LocalImage {
  readonly reference: string;
  readonly imageId: string;
  readonly repoDigest: string | null;
  readonly sizeBytes: number | null;
}

export type ImageInventory = () => readonly LocalImage[];

/** `docker image ls` with the immutable id and the registry digest, never just the name. */
export function dockerImageInventory(): readonly LocalImage[] {
  const out = execFileSync("docker", [
    "image", "ls", "--no-trunc", "--format", "{{.Repository}}:{{.Tag}}\t{{.ID}}\t{{.Digest}}\t{{.Size}}",
  ], { encoding: "utf8", timeout: 120_000 });
  const images: LocalImage[] = [];
  for (const line of out.split("\n")) {
    const [reference, imageId, digest, size] = line.split("\t");
    if (reference === undefined || imageId === undefined || reference.startsWith("<none>")) continue;
    images.push({
      reference,
      imageId,
      repoDigest: digest === undefined || digest === "<none>" || digest.length === 0 ? null : digest,
      sizeBytes: size === undefined ? null : humanSizeToBytes(size),
    });
  }
  return Object.freeze(images);
}

/** `docker image ls` prints a bare `sha256:…`; `RepoDigests` prints `repo@sha256:…`. Compare the digest itself. */
export function digestOnly(reference: string): string {
  const at = reference.indexOf("@");
  return at === -1 ? reference : reference.slice(at + 1);
}

export function humanSizeToBytes(size: string): number | null {
  const match = /^([\d.]+)\s*(TB|GB|MB|kB|KB|B)$/i.exec(size.trim());
  if (match === null) return null;
  const unit = match[2]!.toUpperCase();
  const factor = ({ TB: 1e12, GB: 1e9, MB: 1e6, KB: 1e3, B: 1 } as Record<string, number>)[unit] ?? 1;
  return Math.round(Number(match[1]) * factor);
}

export interface ImageCensusEntry {
  readonly containerImage: string;
  readonly instanceIds: readonly string[];
  readonly repos: readonly string[];
  readonly present: boolean;
  readonly imageId: string | null;
  readonly repoDigest: string | null;
  readonly sizeBytes: number | null;
}

export interface ImageCensus {
  readonly required: number;
  readonly present: number;
  readonly absent: number;
  readonly entries: readonly ImageCensusEntry[];
  readonly missing: readonly string[];
  readonly localNotRequired: readonly string[];
}

export function imageCensus(population: RequiredImagePopulation, inventory: readonly LocalImage[]): ImageCensus {
  const local = new Map(inventory.map((image) => [image.reference, image] as const));
  const entries = population.images.map((required): ImageCensusEntry => {
    const found = local.get(required.containerImage);
    return {
      containerImage: required.containerImage,
      instanceIds: required.instanceIds,
      repos: required.repos,
      present: found !== undefined,
      imageId: found?.imageId ?? null,
      repoDigest: found?.repoDigest ?? null,
      sizeBytes: found?.sizeBytes ?? null,
    };
  });
  const requiredSet = new Set(population.images.map((image) => image.containerImage));
  return {
    required: entries.length,
    present: entries.filter((entry) => entry.present).length,
    absent: entries.filter((entry) => !entry.present).length,
    entries: Object.freeze(entries),
    missing: Object.freeze(entries.filter((entry) => !entry.present).map((entry) => entry.containerImage)),
    localNotRequired: Object.freeze(inventory.map((image) => image.reference).filter((reference) => reference.includes("sweb.eval") && !requiredSet.has(reference)).sort()),
  };
}

export interface ImageIdentityEntry {
  readonly containerImage: string;
  /** The frozen tasks this image serves; a row whose task is not listed is a mapping change. */
  readonly instanceIds: readonly string[];
  readonly imageId: string;
  readonly repoDigest: string | null;
  readonly sizeBytes: number | null;
}

export interface ImageIdentityRecord {
  readonly schemaVersion: typeof M219_IMAGE_IDENTITY_SCHEMA;
  readonly recordedAt: string;
  readonly manifestHash: string;
  readonly host: string;
  readonly images: readonly ImageIdentityEntry[];
}

/**
 * The identity record is written ONCE, after materialization, from the census
 * that saw every required image present. It is M219's own authority: the
 * frozen manifest pins names, not digests, so the record is what makes a later
 * "same name, different image" detectable. It does not alter the manifest.
 */
export function buildImageIdentityRecord(
  census: ImageCensus, manifestHash: string, host: string, recordedAt: string,
): ImageIdentityRecord {
  const absent = census.entries.filter((entry) => !entry.present);
  if (absent.length > 0) {
    throw new Error(`cannot record image identities while ${absent.length} required image(s) are absent: ${absent.map((entry) => entry.containerImage).join(", ")}`);
  }
  return {
    schemaVersion: M219_IMAGE_IDENTITY_SCHEMA,
    recordedAt,
    manifestHash,
    host,
    images: Object.freeze(census.entries.map((entry) => ({
      containerImage: entry.containerImage,
      instanceIds: entry.instanceIds,
      imageId: entry.imageId!,
      repoDigest: entry.repoDigest,
      sizeBytes: entry.sizeBytes,
    }))),
  };
}

export interface InspectedImage {
  readonly imageId: string;
  readonly repoDigests: readonly string[];
}

/** `docker image inspect` of one reference, or null when the daemon has no such image. */
export type ImageInspector = (reference: string) => InspectedImage | null;

export function dockerImageInspector(reference: string): InspectedImage | null {
  try {
    const out = execFileSync("docker", ["image", "inspect", "--format", "{{.Id}}\t{{join .RepoDigests \",\"}}", reference], {
      encoding: "utf8", timeout: 60_000, stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const [imageId, digests] = out.split("\t");
    if (imageId === undefined || imageId.length === 0) return null;
    return { imageId, repoDigests: Object.freeze((digests ?? "").split(",").filter(Boolean)) };
  } catch {
    return null;
  }
}

export interface ImageRowResolution {
  readonly runId: string;
  readonly instanceId: string;
  readonly arm: string;
  readonly containerImage: string;
  readonly resolved: boolean;
  readonly imageId: string | null;
  readonly identityVerified: boolean;
  readonly issues: readonly string[];
}

export interface ImagePreflight {
  readonly verdict: "IMAGE_PREFLIGHT_PASS" | "IMAGE_PREFLIGHT_FAIL";
  readonly rows: number;
  readonly rowsResolved: number;
  readonly rowsIdentityVerified: number;
  readonly uniqueImages: number;
  readonly resolutions: readonly ImageRowResolution[];
  readonly issues: readonly string[];
  readonly networkPullRequested: false;
}

/**
 * §7, §8 — every frozen row must resolve, WITHOUT a pull, to a local image
 * whose immutable identity is the one recorded after materialization. Name
 * presence alone is not enough: a re-tagged or rebuilt image of the same name
 * fails here, and a manifest row naming an image the record does not know
 * (a mapping mutation) fails too.
 */
export function imagePreflight(
  manifest: readonly RunManifestRow[], record: ImageIdentityRecord | null, inspect: ImageInspector,
): ImagePreflight {
  const recorded = new Map((record?.images ?? []).map((entry) => [entry.containerImage, entry] as const));
  const inspected = new Map<string, InspectedImage | null>();
  const issues: string[] = [];
  const resolutions = manifest.map((row): ImageRowResolution => {
    const rowIssues: string[] = [];
    if (!inspected.has(row.containerImage)) inspected.set(row.containerImage, inspect(row.containerImage));
    const local = inspected.get(row.containerImage) ?? null;
    if (local === null) rowIssues.push(`image absent locally: ${row.containerImage}`);
    const expected = recorded.get(row.containerImage);
    if (record === null) rowIssues.push("no image identity record; immutable identity cannot be verified");
    else if (expected === undefined) rowIssues.push(`image ${row.containerImage} is not in the identity record: the task→image mapping differs from the recorded population`);
    else if (!expected.instanceIds.includes(row.instanceId)) rowIssues.push(`image ${row.containerImage} is recorded for [${expected.instanceIds.join(", ")}], not for task ${row.instanceId}: the task→image mapping differs from the recorded population`);
    let identityVerified = false;
    if (local !== null && expected !== undefined) {
      if (local.imageId !== expected.imageId) {
        rowIssues.push(`image id differs for ${row.containerImage}: local ${local.imageId}, recorded ${expected.imageId}`);
      } else if (expected.repoDigest !== null && !local.repoDigests.map(digestOnly).includes(digestOnly(expected.repoDigest))) {
        rowIssues.push(`registry digest ${expected.repoDigest} is not among the local digests for ${row.containerImage}: [${local.repoDigests.join(", ")}]`);
      } else {
        identityVerified = true;
      }
    }
    // A row with ANY issue (absent, unrecorded, mapped to another task, wrong
    // id or digest) is not identity-verified, whatever the id comparison said.
    if (rowIssues.length > 0) identityVerified = false;
    for (const issue of rowIssues) issues.push(`${row.runId}: ${issue}`);
    return {
      runId: row.runId, instanceId: row.instanceId, arm: row.arm, containerImage: row.containerImage,
      resolved: local !== null, imageId: local?.imageId ?? null, identityVerified, issues: Object.freeze(rowIssues),
    };
  });
  if (record !== null) {
    const manifestImages = new Set(manifest.map((row) => row.containerImage));
    for (const entry of record.images) {
      if (!manifestImages.has(entry.containerImage)) issues.push(`identity record names ${entry.containerImage}, which no manifest row requires`);
    }
    if (record.images.length !== manifestImages.size) issues.push(`identity record has ${record.images.length} images; the manifest requires ${manifestImages.size}`);
  }
  return {
    verdict: issues.length === 0 ? "IMAGE_PREFLIGHT_PASS" : "IMAGE_PREFLIGHT_FAIL",
    rows: manifest.length,
    rowsResolved: resolutions.filter((entry) => entry.resolved).length,
    rowsIdentityVerified: resolutions.filter((entry) => entry.identityVerified).length,
    uniqueImages: inspected.size,
    resolutions: Object.freeze(resolutions),
    issues: Object.freeze(issues),
    networkPullRequested: false,
  };
}

// ── §11, §20 — Docker capacity ─────────────────────────────────────

export interface DockerStoreFacts {
  readonly rootDir: string;
  readonly imagesTotal: number;
  readonly imagesActive: number;
  readonly imageBytes: number;
  readonly imageReclaimableBytes: number;
  readonly containersTotal: number;
  readonly containersRunning: number;
  readonly containerBytes: number;
  readonly volumeBytes: number;
  readonly buildCacheBytes: number;
  readonly systemDf: string;
}

export function dockerStoreFacts(): DockerStoreFacts {
  const rootDir = execFileSync("docker", ["info", "--format", "{{.DockerRootDir}}"], { encoding: "utf8", timeout: 60_000 }).trim();
  const df = execFileSync("docker", ["system", "df", "--format", "{{.Type}}\t{{.TotalCount}}\t{{.Active}}\t{{.Size}}\t{{.Reclaimable}}"], { encoding: "utf8", timeout: 300_000 });
  const rows = new Map<string, { total: number; active: number; size: number; reclaimable: number }>();
  for (const line of df.split("\n")) {
    const [type, total, active, size, reclaimable] = line.split("\t");
    if (type === undefined || total === undefined) continue;
    rows.set(type, {
      total: Number(total), active: Number(active),
      size: humanSizeToBytes(size ?? "0B") ?? 0,
      reclaimable: humanSizeToBytes((reclaimable ?? "0B").replace(/\s*\(.*\)$/, "")) ?? 0,
    });
  }
  const images = rows.get("Images") ?? { total: 0, active: 0, size: 0, reclaimable: 0 };
  const containers = rows.get("Containers") ?? { total: 0, active: 0, size: 0, reclaimable: 0 };
  return {
    rootDir,
    imagesTotal: images.total, imagesActive: images.active, imageBytes: images.size, imageReclaimableBytes: images.reclaimable,
    containersTotal: containers.total, containersRunning: containers.active, containerBytes: containers.size,
    volumeBytes: rows.get("Local Volumes")?.size ?? 0,
    buildCacheBytes: rows.get("Build Cache")?.size ?? 0,
    systemDf: execFileSync("docker", ["system", "df"], { encoding: "utf8", timeout: 300_000 }).trim(),
  };
}

export interface DockerCapacityInputs {
  /** Bytes the image store grew by while materializing the frozen population (measured). */
  readonly materializationDeltaBytes: number;
  /** Largest single required image, bytes (measured from the inventory). */
  readonly largestRequiredImageBytes: number;
  /** Highest container writable layer observed in the readiness census (measured). */
  readonly containerWritableHighWaterBytes: number;
  /** How many containers can exist at once under the frozen concurrency (harness + evaluator). */
  readonly concurrentContainers: number;
}

export interface DockerCapacityRequirement {
  readonly inputs: DockerCapacityInputs;
  readonly unplannedRebuildReserveBytes: number;
  readonly containerLifecycleReserveBytes: number;
  readonly fixedMarginBytes: number;
  readonly requiredFreeBytes: number;
  readonly derivation: string;
}

const GIB = 1024 ** 3;

/**
 * §20 — a conservative Docker free-space requirement derived from measurements,
 * not invented: room for one unplanned rebuild of the largest image (swebench
 * rebuilds an instance image when it cannot find it), the concurrent container
 * writable layers at 4x their observed high-water, and the same 10 GiB fixed
 * margin M218's host reserve uses. The materialization delta is recorded so the
 * reader can see what the store actually cost, but it is not required twice:
 * the images are present by the time this gate is evaluated.
 */
export function dockerCapacityRequirement(inputs: DockerCapacityInputs): DockerCapacityRequirement {
  const unplannedRebuildReserveBytes = inputs.largestRequiredImageBytes;
  const containerLifecycleReserveBytes = 4 * inputs.concurrentContainers * Math.max(inputs.containerWritableHighWaterBytes, 64 * 1024 * 1024);
  const fixedMarginBytes = 10 * GIB;
  return {
    inputs,
    unplannedRebuildReserveBytes,
    containerLifecycleReserveBytes,
    fixedMarginBytes,
    requiredFreeBytes: unplannedRebuildReserveBytes + containerLifecycleReserveBytes + fixedMarginBytes,
    derivation:
      `required = largest required image (${inputs.largestRequiredImageBytes}) `
      + `+ 4 x ${inputs.concurrentContainers} concurrent containers x max(observed writable high-water ${inputs.containerWritableHighWaterBytes}, 64 MiB) `
      + `+ 10 GiB fixed margin; the measured materialization delta was ${inputs.materializationDeltaBytes} bytes and is already on disk`,
  };
}

export interface DockerCapacityGateReport {
  readonly at: string;
  readonly dockerRootDir: string;
  readonly filesystem: FilesystemCapacity;
  readonly requirement: DockerCapacityRequirement;
  readonly issues: readonly string[];
  readonly pass: boolean;
}

export function dockerCapacityGate(
  dockerRootDir: string, filesystem: FilesystemCapacity, requirement: DockerCapacityRequirement, at: string,
): DockerCapacityGateReport {
  const issues: string[] = [];
  if (filesystem.freeBytes < requirement.requiredFreeBytes) {
    issues.push(`Docker root ${dockerRootDir} has ${filesystem.freeBytes} bytes free; the derived requirement is ${requirement.requiredFreeBytes}`);
  }
  if (filesystem.freeInodes < M218_SCRATCH_POLICY.hostSafetyReserveInodes) {
    issues.push(`Docker root ${dockerRootDir} has ${filesystem.freeInodes} inodes free; the host reserve is ${M218_SCRATCH_POLICY.hostSafetyReserveInodes}`);
  }
  return { at, dockerRootDir, filesystem, requirement, issues: Object.freeze(issues), pass: issues.length === 0 };
}

// ── §13–§17 — historical /tmp: attribution is not ownership ─────────

export type HistoricalClassification = "PROVABLY_OWNED" | "AMBIGUOUS" | "UNRELATED" | "ACTIVE";

export interface HistoricalTmpEntry {
  readonly path: string;
  readonly name: string;
  readonly bytes: number;
  readonly entries: number;
  readonly ageDays: number | null;
  readonly attributionLabel: string;
  readonly attributionProducer: string;
  readonly classification: HistoricalClassification;
  readonly ownershipEvidence: readonly string[];
  readonly whyOwnershipInsufficient: string | null;
  readonly liveReferences: readonly LiveReference[];
  readonly disposition: "REPORT_ONLY_DO_NOT_DELETE" | "ELIGIBLE_FOR_M218_SWEEP" | "LAUNCH_BLOCKER_UNTIL_CLASSIFIED";
}

export interface HistoricalTmpCensus {
  readonly root: string;
  readonly at: string;
  readonly totalEntries: number;
  readonly byClassification: Record<HistoricalClassification, { entries: number; bytes: number }>;
  readonly significant: readonly HistoricalTmpEntry[];
  readonly deleted: 0;
  readonly rule: string;
}

export interface TmpAttribution {
  readonly test: (name: string) => boolean;
  readonly label: string;
  readonly producer: string;
  /** EXTERNAL producers (system, browser, other tooling) are UNRELATED, never benchmark scratch. */
  readonly external: boolean;
}

export interface OwnershipFacts {
  /** Registries whose claims can prove ownership of a path (M218 §14). */
  readonly registries: readonly ScratchRegistry[];
  /** Canonical roots of currently established, marked namespaces. */
  readonly namespaceRoots: readonly string[];
}

/**
 * §14, §15 — classify one top-level /tmp entry.
 *
 *   PROVABLY_OWNED  a registered M218 claim names the path, or the path is a
 *                   marked namespace of the current experiment (and nothing
 *                   live references it) — the ONLY class the sweep may delete
 *   ACTIVE          something live references it: a process, a mount, a
 *                   container bind — never deleted; blocks until classified
 *   UNRELATED       attributed to an EXTERNAL producer (system, browser,
 *                   other tooling) — never a benchmark candidate, live or not
 *   AMBIGUOUS       attributed to a benchmark or test producer by name, or
 *                   unattributed, without an ownership record — REPORT_ONLY
 */
export function classifyHistoricalEntry(
  path: string, name: string, attributions: readonly TmpAttribution[], facts: OwnershipFacts, liveness: LivenessProbe,
  measured: { readonly bytes: number; readonly entries: number; readonly ageDays: number | null },
): HistoricalTmpEntry {
  const attribution = attributions.find((entry) => entry.test(name));
  const label = attribution?.label ?? "(unclassified)";
  const producer = attribution?.producer ?? "unattributed; no known source produces this name";
  const evidence: string[] = [];
  let canonical = path;
  try {
    canonical = readlinkSync(path);
    evidence.push(`top-level symlink → ${canonical}; a symlink is never deleted through`);
  } catch {
    canonical = path;
  }
  for (const registry of facts.registries) {
    for (const claim of registry.claimsForPath(path)) evidence.push(`registry claim ${claim.claimId} (${claim.attemptId}) state ${claim.state} names this path`);
  }
  const marked = facts.namespaceRoots.some((root) => root === path || path.startsWith(`${root}${sep}`));
  if (marked) evidence.push("inside a marked namespace of the current experiment");
  const owned = evidence.some((line) => line.startsWith("registry claim")) || marked;
  const live = liveness.referencesTo(path);
  const base = { path, name, bytes: measured.bytes, entries: measured.entries, ageDays: measured.ageDays, attributionLabel: label, attributionProducer: producer, liveReferences: live };
  if (attribution?.external === true) {
    // An external producer's temp is UNRELATED whether or not it is live; a
    // live browser or CLI session is normal host activity, not benchmark residue.
    return { ...base, classification: "UNRELATED", ownershipEvidence: Object.freeze(evidence), whyOwnershipInsufficient: "external producer; never a benchmark candidate", disposition: "REPORT_ONLY_DO_NOT_DELETE" };
  }
  if (live.length > 0) {
    return { ...base, classification: "ACTIVE", ownershipEvidence: Object.freeze(evidence), whyOwnershipInsufficient: owned ? null : "a live reference exists; even an owned path is not deleted while referenced", disposition: "LAUNCH_BLOCKER_UNTIL_CLASSIFIED" };
  }
  if (owned) {
    return { ...base, classification: "PROVABLY_OWNED", ownershipEvidence: Object.freeze(evidence), whyOwnershipInsufficient: null, disposition: "ELIGIBLE_FOR_M218_SWEEP" };
  }
  return {
    ...base,
    classification: "AMBIGUOUS",
    ownershipEvidence: Object.freeze(evidence),
    whyOwnershipInsufficient:
      `${attribution === undefined ? "no known benchmark producer; unattributed" : `attributed to "${producer}" by name only`}; no M218 registry claim, operations-ledger record or current-experiment namespace marker names this path, `
      + "and a name prefix, an mtime or a plausible producer is attribution, not ownership (M218 §12, M219 §15)",
    disposition: "REPORT_ONLY_DO_NOT_DELETE",
  };
}

export function historicalTmpCensus(
  root: string, attributions: readonly TmpAttribution[], facts: OwnershipFacts, liveness: LivenessProbe,
  options: { readonly significantBytes?: number; readonly now?: () => string; readonly names?: readonly string[] } = {},
): HistoricalTmpCensus {
  const at = (options.now ?? (() => new Date().toISOString()))();
  const names = options.names ?? readdirSync(root);
  const significantBytes = options.significantBytes ?? 64 * 1024 * 1024;
  const byClassification: Record<HistoricalClassification, { entries: number; bytes: number }> = {
    PROVABLY_OWNED: { entries: 0, bytes: 0 }, AMBIGUOUS: { entries: 0, bytes: 0 }, UNRELATED: { entries: 0, bytes: 0 }, ACTIVE: { entries: 0, bytes: 0 },
  };
  const significant: HistoricalTmpEntry[] = [];
  const nowMs = Date.parse(at);
  for (const name of names) {
    const path = `${root}${sep}${name}`;
    let measured: { bytes: number; entries: number; ageDays: number | null };
    try {
      const stat = lstatSync(path);
      const ageDays = (nowMs - stat.mtimeMs) / 86_400_000;
      if (stat.isDirectory()) {
        const tree = measureTree(path);
        measured = { bytes: tree.bytes, entries: tree.inodes, ageDays };
      } else {
        measured = { bytes: Number(stat.blocks) * 512, entries: 1, ageDays };
      }
    } catch {
      continue;
    }
    // Liveness is probed only for entries large enough to matter or attributed
    // to a benchmark producer; probing 60k fixture directories against /proc
    // would take longer than the census is worth and changes no decision, since
    // nothing below the threshold is deleted either way.
    const attribution = attributions.find((entry) => entry.test(name));
    const probe = measured.bytes >= significantBytes || (attribution !== undefined && !attribution.external)
      ? liveness : { referencesTo: () => [], pidAlive: () => false };
    const entry = classifyHistoricalEntry(path, name, attributions, facts, probe, measured);
    byClassification[entry.classification].entries += 1;
    byClassification[entry.classification].bytes += entry.bytes;
    if (entry.bytes >= significantBytes || entry.classification === "PROVABLY_OWNED" || entry.classification === "ACTIVE") significant.push(entry);
  }
  significant.sort((left, right) => right.bytes - left.bytes);
  return {
    root, at, totalEntries: names.length, byClassification, significant: Object.freeze(significant), deleted: 0,
    rule: "Only PROVABLY_OWNED may be deleted, and only through the M218 sweep authority. AMBIGUOUS is REPORT_ONLY / DO_NOT_DELETE regardless of size. This census deletes nothing.",
  };
}

/** The M218 census attribution table, restated with the EXTERNAL flag M219 needs. */
export const M219_TMP_ATTRIBUTIONS: readonly TmpAttribution[] = Object.freeze([
  { test: (name) => /^(\.com\.google\.Chrome|\.org\.chromium|com\.google\.Chrome|\.X11-unix|\.ICE-unix|\.font-unix|\.XIM-unix|systemd-|snap-private-tmp|tmux-|\.mount_|dbus-|pulse-|\.wayland|xauth|Temp-)/.test(name), label: "system / browser", producer: "EXTERNAL system and browser temp (never benchmark-owned)", external: true },
  { test: (name) => name === "claude-1000" || /^claude-/.test(name), label: "claude-*", producer: "Claude Code CLI session scratchpads (EXTERNAL; not benchmark-owned)", external: true },
  { test: (name) => /^m0[0-9]{2}-/.test(name), label: "m0xx-*", producer: "not a Stage 5 producer (other project prefixes, e.g. m010/m020 model-training scratch)", external: true },
  { test: (name) => /^rxn_/.test(name), label: "rxn_*", producer: "not a Stage 5 producer (other project scratch)", external: true },
  { test: (name) => /^vtrace-stage5-m218-research-/.test(name), label: "vtrace-stage5-m218-research-*", producer: "run_stage5_m218_real_host.ts research namespace (removed by its own finally; a survivor is a crashed control)", external: false },
  { test: (name) => /^m218-unrelated-/.test(name), label: "m218-unrelated-*", producer: "run_stage5_m218_real_host.ts sentinel (removed by its own finally)", external: false },
  { test: (name) => /^vtrace-capsulev2-/.test(name), label: "vtrace-capsulev2-*", producer: "src/capsuleV2/__fixtures__/capsuleV2Fixture.ts mkdtemp (bun test fixtures, never removed)", external: false },
  { test: (name) => /^vtrace-/.test(name), label: "vtrace-* (other)", producer: "src/workspace/workspaceFixture.ts and benchmark runners (mkdtemp prefixes)", external: false },
  { test: (name) => /^m21[0-3]-/.test(name), label: "m210-*/m211-*/m212-*/m213-*", producer: "run_stage5_m210..m213_*.ts default --scratch/--work paths (corpus copies)", external: false },
  { test: (name) => /^m20[0-3]/.test(name), label: "m200-*..m203-*", producer: "run_stage5_m200..m203_*.ts default scratch/snapshot paths", external: false },
  { test: (name) => /^m216-git-/.test(name), label: "m216-git-*", producer: "m216RealSubstrate.ts scratchRepo mkdtemp", external: false },
  { test: (name) => /^m(1[0-9]{2})-/.test(name), label: "m1xx-*", producer: "run_stage5_m1xx_*.test.ts / *.ts mkdtemp fixtures", external: false },
  { test: (name) => /^m19[0-9]/.test(name), label: "m19x-*", producer: "run_stage5_m193a_isolation_evidence.ts, run_stage5_m195a_separation.ts mkdtemp", external: false },
  { test: (name) => /^m[0-9]/.test(name), label: "m*-* (other)", producer: "benchmark runners (see the M218 census grep)", external: false },
  { test: (name) => /^stage5-/.test(name), label: "stage5-*", producer: "benchmark unit-test fixtures", external: false },
  { test: (name) => /^stage4-/.test(name), label: "stage4-*", producer: "benchmarks/arc_stage4_* runner fixtures", external: false },
  { test: (name) => /^arc-stage/.test(name), label: "arc-stage*", producer: "benchmarks/arc_stage3_* fixtures", external: false },
  { test: (name) => /^(pivot-|pilot-|loc-signals|capsule-v|gp-critic|astropy-diag|pivot-check)/.test(name), label: "pivot-*/pilot-*/loc-signals*/capsule-v*/gp-critic*/astropy-diag*", producer: "src/**/__tests__ and benchmark unit-test fixtures (mkdtemp)", external: false },
]);

// ── §18 — live benchmark residue on the host ───────────────────────

export interface ResidueProcess {
  readonly pid: number;
  readonly command: string;
  readonly cwd: string;
  readonly classification: "BENCHMARK_SUBSTRATE" | "AGENT_SANDBOX" | "EVALUATOR" | "UNRELATED_TOOLING" | "THIS_PREFLIGHT";
}

export interface ResidueContainer {
  readonly name: string;
  readonly image: string;
  readonly status: string;
  readonly classification: "HARNESS" | "EVALUATOR" | "M219_PREFLIGHT" | "UNRELATED";
  readonly bindSources: readonly string[];
}

export interface ResidueCensus {
  readonly at: string;
  readonly benchmarkRoots: readonly string[];
  readonly containers: readonly ResidueContainer[];
  readonly processes: readonly ResidueProcess[];
  readonly mounts: readonly string[];
  readonly blocking: readonly string[];
  readonly pass: boolean;
}

/**
 * Enumerate every container, every process and every mount, and classify what
 * touches the benchmark. A harness (`m193-*`) or evaluator (`sweb.eval.*`)
 * container, a substrate bridge, an agent sandbox bound into a benchmark root,
 * an evaluator process, or a mount under a benchmark root is residue and
 * blocks. Unrelated containers and tooling are listed and left alone.
 */
export function residueCensus(
  benchmarkRoots: readonly string[],
  facts: {
    readonly containers: readonly { name: string; image: string; status: string; bindSources: readonly string[] }[];
    readonly processes: readonly { pid: number; command: string; cwd: string }[];
    readonly mountPoints: readonly string[];
  },
  at: string,
  selfPids: readonly number[] = [process.pid, process.ppid],
): ResidueCensus {
  const under = (candidate: string): boolean => benchmarkRoots.some((root) => candidate === root || candidate.startsWith(`${root}${sep}`));
  const containers = facts.containers.map((box): ResidueContainer => {
    const name = box.name.replace(/^\//, "");
    const classification: ResidueContainer["classification"] = name.startsWith("m193-") ? "HARNESS"
      : name.startsWith("sweb.eval.") ? "EVALUATOR"
        : name.startsWith("m219-preflight-") ? "M219_PREFLIGHT"
          : box.bindSources.some(under) ? "HARNESS" : "UNRELATED";
    return { name, image: box.image, status: box.status, classification, bindSources: box.bindSources };
  });
  const processes: ResidueProcess[] = [];
  for (const proc of facts.processes) {
    if (selfPids.includes(proc.pid)) continue;
    const command = proc.command;
    const benchmarkPath = under(proc.cwd) || benchmarkRoots.some((root) => command.includes(root));
    let classification: ResidueProcess["classification"] | null = null;
    if (/m216_substrate_bridge\.py|m193_container_adapter|run_stage5_m194_acquire\.py/.test(command)) classification = "BENCHMARK_SUBSTRATE";
    else if (/swebench\.harness\.run_evaluation|run_evaluation/.test(command)) classification = "EVALUATOR";
    else if (/(^|\s|\/)bwrap(\s|$)/.test(command)) classification = benchmarkPath || /--bind \S+\/tmp \/tmp/.test(command) ? "AGENT_SANDBOX" : "UNRELATED_TOOLING";
    else if (benchmarkPath) classification = /run_stage5_m219_|m219/.test(command) ? "THIS_PREFLIGHT" : "BENCHMARK_SUBSTRATE";
    else if (/(^|\/)claude(\s|$)/.test(command)) classification = "UNRELATED_TOOLING";
    if (classification !== null) processes.push({ pid: proc.pid, command: command.slice(0, 240), cwd: proc.cwd, classification });
  }
  const mounts = facts.mountPoints.filter(under);
  const blocking: string[] = [];
  for (const box of containers) if (box.classification !== "UNRELATED") blocking.push(`container ${box.name} (${box.classification}, ${box.status})`);
  for (const proc of processes) if (proc.classification === "BENCHMARK_SUBSTRATE" || proc.classification === "AGENT_SANDBOX" || proc.classification === "EVALUATOR") blocking.push(`process ${proc.pid} (${proc.classification}) ${proc.command.slice(0, 120)}`);
  for (const mount of mounts) blocking.push(`mount ${mount}`);
  return { at, benchmarkRoots, containers: Object.freeze(containers), processes: Object.freeze(processes), mounts: Object.freeze(mounts), blocking: Object.freeze(blocking), pass: blocking.length === 0 };
}

export function hostResidueFacts(): Parameters<typeof residueCensus>[1] {
  const containers: { name: string; image: string; status: string; bindSources: string[] }[] = [];
  const ids = execFileSync("docker", ["ps", "-aq"], { encoding: "utf8", timeout: 60_000 }).split("\n").map((line) => line.trim()).filter(Boolean);
  if (ids.length > 0) {
    const out = execFileSync("docker", ["inspect", "--format", "{{.Name}}\t{{.Config.Image}}\t{{.State.Status}}\t{{range .Mounts}}{{.Source}};{{end}}", ...ids], { encoding: "utf8", timeout: 120_000 });
    for (const line of out.split("\n")) {
      const [name, image, status, sources] = line.split("\t");
      if (name === undefined || image === undefined) continue;
      containers.push({ name, image, status: status ?? "?", bindSources: (sources ?? "").split(";").filter(Boolean) });
    }
  }
  const processes: { pid: number; command: string; cwd: string }[] = [];
  for (const entry of readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    const pid = Number(entry);
    let command = "";
    try {
      command = readFileSync(`/proc/${pid}/cmdline`, "latin1").replace(/\0/g, " ").trim();
    } catch {
      continue;
    }
    if (command.length === 0) continue;
    let cwd = "";
    try {
      cwd = readlinkSync(`/proc/${pid}/cwd`);
    } catch {
      cwd = "";
    }
    processes.push({ pid, command, cwd });
  }
  const mountPoints = readFileSync("/proc/self/mountinfo", "utf8").split("\n").map((line) => line.split(" ")[4] ?? "").filter(Boolean);
  return { containers, processes, mountPoints };
}

// ── §21 — host resource health ─────────────────────────────────────

export interface HostResourceHealth {
  readonly at: string;
  readonly loadAverage: readonly number[];
  readonly cpus: number;
  readonly memoryTotalBytes: number;
  readonly memoryAvailableBytes: number;
  readonly swapTotalBytes: number;
  readonly swapFreeBytes: number;
  readonly processCount: number;
  readonly threadsMax: number;
  readonly pidMax: number;
  readonly userProcessLimit: number | null;
  readonly issues: readonly string[];
  readonly pass: boolean;
}

/**
 * No performance gate is invented here: the only refusals are obvious
 * exhaustion — under 2 GiB of available memory, or more than 80% of the pid or
 * thread table in use — because prior incidents were fork failures.
 */
export function hostResourceHealth(at: string): HostResourceHealth {
  const meminfo = new Map<string, number>();
  for (const line of readFileSync("/proc/meminfo", "utf8").split("\n")) {
    const match = /^(\w+):\s+(\d+)/.exec(line);
    if (match !== null) meminfo.set(match[1]!, Number(match[2]) * 1024);
  }
  const load = readFileSync("/proc/loadavg", "utf8").trim().split(" ").slice(0, 3).map(Number);
  const processCount = readdirSync("/proc").filter((entry) => /^\d+$/.test(entry)).length;
  const threadsMax = Number(readFileSync("/proc/sys/kernel/threads-max", "utf8").trim());
  const pidMax = Number(readFileSync("/proc/sys/kernel/pid_max", "utf8").trim());
  let userProcessLimit: number | null = null;
  try {
    const limits = readFileSync("/proc/self/limits", "utf8");
    const match = /Max processes\s+(\S+)/.exec(limits);
    userProcessLimit = match === null || match[1] === "unlimited" ? null : Number(match[1]);
  } catch {
    userProcessLimit = null;
  }
  const issues: string[] = [];
  const available = meminfo.get("MemAvailable") ?? 0;
  if (available < 2 * GIB) issues.push(`only ${available} bytes of memory available`);
  if (processCount > 0.8 * pidMax) issues.push(`${processCount} processes against pid_max ${pidMax}`);
  if (userProcessLimit !== null && processCount > 0.8 * userProcessLimit) issues.push(`${processCount} processes against the user process limit ${userProcessLimit}`);
  return {
    at, loadAverage: load, cpus: Number(execFileSync("nproc", { encoding: "utf8" }).trim()),
    memoryTotalBytes: meminfo.get("MemTotal") ?? 0, memoryAvailableBytes: available,
    swapTotalBytes: meminfo.get("SwapTotal") ?? 0, swapFreeBytes: meminfo.get("SwapFree") ?? 0,
    processCount, threadsMax, pidMax, userProcessLimit, issues: Object.freeze(issues), pass: issues.length === 0,
  };
}

// ── F11 — the production path contains no global Docker cleanup ────

export const M219_FORBIDDEN_OPERATIONS: readonly RegExp[] = Object.freeze([
  /docker\s+system\s+prune/, /docker\s+image\s+prune/, /docker\s+container\s+prune/, /docker\s+volume\s+prune/, /docker\s+builder\s+prune/,
  /docker\s+rmi\b/, /docker\s+image\s+rm\b/, /images\.prune\(/, /containers\.prune\(/, /volumes\.prune\(/, /\.remove\(\s*image/,
  /rm\s+-rf\s+\/tmp(\/\*|\s|"|'|$)/, /rmSync\(\s*["']\/tmp["']/, /rmSync\(\s*tmpdir\(\)\s*[,)]/,
]);

export interface ForbiddenOperationScan {
  readonly files: readonly string[];
  readonly hits: readonly { file: string; line: number; text: string }[];
  readonly pass: boolean;
}

export function scanForForbiddenOperations(files: readonly string[], read: (file: string) => string = (file) => readFileSync(file, "utf8")): ForbiddenOperationScan {
  const hits: { file: string; line: number; text: string }[] = [];
  for (const file of files) {
    const lines = read(file).split("\n");
    lines.forEach((text, index) => {
      // Comments that NAME the forbidden operation in order to forbid it are not hits.
      const stripped = text.replace(/\/\/.*$/, "").replace(/^\s*#.*$/, "").replace(/^\s*\*.*$/, "");
      if (M219_FORBIDDEN_OPERATIONS.some((pattern) => pattern.test(stripped))) hits.push({ file, line: index + 1, text: text.trim().slice(0, 160) });
    });
  }
  return { files, hits: Object.freeze(hits), pass: hits.length === 0 };
}

// ── helpers shared by the runners ───────────────────────────────────

export function markedNamespaceRoots(candidates: readonly string[]): readonly string[] {
  return candidates.filter((root) => existsSync(`${root}${sep}${M218_NAMESPACE_MARKER}`));
}

// ── a liveness probe over one host snapshot ─────────────────────────

/**
 * `HostLivenessProbe` re-enumerates /proc and asks Docker on every call; over
 * tens of thousands of /tmp entries that is minutes of probing that changes no
 * decision. This probe answers from ONE snapshot of the same facts (process
 * cmdline + cwd, mount points, container bind sources) taken at census time.
 * It is used for the historical /tmp classification only; the M218 sweep and
 * cleanup keep using the live probe.
 */
export class SnapshotLivenessProbe implements LivenessProbe {
  constructor(
    private readonly facts: ReturnType<typeof hostResidueFacts>,
    private readonly excludePids: readonly number[] = [process.pid, process.ppid],
  ) {}

  pidAlive(pid: number): boolean {
    return this.facts.processes.some((proc) => proc.pid === pid);
  }

  referencesTo(path: string): readonly LiveReference[] {
    const found: LiveReference[] = [];
    for (const proc of this.facts.processes) {
      if (this.excludePids.includes(proc.pid)) continue;
      if (proc.command.includes(path) || proc.cwd === path || proc.cwd.startsWith(`${path}${sep}`)) {
        found.push({ kind: "PROCESS", detail: `pid ${proc.pid} ${proc.command.slice(0, 200)}${proc.cwd ? ` (cwd ${proc.cwd})` : ""}` });
      }
    }
    for (const mount of this.facts.mountPoints) {
      if (mount === path || mount.startsWith(`${path}${sep}`)) found.push({ kind: "MOUNT", detail: `mount at ${mount}` });
    }
    for (const box of this.facts.containers) {
      for (const source of box.bindSources) {
        if (source === path || source.startsWith(`${path}${sep}`)) {
          found.push({ kind: "CONTAINER", detail: `${box.name.replace(/^\//, "")} (${box.status}) binds ${source}` });
        }
      }
    }
    return Object.freeze(found);
  }
}
