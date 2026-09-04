/**
 * M214 §7, §8, §18, §20, §39, §40, §42 — the external VEXP reference, and the
 * machinery that keeps it out of the causal analysis.
 *
 * VEXP's published 73/100 is a number a vendor computed in their own harness,
 * on their own cohort, at a time we cannot reconstruct. It is genuinely useful:
 * it is the only absolute figure that exists for the exact 100 tasks M214 runs.
 * It is also not an experimental arm, not a paired observation, and not a
 * comparator any causal statistic may take as an operand.
 *
 * Documentation cannot enforce that distinction — the failure mode is a
 * well-meaning table with three rows in it. So the separation is structural:
 *
 *   • the external reference is a `ExternalVendorReference`, a type that is not
 *     `M214Arm` and has no run id, container, budget or execution order;
 *   • `pairedComparisonOperands` accepts arms only, and the guard that checks it
 *     fires on anything carrying the external evidence class;
 *   • the wording auditor rejects the sentences that would misreport it, before
 *     any outcome exists to make them tempting.
 *
 * PURE. No spawning, no network, no model, no product import.
 */

import { createHash } from "node:crypto";

import {
  M214_ARMS,
  M214_EXTERNAL_REFERENCE_TASK_ARTIFACT_SHA256,
  type M214Arm,
  canonicalize,
} from "./m214Preregistration";

// ── Evidence class (§8) ─────────────────────────────────────────────

export const EXTERNAL_VENDOR_REFERENCE = "EXTERNAL_VENDOR_REFERENCE" as const;
export const M214_EXPERIMENTAL_ARM = "M214_EXPERIMENTAL_ARM" as const;

export type EvidenceClass = typeof EXTERNAL_VENDOR_REFERENCE | typeof M214_EXPERIMENTAL_ARM;

/**
 * The labels the external reference may NOT be given (§8, F17).
 *
 * Each of these has appeared, in some form, in real write-ups of cross-study
 * comparisons. Naming them is what lets a guard reject them.
 */
export const FORBIDDEN_EXTERNAL_REFERENCE_LABELS: readonly string[] = Object.freeze([
  "experimental arm",
  "arm c",
  "third arm",
  "paired observation",
  "causal head-to-head result",
  "head-to-head",
  "control arm",
  "comparator arm",
  "baseline",
]);

// ── The frozen reference (§7) ───────────────────────────────────────

export interface ExternalReferenceSource {
  readonly url: string;
  readonly file: string;
  readonly vendorCommit: string;
  readonly vendorCommitDate: string;
  readonly fileSha256: string;
  readonly retrievedAt: string;
  readonly quotedLine: string;
}

export interface ExternalVendorReference {
  readonly evidenceClass: typeof EXTERNAL_VENDOR_REFERENCE;
  readonly system: string;
  readonly taskArtifactSha256: string;
  readonly taskCount: number;
  readonly publishedPassAt1Count: number;
  readonly publishedPassAt1Percent: number;
  readonly publishedCostPerTaskUsd: number;
  readonly publishedModel: string;
  readonly publishedCostLimitUsdPerTask: number;
  readonly publishedTurnBudget: number;
  readonly repositoriesRepresented: number;
  readonly perTaskOutcomesPublished: boolean;
  readonly sources: readonly ExternalReferenceSource[];
  readonly caveats: readonly string[];
}

/**
 * VEXP's published result, snapshotted before any paid run.
 *
 * Every figure is quoted from the vendor's own committed README at a pinned
 * commit whose bytes are digested here, so "what the vendor published" is a
 * fact about a file rather than a recollection of a web page. If the vendor
 * changes their site or their repository later, M214 stays tied to THIS
 * snapshot: a moved external number does not retroactively change what this
 * experiment was preregistered against.
 */
export const M214_EXTERNAL_REFERENCE: ExternalVendorReference = Object.freeze({
  evidenceClass: EXTERNAL_VENDOR_REFERENCE,
  system: "vexp + Claude Code",
  taskArtifactSha256: M214_EXTERNAL_REFERENCE_TASK_ARTIFACT_SHA256,
  taskCount: 100,
  publishedPassAt1Count: 73,
  publishedPassAt1Percent: 73.0,
  publishedCostPerTaskUsd: 0.67,
  publishedModel: "Claude Opus 4.5",
  publishedCostLimitUsdPerTask: 3,
  publishedTurnBudget: 250,
  repositoriesRepresented: 12,
  perTaskOutcomesPublished: false,
  sources: Object.freeze([
    Object.freeze({
      url: "https://github.com/Vexp-ai/vexp-swe-bench",
      file: "README.md",
      vendorCommit: "d658e3457b82b5cb041f586093cc5002008a8cea",
      vendorCommitDate: "2026-03-22T19:04:18+01:00",
      fileSha256: "e743e1483aa24a9214a415537742a081d31a888cf117d9c0749fea7d10f9f19a",
      retrievedAt: "2026-09-04",
      quotedLine: "| **vexp + Claude Code** | **73.0%** | **$0.67** | 7–10 |",
    }),
    Object.freeze({
      url: "https://github.com/Vexp-ai/vexp-swe-bench",
      file: "README.md",
      vendorCommit: "d658e3457b82b5cb041f586093cc5002008a8cea",
      vendorCommitDate: "2026-03-22T19:04:18+01:00",
      fileSha256: "e743e1483aa24a9214a415537742a081d31a888cf117d9c0749fea7d10f9f19a",
      retrievedAt: "2026-09-04",
      quotedLine:
        "Evaluated on a 100-task subset of SWE-bench Verified. All agents use Claude Opus 4.5 for a "
        + "fair, apples-to-apples comparison.",
    }),
    Object.freeze({
      url: "https://github.com/Vexp-ai/vexp-swe-bench",
      file: "README.md",
      vendorCommit: "d658e3457b82b5cb041f586093cc5002008a8cea",
      vendorCommitDate: "2026-03-22T19:04:18+01:00",
      fileSha256: "e743e1483aa24a9214a415537742a081d31a888cf117d9c0749fea7d10f9f19a",
      retrievedAt: "2026-09-04",
      quotedLine:
        "The defaults are aligned with mini-SWE-agent v2: 250 turns, $3/task cost limit, no global "
        + "timeout.",
    }),
    Object.freeze({
      url: "https://github.com/Vexp-ai/vexp-swe-bench",
      file: "docs/TASK_SELECTION.md",
      vendorCommit: "d658e3457b82b5cb041f586093cc5002008a8cea",
      vendorCommitDate: "2026-03-22T19:04:18+01:00",
      fileSha256: "6718013fcf3873d9e493a89e2eb269e1a7593a6c85919e6b2a68935c26a808e5",
      retrievedAt: "2026-09-04",
      quotedLine: "the per-repository distribution of the published 100-task subset (12 repositories)",
    }),
  ]),
  caveats: Object.freeze([
    "VEXP was NOT executed in the M214 harness. This number is a vendor-published external "
      + "reference, produced by a different cohort at a different time.",
    "No per-task VEXP outcomes are published, so no paired table against it can exist even in "
      + "principle.",
    "The vendor's own benchmark contains no orientation intervention that M188 could identify: "
      + "their buildPrompt injects nothing and their tool fired on 5 of 100 tasks. The published "
      + "73/100 is therefore not itself clean causal evidence for the VEXP repository-intelligence "
      + "treatment.",
    "The published cost of $0.67/task was measured on the vendor's cohort with the vendor's agent "
      + "version, container substrate and network posture, none of which are published.",
    "The agent version, container substrate, network policy and repetitions-per-task behind the "
      + "published figure are all UNKNOWN; see the published-condition matrix.",
  ]),
});

export const M214_EXTERNAL_REFERENCE_SCHEMA = "stage5.m214.external-reference.v1" as const;

export function externalReferenceHash(
  reference: ExternalVendorReference = M214_EXTERNAL_REFERENCE,
): string {
  return createHash("sha256")
    .update("M214_EXTERNAL_VENDOR_REFERENCE\n")
    .update(JSON.stringify(canonicalize(reference)))
    .digest("hex");
}

/**
 * The digest recorded at preregistration.
 *
 * Left empty here and filled by the generator from the frozen object itself:
 * a hardcoded expectation would have to be hand-updated whenever a caveat is
 * reworded, and a guard people hand-update is a guard that stops guarding.
 * The committed artifact carries the value; §42's gate compares against it.
 */
export const M214_EXTERNAL_REFERENCE_HASH_RULE: string =
  'sha256 over "M214_EXTERNAL_VENDOR_REFERENCE\\n" followed by the canonical (recursively '
  + "key-sorted) JSON of the frozen reference object";

// ── Guards ──────────────────────────────────────────────────────────

/**
 * §42 — the external comparison is valid ONLY for the artifact the published
 * number was computed on.
 *
 * If the task artifact's digest changes, the vendor's 73/100 stops describing
 * the population being run, and the comparison must be re-preregistered rather
 * than carried forward. That is a harder failure than it looks: the natural
 * mistake is to regenerate the population "the same way" and keep the number.
 */
export function auditExternalReferenceTaskArtifact(
  observedArtifactSha256: string,
  reference: ExternalVendorReference = M214_EXTERNAL_REFERENCE,
): readonly string[] {
  return observedArtifactSha256 === reference.taskArtifactSha256
    ? []
    : [
      `external-reference task artifact drift: the published ${reference.publishedPassAt1Count}/`
      + `${reference.taskCount} describes artifact ${reference.taskArtifactSha256}, but the frozen `
      + `population is ${observedArtifactSha256}; the external comparison is void until `
      + "re-preregistered",
    ];
}

/**
 * §24 (F24) — the published snapshot may not move after preregistration.
 *
 * A vendor is free to update their site; M214 is not free to follow along
 * mid-experiment. A changed figure or a changed source digest is a NEW external
 * reference with a new hash, and the comparison must be re-frozen deliberately.
 */
export function auditExternalReferenceSnapshot(
  observed: ExternalVendorReference,
  recordedHash: string,
): readonly string[] {
  const actual = externalReferenceHash(observed);
  return actual === recordedHash
    ? []
    : [
      `external reference snapshot changed: recorded ${recordedHash}, computed ${actual}; a moved `
      + "vendor number requires a new preregistration, not a silent update",
    ];
}

/** §8 (F17) — the reference may not be relabelled as an arm. */
export function auditEvidenceClassLabel(
  label: string,
  evidenceClass: EvidenceClass,
): readonly string[] {
  if (evidenceClass !== EXTERNAL_VENDOR_REFERENCE) return [];
  const normalized = label.trim().toLowerCase();
  return FORBIDDEN_EXTERNAL_REFERENCE_LABELS.some((forbidden) => normalized.includes(forbidden))
    ? [
      `the external vendor reference is labelled "${label}"; it is not an experimental arm, a `
      + "paired observation or a causal comparator",
    ]
    : [];
}

/**
 * §39 (F16) — the entry point every paired statistic must go through.
 *
 * A paired comparison needs two operands that were RUN, in this harness, on the
 * same tasks, one per arm. The external reference satisfies none of that: there
 * is no per-task VEXP outcome to pair with, so a McNemar table against it could
 * only be fabricated. The guard rejects any operand that is not one of the two
 * M214 arms — including a well-formed-looking `"vexp"` string.
 */
export interface PairedComparisonRequest {
  readonly left: string;
  readonly right: string;
  readonly evidenceClasses?: Readonly<Record<string, EvidenceClass>>;
}

export function auditPairedComparison(request: PairedComparisonRequest): readonly string[] {
  const issues: string[] = [];
  const arms = new Set<string>(M214_ARMS);
  for (const [side, operand] of [["left", request.left], ["right", request.right]] as const) {
    const evidenceClass = request.evidenceClasses?.[operand];
    if (evidenceClass === EXTERNAL_VENDOR_REFERENCE) {
      issues.push(
        `paired analysis operand (${side}) "${operand}" carries evidence class `
        + `${EXTERNAL_VENDOR_REFERENCE}; external references have no per-task paired outcomes and `
        + "cannot enter a causal statistic",
      );
      continue;
    }
    if (!arms.has(operand)) {
      issues.push(
        `paired analysis operand (${side}) "${operand}" is not an M214 arm; only `
        + `${[...arms].join(" and ")} were executed in this harness`,
      );
    }
  }
  if (issues.length === 0 && request.left === request.right) {
    issues.push(`paired analysis compares "${request.left}" with itself`);
  }
  return issues;
}

/**
 * §8 — the causal table's membership rule.
 *
 * Enforced over a rendered table's rows rather than over a call, because the
 * realistic failure is presentational: someone builds a correct paired analysis
 * and then adds a third row to the table for context.
 */
export interface ResultTableRow {
  readonly label: string;
  readonly evidenceClass: EvidenceClass;
}

export function auditCausalTableMembership(
  rows: readonly ResultTableRow[],
): readonly string[] {
  return rows
    .filter((row) => row.evidenceClass === EXTERNAL_VENDOR_REFERENCE)
    .map((row) =>
      `causal table contains external vendor reference "${row.label}"; it belongs in a separate `
      + "external-reference table");
}

// ── Wording discipline (§19, §20) ───────────────────────────────────

/**
 * Sentences that misreport a cross-study difference as a head-to-head win.
 *
 * Frozen before outcomes on purpose. The temptation to write "VTRACE beats
 * VEXP" only exists once a favourable number is in hand, which is exactly when
 * a rule invented on the spot would be negotiable.
 */
export const FORBIDDEN_EXTERNAL_CLAIM_PATTERNS: readonly { readonly pattern: RegExp; readonly why: string }[] =
  Object.freeze([
    {
      pattern: /\bvtrace\b[^.]{0,40}\bbeat(s|ing)?\b[^.]{0,40}\bvexp\b/i,
      why: "'beats' asserts a head-to-head result; the systems were never run in the same harness",
    },
    {
      pattern: /\bvtrace\b[^.]{0,40}\bout(performs|performed|scores|scored)\b[^.]{0,40}\bvexp\b/i,
      why: "outperformance is a head-to-head claim that a cross-study difference cannot support",
    },
    {
      pattern: /\bvtrace\b[^.]{0,30}\bvs\.?\b[^.]{0,30}\bvexp\b/i,
      why: "'VTRACE vs VEXP' frames a comparison that was not run",
    },
    {
      pattern: /\bwe\b[^.]{0,30}\b(beat|won against|defeated)\b[^.]{0,30}\bvexp\b/i,
      why: "a competitive framing of a descriptive difference",
    },
    {
      pattern: /\b(head[- ]to[- ]head|apples[- ]to[- ]apples)\b[^.]{0,40}\bvexp\b/i,
      why: "the comparison is cross-study, not head-to-head",
    },
    {
      pattern: /\bexact\b[^.]{0,20}\breplication\b/i,
      why: "material published conditions are UNKNOWN, so 'exact replication' overstates the match",
    },
  ]);

/**
 * The qualifier every VTRACE-vs-published sentence must carry.
 *
 * One of these phrases must be present, in the same passage, whenever a number
 * of ours is placed beside the vendor's — because the difference is only
 * honestly readable with it.
 */
export const REQUIRED_EXTERNAL_QUALIFIERS: readonly string[] = Object.freeze([
  "cross-study",
  "descriptive",
  "descriptively",
  "not a causal",
  "external reference",
  "was not executed",
  "different execution cohort",
]);

export function auditExternalComparisonWording(text: string): readonly string[] {
  const issues: string[] = [];
  for (const { pattern, why } of FORBIDDEN_EXTERNAL_CLAIM_PATTERNS) {
    const found = pattern.exec(text);
    if (found !== null) issues.push(`forbidden external claim "${found[0].trim()}": ${why}`);
  }
  const mentionsBoth = /\bvexp\b/i.test(text)
    && (/\bvtrace\b/i.test(text) || /\bbaseline\b/i.test(text));
  const compares = mentionsBoth && /\b\d{1,3}(\.\d+)?\s*(%|\/\s*100)/.test(text);
  if (compares) {
    const qualified = REQUIRED_EXTERNAL_QUALIFIERS.some((phrase) =>
      text.toLowerCase().includes(phrase));
    if (!qualified) {
      issues.push(
        "a numeric comparison with the vendor's published result carries no cross-study qualifier; "
        + `one of [${REQUIRED_EXTERNAL_QUALIFIERS.join(", ")}] must appear in the same passage`,
      );
    }
  }
  return issues;
}

/**
 * The sentence M214 will actually publish, generated rather than hand-written.
 *
 * A renderer cannot forget the qualifier, and its output is checked by the same
 * auditor that rejects the forbidden phrasings — so the discipline is exercised
 * on the real text, not only on fixtures.
 */
export function renderExternalComparison(
  observed: { readonly baselineResolved: number; readonly vtraceResolved: number; readonly tasks: number },
  reference: ExternalVendorReference = M214_EXTERNAL_REFERENCE,
): string {
  const delta = observed.vtraceResolved - reference.publishedPassAt1Count;
  const direction = delta > 0 ? "above" : delta < 0 ? "below" : "level with";
  const magnitude = Math.abs(delta);
  return (
    `Observed in M214: baseline ${observed.baselineResolved} / ${observed.tasks}, `
    + `VTRACE ${observed.vtraceResolved} / ${observed.tasks}. `
    + `Published external reference: ${reference.system} `
    + `${reference.publishedPassAt1Count} / ${reference.taskCount}. `
    + `VTRACE's observed absolute pass rate is ${magnitude === 0 ? "" : `${magnitude} point`
      + `${magnitude === 1 ? "" : "s"} `}${direction} the published result. `
    + `${reference.system} was not executed in the M214 harness; this is a cross-study descriptive `
    + "comparison, not a causal head-to-head estimate, and the causal quantity is "
    + "VTRACE minus our own baseline."
  );
}

/** The causal sentence, chosen by the sign of the delta and nothing else (§19). */
export function renderCausalConclusion(
  baselineResolved: number,
  vtraceResolved: number,
  tasks: number,
): string {
  const delta = vtraceResolved - baselineResolved;
  if (delta > 0) {
    return `VTRACE improved resolution relative to its matched baseline by ${delta} / ${tasks} on `
      + "this frozen population.";
  }
  if (delta === 0) {
    return "No resolution benefit was observed relative to the matched baseline.";
  }
  return `VTRACE reduced resolution relative to the matched baseline by ${Math.abs(delta)} / `
    + `${tasks} under these conditions.`;
}

export type { M214Arm };
