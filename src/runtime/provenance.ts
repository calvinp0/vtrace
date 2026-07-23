import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { INDEX_FORMAT_VERSION } from "../indexer/indexMeta";
import {
  PRODUCT_RETRIEVAL_AUTHORITY,
  PRODUCT_RETRIEVAL_RANKING_VERSION,
} from "../capsuleV2/authoritativeProductRetrieval";

export const CAPSULE_IMPLEMENTATION = "hybrid" as const;
export const CAPSULE_SELECTION_AUTHORITY = "hybrid" as const;

const SOURCE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const PACKAGE_VERSION = readPackageVersion();
const SOURCE_COMMIT = readSourceCommit();

export interface RuntimeProvenance {
  packageVersion: string;
  commit: string | null;
  executablePath: string;
  sourceRoot: string;
  capsuleImplementation: typeof CAPSULE_IMPLEMENTATION;
  retrievalImplementation: typeof PRODUCT_RETRIEVAL_AUTHORITY;
  retrievalRankingVersion: typeof PRODUCT_RETRIEVAL_RANKING_VERSION;
  indexSchemaVersion: typeof INDEX_FORMAT_VERSION;
  manifestVersion: typeof INDEX_FORMAT_VERSION;
}

/** Compact, request-independent runtime identity. Never included in semantic hashes. */
export function getRuntimeProvenance(): RuntimeProvenance {
  return {
    packageVersion: PACKAGE_VERSION,
    commit: SOURCE_COMMIT,
    executablePath: path.join(SOURCE_ROOT, "bin", "vtrace"),
    sourceRoot: SOURCE_ROOT,
    capsuleImplementation: CAPSULE_IMPLEMENTATION,
    retrievalImplementation: PRODUCT_RETRIEVAL_AUTHORITY,
    retrievalRankingVersion: PRODUCT_RETRIEVAL_RANKING_VERSION,
    indexSchemaVersion: INDEX_FORMAT_VERSION,
    manifestVersion: INDEX_FORMAT_VERSION,
  };
}

function readPackageVersion(): string {
  try {
    const parsed = JSON.parse(readFileSync(path.join(SOURCE_ROOT, "package.json"), "utf8")) as {
      version?: unknown;
    };
    return typeof parsed.version === "string" ? parsed.version : "unknown";
  } catch {
    return "unknown";
  }
}

function readSourceCommit(): string | null {
  const fromEnvironment = process.env.VTRACE_BUILD_COMMIT?.trim();
  if (fromEnvironment) return fromEnvironment;
  try {
    const gitDir = path.join(SOURCE_ROOT, ".git");
    const head = readFileSync(path.join(gitDir, "HEAD"), "utf8").trim();
    if (!head.startsWith("ref: ")) return /^[0-9a-f]{40}$/i.test(head) ? head : null;
    const ref = head.slice("ref: ".length);
    try {
      const value = readFileSync(path.join(gitDir, ref), "utf8").trim();
      if (/^[0-9a-f]{40}$/i.test(value)) return value;
    } catch {
      const packed = readFileSync(path.join(gitDir, "packed-refs"), "utf8");
      const match = packed.split(/\r?\n/).find((line) => line.endsWith(` ${ref}`));
      const value = match?.split(" ", 1)[0];
      if (value !== undefined && /^[0-9a-f]{40}$/i.test(value)) return value;
    }
  } catch {
    // Packaged installs may not carry .git. VTRACE_BUILD_COMMIT is the build seam.
  }
  return null;
}
