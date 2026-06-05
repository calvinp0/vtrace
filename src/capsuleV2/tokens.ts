// Token accounting for capsule v2.
//
// The internal capsule builder budgets in CHARACTERS (there is no tokenizer in
// the dependency tree, by design — vtrace is local-first and network-free). The
// product surface speaks TOKENS, so this module owns the single, deterministic
// char->token approximation used everywhere a capsule is sized.
//
// The estimate is intentionally simple and stable: ~4 characters per token is
// the well-known rule of thumb for English + code with a BPE tokenizer. It is an
// APPROXIMATION, not a tokenizer, and the budget surface documents it as such.

const CHARS_PER_TOKEN = 4;

/** Estimate the token cost of a string. Deterministic; never negative. */
export function estimateTokens(text: string): number {
  if (text.length === 0) {
    return 0;
  }
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/** Convert a token budget into the equivalent character budget. */
export function tokensToChars(tokens: number): number {
  return Math.max(0, Math.floor(tokens)) * CHARS_PER_TOKEN;
}

/** Round a percentage to two decimal places (the budget surface's precision). */
export function roundPercent(value: number): number {
  return Math.round(value * 100) / 100;
}
