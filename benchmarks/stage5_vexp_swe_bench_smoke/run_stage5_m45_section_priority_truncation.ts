// M45 offline replay — section-priority truncation vs the legacy section-blind slice.
//
// PURE, offline, read-only: no agent, no Docker, no SWE-bench evaluation, no
// retrieval/ranking/scoring change. It reads CAPTURED rendered capsule contexts
// (`_capsule_v2_context.md`) and, for each, compares two reductions against the
// 12,000-char budget:
//   - legacy: the old head-preserving slice (`analyzeSectionTruncation` models it),
//   - M45:    section-priority truncation (`truncateContextByPriority`).
// It reports whether the essential pivot-neighborhood is preserved under M45 where the
// legacy slice evicted it. Writes results/stage5_m45_section_priority_truncation.{json,csv}.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import {
  analyzeSectionTruncation,
  truncateContextByPriority,
} from "../../src/capsuleV2/sectionBudgetAccounting";

const VTRACE_CONTEXT_MAX_CHARS = 12_000;
const NEIGHBORHOOD_HEADING = "## Pivot neighborhood";

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

// A stable marker for the neighborhood tail content — present iff the neighborhood
// block survives whole (the legacy slice clipped it mid-block in the M42 treatment).
function neighborhoodFullyPreserved(text: string): boolean {
  const idx = text.indexOf(NEIGHBORHOOD_HEADING);
  if (idx < 0) return false;
  // The neighborhood is the last block; "preserved whole" ⇒ no truncation marker after it
  // and the block's tail content is present (heuristic: the block is > ~200 chars).
  const tail = text.slice(idx);
  return !tail.includes("[truncated to") && tail.length > 200;
}

interface ReplayRow {
  label: string;
  arm: string;
  preTruncationChars: number | null;
  legacyPostChars: number | null;
  legacyEssentialEvicted: boolean | null;
  legacyNeighborhoodPreserved: boolean | null;
  m45PostChars: number | null;
  m45Mode: string | null;
  m45DroppedOptional: string[];
  m45EssentialEvicted: boolean | null;
  m45NeighborhoodPreserved: boolean | null;
}

function replay(label: string): ReplayRow | null {
  const ctx = path.join(RUNS_DIR, label, "raw", "vtrace", "_capsule_v2_context.md");
  if (!existsSync(ctx)) return null;
  const text = readFileSync(ctx, "utf-8");

  // Legacy model: head-preserving slice to maxChars.
  const legacy = analyzeSectionTruncation(text, VTRACE_CONTEXT_MAX_CHARS);
  const legacyText = legacy.truncationOccurred
    ? `${text.slice(0, VTRACE_CONTEXT_MAX_CHARS)}\n[truncated to ${VTRACE_CONTEXT_MAX_CHARS} chars]`
    : text;

  // M45: section-priority truncation.
  const m45 = truncateContextByPriority(text, VTRACE_CONTEXT_MAX_CHARS);

  return {
    label,
    arm: label.includes("-control-") ? "control" : label.includes("-treatment-") ? "treatment" : "other",
    preTruncationChars: legacy.preTruncationChars,
    legacyPostChars: legacy.postTruncationChars,
    legacyEssentialEvicted: legacy.essentialSectionsEvicted.length > 0,
    legacyNeighborhoodPreserved: neighborhoodFullyPreserved(legacyText),
    m45PostChars: m45.budget.postTruncationChars,
    m45Mode: m45.budget.truncationMode,
    m45DroppedOptional: m45.budget.droppedSectionNames.filter((n) =>
      // optional headings dropped (action plan / semantic hypothesis / checklist)
      /action plan|semantic edit hypothesis|edit-sufficiency check/i.test(n)),
    m45EssentialEvicted: m45.budget.essentialSectionsEvicted,
    m45NeighborhoodPreserved: neighborhoodFullyPreserved(m45.text),
  };
}

function main(): void {
  const rows = LABELS.map(replay).filter((r): r is ReplayRow => r !== null);

  const json = {
    milestone: "M45",
    generatedFrom: "captured _capsule_v2_context.md artifacts (offline, read-only)",
    vtraceContextMaxChars: VTRACE_CONTEXT_MAX_CHARS,
    rows,
    summary: {
      treatmentRunsWhereLegacyEvictedNeighborhood: rows.filter(
        (r) => r.arm === "treatment" && r.legacyEssentialEvicted,
      ).length,
      treatmentRunsWhereM45PreservedNeighborhood: rows.filter(
        (r) => r.arm === "treatment" && r.legacyEssentialEvicted && !r.m45EssentialEvicted,
      ).length,
      anyM45EssentialEvicted: rows.some((r) => r.m45EssentialEvicted),
    },
  };
  writeFileSync(
    path.join(RESULTS_DIR, "stage5_m45_section_priority_truncation.json"),
    `${JSON.stringify(json, null, 2)}\n`,
  );

  const header = [
    "label", "arm", "preChars",
    "legacyPostChars", "legacyEssentialEvicted", "legacyNeighborhoodPreserved",
    "m45PostChars", "m45Mode", "m45DroppedOptional", "m45EssentialEvicted", "m45NeighborhoodPreserved",
  ];
  const csv = [header.join(",")];
  for (const r of rows) {
    csv.push([
      r.label, r.arm, r.preTruncationChars ?? "",
      r.legacyPostChars ?? "", r.legacyEssentialEvicted ?? "", r.legacyNeighborhoodPreserved ?? "",
      r.m45PostChars ?? "", r.m45Mode ?? "", `"${r.m45DroppedOptional.join("; ")}"`,
      r.m45EssentialEvicted ?? "", r.m45NeighborhoodPreserved ?? "",
    ].join(","));
  }
  writeFileSync(
    path.join(RESULTS_DIR, "stage5_m45_section_priority_truncation.csv"),
    `${csv.join("\n")}\n`,
  );

  for (const r of rows) {
    console.log(
      `${r.label.padEnd(38)} pre=${r.preTruncationChars} `
      + `legacy[evicted=${r.legacyEssentialEvicted} nbhd=${r.legacyNeighborhoodPreserved}] `
      + `M45[mode=${r.m45Mode} evicted=${r.m45EssentialEvicted} nbhd=${r.m45NeighborhoodPreserved} dropped=${r.m45DroppedOptional.length}]`,
    );
  }
  console.log(`\nWrote stage5_m45_section_priority_truncation.{json,csv}`);
}

main();
