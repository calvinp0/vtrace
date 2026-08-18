/**
 * M161 §32-§34, §62-§63, §84 — treatment-state, lead-quality and prompt-parity
 * classifiers.
 *
 * PURE. Every function reads a captured run's metadata and returns a label. None
 * of them run anything, and none of them may be tuned after outcomes are read.
 *
 * These exist as a separate module, with known-positive controls, because M161's
 * headline numbers are COUNTS produced by exactly these classifiers — treatment
 * availability, lead quality, the cross-tab that answers the right-neighbourhood
 * question. M155 shipped a paired experiment in which a legitimate empty delivery
 * was misfiled, and §123 is the standing rule that came out of it: a plausible
 * zero is not evidence until the detector has demonstrated a known positive.
 */

// ---------------------------------------------------------------------------
// Treatment state (§32-§34)
// ---------------------------------------------------------------------------

/**
 * The four states §32 forbids collapsing, plus the pre-spawn corpus verdict.
 *
 * The distinction that matters most is VALID_DELIVERY_EMPTY vs
 * TREATMENT_UNAVAILABLE. Both look like "VTRACE gave the agent nothing", and they
 * mean opposite things: the first is the product working and correctly declining
 * to deliver, and the agent still runs and is still graded (§33); the second is
 * the product failing, and no treatment agent runs at all (§34), so it can never
 * enter the paired outcome matrix as an ordinary loss (§69).
 */
export type TreatmentState =
  | "VALID_NONEMPTY"
  | "VALID_DELIVERY_EMPTY"
  | "DEGRADED_VALID"
  | "TREATMENT_UNAVAILABLE"
  | "CORPUS_INVALID"
  | "NOT_RUN";

export interface TreatmentMeta {
  /** Did context generation complete without a hard error? */
  readonly vtraceTreatmentValid?: unknown;
  /**
   * The runner's HARD-ERROR signal. Its own comment is the authority here:
   * "A hard error still aborts. hardErrors.length === 0 is what separates an empty
   * [delivery] from a failure." This, not `vtraceIndexedContext`, decides
   * availability.
   */
  readonly vtraceContextError?: unknown;
  readonly vtraceInjectionError?: unknown;
  readonly vtraceInjectionObserved?: unknown;
  /**
   * Whether any section produced non-empty context — a DELIVERY signal, not index
   * health. It is false whenever the product declines to deliver, including a
   * deliberate policy skip, so it must never be read as a failure.
   */
  readonly vtraceIndexedContext?: unknown;
  readonly vtracePolicyAction?: unknown;
  readonly vtracePolicyReason?: unknown;
  readonly vtraceCapsulePivots?: unknown;
  readonly vtraceCapsuleSupport?: unknown;
  readonly vtraceInstructionsFileSize?: unknown;
  /** M156: index readiness reported usable, with contained per-file parse failures. */
  readonly vtraceIndexDegraded?: unknown;
  readonly vtraceIndexFailedFiles?: unknown;
}

export interface TreatmentClassification {
  readonly state: TreatmentState;
  readonly reason: string;
  readonly deliveredItems: number;
  readonly pivotCount: number;
  readonly supportCount: number;
  readonly degraded: boolean;
}

function arrayLength(value: unknown): number {
  return Array.isArray(value) ? value.length : 0;
}

/**
 * Positive evidence that a treatment was actually attempted.
 *
 * Without this, an EMPTY metadata object classifies as VALID_DELIVERY_EMPTY —
 * "retrieval succeeded and correctly delivered nothing" — which is exactly the
 * M155 misclassification in a new costume, and worse, it is the reading that
 * makes a sweep that never ran look like a product working as intended. A valid
 * empty delivery is a CLAIM about a run, so it requires a run to point at.
 */
function treatmentWasAttempted(meta: TreatmentMeta): boolean {
  return meta.vtraceIndexedContext !== undefined
    || meta.vtraceInjectionObserved !== undefined
    || meta.vtraceTreatmentValid !== undefined
    || meta.vtraceCapsulePivots !== undefined
    || meta.vtraceCapsuleSupport !== undefined;
}

/**
 * Classify one VTRACE arm's treatment. `corpusInvalid` short-circuits because the
 * pre-spawn integrity gate owns that verdict and no agent money was spent;
 * `ran: false` short-circuits because an arm that has not run is not a product
 * outcome of any kind.
 */
export function classifyTreatmentState(
  meta: TreatmentMeta,
  options: { readonly corpusInvalid?: boolean; readonly ran?: boolean } = {},
): TreatmentClassification {
  const pivotCount = arrayLength(meta.vtraceCapsulePivots);
  const supportCount = arrayLength(meta.vtraceCapsuleSupport);
  const deliveredItems = pivotCount + supportCount;
  const failedFiles = arrayLength(meta.vtraceIndexFailedFiles);
  const degraded = meta.vtraceIndexDegraded === true || failedFiles > 0;
  const base = { deliveredItems, pivotCount, supportCount, degraded };

  if (options.corpusInvalid === true) {
    return { ...base, state: "CORPUS_INVALID", reason: "source-tree integrity could not be established before spawn" };
  }
  if (options.ran === false || !treatmentWasAttempted(meta)) {
    return {
      ...base,
      state: "NOT_RUN",
      reason: "no treatment metadata was captured — the arm has not run, which is not a product outcome",
    };
  }

  // A hard treatment failure is a PRODUCT failure and must never be laundered into
  // an empty delivery. Order matters here: an aborted index also delivers zero items.
  //
  // The converse error is just as bad and is the one this ordering exists to
  // prevent: `vtraceIndexedContext === false` was once read as "no index was
  // produced" and therefore unavailable. It actually means "no section delivered
  // non-empty context", which is exactly what a DELIBERATE policy skip produces —
  // so a product correctly declining to deliver was being filed as a product
  // failure, inflating the unavailability count with its own good judgement.
  const errors = [
    ["context error", meta.vtraceContextError],
    ["injection error", meta.vtraceInjectionError],
  ] as const;
  for (const [kind, value] of errors) {
    if (typeof value === "string" && value.trim().length > 0) {
      return { ...base, state: "TREATMENT_UNAVAILABLE", reason: `${kind}: ${value}` };
    }
  }
  if (meta.vtraceTreatmentValid === false) {
    return { ...base, state: "TREATMENT_UNAVAILABLE", reason: "runner reported the treatment invalid" };
  }

  if (deliveredItems === 0) {
    // §33 — a legitimate product outcome. Zero VTRACE tokens are injected, the
    // agent spawns normally, and the case is graded normally.
    const action = typeof meta.vtracePolicyAction === "string" ? meta.vtracePolicyAction : null;
    const why = typeof meta.vtracePolicyReason === "string" ? meta.vtracePolicyReason : null;
    return {
      ...base,
      state: "VALID_DELIVERY_EMPTY",
      reason: why !== null
        ? `retrieval succeeded and delivered 0 items (policy ${action ?? "n/a"}: ${why})`
        : "retrieval succeeded and delivered 0 items",
    };
  }
  if (degraded) {
    return {
      ...base,
      state: "DEGRADED_VALID",
      reason: `usable index with ${failedFiles} contained parse failure(s) (M156)`,
    };
  }
  return { ...base, state: "VALID_NONEMPTY", reason: `${pivotCount} pivot(s) + ${supportCount} support item(s) delivered` };
}

// ---------------------------------------------------------------------------
// Lead quality (§62-§63)
// ---------------------------------------------------------------------------

/**
 * §63 — the central M161 label.
 *
 * LEAD_WRONG_GOLD_ELSEWHERE is the one the milestone exists to cross-tab (§64):
 * M160 left Top-1 at 41-58% while gold-anywhere held near 87-89%, so the product's
 * lead is often wrong while useful evidence sits further down the same capsule.
 * Whether that materially hurts an agent is not answerable from a retrieval metric.
 */
export type LeadQuality =
  | "LEAD_GOLD"
  | "LEAD_WRONG_GOLD_ELSEWHERE"
  | "LEAD_WRONG_NO_GOLD"
  | "VALID_EMPTY"
  | "TREATMENT_UNAVAILABLE";

export interface DeliveredItem {
  readonly path: string;
  readonly symbol?: string;
}

export interface LeadClassification {
  readonly quality: LeadQuality;
  readonly leadFile: string | null;
  readonly leadSymbol: string | null;
  readonly top1Gold: boolean;
  readonly top3Gold: boolean;
  readonly goldAnywhere: boolean;
  readonly goldDelivered: readonly string[];
}

/**
 * Classify the lead against the reference patch's gold files.
 *
 * Gold paths are used for EVALUATION ONLY and are never fed to retrieval (§20).
 * `pivots` must be in delivery order — the lead is `pivots[0]`, and "top 3" spans
 * pivots then support in that same order, because that is the order the agent
 * actually reads them in.
 */
export function classifyLeadQuality(args: {
  readonly state: TreatmentState;
  readonly pivots: readonly DeliveredItem[];
  readonly support: readonly DeliveredItem[];
  readonly goldFiles: readonly string[];
}): LeadClassification {
  const { state, pivots, support, goldFiles } = args;
  const gold = new Set(goldFiles);
  const delivered = [...pivots, ...support];
  const deliveredGold = [...new Set(delivered.map((d) => d.path).filter((p) => gold.has(p)))].sort();
  const lead = pivots[0] ?? support[0] ?? null;
  const empty = {
    leadFile: lead?.path ?? null,
    leadSymbol: lead?.symbol ?? null,
    top1Gold: false,
    top3Gold: false,
    goldAnywhere: deliveredGold.length > 0,
    goldDelivered: deliveredGold,
  };

  if (state === "TREATMENT_UNAVAILABLE" || state === "CORPUS_INVALID" || state === "NOT_RUN") {
    return { ...empty, quality: "TREATMENT_UNAVAILABLE", goldAnywhere: false, goldDelivered: [] };
  }
  if (state === "VALID_DELIVERY_EMPTY" || lead === null) {
    return { ...empty, quality: "VALID_EMPTY", goldAnywhere: false, goldDelivered: [] };
  }

  const top1Gold = gold.has(lead.path);
  const top3Gold = delivered.slice(0, 3).some((d) => gold.has(d.path));
  const goldAnywhere = deliveredGold.length > 0;
  const quality: LeadQuality =
    top1Gold ? "LEAD_GOLD"
    : goldAnywhere ? "LEAD_WRONG_GOLD_ELSEWHERE"
    : "LEAD_WRONG_NO_GOLD";

  return { quality, leadFile: lead.path, leadSymbol: lead.symbol ?? null, top1Gold, top3Gold, goldAnywhere, goldDelivered: deliveredGold };
}

// ---------------------------------------------------------------------------
// Prompt parity (§84-§85)
// ---------------------------------------------------------------------------

export const VTRACE_EVIDENCE_MARKERS: readonly string[] = [
  "# vtrace",
  "VTRACE_DIGEST_DECISION_CONTRACT",
  "## Pivots",
  "## Support",
  "vtrace instructions",
];

export interface ParityResult {
  readonly identicalAfterEvidenceRemoval: boolean;
  readonly baselineVtraceByteCount: number;
  readonly vtraceEvidenceBytes: number;
  readonly residualDifferences: readonly string[];
  readonly tokenDisciplinePresent: { readonly baseline: boolean; readonly vtrace: boolean };
}

/**
 * §84 — show that the two arms' assembled inputs differ ONLY by the injected
 * VTRACE evidence block.
 *
 * `stripEvidence` removes the treatment; whatever remains must match the baseline
 * line for line. Anything left over is a hidden asymmetry, and §85 is explicit
 * that a difference in ADVICE is not the same thing as a difference in evidence —
 * which is exactly the STAGE5_TOKEN_DISCIPLINE case M161 froze off, so the parity
 * result reports its presence in each arm separately rather than folding it into
 * the byte diff.
 */
export function checkPromptParity(args: {
  readonly baseline: string;
  readonly vtrace: string;
  readonly stripEvidence: (text: string) => string;
  readonly detectTokenDiscipline: (text: string) => boolean;
}): ParityResult {
  const { baseline, vtrace, stripEvidence, detectTokenDiscipline } = args;
  const strippedVtrace = stripEvidence(vtrace);
  const baselineLines = baseline.split("\n");
  const strippedLines = strippedVtrace.split("\n");

  const residual: string[] = [];
  const max = Math.max(baselineLines.length, strippedLines.length);
  for (let i = 0; i < max; i += 1) {
    const a = baselineLines[i] ?? "<absent>";
    const b = strippedLines[i] ?? "<absent>";
    if (a !== b) residual.push(`line ${i + 1}: baseline ${JSON.stringify(a)} vs vtrace ${JSON.stringify(b)}`);
    if (residual.length >= 20) break;
  }

  // A VTRACE evidence marker surviving in the BASELINE is the failure §83 warns
  // about: condition names are not proof, the assembled input is.
  const leaked = VTRACE_EVIDENCE_MARKERS.filter((marker) => baseline.includes(marker));
  for (const marker of leaked) residual.push(`baseline contains VTRACE evidence marker ${JSON.stringify(marker)}`);

  return {
    identicalAfterEvidenceRemoval: residual.length === 0,
    baselineVtraceByteCount: baseline.length,
    vtraceEvidenceBytes: vtrace.length - strippedVtrace.length,
    residualDifferences: residual,
    tokenDisciplinePresent: { baseline: detectTokenDiscipline(baseline), vtrace: detectTokenDiscipline(vtrace) },
  };
}

/** Does an assembled baseline input carry ANY VTRACE-generated evidence? (§83) */
export function baselineCarriesVtraceEvidence(baseline: string): readonly string[] {
  return VTRACE_EVIDENCE_MARKERS.filter((marker) => baseline.includes(marker));
}
