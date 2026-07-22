import { createHash } from "node:crypto";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";

import {
  computeFileId,
  normalizeFilePath,
  type FilePath,
  type FileRecord,
} from "../domain/types";
import { hashFile } from "./hashFile";
import { detectLanguage } from "./languageDetection";
import {
  isPathIgnored,
  loadIgnoreRulesForDirectory,
  type IgnoreRule,
} from "./ignoreRules";

const IGNORED_DIRECTORIES = new Set([
  ".git",
  ".vtrace",
  "node_modules",
  "dist",
  "build",
  "out",
  "coverage",
  ".next",
  ".nuxt",
  ".svelte-kit",
  ".turbo",
  ".cache",
  ".parcel-cache",
  ".vite",
  ".venv",
  "venv",
  "__pycache__",
  ".mypy_cache",
  ".pytest_cache",
  ".ruff_cache",
  ".tox",
  ".eggs",
  "target",
  ".gradle",
  ".idea",
  ".vscode",
  ".vs",
  "vendor",
]);

export interface RepoSourceSnapshot {
  fileCount: number;
  fingerprint: string;
}

export async function scanRepo(repoRoot: string): Promise<FileRecord[]> {
  const root = path.resolve(repoRoot);
  const files = await scanDirectory(root, root, []);

  return files.sort((left, right) => left.path.localeCompare(right.path));
}

export async function captureRepoSourceSnapshot(
  repoRoot: string,
): Promise<RepoSourceSnapshot> {
  const root = path.resolve(repoRoot);
  const fingerprint = createHash("sha256");
  const fileCount = await updateSourceSnapshotFingerprint(root, root, fingerprint, []);

  return {
    fileCount,
    fingerprint: fingerprint.digest("hex"),
  };
}

export function isRecognizedRepoSourcePath(filePath: string): boolean {
  const normalizedPath = normalizeFilePath(filePath);
  const segments = normalizedPath.split("/");

  if (segments.some((segment) => IGNORED_DIRECTORIES.has(segment))) {
    return false;
  }

  return detectLanguage(normalizedPath) !== undefined;
}

async function scanDirectory(
  root: string,
  directory: string,
  inheritedRules: readonly IgnoreRule[],
): Promise<FileRecord[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));

  const rules = await accumulateIgnoreRules(root, directory, inheritedRules, entries);
  const files: FileRecord[] = [];

  for (const entry of entries) {
    const relativePath = toRepoRelativePath(root, path.join(directory, entry.name));

    if (entry.isDirectory()) {
      if (IGNORED_DIRECTORIES.has(entry.name) || isPathIgnored(rules, relativePath, true)) {
        continue;
      }

      files.push(...(await scanDirectory(root, path.join(directory, entry.name), rules)));
      continue;
    }

    if (!entry.isFile()) {
      continue;
    }

    if (isPathIgnored(rules, relativePath, false)) {
      continue;
    }

    const language = detectLanguage(relativePath);

    if (language === undefined) {
      continue;
    }

    const absolutePath = path.join(directory, entry.name);
    const [fileStat, contentHash] = await Promise.all([
      stat(absolutePath),
      hashFile(absolutePath),
    ]);

    files.push({
      id: computeFileId(relativePath),
      path: relativePath,
      language,
      contentHash,
      sizeBytes: fileStat.size,
    });
  }

  return files;
}

async function accumulateIgnoreRules(
  root: string,
  directory: string,
  inheritedRules: readonly IgnoreRule[],
  entries: readonly import("node:fs").Dirent[],
): Promise<IgnoreRule[]> {
  const entryNames = new Set(
    entries.filter((entry) => entry.isFile()).map((entry) => entry.name),
  );
  const relativeDirectory = path.relative(root, directory);
  const baseDir = relativeDirectory.length === 0 ? "" : normalizeFilePath(relativeDirectory);
  const localRules = await loadIgnoreRulesForDirectory(directory, baseDir, entryNames);

  return [...inheritedRules, ...localRules];
}

async function updateSourceSnapshotFingerprint(
  root: string,
  directory: string,
  fingerprint: ReturnType<typeof createHash>,
  inheritedRules: readonly IgnoreRule[],
): Promise<number> {
  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));

  const rules = await accumulateIgnoreRules(root, directory, inheritedRules, entries);
  let fileCount = 0;

  for (const entry of entries) {
    const relativePath = toRepoRelativePath(root, path.join(directory, entry.name));

    if (entry.isDirectory()) {
      if (IGNORED_DIRECTORIES.has(entry.name) || isPathIgnored(rules, relativePath, true)) {
        continue;
      }

      fileCount += await updateSourceSnapshotFingerprint(
        root,
        path.join(directory, entry.name),
        fingerprint,
        rules,
      );
      continue;
    }

    if (!entry.isFile()) {
      continue;
    }

    if (isPathIgnored(rules, relativePath, false)) {
      continue;
    }

    const absolutePath = path.join(directory, entry.name);

    if (detectLanguage(relativePath) === undefined) {
      continue;
    }

    const fileStat = await stat(absolutePath, { bigint: true });
    fingerprint.update(relativePath);
    fingerprint.update("\0");
    fingerprint.update(fileStat.size.toString(10));
    fingerprint.update("\0");
    fingerprint.update(fileStat.mtimeNs.toString(10));
    fingerprint.update("\n");
    fileCount += 1;
  }

  return fileCount;
}

function toRepoRelativePath(root: string, absolutePath: string): FilePath {
  return normalizeFilePath(path.relative(root, absolutePath));
}
