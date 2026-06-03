// Capsule sizing modes. A "mode" is the outer envelope chosen for a capsule:
// how many items it may carry and how many characters it may spend. The mode
// then drives the existing content-compression ladder in buildCapsuleImpl.
//
// The three modes exist because SWE-bench-style tasks split sharply: small,
// local edits are hurt by a large oriented context (the agent already has the
// issue text), while large, navigation-heavy tasks benefit from more. Picking
// the right envelope per task is what `recommendCapsuleMode` is for.

export const CapsuleMode = Object.freeze({
  Micro: "micro",
  Standard: "standard",
  Full: "full",
});

export type CapsuleMode = (typeof CapsuleMode)[keyof typeof CapsuleMode];

export interface CapsuleModeLimits {
  /** Maximum number of capsule items (pivots) surfaced for this mode. */
  maxItems: number;
  /** Maximum character budget for the assembled capsule. */
  maxChars: number;
}

// Suggested sizing per the Stage 5 product brief. micro is deliberately tiny so
// that small/local tasks stop paying navigation overhead.
export const CAPSULE_MODE_LIMITS: Readonly<Record<CapsuleMode, CapsuleModeLimits>> =
  Object.freeze({
    [CapsuleMode.Micro]: Object.freeze({ maxItems: 2, maxChars: 1_500 }),
    [CapsuleMode.Standard]: Object.freeze({ maxItems: 5, maxChars: 6_000 }),
    [CapsuleMode.Full]: Object.freeze({ maxItems: 8, maxChars: 12_000 }),
  });

export const DEFAULT_CAPSULE_MODE: CapsuleMode = CapsuleMode.Standard;

export const CAPSULE_MODE_VALUES: readonly CapsuleMode[] = Object.freeze([
  CapsuleMode.Micro,
  CapsuleMode.Standard,
  CapsuleMode.Full,
]);

export function isCapsuleMode(value: string): value is CapsuleMode {
  return (CAPSULE_MODE_VALUES as readonly string[]).includes(value);
}

export function parseCapsuleMode(value: string): CapsuleMode | undefined {
  const normalized = value.trim().toLowerCase();
  return isCapsuleMode(normalized) ? normalized : undefined;
}

export interface CapsuleLimitOverrides {
  maxItems?: number;
  maxChars?: number;
}

// Resolve the effective limits for a mode, applying explicit overrides. An
// override of 0 is honoured (callers may legitimately request an empty capsule);
// only undefined falls back to the mode default. Negative/non-integer overrides
// are rejected so the downstream character budget stays well-formed.
export function resolveCapsuleModeLimits(
  mode: CapsuleMode = DEFAULT_CAPSULE_MODE,
  overrides: CapsuleLimitOverrides = {},
): CapsuleModeLimits {
  const base = CAPSULE_MODE_LIMITS[mode];

  return {
    maxItems: resolveLimitOverride("maxItems", base.maxItems, overrides.maxItems),
    maxChars: resolveLimitOverride("maxChars", base.maxChars, overrides.maxChars),
  };
}

function resolveLimitOverride(
  label: string,
  fallback: number,
  override: number | undefined,
): number {
  if (override === undefined) {
    return fallback;
  }

  if (!Number.isInteger(override) || override < 0) {
    throw new Error(`${label} override must be a non-negative integer`);
  }

  return override;
}
