/**
 * M166-A — response-boundary and token-authority primitives.
 *
 * Five representations of one repository-context call are distinguished, and this
 * module never lets two of them be spoken of as one:
 *
 *   INTERNAL      the handler's structured result object
 *   TRANSPORT     what crosses the MCP wire (content text AND structuredContent)
 *   MODEL_VISIBLE what the runtime put in the model's tool_result block
 *   MODEL_TRAFFIC what the next request actually carried
 *   BILLED        cache-creation and cache-read as the provider reported them
 *
 * Offline tokenizer figures are OFFLINE_ESTIMATED_TOKENS and are never returned
 * from the functions that report billed traffic.
 */

/** A token figure with a stated authority. Never collapse these into "tokens". */
export const TokenAuthority = Object.freeze({
  /** chars/N arithmetic over a serialized representation. Not billing evidence. */
  OfflineEstimated: "OFFLINE_ESTIMATED_TOKENS",
  /** Reported by the provider for a real request. */
  ProviderReported: "PROVIDER_REPORTED_TOKENS",
  /** Derived from provider-reported figures by an arithmetic identity that held. */
  DerivedFromReported: "DERIVED_FROM_PROVIDER_REPORTED",
});
export type TokenAuthority = (typeof TokenAuthority)[keyof typeof TokenAuthority];

export interface AssistantTurn {
  readonly kind: "assistant";
  readonly index: number;
  readonly cacheReadTokens: number | null;
  readonly cacheCreationTokens: number | null;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  /** Characters of assistant-authored content that also enters the next request. */
  readonly authoredCharacters: number;
  readonly toolNames: readonly string[];
}

export interface ToolResultTurn {
  readonly kind: "toolResult";
  readonly index: number;
  readonly toolUseId: string | null;
  readonly characters: number;
  /** First 160 characters, enough to identify which representation was delivered. */
  readonly head: string;
  readonly isError: boolean;
}

export type StreamTurn = AssistantTurn | ToolResultTurn;

interface RawBlock { type?: unknown; text?: unknown; thinking?: unknown; name?: unknown; input?: unknown; content?: unknown; tool_use_id?: unknown; is_error?: unknown }

/**
 * Parse a Claude Code stream-json transcript into the alternating turn sequence.
 *
 * Streaming emits one `assistant` event per content block, all carrying the SAME
 * request usage. Collapsing consecutive events that report identical usage keeps
 * one turn per request; keeping the LAST of the run keeps the tool_use block.
 */
export function parseAgentStream(lines: readonly string[]): StreamTurn[] {
  const turns: StreamTurn[] = [];
  const authoredOf = (blocks: readonly RawBlock[]): number => {
    let total = 0;
    for (const block of blocks) {
      if (typeof block.text === "string") total += block.text.length;
      if (typeof block.thinking === "string") total += block.thinking.length;
      if (block.type === "tool_use" && block.input !== undefined) total += JSON.stringify(block.input).length;
    }
    return total;
  };

  for (const line of lines) {
    let row: Record<string, unknown>;
    try { row = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
    const message = row.message as Record<string, unknown> | undefined;
    const blocks = (Array.isArray(message?.content) ? message?.content : []) as RawBlock[];

    if (row.type === "assistant") {
      const usage = (message?.usage ?? {}) as Record<string, unknown>;
      const numeric = (key: string): number | null => {
        const value = usage[key];
        return typeof value === "number" && Number.isFinite(value) ? value : null;
      };
      const turn: AssistantTurn = {
        kind: "assistant",
        index: turns.length,
        cacheReadTokens: numeric("cache_read_input_tokens"),
        cacheCreationTokens: numeric("cache_creation_input_tokens"),
        inputTokens: numeric("input_tokens"),
        outputTokens: numeric("output_tokens"),
        authoredCharacters: authoredOf(blocks),
        toolNames: blocks.filter((b) => b.type === "tool_use" && typeof b.name === "string").map((b) => b.name as string),
      };
      const previous = turns[turns.length - 1];
      if (previous !== undefined && previous.kind === "assistant"
        && previous.cacheReadTokens === turn.cacheReadTokens
        && previous.cacheCreationTokens === turn.cacheCreationTokens) {
        // Same request, next content block: merge rather than double-count.
        turns[turns.length - 1] = {
          ...turn,
          index: previous.index,
          authoredCharacters: previous.authoredCharacters + turn.authoredCharacters,
          toolNames: [...previous.toolNames, ...turn.toolNames],
        };
        continue;
      }
      turns.push({ ...turn, index: turns.length });
      continue;
    }

    if (row.type === "user") {
      for (const block of blocks) {
        if (block.type !== "tool_result") continue;
        const content = block.content;
        const text = typeof content === "string" ? content : JSON.stringify(content ?? "");
        turns.push({
          kind: "toolResult",
          index: turns.length,
          toolUseId: typeof block.tool_use_id === "string" ? block.tool_use_id : null,
          characters: text.length,
          head: text.slice(0, 160),
          isError: block.is_error === true,
        });
      }
    }
  }
  return turns;
}

export interface CacheIdentityReport {
  readonly checked: number;
  readonly held: number;
  /** Turn indices where cache_read[n+1] != cache_read[n] + cache_creation[n]. */
  readonly violations: readonly number[];
  readonly holdsEverywhere: boolean;
}

/**
 * The identity that licenses attribution: everything a request cached is re-read by
 * the next one. Where it fails (cache expiry, a fresh prefix), attribution for the
 * affected turn is not derivable and must be reported as such rather than assumed.
 */
export function checkCacheIdentity(turns: readonly StreamTurn[]): CacheIdentityReport {
  const assistants = turns.filter((t): t is AssistantTurn => t.kind === "assistant");
  const violations: number[] = [];
  let checked = 0;
  for (let i = 1; i < assistants.length; i += 1) {
    const previous = assistants[i - 1]!;
    const current = assistants[i]!;
    if (previous.cacheReadTokens === null || previous.cacheCreationTokens === null || current.cacheReadTokens === null) continue;
    checked += 1;
    if (current.cacheReadTokens !== previous.cacheReadTokens + previous.cacheCreationTokens) violations.push(current.index);
  }
  return { checked, held: checked - violations.length, violations: Object.freeze(violations), holdsEverywhere: violations.length === 0 && checked > 0 };
}

export interface CalibrationSample {
  readonly resultCharacters: number;
  readonly authoredCharacters: number;
  readonly cacheCreationTokens: number;
}

export interface Calibration {
  readonly samples: number;
  /** Tokens per character of tool-result content. */
  readonly resultTokensPerCharacter: number;
  readonly resultCharactersPerToken: number;
  /** Tokens per character of assistant-authored content (text + thinking + tool input). */
  readonly authoredTokensPerCharacter: number;
  readonly fixedTokensPerRequest: number;
  readonly rSquared: number;
}

/**
 * Least-squares calibration of billed cache-creation against the two things a turn
 * adds: the tool result the model was handed, and the assistant text that preceded
 * it. The slope is what converts a serialized size into billed tokens; R² is what
 * says whether the conversion may be trusted at all.
 */
export function calibrateResultTokens(samples: readonly CalibrationSample[]): Calibration | null {
  if (samples.length < 3) return null;
  // Normal equations for y = a*r + b*x + c.
  const n = samples.length;
  let sr = 0, sx = 0, sy = 0, srr = 0, sxx = 0, srx = 0, sry = 0, sxy = 0;
  for (const s of samples) {
    sr += s.resultCharacters; sx += s.authoredCharacters; sy += s.cacheCreationTokens;
    srr += s.resultCharacters * s.resultCharacters;
    sxx += s.authoredCharacters * s.authoredCharacters;
    srx += s.resultCharacters * s.authoredCharacters;
    sry += s.resultCharacters * s.cacheCreationTokens;
    sxy += s.authoredCharacters * s.cacheCreationTokens;
  }
  const matrix = [[srr, srx, sr], [srx, sxx, sx], [sr, sx, n]];
  const vector = [sry, sxy, sy];
  const solved = solve3(matrix, vector);
  if (solved === null) return null;
  const [a, b, c] = solved;
  const mean = sy / n;
  let ssRes = 0, ssTot = 0;
  for (const s of samples) {
    const predicted = a * s.resultCharacters + b * s.authoredCharacters + c;
    ssRes += (s.cacheCreationTokens - predicted) ** 2;
    ssTot += (s.cacheCreationTokens - mean) ** 2;
  }
  return {
    samples: n,
    resultTokensPerCharacter: a,
    resultCharactersPerToken: a === 0 ? Number.POSITIVE_INFINITY : 1 / a,
    authoredTokensPerCharacter: b,
    fixedTokensPerRequest: c,
    rSquared: ssTot === 0 ? 0 : 1 - ssRes / ssTot,
  };
}

function solve3(matrix: number[][], vector: number[]): [number, number, number] | null {
  const m = matrix.map((row, i) => [...row, vector[i]!]);
  for (let col = 0; col < 3; col += 1) {
    let pivot = col;
    for (let row = col + 1; row < 3; row += 1) if (Math.abs(m[row]![col]!) > Math.abs(m[pivot]![col]!)) pivot = row;
    if (Math.abs(m[pivot]![col]!) < 1e-12) return null;
    [m[col], m[pivot]] = [m[pivot]!, m[col]!];
    for (let row = 0; row < 3; row += 1) {
      if (row === col) continue;
      const factor = m[row]![col]! / m[col]![col]!;
      for (let k = col; k < 4; k += 1) m[row]![k]! -= factor * m[col]![k]!;
    }
  }
  return [m[0]![3]! / m[0]![0]!, m[1]![3]! / m[1]![1]!, m[2]![3]! / m[2]![2]!];
}

export interface MarginalAttribution {
  readonly resultCharacters: number;
  /** Everything the following request cached: tool result AND assistant text. */
  readonly upperBoundTokens: number | null;
  /** Calibrated share of that attributable to the tool result alone. */
  readonly estimatedTokens: number | null;
  /** The following request's cache-creation minus the calibrated assistant share. */
  readonly lowerBoundTokens: number | null;
  readonly authority: TokenAuthority;
  /** Requests issued after this tool result entered context. */
  readonly subsequentRequests: number;
  /** Estimated tokens re-read on every later request. */
  readonly cacheReadAmplificationTokens: number | null;
  readonly derivable: boolean;
  readonly note: string;
}

/**
 * Bound the model traffic one tool result caused. The upper bound is measured; the
 * point estimate is calibrated; the lower bound subtracts the assistant text that
 * shared the same cache write. An exact figure is not available because a single
 * cache-creation covers both, and M166 reports bounds rather than inventing one.
 */
export function attributeToolResult(
  turns: readonly StreamTurn[],
  toolResultIndex: number,
  calibration: Calibration | null,
): MarginalAttribution {
  const target = turns.find((t) => t.index === toolResultIndex && t.kind === "toolResult") as ToolResultTurn | undefined;
  if (target === undefined) {
    return { resultCharacters: 0, upperBoundTokens: null, estimatedTokens: null, lowerBoundTokens: null, authority: TokenAuthority.OfflineEstimated, subsequentRequests: 0, cacheReadAmplificationTokens: null, derivable: false, note: "no such tool result" };
  }
  const after = turns.filter((t): t is AssistantTurn => t.kind === "assistant" && t.index > toolResultIndex);
  const before = turns.filter((t): t is AssistantTurn => t.kind === "assistant" && t.index < toolResultIndex);
  const next = after[0];
  const previous = before[before.length - 1];
  const subsequentRequests = after.length;

  if (next === undefined || next.cacheCreationTokens === null) {
    const offline = calibration === null ? null : Math.round(target.characters * calibration.resultTokensPerCharacter);
    return {
      resultCharacters: target.characters,
      upperBoundTokens: null,
      estimatedTokens: offline,
      lowerBoundTokens: null,
      authority: TokenAuthority.OfflineEstimated,
      subsequentRequests,
      cacheReadAmplificationTokens: offline === null ? null : offline * subsequentRequests,
      derivable: false,
      note: "no request followed this tool result; only an offline estimate exists",
    };
  }

  const upper = next.cacheCreationTokens;
  const estimated = calibration === null ? null : Math.round(target.characters * calibration.resultTokensPerCharacter);
  const authoredShare = calibration === null || previous === undefined
    ? null
    : Math.round(previous.authoredCharacters * calibration.authoredTokensPerCharacter + calibration.fixedTokensPerRequest);
  const lower = authoredShare === null ? null : Math.max(0, upper - authoredShare);

  return {
    resultCharacters: target.characters,
    upperBoundTokens: upper,
    estimatedTokens: estimated,
    lowerBoundTokens: lower,
    authority: TokenAuthority.DerivedFromReported,
    subsequentRequests,
    cacheReadAmplificationTokens: estimated === null ? null : estimated * subsequentRequests,
    derivable: true,
    note: "upper bound is the following request's measured cache-creation, which also covers the assistant text that shared it",
  };
}

/** Which serialized representation the runtime handed the model. */
export const DeliveredRepresentation = Object.freeze({
  ContentText: "MCP_CONTENT_TEXT",
  StructuredContent: "MCP_STRUCTURED_CONTENT",
  Neither: "NEITHER",
  Undetermined: "UNDETERMINED",
});
export type DeliveredRepresentation = (typeof DeliveredRepresentation)[keyof typeof DeliveredRepresentation];

/**
 * Decide from evidence, not from the MCP specification, which of the two
 * representations a server returns is the one the model was actually given.
 */
export function identifyDeliveredRepresentation(input: {
  readonly modelVisibleHead: string;
  readonly contentTextHead: string;
  readonly structuredContentHead: string;
}): DeliveredRepresentation {
  const prefix = (a: string, b: string): boolean => {
    const width = Math.min(a.length, b.length, 60);
    return width > 0 && a.slice(0, width) === b.slice(0, width);
  };
  const matchesContent = prefix(input.modelVisibleHead, input.contentTextHead);
  const matchesStructured = prefix(input.modelVisibleHead, input.structuredContentHead);
  if (matchesStructured && !matchesContent) return DeliveredRepresentation.StructuredContent;
  if (matchesContent && !matchesStructured) return DeliveredRepresentation.ContentText;
  if (matchesContent && matchesStructured) return DeliveredRepresentation.Undetermined;
  return DeliveredRepresentation.Neither;
}
