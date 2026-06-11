// Stage 5 ad hoc run-label candidate materialization (benchmark tooling only).
//
// The deterministic probes, live critic, and gated repair runners normally enumerate a FIXED
// universe of curated editguard/patchverify candidate runs. A newly produced run (e.g. a
// strict-gated VTRACE run such as `eval-strictgated-vtrace-requests-5414`) is outside that universe,
// so without opt-in it is reported as an unknown --run-label and skipped. This module lets the
// runners opt in (`--include-ad-hoc-run-labels`) to materialize candidates for explicitly-requested
// run labels by reading the same raw VTRACE artifacts the curated runs expose.
//
// It is READ-ONLY: it writes nothing, calls no model, runs no Docker, and never throws. It only
// inspects results/runs/<runLabel>/raw/vtrace and reports whether a usable candidate exists.

import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

// Whether a candidate came from the fixed curated universe or was materialized on demand from a
// requested run label. Surfaced in both the live-critic and repair reports.
export type CandidateSource = "curated_existing" | "ad_hoc_run_label";

// Outcome of probing a requested ad hoc run label.
export type AdHocMaterializeStatus =
  | "materialized" // run dir + JSONL row + non-empty modelPatch all present
  | "missing-run-dir" // no results/runs/<runLabel>/raw/vtrace
  | "missing-jsonl" // run dir present but no parseable swebench-*.jsonl row
  | "no-model-patch"; // JSONL row present but its modelPatch is empty

// The skip reason recorded when an ad hoc run label could not be materialized into a candidate.
// Mirrors AdHocMaterializeStatus (minus "materialized"); deterministic and testable.
export type AdHocSkipReason = "ad-hoc-missing-run-dir" | "ad-hoc-missing-jsonl" | "ad-hoc-no-model-patch";

export interface AdHocProbeResult {
  readonly runLabel: string;
  readonly status: AdHocMaterializeStatus;
  readonly skipReason: AdHocSkipReason | null; // null only when status === "materialized"
  readonly detail: string;
  readonly instanceId: string | null; // from the JSONL row when available
  readonly resolved: boolean | null; // SWE-bench resolution flag when available
  readonly modelPatch: string | null; // the first patch when materialized
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// Inspect results/runs/<runLabel>/raw/vtrace for a usable SWE-bench JSONL row whose modelPatch is
// non-empty. Distinguishes a missing run dir from a missing/empty JSONL row from an empty patch so
// the runners can report each case precisely (the existing loadRun collapses all three to null).
// Read-only; never throws.
export async function probeAdHocRun(resultsDir: string, runLabel: string): Promise<AdHocProbeResult> {
  const vtraceDir = path.join(resultsDir, "runs", runLabel, "raw", "vtrace");

  let entries: string[];
  try {
    entries = await readdir(vtraceDir);
  } catch {
    return {
      runLabel,
      status: "missing-run-dir",
      skipReason: "ad-hoc-missing-run-dir",
      detail: `no raw VTRACE run directory at runs/${runLabel}/raw/vtrace`,
      instanceId: null,
      resolved: null,
      modelPatch: null,
    };
  }

  const jsonl = entries.find((e) => e.startsWith("swebench-") && e.endsWith(".jsonl"));
  if (!jsonl) {
    return {
      runLabel,
      status: "missing-jsonl",
      skipReason: "ad-hoc-missing-jsonl",
      detail: `no swebench-*.jsonl row in runs/${runLabel}/raw/vtrace`,
      instanceId: null,
      resolved: null,
      modelPatch: null,
    };
  }

  let record: Record<string, unknown> | null = null;
  try {
    const text = await readFile(path.join(vtraceDir, jsonl), "utf8");
    const firstLine = text.split("\n").find((l) => l.trim().length > 0);
    if (firstLine) {
      const parsed = JSON.parse(firstLine);
      if (isRecord(parsed)) record = parsed;
    }
  } catch {
    record = null;
  }
  if (record === null) {
    return {
      runLabel,
      status: "missing-jsonl",
      skipReason: "ad-hoc-missing-jsonl",
      detail: `swebench JSONL row in runs/${runLabel} is empty or unparseable`,
      instanceId: null,
      resolved: null,
      modelPatch: null,
    };
  }

  const instanceId = typeof record.instanceId === "string" ? record.instanceId : null;
  const resolved = typeof record.resolved === "boolean" ? record.resolved : null;
  const modelPatch = typeof record.modelPatch === "string" ? record.modelPatch : "";
  if (modelPatch.trim() === "") {
    return {
      runLabel,
      status: "no-model-patch",
      skipReason: "ad-hoc-no-model-patch",
      detail: `swebench JSONL row in runs/${runLabel} has an empty modelPatch`,
      instanceId,
      resolved,
      modelPatch: null,
    };
  }

  return {
    runLabel,
    status: "materialized",
    skipReason: null,
    detail: `materialized ad hoc candidate from runs/${runLabel} (instance ${instanceId ?? "unknown"}, resolved=${resolved})`,
    instanceId,
    resolved,
    modelPatch,
  };
}
