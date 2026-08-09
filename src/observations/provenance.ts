import { createHash } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { readIndexMeta, type IndexMeta } from "../indexer/indexMeta";
import { resolveWorktreeIdentity } from "../indexer/worktreeIdentity";
import {
  OBSERVATION_PROVENANCE_SCHEMA_VERSION,
  type CurrentObservationContext,
  type ObservationIndexProvenance,
  type ObservationProvenance,
  type ObservationToolProvenance,
  type TechnicalObservationSummary,
} from "./types";

const execFile = promisify(execFileCallback);
const VTRACE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

export const MEMORY_CAPABILITY_FINGERPRINT = "vtrace.memory-provenance/1" as const;

/**
 * Narrow, explicit capability identities. An older implementation commit remains
 * compatible when the relevant capability identity is unchanged; unrelated
 * source edits therefore do not invalidate repository evidence.
 */
export const TOOL_CAPABILITY_FINGERPRINTS = Object.freeze({
  get_impact_graph: "vtrace.impact/canonical-bounded-v2",
  search_logic_flow: "vtrace.flow/frontier-edge-sites-v2",
  get_code_context: "vtrace.context/direct-attribution-v3",
  get_context_capsule: "vtrace.capsule/direct-attribution-v3",
  run_pipeline: "vtrace.pipeline/direct-attribution-v3",
  get_skeleton: "vtrace.skeleton/v1",
  search_memory: "vtrace.memory-search/provenance-v1",
  get_session_context: "vtrace.session-context/provenance-v1",
  expand_vexp_ref: "vtrace.vexp-ref/v1",
  save_observation: "vtrace.observation-save/provenance-v1",
  detect_anti_patterns: "vtrace.anti-patterns/index-events-v1",
}) satisfies Readonly<Record<string, string>>;

export async function resolveCurrentObservationContext(
  repoRoot: string,
): Promise<CurrentObservationContext> {
  const [identity, indexMeta, implementation] = await Promise.all([
    resolveWorktreeIdentity(repoRoot),
    readIndexMeta(repoRoot),
    resolveImplementationProvenance(),
  ]);

  return {
    repository: {
      repositoryId: identity.repository.repositoryId,
      worktreeId: identity.worktree.worktreeId,
      worktreeRoot: identity.worktree.worktreeRoot,
      headCommit: identity.snapshot.headCommit,
      branch: identity.snapshot.branch,
      detached: identity.snapshot.detached,
      dirtyFingerprint: identity.snapshot.dirtyFingerprint,
    },
    index: indexMeta === undefined ? null : indexProvenance(indexMeta),
    implementation,
    toolCapabilityFingerprints: TOOL_CAPABILITY_FINGERPRINTS,
  };
}

export function buildObservationProvenance(input: {
  readonly context: CurrentObservationContext;
  readonly toolName?: string;
  readonly queryText?: string;
  readonly semanticOptions?: Readonly<Record<string, unknown>>;
  readonly resultSummary?: TechnicalObservationSummary;
  readonly resultValue?: unknown;
}): ObservationProvenance {
  const tool = input.toolName === undefined
    ? null
    : buildToolProvenance(input.context, input.toolName, input.queryText, input.semanticOptions);
  const resultSemanticHash = input.resultValue === undefined
    ? null
    : semanticHash(input.resultValue);

  return {
    schemaVersion: OBSERVATION_PROVENANCE_SCHEMA_VERSION,
    repository: { ...input.context.repository },
    index: input.context.index === null ? null : { ...input.context.index },
    implementation: { ...input.context.implementation },
    tool,
    resultSemanticHash,
    resultSummary: input.resultSummary ?? null,
  };
}

export function buildObservationSemanticKey(input: {
  readonly scope: string;
  readonly provenance: ObservationProvenance;
}): string {
  const repository = input.provenance.repository;
  const index = input.provenance.index;
  const tool = input.provenance.tool;
  return semanticHash({
    scope: input.scope,
    repositoryId: repository.repositoryId,
    worktreeId: repository.worktreeId,
    headCommit: repository.headCommit,
    dirtyFingerprint: repository.dirtyFingerprint,
    indexIdentity: index?.identity ?? null,
    tool: tool?.name ?? null,
    normalizedQuery: tool?.normalizedQuery ?? null,
    semanticOptions: tool?.semanticOptions ?? {},
  });
}

export function semanticHash(value: unknown): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

export function normalizeObservationQuery(value: string | undefined): string | null {
  if (value === undefined) return null;
  const normalized = value.trim().replace(/\\/g, "/").replace(/\s+/gu, " ").toLowerCase();
  return normalized.length === 0 ? null : normalized;
}

function buildToolProvenance(
  context: CurrentObservationContext,
  name: string,
  queryText: string | undefined,
  semanticOptions: Readonly<Record<string, unknown>> | undefined,
): ObservationToolProvenance {
  return {
    name,
    normalizedQuery: normalizeObservationQuery(queryText),
    semanticOptions: semanticOptions ?? {},
    capabilityFingerprint: context.toolCapabilityFingerprints[name]
      ?? `vtrace.tool/${name}/unversioned`,
  };
}

function indexProvenance(meta: IndexMeta): ObservationIndexProvenance {
  const capability = {
    formatVersion: meta.index_format_version,
    schemaVersion: meta.schema_version,
    indexerFingerprint: meta.indexer_fingerprint,
    parserFingerprint: meta.parser_fingerprint,
    configFingerprint: meta.config_hash,
  };
  const identity = semanticHash({
    repositoryId: meta.manifest.repository.repositoryId,
    worktreeId: meta.manifest.worktree.worktreeId,
    headCommit: meta.manifest.snapshot.headCommit,
    dirtyFingerprint: meta.manifest.snapshot.dirtyFingerprint,
    runId: meta.manifest.index.runId,
    ...capability,
  });
  return {
    identity,
    runId: meta.manifest.index.runId,
    worktreeId: meta.manifest.worktree.worktreeId,
    headCommit: meta.manifest.snapshot.headCommit,
    dirtyFingerprint: meta.manifest.snapshot.dirtyFingerprint,
    ...capability,
  };
}

async function resolveImplementationProvenance(): Promise<CurrentObservationContext["implementation"]> {
  const [commit, tree, status] = await Promise.all([
    gitOutputOrNull(["rev-parse", "HEAD"]),
    gitOutputOrNull(["rev-parse", "HEAD^{tree}"]),
    gitOutputOrNull([
      "-c", "core.quotepath=off", "status", "--porcelain=v1", "--untracked-files=all", "--",
      "src", "package.json", "tsconfig.json",
    ]),
  ]);
  return {
    commit,
    tree,
    dirtyFingerprint: status === null || status.length === 0
      ? null
      : await hashImplementationDirtyState(status),
    memoryCapabilityFingerprint: MEMORY_CAPABILITY_FINGERPRINT,
  };
}

async function hashImplementationDirtyState(status: string): Promise<string> {
  const hash = createHash("sha256").update(status).update("\0");
  const paths = status.split(/\r?\n/u)
    .filter(Boolean)
    .map((line) => line.slice(3).split(" -> ").at(-1)!)
    .sort((left, right) => left.localeCompare(right));
  for (const relativePath of paths) {
    hash.update(relativePath).update("\0");
    try {
      hash.update(await readFile(path.join(VTRACE_ROOT, relativePath)));
    } catch {
      hash.update("<missing>");
    }
    hash.update("\n");
  }
  return hash.digest("hex");
}

async function gitOutputOrNull(args: readonly string[]): Promise<string | null> {
  try {
    const { stdout } = await execFile("git", [...args], { cwd: VTRACE_ROOT, encoding: "utf8" });
    return stdout.trim();
  } catch {
    return null;
  }
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => (
    `${JSON.stringify(key)}:${stableStringify(record[key])}`
  )).join(",")}}`;
}
