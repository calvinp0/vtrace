// Shared Capsule-engine selection model.
//
// Historically the Capsule v2 engine was reachable from MCP get_context_capsule,
// run_pipeline / get_code_context, and the CLI, but each surface tracked the
// choice with its own ad-hoc `useCapsuleV2` boolean and none of them recorded a
// *requested vs effective* distinction or a fallback reason. The Stage 5
// benchmark harness, separately, carried its own private requested/effective/
// fallbackReason/compactInspectFirst bookkeeping. This module is the single shared
// vocabulary so every product surface records the same thing, ending the
// split-brain where one path saw v1 and another saw v2 with no audit trail.
//
// It is pure: no IO, no clocks, no randomness. It performs NO retrieval, ranking,
// scoring, or candidate generation — it only normalizes the requested engine
// string and packages the resolved selection for output.

/**
 * What the caller asked for.
 * - `default`: no explicit engine (or an unrecognized value) — follow the surface
 *   default, which today is the v1 character-budgeted path.
 * - `v1` / `legacy`: explicitly pin the legacy v1 engine.
 * - `v2`: opt into the Capsule v2 compact inspect-first engine.
 */
export type RequestedCapsuleEngine = "default" | "v1" | "v2" | "legacy";

/**
 * Which engine actually produced the emitted context.
 * - `v2`: the Capsule v2 engine ran and produced the v2 section (this includes a
 *   legitimate `no_context` v2 result — v2 ran, it just found no pivot).
 * - `v1`: the legacy v1 path produced the context. This is the value on the
 *   default/v1/legacy paths and also when a v2 build failed and fell back to v1.
 * - `none`: no context engine produced usable context (reserved; the product
 *   paths always run at least v1, so this is a defensive/forward-compat value).
 */
export type EffectiveCapsuleEngine = "v1" | "v2" | "none";

/**
 * The resolved engine selection, emitted on the product surfaces so a consumer can
 * see what was asked for, what actually ran, and why (if the two differ).
 */
export interface CapsuleEngineSelection {
  /** The normalized engine the caller requested. */
  readonly requested: RequestedCapsuleEngine;
  /** The engine that actually produced the emitted context. */
  readonly effective: EffectiveCapsuleEngine;
  /**
   * Non-null only when the effective engine differs from a v2 request because of
   * a genuine v2 query/render failure (a v2 build threw and the surface fell back
   * to v1). Workspace/index-preparation failures are NOT represented here — those
   * fail the request before any engine runs and must never be masked as a fallback.
   * `no_context` is also NOT a fallback: a v2 capsule with no pivot is a real v2
   * result and keeps `effective=v2`, `fallbackReason=null`.
   */
  readonly fallbackReason: string | null;
  /**
   * True when the v2 compact inspect-first guidance was actually produced for this
   * response. Mirrors what the Stage 5 injected path consumes.
   */
  readonly compactInspectFirst: boolean;
}

// String discriminators, shared so the surfaces never hardcode the literals.
export const CAPSULE_ENGINE = Object.freeze({
  Default: "default",
  V1: "v1",
  V2: "v2",
  Legacy: "legacy",
} as const);

/**
 * Normalize a raw engine string (from MCP input, a CLI flag, or stored metadata)
 * into a {@link RequestedCapsuleEngine}. Case-insensitive and whitespace-tolerant.
 * Unrecognized or empty values normalize to `default` so old callers and stray
 * values keep the surface default rather than erroring.
 */
export function parseRequestedCapsuleEngine(
  raw: string | undefined | null,
): RequestedCapsuleEngine {
  if (raw === undefined || raw === null) {
    return "default";
  }
  switch (raw.trim().toLowerCase()) {
    case "v2":
      return "v2";
    case "v1":
      return "v1";
    case "legacy":
      return "legacy";
    case "default":
      return "default";
    default:
      return "default";
  }
}

/** True when the requested engine should run Capsule v2. */
export function requestWantsCapsuleV2(requested: RequestedCapsuleEngine): boolean {
  return requested === CAPSULE_ENGINE.V2;
}

/** The selection for a path that ran (or fell back to) the v1 engine. */
export function v1EngineSelection(
  requested: RequestedCapsuleEngine,
  fallbackReason: string | null = null,
): CapsuleEngineSelection {
  return {
    requested,
    effective: "v1",
    fallbackReason,
    compactInspectFirst: false,
  };
}

/** The selection for a path where Capsule v2 ran and produced the v2 section. */
export function v2EngineSelection(
  requested: RequestedCapsuleEngine,
  compactInspectFirst: boolean,
): CapsuleEngineSelection {
  return {
    requested,
    effective: "v2",
    fallbackReason: null,
    compactInspectFirst,
  };
}
