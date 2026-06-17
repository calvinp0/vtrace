// M34 — capsule-attributable accounting + functional actionability labels.
//
// PURE, offline, read-only helpers. Nothing here runs an agent, Docker, or any
// command; every function takes already-captured artifact text/objects and
// returns a derived value. It exists to make the M32 token story trustworthy:
//
//   1. injected-context accounting — the *full* VTRACE-injected instructions
//      block (capsule body + scaffold + contract + hints + wrapper), not just
//      the capsule body that `capsuleEstimatedTokens` measures (M33 found the
//      latter under-counts the real first-turn injection by 2–3×).
//   2. post-capsule wandering — tool calls / reads / searches the agent made
//      after receiving the capsule, and the slice of them before the first edit.
//   3. functional actionability — labels keyed on `resolved` (the functional
//      truth), kept BESIDE the existing structural gold-file labels, so a
//      resolve-without-gold (xarray-3677) and an edit-all-gold-but-fail
//      (django-13195) are no longer mislabeled by the structural proxy alone.
//
// Token figures reuse the one `chars/4` estimator that already sizes Capsule v2
// (`src/capsuleV2/tokens.ts`) so every surface speaks the same unit. This is an
// APPROXIMATION, never a tokenizer count, and the accountingMethod field says so.

import { estimateTokens } from "../../src/capsuleV2/tokens";

// --- injected-context component accounting ------------------------------------

/** Component buckets of the rendered VTRACE-injected instructions block. */
export type InjectedComponent =
  | "capsuleBody"
  | "instructionScaffold"
  | "pivotContract"
  | "actionabilityHints"
  | "coeditHint"
  | "benchmarkWrapper"
  | "unclassified";

/** How the injected-context tokens were obtained, surfaced for honesty. */
export type AccountingMethod =
  | "exact_rendered_block" // measured the actual captured rendered snapshot (chars/4)
  | "estimated_components" // component split of that snapshot (chars/4)
  | "legacy_estimate" // only the legacy capsuleEstimatedTokens was available
  | "no_context_injected"; // policy declined to inject — nothing to count

/**
 * Capsule-attributable token accounting. Additive over the legacy field: a
 * consumer that only reads `capsuleEstimatedTokens` keeps working unchanged.
 *
 * `injectedContextTokens` is the estimate that matters — the WHOLE rendered
 * block the agent paid for on turn 1 — and the per-component fields explain
 * where those tokens went. Component char counts partition the block exactly
 * (their sum equals `injectedContextChars`); component token counts sum to
 * `injectedContextTokens` within per-section ceil rounding.
 */
export interface ProductV2Accounting {
  /** Existing legacy field (capsule body pivots/support only). Preserved as-is. */
  capsuleEstimatedTokens: number | null;
  /** chars/4 estimate of the full rendered injected instructions block. */
  injectedContextTokens: number | null;
  /** Raw character length of the full rendered injected block. */
  injectedContextChars: number | null;
  capsuleBodyTokens: number | null;
  instructionScaffoldTokens: number | null;
  pivotContractTokens: number | null;
  actionabilityHintsTokens: number | null;
  coeditHintTokens: number | null;
  productAccountingTokens: number | null;
  manifestReferenceTokens: number | null;
  benchmarkWrapperTokens: number | null;
  unclassifiedTokens: number | null;
  accountingMethod: AccountingMethod;
}

interface SectionChunk {
  component: InjectedComponent;
  text: string;
}

/**
 * Map an injected-block level-2 heading (the text after `## `) to a component.
 * Phrase tests are disjoint on the real headings; the exact `instance` /
 * `instruction` checks do not overlap each other or any phrase above them.
 */
export function classifyInjectedHeading(headingRaw: string): InjectedComponent {
  const h = headingRaw.trim().toLowerCase();
  if (h.includes("stage5_token_discipline") || h.includes("token discipline")) return "benchmarkWrapper";
  if (h.includes("pivot neighborhood")) return "capsuleBody";
  if (h.includes("pivot inspection contract")) return "pivotContract";
  if (h.includes("actionability hint")) return "actionabilityHints";
  if (h.includes("multiple edit targets") || h.includes("co-edit")) return "coeditHint";
  if (h.includes("inspect-first")) return "instructionScaffold";
  if (h.includes("vtrace context")) return "capsuleBody";
  if (h.startsWith("instruction")) return "instructionScaffold";
  if (h.startsWith("instance")) return "benchmarkWrapper";
  return "unclassified";
}

/**
 * Split a rendered injected-instructions snapshot into component chunks that
 * together cover 100% of the text (the level-1 header + any preamble before the
 * first `## ` is bucketed as instructionScaffold). Splitting is line-based on
 * level-2 (`## `) headings; the heading line is kept with its section.
 */
export function splitInjectedContextChunks(snapshot: string): SectionChunk[] {
  const lines = snapshot.split("\n");
  const chunks: SectionChunk[] = [];
  let current: SectionChunk | null = null;
  // Preamble (level-1 header + intro) before the first `## ` heading.
  let preamble = "";
  const flush = () => {
    if (current) chunks.push(current);
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const isLast = i === lines.length - 1;
    const piece = isLast ? line : line + "\n";
    const m = /^##\s+(.*)$/.exec(line);
    if (m) {
      // starting a new level-2 section
      if (current === null && preamble.length > 0) {
        chunks.push({ component: "instructionScaffold", text: preamble });
        preamble = "";
      }
      flush();
      current = { component: classifyInjectedHeading(m[1]), text: piece };
    } else if (current) {
      current.text += piece;
    } else {
      preamble += piece;
    }
  }
  flush();
  if (current === null && preamble.length > 0) {
    // No level-2 headings at all — the whole block is scaffold.
    chunks.push({ component: "instructionScaffold", text: preamble });
  }
  return chunks;
}

function sumTokensFor(chunks: SectionChunk[], component: InjectedComponent): number {
  return chunks
    .filter((c) => c.component === component)
    .reduce((acc, c) => acc + estimateTokens(c.text), 0);
}

/**
 * Build {@link ProductV2Accounting} from the captured injected snapshot text and
 * the legacy `capsuleEstimatedTokens`. `snapshot === null` means the policy did
 * not inject context (no snapshot was written) — every injected figure is null
 * and the method is `no_context_injected`.
 */
export function buildProductV2Accounting(
  snapshot: string | null,
  legacyCapsuleEstimatedTokens: number | null,
): ProductV2Accounting {
  if (snapshot === null) {
    return {
      capsuleEstimatedTokens: legacyCapsuleEstimatedTokens,
      injectedContextTokens: null,
      injectedContextChars: null,
      capsuleBodyTokens: null,
      instructionScaffoldTokens: null,
      pivotContractTokens: null,
      actionabilityHintsTokens: null,
      coeditHintTokens: null,
      productAccountingTokens: null,
      manifestReferenceTokens: null,
      benchmarkWrapperTokens: null,
      unclassifiedTokens: null,
      accountingMethod: legacyCapsuleEstimatedTokens === null ? "no_context_injected" : "legacy_estimate",
    };
  }
  const chunks = splitInjectedContextChunks(snapshot);
  return {
    capsuleEstimatedTokens: legacyCapsuleEstimatedTokens,
    injectedContextTokens: estimateTokens(snapshot),
    injectedContextChars: snapshot.length,
    capsuleBodyTokens: sumTokensFor(chunks, "capsuleBody"),
    instructionScaffoldTokens: sumTokensFor(chunks, "instructionScaffold"),
    pivotContractTokens: sumTokensFor(chunks, "pivotContract"),
    actionabilityHintsTokens: sumTokensFor(chunks, "actionabilityHints"),
    coeditHintTokens: sumTokensFor(chunks, "coeditHint"),
    // No product-accounting or manifest text is injected into the prompt; these
    // live in side-car artifacts (`_product_v2_probe`, `_capsule_v2_manifest`),
    // so they contribute zero injected prompt tokens. Recorded explicitly.
    productAccountingTokens: 0,
    manifestReferenceTokens: 0,
    benchmarkWrapperTokens: sumTokensFor(chunks, "benchmarkWrapper"),
    unclassifiedTokens: sumTokensFor(chunks, "unclassified"),
    accountingMethod: "exact_rendered_block",
  };
}

/**
 * Undercount ratio of the legacy capsule estimate vs the full injected block:
 * injectedContextTokens / capsuleEstimatedTokens. >1 means the legacy field
 * under-counts. Null when either input is missing or the legacy value is 0.
 */
export function tokenUndercountRatio(
  capsuleEstimatedTokens: number | null,
  injectedContextTokens: number | null,
): number | null {
  if (
    capsuleEstimatedTokens === null ||
    injectedContextTokens === null ||
    capsuleEstimatedTokens === 0
  ) {
    return null;
  }
  return injectedContextTokens / capsuleEstimatedTokens;
}

// --- post-capsule tool-use accounting -----------------------------------------

/** One captured tool call (subset of `_tool_calls_with_outputs.json` fields). */
export interface ToolCallWithOutput {
  index?: number;
  tool?: string | null;
  category?: string | null;
  path?: string | null;
  output?: string | null;
  truncated?: boolean | null;
}

/**
 * Post-capsule wandering for a VTRACE run. The capsule is injected in the turn-1
 * prompt, so ALL first-pass tool calls happen "after context" — the
 * `afterContext` totals therefore equal the full first-pass counts, and the
 * `beforeFirstPatch` slice isolates the localization phase before the first edit.
 * Tool-output tokens are approximate (chars/4, and captured outputs may be
 * truncated): `toolOutputTokensApproximate` / `truncatedOutputCount` flag that.
 */
export interface PostCapsuleToolUse {
  toolCallsAfterContext: number;
  readCallsAfterContext: number;
  grepSearchCallsAfterContext: number;
  bashCallsAfterContext: number;
  uniqueFilesReadAfterContext: number;
  uniqueFilesTouchedAfterContext: number;
  toolOutputTokensAfterContext: number | null;
  beforeFirstPatchToolCalls: number | null;
  beforeFirstPatchReadCalls: number | null;
  beforeFirstPatchGrepSearchCalls: number | null;
  beforeFirstPatchToolOutputTokens: number | null;
  firstPatchToolIndex: number | null;
  toolOutputTokensApproximate: boolean;
  truncatedOutputCount: number;
}

function toolKind(c: ToolCallWithOutput): "read" | "search" | "edit" | "bash" | "other" {
  const cat = (c.category ?? "").toLowerCase();
  const tool = (c.tool ?? "").toLowerCase();
  if (cat === "edit" || cat === "write" || tool === "edit" || tool === "write") return "edit";
  if (cat === "read" || tool === "read") return "read";
  if (cat === "search" || tool === "grep" || tool === "glob") return "search";
  if (cat === "bash" || tool === "bash") return "bash";
  return "other";
}

/**
 * Compute {@link PostCapsuleToolUse} from the ordered captured tool calls.
 * `null` input (telemetry missing) yields a graceful all-zero/null record.
 */
export function computePostCapsuleToolUse(
  calls: ToolCallWithOutput[] | null,
): PostCapsuleToolUse {
  const empty: PostCapsuleToolUse = {
    toolCallsAfterContext: 0,
    readCallsAfterContext: 0,
    grepSearchCallsAfterContext: 0,
    bashCallsAfterContext: 0,
    uniqueFilesReadAfterContext: 0,
    uniqueFilesTouchedAfterContext: 0,
    toolOutputTokensAfterContext: null,
    beforeFirstPatchToolCalls: null,
    beforeFirstPatchReadCalls: null,
    beforeFirstPatchGrepSearchCalls: null,
    beforeFirstPatchToolOutputTokens: null,
    firstPatchToolIndex: null,
    toolOutputTokensApproximate: false,
    truncatedOutputCount: 0,
  };
  if (calls === null || calls.length === 0) return empty;

  const readPaths = new Set<string>();
  const touchedPaths = new Set<string>();
  let reads = 0;
  let searches = 0;
  let bash = 0;
  let outputTokens = 0;
  let anyOutput = false;
  let truncated = 0;
  let firstPatchIndex: number | null = null;

  // before-first-patch accumulators
  let bfpCalls = 0;
  let bfpReads = 0;
  let bfpSearches = 0;
  let bfpOutputTokens = 0;

  calls.forEach((c, i) => {
    const kind = toolKind(c);
    const fp = typeof c.path === "string" ? c.path : "";
    if (kind === "read") reads += 1;
    else if (kind === "search") searches += 1;
    else if (kind === "bash") bash += 1;
    if (kind === "read" && fp) readPaths.add(fp);
    if ((kind === "read" || kind === "edit") && fp) touchedPaths.add(fp);
    if (kind === "edit" && firstPatchIndex === null) firstPatchIndex = i;

    if (typeof c.output === "string") {
      anyOutput = true;
      outputTokens += estimateTokens(c.output);
      if (c.truncated === true) truncated += 1;
    }

    // before-first-patch slice (strictly before the first edit)
    if (firstPatchIndex === null) {
      bfpCalls += 1;
      if (kind === "read") bfpReads += 1;
      else if (kind === "search") bfpSearches += 1;
      if (typeof c.output === "string") bfpOutputTokens += estimateTokens(c.output);
    }
  });

  const hasPatch = firstPatchIndex !== null;
  return {
    toolCallsAfterContext: calls.length,
    readCallsAfterContext: reads,
    grepSearchCallsAfterContext: searches,
    bashCallsAfterContext: bash,
    uniqueFilesReadAfterContext: readPaths.size,
    uniqueFilesTouchedAfterContext: touchedPaths.size,
    toolOutputTokensAfterContext: anyOutput ? outputTokens : null,
    beforeFirstPatchToolCalls: hasPatch ? bfpCalls : null,
    beforeFirstPatchReadCalls: hasPatch ? bfpReads : null,
    beforeFirstPatchGrepSearchCalls: hasPatch ? bfpSearches : null,
    beforeFirstPatchToolOutputTokens: hasPatch && anyOutput ? bfpOutputTokens : null,
    firstPatchToolIndex: firstPatchIndex,
    toolOutputTokensApproximate: anyOutput,
    truncatedOutputCount: truncated,
  };
}

// --- functional actionability labels ------------------------------------------

/** Functional actionability label, keyed on `resolved` and kept beside the structural label. */
export type FunctionalActionabilityLabel =
  | "functional_actionability_success"
  | "structural_only_success"
  | "functional_success_gold_proxy_mismatch"
  | "retrieval_success_action_failure"
  | "retrieval_success_synthesis_failure"
  | "safe_no_context_success"
  | "safe_no_context_failure"
  | "unknown";

/** Inputs for {@link classifyFunctionalActionability}. `null` = unknown/missing. */
export interface FunctionalActionabilityInput {
  /** Canonical Docker resolution. null when no result was captured. */
  resolved: boolean | null;
  /** Whether VTRACE injected a capsule. null when unknown. */
  contextInjected: boolean | null;
  /** A gold file was surfaced as a pivot. null when unknown. */
  goldSurfaced: boolean | null;
  /** The final patch edits EVERY gold file. null when unknown. */
  goldEditedComplete: boolean | null;
}

/**
 * Map a run to a single functional actionability label by documented precedence.
 * Functional truth (`resolved`) dominates the structural gold-file proxy:
 *
 *   resolved=true  + no context injected ............ safe_no_context_success
 *   resolved=true  + all gold edited ................ functional_actionability_success
 *   resolved=true  + NOT all gold edited ............ functional_success_gold_proxy_mismatch  (xarray-3677)
 *   resolved=false + no context injected ............ safe_no_context_failure
 *   resolved=false + all gold edited + surfaced ..... retrieval_success_synthesis_failure     (django-13195)
 *   resolved=false + all gold edited + not surfaced . structural_only_success
 *   resolved=false + gold surfaced, not all edited .. retrieval_success_action_failure         (sphinx-7462, seaborn)
 *   otherwise ....................................... unknown
 */
export function classifyFunctionalActionability(
  s: FunctionalActionabilityInput,
): FunctionalActionabilityLabel {
  if (s.resolved === null) return "unknown";
  if (s.resolved === true) {
    if (s.contextInjected === false) return "safe_no_context_success";
    if (s.goldEditedComplete === true) return "functional_actionability_success";
    return "functional_success_gold_proxy_mismatch";
  }
  // resolved === false
  if (s.contextInjected === false) return "safe_no_context_failure";
  if (s.goldEditedComplete === true) {
    return s.goldSurfaced === true ? "retrieval_success_synthesis_failure" : "structural_only_success";
  }
  if (s.goldSurfaced === true) return "retrieval_success_action_failure";
  return "unknown";
}
