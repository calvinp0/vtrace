// Historical capsule selector compatibility.
//
// VTRACE has one runtime capsule implementation. This module validates inputs
// from callers that may still send the former selector; it never selects an
// implementation and contains no fallback path.

export const UNSUPPORTED_LEGACY_CAPSULE_ENGINE = "unsupported_legacy_capsule_engine" as const;
export const INVALID_CAPSULE_ENGINE_ALIAS = "invalid_capsule_engine_alias" as const;

export interface CapsuleCompatibility {
  /** Omitted for current calls; populated only when a deprecated alias was supplied. */
  readonly deprecatedAlias: "default" | "v2" | null;
  readonly warnings: readonly string[];
}

export class CapsuleEngineCompatibilityError extends Error {
  readonly code:
    | typeof UNSUPPORTED_LEGACY_CAPSULE_ENGINE
    | typeof INVALID_CAPSULE_ENGINE_ALIAS;

  constructor(
    code: CapsuleEngineCompatibilityError["code"],
    message: string,
  ) {
    super(message);
    this.name = "CapsuleEngineCompatibilityError";
    this.code = code;
  }
}

/**
 * Validate a historical selector without selecting an implementation.
 *
 * Omission is the current unversioned API. `default` and `v2` are temporary
 * deprecated aliases and never alter execution. `v1`/`legacy` are rejected
 * before retrieval. Unknown values are errors rather than silently becoming a
 * default.
 */
export function resolveCapsuleCompatibility(
  raw: string | undefined | null,
): CapsuleCompatibility {
  if (raw === undefined || raw === null || raw.trim().length === 0) {
    return { deprecatedAlias: null, warnings: [] };
  }
  const normalized = raw.trim().toLowerCase();
  if (normalized === "v1" || normalized === "legacy") {
    throw new CapsuleEngineCompatibilityError(
      UNSUPPORTED_LEGACY_CAPSULE_ENGINE,
      "VTRACE supports one authoritative capsule. Remove capsule_engine=v1.",
    );
  }
  if (normalized === "default" || normalized === "v2") {
    return {
      deprecatedAlias: normalized,
      warnings: [
        `capsule_engine=${normalized} is deprecated and ignored; VTRACE always uses the authoritative capsule.`,
      ],
    };
  }
  throw new CapsuleEngineCompatibilityError(
    INVALID_CAPSULE_ENGINE_ALIAS,
    `Unsupported capsule_engine value "${raw}". Remove the capsule engine selector.`,
  );
}
