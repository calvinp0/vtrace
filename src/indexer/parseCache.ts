import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import type { Language, ParseResult } from "../domain/types";
import type { ResolvedWorktreeIdentity } from "./worktreeIdentity";

export const PARSE_CACHE_SCHEMA_VERSION = 1 as const;

export interface ParseCacheKeyInput {
  readonly contentHash: string;
  readonly contentKind: "git_blob" | "working_tree_hash";
  readonly gitBlobSha?: string;
  readonly parserId: string;
  readonly parserVersion: string;
  readonly parserConfigFingerprint: string;
  readonly language: Language;
  readonly relativePath: string;
  readonly bindingContextHash: string;
}

interface ParseCacheEnvelope {
  readonly schemaVersion: typeof PARSE_CACHE_SCHEMA_VERSION;
  readonly key: string;
  readonly keyInput: ParseCacheKeyInput;
  readonly payloadHash: string;
  readonly result: ParseResult;
}

export function computeParseCacheKey(input: ParseCacheKeyInput): string {
  return hash(JSON.stringify(canonicalKeyInput(input)));
}

export function resolveRepositoryParseCacheRoot(identity: ResolvedWorktreeIdentity): string {
  if (identity.repository.gitCommonDir !== null) {
    return path.join(identity.repository.gitCommonDir, "vtrace", "repositories", identity.repository.repositoryId, "parse-cache");
  }
  return path.join(identity.worktree.worktreeRoot, ".vtrace", "repositories", identity.repository.repositoryId, "parse-cache");
}

export function resolveParseCacheEntryPath(cacheRoot: string, input: ParseCacheKeyInput): string {
  const key = computeParseCacheKey(input);
  return path.join(cacheRoot, input.parserId, input.parserVersion.slice(0, 16), key.slice(0, 2), `${key}.json`);
}

export async function readParseCacheEntry(cacheRoot: string, input: ParseCacheKeyInput): Promise<ParseResult | undefined> {
  const key = computeParseCacheKey(input);
  try {
    const envelope = JSON.parse(await readFile(resolveParseCacheEntryPath(cacheRoot, input), "utf8")) as ParseCacheEnvelope;
    if (envelope.schemaVersion !== PARSE_CACHE_SCHEMA_VERSION || envelope.key !== key) return undefined;
    if (computeParseCacheKey(envelope.keyInput) !== key) return undefined;
    if (hash(JSON.stringify(envelope.result)) !== envelope.payloadHash) return undefined;
    if (envelope.result.file.path !== input.relativePath || envelope.result.file.language !== input.language || envelope.result.file.contentHash !== input.contentHash) return undefined;
    return envelope.result;
  } catch {
    return undefined;
  }
}

export async function writeParseCacheEntry(cacheRoot: string, input: ParseCacheKeyInput, result: ParseResult): Promise<string> {
  const key = computeParseCacheKey(input);
  const destination = resolveParseCacheEntryPath(cacheRoot, input);
  const existing = await readParseCacheEntry(cacheRoot, input);
  if (existing !== undefined) return key;
  await mkdir(path.dirname(destination), { recursive: true });
  const envelope: ParseCacheEnvelope = {
    schemaVersion: PARSE_CACHE_SCHEMA_VERSION,
    key,
    keyInput: canonicalKeyInput(input),
    payloadHash: hash(JSON.stringify(result)),
    result,
  };
  const temporary = path.join(path.dirname(destination), `.${key}.${process.pid}.${randomUUID()}.tmp`);
  await writeFile(temporary, `${JSON.stringify(envelope)}\n`, { flag: "wx" });
  // Rename is atomic for readers. Identical writers produce identical payloads;
  // the last rename may replace the same immutable value but never exposes a
  // partial entry.
  await rename(temporary, destination);
  return key;
}

function canonicalKeyInput(input: ParseCacheKeyInput): ParseCacheKeyInput {
  return {
    contentHash: input.contentHash,
    contentKind: input.contentKind,
    ...(input.gitBlobSha === undefined ? {} : { gitBlobSha: input.gitBlobSha }),
    parserId: input.parserId,
    parserVersion: input.parserVersion,
    parserConfigFingerprint: input.parserConfigFingerprint,
    language: input.language,
    relativePath: input.relativePath.replace(/\\/g, "/"),
    bindingContextHash: input.bindingContextHash,
  };
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
