import { describe, expect, test } from "bun:test";

import {
  DEFAULT_OUTCOME_DETAIL_LIMIT,
  summarizeIndexOutcomes,
  type BoundedIndexOutcomes,
} from "./indexOutcomeSummary";
import type { IndexedFileStatus, IndexedFileSummary } from "./types";
import { Language } from "../domain/types";

function outcome(
  path: string,
  status: IndexedFileStatus,
  diagnostics: IndexedFileSummary["diagnostics"] = [],
): IndexedFileSummary {
  return { path, language: Language.Python, status, diagnostics };
}

function successes(count: number, prefix = "src/file"): IndexedFileSummary[] {
  return Array.from({ length: count }, (_unused, index) => outcome(`${prefix}${index}.py`, "indexed"));
}

/** Serialized size of the whole response, not of one bounded component. */
function responseBytes(summary: BoundedIndexOutcomes): number {
  return JSON.stringify(summary).length;
}

describe("M141 bounded index outcomes", () => {
  test("an all-success run reports exact counts and lists nothing", () => {
    const summary = summarizeIndexOutcomes({ files: successes(290) });

    expect(summary.counts.filesTotal).toBe(290);
    expect(summary.counts.indexed).toBe(290);
    expect(summary.counts.failed).toBe(0);
    expect(summary.counts.skipped).toBe(0);
    expect(summary.detail.delivered).toBe(0);
    expect(summary.detail.omitted).toBe(0);
    expect(summary.detail.note).toContain("290 ordinary successful outcomes are summarized");
  });

  test("response size grows sublinearly from 10 to 30,000 files", () => {
    // The scale property that matters: 3,000x the files must not mean 3,000x
    // the response. A per-file response would blow through any envelope.
    const sizes = [10, 300, 3_000, 30_000].map((count) => ({
      count,
      bytes: responseBytes(summarizeIndexOutcomes({ files: successes(count) })),
    }));

    for (const { bytes } of sizes) {
      expect(bytes).toBeLessThan(2_000);
    }
    const smallest = sizes[0]!.bytes;
    const largest = sizes.at(-1)!.bytes;
    // Allow for the digits in the counts themselves; nothing more.
    expect(largest - smallest).toBeLessThan(64);
  });

  test("every failure is counted exactly even when detail is capped", () => {
    const failures = Array.from(
      { length: 120 },
      (_unused, index) => outcome(`broken${index}.py`, "parse_failed"),
    );
    const summary = summarizeIndexOutcomes({ files: [...successes(500), ...failures] });

    expect(summary.counts.failed).toBe(120);
    expect(summary.counts.byStatus.parse_failed).toBe(120);
    expect(summary.detail.delivered).toBe(DEFAULT_OUTCOME_DETAIL_LIMIT);
    expect(summary.detail.omitted).toBe(120 - DEFAULT_OUTCOME_DETAIL_LIMIT);
    expect(summary.detail.omittedByStatus.parse_failed).toBe(120 - DEFAULT_OUTCOME_DETAIL_LIMIT);
    expect(summary.detail.note).toContain("omitted by the summary detail cap");
  });

  test("failures are never displaced by warnings or skips", () => {
    const files = [
      ...successes(50),
      ...Array.from({ length: 40 }, (_u, i) => outcome(`skip${i}.txt`, "unsupported_language")),
      outcome("warned.py", "indexed", [{ severity: "warning", message: "partial parse" } as never]),
      outcome("broken.py", "read_failed"),
    ];
    const summary = summarizeIndexOutcomes({ files }, { limit: 2 });

    expect(summary.detail.outcomes.map((entry) => entry.path)).toEqual(["broken.py", "warned.py"]);
    expect(summary.counts.skipped).toBe(40);
    expect(summary.skipReasons.unsupported_language).toBe(40);
    expect(summary.detail.omitted).toBe(40);
  });

  test("debug mode raises the cap without becoming unbounded", () => {
    const failures = Array.from({ length: 4_000 }, (_u, i) => outcome(`broken${i}.py`, "parse_failed"));
    const summary = summarizeIndexOutcomes({ files: failures }, { mode: "debug" });

    expect(summary.counts.failed).toBe(4_000);
    expect(summary.detail.delivered).toBe(500);
    expect(summary.detail.omitted).toBe(3_500);
  });

  test("planner change counts are reported when the run had them", () => {
    const summary = summarizeIndexOutcomes({
      files: successes(12),
      performance: {
        mode: "incremental",
        totalCurrentFiles: 12,
        addedFiles: 2,
        modifiedFiles: 3,
        deletedFiles: 1,
        renamedFiles: 0,
        unchangedFiles: 7,
        parseCacheHits: 7,
        parseCacheMisses: 5,
        parsedFiles: 5,
        reusedParseResults: 7,
        initiallyInvalidatedFiles: 5,
        affectedClosureFiles: 5,
        timingsMs: { total: 1 } as never,
        previousGraphSnapshotUsedForMutation: true,
        unsupportedFilesCarriedForward: 0,
      } as never,
    });

    expect(summary.changes).toEqual({ added: 2, modified: 3, removed: 1, renamed: 0, unchanged: 7 });
  });

  test("summarizing does not mutate or drop the underlying outcome records", () => {
    const files = [...successes(5), outcome("broken.py", "parse_failed")];
    const before = JSON.stringify(files);
    summarizeIndexOutcomes({ files });

    expect(JSON.stringify(files)).toBe(before);
  });
});
