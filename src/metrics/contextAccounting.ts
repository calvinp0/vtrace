// Product-path context accounting.
//
// VTRACE's context tools (`get_context_capsule`, `run_pipeline`, and
// `get_code_context` through delegation) emit a compact, focused projection of
// source code instead of whole files. This module attaches a deterministic,
// honest `accounting` block to those product responses so a consumer can see
// *how compact* the emitted context is relative to the naive alternative —
// reading the full contents of every source file the context touched.
//
// The estimate is intentionally NOT a tokenizer. It reuses the single
// `chars / 4` approximation that already sizes Capsule v2 (`capsuleV2/tokens.ts`)
// so the product surface speaks one consistent, well-documented unit. It exists
// to distinguish two things:
//   1. VTRACE compactness        (emitted context vs. naive full-file reads)
//   2. follow-up turn amplification (an agent re-Reading/Grepping the same files)
// It does not claim exact model-token truth, and it never touches retrieval,
// ranking, or capsule assembly.
//
// Safety: the naive baseline reads ONLY the unique files already selected and
// emitted by the capsule/context. It never scans the repo, refuses paths that
// escape the repo root, and treats every missing/unreadable file as a recorded
// skip rather than a failure. Accounting is best-effort: a caller should treat a
// thrown error as "omit the block", never as "fail the request".

import { readFile } from "node:fs/promises";
import path from "node:path";

import { estimateTokens, roundPercent } from "../capsuleV2/tokens";

/** The deterministic char->token method this module uses. Stable string. */
export const CONTEXT_ACCOUNTING_METHOD = "chars_div_4" as const;

/** Explicit description of the comparison baseline, surfaced in the response. */
export const CONTEXT_ACCOUNTING_BASELINE =
  "full contents of unique files represented in emitted context items";

/** A file that could not be counted toward the naive baseline, with the reason. */
export interface SkippedAccountingFile {
  path: string;
  reason: string;
}

/**
 * The deterministic accounting block attached to a product context response.
 * Every figure is an ESTIMATE derived from `chars / 4`, never a tokenizer count.
 */
export interface ContextAccounting {
  /** Wall-clock latency of the measured tool/orchestrator path, in milliseconds. */
  latencyMs: number;
  /** Estimated token cost of the actual emitted product response. */
  estimatedOutputTokens: number;
  /** Estimated token cost of reading the full contents of every unique file. */
  estimatedNaiveFullFileTokens: number;
  /** Naive full-file estimate minus emitted estimate, clamped at 0. */
  estimatedTokensSavedVsNaiveFullFile: number;
  /** Percent reduction vs. the naive full-file baseline; null when no files counted. */
  estimatedSavingsPercentVsNaiveFullFile: number | null;
  /** Count of unique files actually read for the naive baseline. */
  uniqueFilesCounted: number;
  /** The deterministic estimation method. */
  method: typeof CONTEXT_ACCOUNTING_METHOD;
  /** Explicit wording of the naive baseline. */
  baseline: string;
  /** Files that could not be counted (missing/unreadable/outside repo), if any. */
  skippedFiles?: SkippedAccountingFile[];
}

/** Reads a file's text. Injectable so the accounting builder stays unit-testable. */
export type AccountingFileReader = (absolutePath: string) => Promise<string>;

const defaultFileReader: AccountingFileReader = (absolutePath) =>
  readFile(absolutePath, "utf8");

/** A context item that carries a file path under one of the stable field names. */
export interface ContextFileBearer {
  /** Capsule v2 product items use `path`. */
  path?: string | null;
  /** Capsule v1 / run_pipeline context items use `filePath`. */
  filePath?: string | null;
}

/**
 * Estimate the token cost of a string. Deterministic, never negative, returns 0
 * for empty text. Delegates to the same `chars / 4` approximation used to size
 * Capsule v2, so the product surface has one consistent unit.
 */
export function estimateTokensFromText(text: string): number {
  return estimateTokens(text);
}

/**
 * Collect the unique, order-preserving set of repo-relative file paths from the
 * given groups of emitted context items. Reads `path` (Capsule v2) or `filePath`
 * (Capsule v1 / run_pipeline), whichever is present. Blank/missing paths are
 * ignored; this never invents or globs paths.
 */
export function collectUniqueContextFilePaths(
  groups: ReadonlyArray<ReadonlyArray<ContextFileBearer> | undefined>,
): string[] {
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const group of groups) {
    if (group === undefined) {
      continue;
    }
    for (const item of group) {
      const raw = item?.path ?? item?.filePath ?? "";
      const trimmed = typeof raw === "string" ? raw.trim() : "";
      if (trimmed.length === 0 || seen.has(trimmed)) {
        continue;
      }
      seen.add(trimmed);
      ordered.push(trimmed);
    }
  }
  return ordered;
}

/**
 * Resolve a repo-relative path against the repo root, refusing anything that
 * escapes the root (or resolves to the root itself). Returns the absolute path,
 * or null when the path is unsafe to read.
 */
function resolveWithinRepo(repoRoot: string, relativePath: string): string | null {
  const resolvedRoot = path.resolve(repoRoot);
  const resolved = path.resolve(resolvedRoot, relativePath);
  const relative = path.relative(resolvedRoot, resolved);
  if (relative.length === 0 || relative.startsWith("..") || path.isAbsolute(relative)) {
    return null;
  }
  return resolved;
}

function describeReadError(error: unknown): string {
  if (error !== null && typeof error === "object" && "code" in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string" && code.length > 0) {
      return code;
    }
  }
  return "unreadable";
}

/** Inputs for {@link buildContextAccounting}. */
export interface BuildContextAccountingInput {
  /** Repo root the relative file paths resolve against. */
  repoRoot: string;
  /** The emitted product response/context whose serialized size is estimated. */
  emittedValue: unknown;
  /** Groups of emitted context items to derive the unique file set from. */
  filePathGroups: ReadonlyArray<ReadonlyArray<ContextFileBearer> | undefined>;
  /** Measured wall-clock latency of the tool/orchestrator path, in milliseconds. */
  latencyMs: number;
  /** Optional file reader override (defaults to a bounded utf8 read). */
  reader?: AccountingFileReader;
}

/**
 * Build the deterministic `accounting` block for a product context response.
 *
 * - `estimatedOutputTokens` = chars/4 of the JSON-serialized emitted response.
 * - `estimatedNaiveFullFileTokens` = sum of chars/4 over the full contents of
 *   each unique file the emitted context represents.
 * - savings = naive - emitted, clamped at 0; percent is relative to naive.
 *
 * Best-effort and bounded: only the explicitly emitted files are read, each read
 * is guarded, and missing/unreadable/out-of-repo files are recorded as skips
 * rather than thrown. Pure aside from the injected file reads.
 */
export async function buildContextAccounting(
  input: BuildContextAccountingInput,
): Promise<ContextAccounting> {
  const reader = input.reader ?? defaultFileReader;
  const emittedText = safeSerialize(input.emittedValue);
  const estimatedOutputTokens = estimateTokensFromText(emittedText);

  const uniquePaths = collectUniqueContextFilePaths(input.filePathGroups);
  const skippedFiles: SkippedAccountingFile[] = [];
  let estimatedNaiveFullFileTokens = 0;
  let uniqueFilesCounted = 0;

  for (const relativePath of uniquePaths) {
    const absolutePath = resolveWithinRepo(input.repoRoot, relativePath);
    if (absolutePath === null) {
      skippedFiles.push({ path: relativePath, reason: "outside_repo" });
      continue;
    }
    try {
      const content = await reader(absolutePath);
      estimatedNaiveFullFileTokens += estimateTokensFromText(content);
      uniqueFilesCounted += 1;
    } catch (error) {
      skippedFiles.push({ path: relativePath, reason: describeReadError(error) });
    }
  }

  const estimatedTokensSavedVsNaiveFullFile = Math.max(
    0,
    estimatedNaiveFullFileTokens - estimatedOutputTokens,
  );
  const estimatedSavingsPercentVsNaiveFullFile = estimatedNaiveFullFileTokens > 0
    ? roundPercent((estimatedTokensSavedVsNaiveFullFile / estimatedNaiveFullFileTokens) * 100)
    : null;

  return {
    latencyMs: input.latencyMs,
    estimatedOutputTokens,
    estimatedNaiveFullFileTokens,
    estimatedTokensSavedVsNaiveFullFile,
    estimatedSavingsPercentVsNaiveFullFile,
    uniqueFilesCounted,
    method: CONTEXT_ACCOUNTING_METHOD,
    baseline: CONTEXT_ACCOUNTING_BASELINE,
    ...(skippedFiles.length > 0 ? { skippedFiles } : {}),
  };
}

function safeSerialize(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return "";
  }
}

/**
 * Derive the file-path groups for a formatted `run_pipeline` output. The default
 * (v1) path contributes its compact context pivots/supports; an opt-in Capsule v2
 * section contributes its pivots/support too. Shared by the MCP tool and the CLI
 * command so both surfaces count the same files.
 */
export function runPipelineOutputFilePathGroups(
  output: {
    context?: { pivots?: ContextFileBearer[]; supports?: ContextFileBearer[] } | null;
    capsuleV2?: { pivots?: ContextFileBearer[]; support?: ContextFileBearer[] } | null;
  },
): Array<ReadonlyArray<ContextFileBearer> | undefined> {
  return [
    output.context?.pivots,
    output.context?.supports,
    output.capsuleV2?.pivots,
    output.capsuleV2?.support,
  ];
}
