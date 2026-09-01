/**
 * M197A — the scoring rules the falsification controls F4-F8 are written
 * against. PURE, so a control can assert the RULE rather than a run's output.
 *
 * Every function here encodes one way a claim could be passed dishonestly:
 *
 *   F4  a malformed slice counted as a small, impressive representation
 *   F5  `file:line` counted as a rendered call expression
 *   F6  a debug-only field counted as default model-facing output
 *   F7  a declared language enum member counted as language support
 *   F8  a semantically unstable output counted as a measurement
 *
 * The rules are kept out of the measurement scripts so that they cannot quietly
 * change when a number comes out wrong.
 */

// ------------------------------------------------------- F4 skeleton validity

const WORD = /[A-Za-z0-9_$]/;

/**
 * M140's `<module>` symbol is the file scope itself: a STRUCTURAL endpoint that
 * exists so module-level imports have a stable owner, and which the domain types
 * document as carrying no deliverable body. It has no signature by design, so
 * requiring one would score every Python file malformed for something that is
 * not a declaration at all.
 */
export function isStructuralDeclaration(declaration: { kind?: string; name?: string }): boolean {
  return declaration?.kind === "module" || declaration?.name === "<module>";
}

/**
 * Validity is decided against SOURCE TRUTH, not a grammar heuristic. An earlier
 * version of this check counted angle brackets and flagged every signature
 * containing `=>`, which is a fact about the checker and not about the product.
 * What is tested is whether the emitted signature is a faithful, token-aligned
 * slice of the file it claims to describe:
 *
 *   - it occurs verbatim in the source;
 *   - it does not begin in the middle of an identifier;
 *   - it does not end in the middle of one;
 *   - its round and square brackets close. These, unlike `<`, are not also
 *     operators, so an imbalance is a truncation rather than a comparison.
 */
export function signatureFaults(signature: string, raw: string): string[] {
  const faults: string[] = [];
  const at = raw.indexOf(signature);
  if (at < 0) return ["SIGNATURE_NOT_IN_SOURCE"];
  if (at > 0 && WORD.test(raw[at - 1]!) && WORD.test(signature[0]!)) {
    faults.push("SLICED_MID_IDENTIFIER_START");
  }
  const end = at + signature.length;
  if (end < raw.length && WORD.test(raw[end]!) && WORD.test(signature.at(-1)!)) {
    faults.push("SLICED_MID_IDENTIFIER_END");
  }
  let round = 0;
  let square = 0;
  for (const ch of signature) {
    if (ch === "(") round += 1;
    else if (ch === ")") round -= 1;
    else if (ch === "[") square += 1;
    else if (ch === "]") square -= 1;
    if (round < 0 || square < 0) return [...faults, "UNBALANCED_BRACKETS"];
  }
  if (round !== 0 || square !== 0) faults.push("UNBALANCED_BRACKETS");
  return faults;
}

export interface SkeletonValidity {
  readonly faults: readonly string[];
  readonly declarations: number;
  readonly validSignatures: number;
}

export function skeletonValidity(file: any, raw: string): SkeletonValidity {
  const faults: string[] = [];
  let declarations = 0;
  let validSignatures = 0;
  for (const d of file?.declarations ?? []) {
    if (isStructuralDeclaration(d)) continue;
    declarations += 1;
    if (typeof d.name !== "string" || d.name.trim().length === 0) faults.push("EMPTY_DECLARATION_NAME");
    if (typeof d.signature !== "string" || d.signature.length === 0) { faults.push("MISSING_SIGNATURE"); continue; }
    const f = signatureFaults(d.signature, raw);
    if (f.length === 0) validSignatures += 1;
    else faults.push(...f);
  }
  return { faults, declarations, validSignatures };
}

/**
 * F4: a file whose skeleton is malformed is excluded from A9's reduction
 * population. Rewarding a truncation for being short is the exact failure this
 * control exists to prevent.
 */
export function countsTowardReduction(validity: SkeletonValidity): boolean {
  return validity.faults.length === 0;
}

/** The model-facing skeleton text, rendered as M196 rendered it. */
export function renderSkeleton(file: any): string {
  return [
    ...(file?.imports ?? []).map((i: any) => `import ${i.name} from ${i.fromFilePath}`),
    ...(file?.declarations ?? []).flatMap((d: any) => [
      `${d.exported ? "export " : ""}${d.kind} ${d.name}${d.signature ? ` ${d.signature}` : ""}`,
      ...(d.docstring ? [`  """${d.docstring}"""`] : []),
      ...(d.members ?? []).map((m: any) => `  ${m.kind} ${m.name}${m.signature ? ` ${m.signature}` : ""}`),
    ]),
  ].join("\n");
}

// -------------------------------------------------- F5 call-site rendering

export interface CallSiteEvidence {
  readonly sourceText?: string;
  readonly referenceName?: string;
  readonly callSites?: readonly { startLine: number; endLine: number }[];
}

/**
 * F5: a result containing only `file:line` does not satisfy A15. A call site
 * counts as RENDERED only when the evidence carries source text that actually
 * names the callee — coordinates are a pointer to the expression, not the
 * expression, and text that names something else is worse than coordinates
 * because a reader cannot tell it is wrong without opening the file.
 */
export function callSiteIsRendered(evidence: CallSiteEvidence): boolean {
  const text = evidence?.sourceText;
  if (typeof text !== "string" || text.trim().length === 0) return false;
  const callee = evidence.referenceName;
  if (typeof callee !== "string" || callee.length === 0) return false;
  return text.includes(callee);
}

// ------------------------------------------------------- F6 default output

/**
 * F6: a capability reachable only at `detail: "debug"` does not satisfy a claim
 * about what the DEFAULT response gives the model. The claim is about what the
 * model is handed, and a field it is not handed cannot be part of that.
 */
export function satisfiedByDefaultOutput(
  presence: { readonly inDefaultResponse: boolean; readonly inDebugResponse: boolean },
): boolean {
  return presence.inDefaultResponse;
}

// -------------------------------------------------------- F7 language support

/**
 * F7: a declared enum member with no registered parser is a type, and an
 * extension mapping with no registered parser is a detection rule. Neither is
 * language support, so A1 counts only parser-backed families.
 */
export function supportedLanguageCount(input: {
  readonly declaredEnum: readonly string[];
  readonly extensionDetected: readonly string[];
  readonly parserBacked: readonly string[];
}): number {
  const backed = new Set(input.parserBacked);
  return input.declaredEnum.filter((l) => backed.has(l)).length;
}

// --------------------------------------------------------- F8 determinism

/**
 * Keys stripped before hashing a response for the §29 determinism replay.
 *
 * §29 permits latency to vary and forbids semantic content to vary, so the
 * projection must remove time-valued fields WITHOUT removing anything a content
 * change would show up in.
 *
 *   timing, latencyMs        wall-clock, by definition
 *   serializedCharacters,    measurements of the response's OWN size. The
 *   metadataEstimatedTokens, response embeds the latency values above, whose
 *   estimatedTotalTokens     decimal length changes between runs, so these
 *                            counters differ by one character while the content
 *                            is identical. They are latency-derived, not
 *                            semantic. Each was observed differing by 1-2 across
 *                            responses whose every other field was identical.
 *
 * The second group needs its justification stated precisely, because stripping
 * token counts could otherwise hide a real change: these counters are computed
 * over the SERIALIZED response, and at the moment they are computed that string
 * still contains the timing floats above. A float whose decimal length changes
 * between runs therefore moves the count without any content changing. The
 * counters are downstream of the clock, not of the evidence.
 *
 * Nothing else is stripped. A changed symbol, path, span, edge, ordering or
 * rendering still reaches the hash and still fails the replay.
 */
export const NON_SEMANTIC_RESPONSE_KEYS: ReadonlySet<string> = new Set([
  "timing", "latencyMs",
  "serializedCharacters", "metadataEstimatedTokens", "estimatedTotalTokens",
  "estimatedOutputTokens", "estimatedTokensSavedVsNaiveFullFile",
  "estimatedSavingsPercentVsNaiveFullFile",
]);

/** Recursively drop the non-semantic keys, preserving everything else verbatim. */
export function semanticProjection(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(semanticProjection);
  if (value === null || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (NON_SEMANTIC_RESPONSE_KEYS.has(k)) continue;
    out[k] = semanticProjection(v);
  }
  return out;
}

/**
 * F8: identical inputs against an unchanged source state must produce identical
 * SEMANTIC output. Latency may vary; content may not. More than one distinct
 * hash for a query is a measurement failure, not a smaller result.
 */
export function determinismVerdict(
  hashesByQuery: ReadonlyMap<string, ReadonlySet<string>>,
): { deterministic: boolean; unstableQueries: string[] } {
  const unstableQueries = [...hashesByQuery.entries()]
    .filter(([, hashes]) => hashes.size > 1)
    .map(([query]) => query);
  return { deterministic: unstableQueries.length === 0, unstableQueries };
}
