// What each session-backed feature does when its write fails.
//
// THE GOVERNING RULE
// ------------------
// Fail CLOSED when successful persistence is what makes something returned to
// the caller truthful or resolvable. Fail OPEN when persistence is auxiliary and
// the core response stays truthful without it — while saying that the auxiliary
// feature was unavailable rather than pretending it succeeded.
//
// The distinction is response-level success versus feature-level success:
//
//   get_code_context retrieval succeeds + manifest persistence fails
//     => a valid context response, with NO capsuleManifestId
//     NOT => the whole request fails
//
//   deferred content cannot be delivered inline + ref persistence fails
//     => degrade truthfully by existing semantics
//     NOT => emit `vexp:…` that nothing can later resolve
//
// WHY A DECLARATION RATHER THAN A BOOLEAN
// ---------------------------------------
// M151 found that the deferred-ref case was load-bearing precisely because
// nobody had written the rule down: the correct behaviour lived in the shape of
// one `try`/`catch` and could have been "simplified" away without a single test
// failing. A future session-backed feature must now DECLARE its failure
// semantics here rather than inherit whichever handler happens to surround it.
//
// This module holds no `try`/`catch` of its own. It states the contract; the
// call sites implement it, and `persistenceFailurePolicy.test.ts` injects real
// write failures against each one.

/** What a feature does when a session write fails. */
export const PersistenceFailureMode = Object.freeze({
  /**
   * The externally visible artifact IS the persisted row. Persist first; if that
   * fails, emit nothing. Never a reference that cannot be resolved (§39, §73).
   */
  RequirePersistence: "require_persistence",
  /**
   * The response is valid without the identifier. Return the response, omit the
   * identifier, and do not claim the artifact was stored (§40, §169).
   */
  OmitIdentifierOnFailure: "omit_identifier_on_failure",
  /**
   * Auxiliary. Swallow at the feature boundary, report the feature as
   * unavailable, and never fail the repository retrieval underneath (§41).
   */
  BestEffort: "best_effort",
});

export type PersistenceFailureMode =
  (typeof PersistenceFailureMode)[keyof typeof PersistenceFailureMode];

/** The session-backed features, named as the codebase names them. */
export const SessionBackedFeature = Object.freeze({
  DeferredRef: "deferredRef",
  CapsuleManifest: "capsuleManifest",
  Observation: "observation",
  ProjectRules: "projectRules",
});

export type SessionBackedFeature =
  (typeof SessionBackedFeature)[keyof typeof SessionBackedFeature];

/**
 * The policy. Every session-backed feature appears exactly once;
 * `persistenceFailurePolicy.test.ts` fails if one is missing, so adding a
 * feature without deciding its failure semantics is not possible.
 */
export const SESSION_PERSISTENCE_FAILURE_POLICY: Readonly<
  Record<SessionBackedFeature, PersistenceFailureMode>
> = Object.freeze({
  // A deferred ref IS its persisted row. Emitting the hash before the row is
  // durable produces a reference `expand_vexp_ref` can never answer.
  [SessionBackedFeature.DeferredRef]: PersistenceFailureMode.RequirePersistence,
  // `capsuleManifestId` names a manifest `check_capsule_staleness` must be able
  // to load. The capsule itself is valid without one.
  [SessionBackedFeature.CapsuleManifest]: PersistenceFailureMode.OmitIdentifierOnFailure,
  // Memory auto-capture: the context returned is exactly as true whether or not
  // the lookup was recorded.
  [SessionBackedFeature.Observation]: PersistenceFailureMode.BestEffort,
  // Rules are bounded guidance layered onto a response that stands without them.
  [SessionBackedFeature.ProjectRules]: PersistenceFailureMode.BestEffort,
});

export function resolvePersistenceFailureMode(
  feature: SessionBackedFeature,
): PersistenceFailureMode {
  return SESSION_PERSISTENCE_FAILURE_POLICY[feature];
}

/**
 * Run a `RequirePersistence` write. Rethrows, because the caller must not emit
 * the artifact when this fails — swallowing here is the exact bug §39 names.
 */
export function persistOrRefuse<T>(persist: () => T): T {
  return persist();
}

/**
 * Run a write whose failure costs an identifier but not the response. Returns
 * null when persistence failed, which callers surface as an absent id rather
 * than a fabricated one.
 */
export function persistOrOmitIdentifier<T>(persist: () => T): T | null {
  try {
    return persist();
  } catch {
    return null;
  }
}

/** Run an auxiliary write. Never throws; the caller's response is unaffected. */
export function persistBestEffort<T>(persist: () => T): T | undefined {
  try {
    return persist();
  } catch {
    return undefined;
  }
}
