// Product-path Capsule v2 probe helpers for the Stage 5 turn-reduction gate.
//
// These are the helpers that satisfy requirement #4 of the gate: the validation
// condition must opt into Capsule v2 through the ACTUAL product surface
// (`run-pipeline` / `get_code_context`), not only through the benchmark-only
// `capsule` subcommand. The product surface is the only one that emits the
// deterministic `accounting` block, the `contextEngine: "v2"` discriminator, and
// the product `capsuleV2` projection — so a probe through it is what proves the
// richer first VTRACE call is observable end to end.
//
// Retrieval is identical between the two surfaces (both call `buildCapsuleV2`);
// the product surface differs only in the response envelope it wraps around the
// capsule. This module is therefore pure instrumentation — it never tunes
// retrieval or changes context selection. It has NO fs / spawn dependencies so it
// stays unit-testable offline; the harness wraps `buildProductV2RunPipelineArgs`
// with a real process runner and persists the parsed signals.

import path from "node:path";

import type { ContextAccounting } from "../../src/metrics/contextAccounting";

// The product run-pipeline subcommand and the only accepted engine value.
export const PRODUCT_V2_SUBCOMMAND = "run-pipeline";
export const PRODUCT_V2_ENGINE = "v2";

// Canonical condition name + suggested run label for the product v2 path. The
// condition name distinguishes this run from the prior in-pipeline `vtrace`
// condition in every report and on-disk artifact.
export const PRODUCT_V2_CONDITION = "vtrace-product-v2";
export const PRODUCT_V2_RUN_LABEL = "eval-product-v2-turn-reduction-4case";

// The four known overhead cases this gate validates first. Kept here (not in the
// harness) so the report and any preflight share one list.
export const PRODUCT_V2_DEFAULT_INSTANCES: readonly string[] = [
  "matplotlib-22719",
  "astropy-14369",
  "django-10880",
  "django-11095",
];

// The v2 signals observable from a single product-path response. `accounting` is
// the deterministic first-call accounting block; the engine/presence fields prove
// the product surface actually routed through Capsule v2.
export interface ProductV2Signals {
  // True when the response JSON parsed at all.
  readonly parseOk: boolean;
  // The product `contextEngine` discriminator ("v2" on the v2 path, else null).
  readonly contextEngine: string | null;
  // Convenience: contextEngine === "v2".
  readonly contextEngineIsV2: boolean;
  // Whether a non-null `capsuleV2` object was present on the response.
  readonly capsuleV2Present: boolean;
  // Whether the additive `pivotNeighborhood` array was present on the response.
  // This is the discriminator that proves the new debug-enrichment response shape
  // reached the live product surface (absent on a pre-neighborhood build).
  readonly pivotNeighborhoodPresent: boolean;
  // Total bounded neighbor excerpts emitted across all pivot neighborhoods.
  readonly pivotNeighborhoodExcerptCount: number;
  // How many pivots carried at least one neighbor excerpt.
  readonly pivotNeighborhoodPivotsEnriched: number;
  // The deterministic accounting block, when present and shaped correctly.
  readonly accounting: ContextAccounting | null;
}

const EMPTY_SIGNALS: ProductV2Signals = {
  parseOk: false,
  contextEngine: null,
  contextEngineIsV2: false,
  capsuleV2Present: false,
  pivotNeighborhoodPresent: false,
  pivotNeighborhoodExcerptCount: 0,
  pivotNeighborhoodPivotsEnriched: 0,
  accounting: null,
};

// Build the product-path command args for one instance. The base command is the
// configured vtrace command split into `[command, ...base]` (e.g.
// `["bun", "src/cli/index.ts"]`); the returned args invoke `run-pipeline` with
// the Capsule v2 opt-in flags. This is the EXACT product opt-in: the same
// `--capsule-engine v2 --capsule-intent <i> --capsule-budget-tokens <n>` triple
// the `run-pipeline` CLI / `get_code_context` MCP tool accept.
export function buildProductV2RunPipelineArgs(params: {
  readonly baseArgs: readonly string[];
  readonly workspace: string;
  readonly query: string;
  readonly intent: string;
  readonly budgetTokens: number;
}): readonly string[] {
  return [
    ...params.baseArgs,
    PRODUCT_V2_SUBCOMMAND,
    params.workspace,
    params.query,
    "--capsule-engine",
    PRODUCT_V2_ENGINE,
    "--capsule-intent",
    params.intent,
    "--capsule-budget-tokens",
    String(params.budgetTokens),
  ];
}

// The directory the product-v2 probe is persisted in: the per-run LABEL dir
// (`results/runs/<label>/`), or the results root when unlabeled. This is
// deliberately NOT the `raw/vtrace` condition dir — the external vexp `run`
// command cleans its `--output` (raw/vtrace) at startup, which would delete a
// probe written during context preparation. The label dir is never cleaned (the
// injected-instructions snapshot survives there for the same reason).
export function productV2ProbeDir(resultsRoot: string, runLabel: string | null): string {
  return runLabel === null || runLabel.length === 0
    ? resultsRoot
    : path.join(resultsRoot, "runs", runLabel);
}

// Where the parsed product-v2 signals for one instance are persisted within the
// probe dir above.
export function productV2ProbeFilePath(outDir: string, instanceId: string): string {
  const safe = instanceId.replace(/[^A-Za-z0-9._-]/g, "_");
  return path.join(outDir, `_product_v2_probe.${safe}.json`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// A light shape check for the accounting block. We require the numeric core to be
// present so a malformed/partial response degrades to `null` rather than a wrong
// figure. The savings-percent field is intentionally allowed to be null.
function asContextAccounting(value: unknown): ContextAccounting | null {
  if (!isRecord(value)) return null;
  const numericKeys = [
    "latencyMs",
    "estimatedOutputTokens",
    "estimatedNaiveFullFileTokens",
    "estimatedTokensSavedVsNaiveFullFile",
    "uniqueFilesCounted",
  ] as const;
  for (const key of numericKeys) {
    if (typeof value[key] !== "number" || !Number.isFinite(value[key] as number)) return null;
  }
  return value as unknown as ContextAccounting;
}

// Parse one product-path response (the `run-pipeline --json` stdout) into the v2
// signals. Tolerant by design: non-JSON, missing keys, or a v1 (no-engine)
// response all degrade to honest negatives rather than throwing — a probe must
// never fail the surrounding run.
export function parseProductV2Response(stdout: string): ProductV2Signals {
  const trimmed = stdout.trim();
  if (trimmed.length === 0 || !trimmed.startsWith("{")) return EMPTY_SIGNALS;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return EMPTY_SIGNALS;
  }
  if (!isRecord(parsed)) return { ...EMPTY_SIGNALS, parseOk: true };
  const contextEngine = typeof parsed.contextEngine === "string" ? parsed.contextEngine : null;
  const neighborhood = summarizePivotNeighborhood(parsed.pivotNeighborhood);
  return {
    parseOk: true,
    contextEngine,
    contextEngineIsV2: contextEngine?.toLowerCase() === PRODUCT_V2_ENGINE,
    capsuleV2Present: isRecord(parsed.capsuleV2),
    pivotNeighborhoodPresent: neighborhood.present,
    pivotNeighborhoodExcerptCount: neighborhood.excerptCount,
    pivotNeighborhoodPivotsEnriched: neighborhood.pivotsEnriched,
    accounting: asContextAccounting(parsed.accounting),
  };
}

// Summarize the additive `pivotNeighborhood` array (present only on the
// neighborhood-enabled v2 build). Tolerant: a missing/malformed field degrades to
// "absent with zero counts" rather than throwing, so an older build reads as a
// clean negative.
function summarizePivotNeighborhood(value: unknown): {
  present: boolean;
  excerptCount: number;
  pivotsEnriched: number;
} {
  if (!Array.isArray(value)) {
    return { present: false, excerptCount: 0, pivotsEnriched: 0 };
  }
  let excerptCount = 0;
  let pivotsEnriched = 0;
  for (const entry of value) {
    const excerpts = isRecord(entry) && Array.isArray(entry.excerpts) ? entry.excerpts : [];
    if (excerpts.length > 0) {
      pivotsEnriched += 1;
    }
    excerptCount += excerpts.length;
  }
  return { present: true, excerptCount, pivotsEnriched };
}
