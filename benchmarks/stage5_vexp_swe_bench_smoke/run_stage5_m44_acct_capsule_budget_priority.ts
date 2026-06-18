// M44-ACCT offline audit — capsule render budget / truncation priority.
//
// PURE, offline, read-only: no agent, no Docker, no SWE-bench evaluation, no
// retrieval/ranking/scoring change. It reads CAPTURED run artifacts only and
// recomputes, per run, how the Stage 5 injector's global head-preserving char-budget
// truncation (`truncateContext`, slice-to-maxChars) carves up the rendered capsule
// BY SECTION — using the M44-ACCT section-accounting helper. It answers: did optional
// advisory text (M39 hypothesis / M41 checklist / M35 action plan) silently evict the
// essential pivot-neighborhood / source evidence at the TAIL?
//
// For each run it cross-checks the recomputed verdict against the captured
// `_run.meta.json` (vtraceContextChars / vtraceContextTruncated = POST-truncation)
// and the `_product_v2_probe.*.json` accounting (pivotNeighborhoodPresent / token
// estimates = PRE-truncation) to expose where accounting is truncation-blind.
//
// Writes results/stage5_m44_acct_capsule_budget_priority.{json,csv}.

import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { analyzeSectionTruncation } from "../../src/capsuleV2/sectionBudgetAccounting";

// The documented Stage 5 default injector char budget (run_stage5_vexp_swe_bench_smoke.ts
// DEFAULT_CONFIG.vtraceContextMaxChars). The captured runs used this default.
const VTRACE_CONTEXT_MAX_CHARS = 12_000;

const RESULTS_DIR = path.join(import.meta.dir, "results");
const RUNS_DIR = path.join(RESULTS_DIR, "runs");

const LABELS = [
  "eval-m42-control-sphinx-7462-r1",
  "eval-m42-control-sphinx-7462-r2",
  "eval-m42-control-sphinx-7462-r3",
  "eval-m42-treatment-sphinx-7462-r1",
  "eval-m42-treatment-sphinx-7462-r2",
  "eval-m42-treatment-sphinx-7462-r3",
  "eval-m40-control-sphinx-7462-r1",
  "eval-m40-treatment-sphinx-7462-r1",
];

interface RunAudit {
  label: string;
  arm: string;
  // Recomputed section truncation (pre-truncation rendered capsule vs the 12k cut).
  preTruncationChars: number | null;
  postTruncationChars: number | null;
  truncatedChars: number | null;
  truncationOccurred: boolean | null;
  truncatedSectionNames: string[];
  essentialSectionsEvicted: string[];
  optionalSectionsRetained: string[];
  fullyEvictedSectionNames: string[];
  // Captured POST-truncation accounting (run.meta).
  metaContextChars: number | null;
  metaContextTruncated: boolean | null;
  // Captured PRE-truncation accounting (product-v2 probe) — truncation-blind.
  probeNeighborhoodPresent: boolean | null;
  probeNeighborhoodExcerptCount: number | null;
  probeEstimatedOutputTokens: number | null;
}

function readJson(file: string): any | null {
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf-8"));
  } catch {
    return null;
  }
}

function armOf(label: string): string {
  if (label.includes("-control-")) return "control";
  if (label.includes("-treatment-")) return "treatment";
  return "other";
}

function auditRun(label: string): RunAudit {
  const runDir = path.join(RUNS_DIR, label);
  const ctxFile = path.join(runDir, "raw", "vtrace", "_capsule_v2_context.md");
  const metaFile = path.join(runDir, "raw", "vtrace", "_run.meta.json");

  const audit: RunAudit = {
    label,
    arm: armOf(label),
    preTruncationChars: null,
    postTruncationChars: null,
    truncatedChars: null,
    truncationOccurred: null,
    truncatedSectionNames: [],
    essentialSectionsEvicted: [],
    optionalSectionsRetained: [],
    fullyEvictedSectionNames: [],
    metaContextChars: null,
    metaContextTruncated: null,
    probeNeighborhoodPresent: null,
    probeNeighborhoodExcerptCount: null,
    probeEstimatedOutputTokens: null,
  };

  if (existsSync(ctxFile)) {
    const text = readFileSync(ctxFile, "utf-8");
    const a = analyzeSectionTruncation(text, VTRACE_CONTEXT_MAX_CHARS);
    audit.preTruncationChars = a.preTruncationChars;
    audit.postTruncationChars = a.postTruncationChars;
    audit.truncatedChars = a.truncatedChars;
    audit.truncationOccurred = a.truncationOccurred;
    audit.truncatedSectionNames = [...a.truncatedSectionNames];
    audit.essentialSectionsEvicted = [...a.essentialSectionsEvicted];
    audit.optionalSectionsRetained = [...a.optionalSectionsRetained];
    audit.fullyEvictedSectionNames = [...a.fullyEvictedSectionNames];
  }

  const meta = readJson(metaFile);
  if (meta) {
    audit.metaContextChars = typeof meta.vtraceContextChars === "number" ? meta.vtraceContextChars : null;
    audit.metaContextTruncated =
      typeof meta.vtraceContextTruncated === "boolean" ? meta.vtraceContextTruncated : null;
  }

  // The product-v2 probe filename is instance-keyed: find it in the run dir.
  if (existsSync(runDir)) {
    const probeName = readdirSync(runDir).find((f) => f.startsWith("_product_v2_probe.") && f.endsWith(".json"));
    if (probeName) {
      const probe = readJson(path.join(runDir, probeName));
      if (probe) {
        audit.probeNeighborhoodPresent =
          typeof probe.pivotNeighborhoodPresent === "boolean" ? probe.pivotNeighborhoodPresent : null;
        audit.probeNeighborhoodExcerptCount =
          typeof probe.pivotNeighborhoodExcerptCount === "number" ? probe.pivotNeighborhoodExcerptCount : null;
        audit.probeEstimatedOutputTokens =
          probe.accounting && typeof probe.accounting.estimatedOutputTokens === "number"
            ? probe.accounting.estimatedOutputTokens
            : null;
      }
    }
  }

  return audit;
}

function main(): void {
  const audits = LABELS.filter((l) => existsSync(path.join(RUNS_DIR, l))).map(auditRun);

  const json = {
    milestone: "M44-ACCT",
    generatedFrom: "captured run artifacts (offline, read-only)",
    vtraceContextMaxChars: VTRACE_CONTEXT_MAX_CHARS,
    truncationModel: "global, head-preserving, section-blind (truncateContext slice-to-maxChars)",
    runs: audits,
    summary: {
      anyEssentialEvicted: audits.some((a) => a.essentialSectionsEvicted.length > 0),
      evictedRuns: audits
        .filter((a) => a.essentialSectionsEvicted.length > 0)
        .map((a) => a.label),
    },
  };
  const jsonFile = path.join(RESULTS_DIR, "stage5_m44_acct_capsule_budget_priority.json");
  writeFileSync(jsonFile, `${JSON.stringify(json, null, 2)}\n`);

  // CSV: one row per run.
  const header = [
    "label", "arm", "preTruncationChars", "postTruncationChars", "truncatedChars",
    "truncationOccurred", "metaContextChars", "metaContextTruncated",
    "probeNeighborhoodPresent", "probeEstimatedOutputTokens",
    "essentialSectionsEvicted", "optionalSectionsRetained",
  ];
  const rows = audits.map((a) =>
    [
      a.label, a.arm, a.preTruncationChars ?? "", a.postTruncationChars ?? "",
      a.truncatedChars ?? "", a.truncationOccurred ?? "", a.metaContextChars ?? "",
      a.metaContextTruncated ?? "", a.probeNeighborhoodPresent ?? "",
      a.probeEstimatedOutputTokens ?? "",
      a.essentialSectionsEvicted.join(" | "), a.optionalSectionsRetained.join(" | "),
    ].map((v) => {
      const s = String(v);
      return s.includes(",") || s.includes('"') ? `"${s.replace(/"/g, '""')}"` : s;
    }).join(","),
  );
  const csvFile = path.join(RESULTS_DIR, "stage5_m44_acct_capsule_budget_priority.csv");
  writeFileSync(csvFile, `${[header.join(","), ...rows].join("\n")}\n`);

  // Console summary.
  for (const a of audits) {
    const flag = a.essentialSectionsEvicted.length > 0 ? " <<< ESSENTIAL EVICTED" : "";
    console.log(
      `${a.label.padEnd(38)} pre=${a.preTruncationChars} post=${a.postTruncationChars} `
      + `trunc=${a.truncationOccurred} metaChars=${a.metaContextChars} metaTrunc=${a.metaContextTruncated} `
      + `probeNbhd=${a.probeNeighborhoodPresent}${flag}`,
    );
    if (a.essentialSectionsEvicted.length > 0) {
      console.log(`    evicted: ${a.essentialSectionsEvicted.join("; ")}`);
      console.log(`    optional retained: ${a.optionalSectionsRetained.join("; ") || "(none)"}`);
    }
  }
  console.log(`\nWrote ${jsonFile}`);
  console.log(`Wrote ${csvFile}`);
}

main();
