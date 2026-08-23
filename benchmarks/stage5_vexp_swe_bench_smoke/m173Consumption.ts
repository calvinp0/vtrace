/**
 * M173-D — how the agent consumed the orientation, and whether re-searching it
 * was waste.
 *
 * WRITTEN BEFORE ANY M173 LIVE RUN EXISTED. That ordering is the only thing
 * that makes these rules evidence rather than description: a classifier written
 * after the transcripts is a summary of them.
 *
 * §33 is the rule that shapes the whole module: not all verification is waste.
 * The compact packet carries a skeleton and a one-line reason, not a file. An
 * agent that opens the file the packet pointed at is doing the work the packet
 * exists to direct, and scoring that as redundancy would manufacture a saving
 * the product never offered. So three categories, and the boundary between the
 * first two is whether the action's target was NAMED by the orientation:
 *
 *   TARGETED_CONFIRMATION    the target was named by the orientation. The
 *                            packet pointed here; reading it is consumption.
 *   REDUNDANT_REDISCOVERY    a SEARCH whose query would have surfaced a file
 *                            the orientation already named. The agent paid to
 *                            find what it had been handed.
 *   NEW_INFORMATION_SEARCH   the target was not named. This is the work the
 *                            orientation did not do, and it is not a cost of
 *                            the orientation.
 *
 * PURE. No I/O, no clock, no randomness.
 */

export const OrientationUse = Object.freeze({
  DirectlyUsed: "DIRECTLY_USED",
  PartiallyUsed: "PARTIALLY_USED",
  Ignored: "IGNORED",
  Misleading: "MISLEADING",
  Unobservable: "UNOBSERVABLE",
});
export type OrientationUse = (typeof OrientationUse)[keyof typeof OrientationUse];

export const Rediscovery = Object.freeze({
  TargetedConfirmation: "TARGETED_CONFIRMATION",
  RedundantRediscovery: "REDUNDANT_REDISCOVERY",
  NewInformationSearch: "NEW_INFORMATION_SEARCH",
  Unobservable: "UNOBSERVABLE",
});
export type Rediscovery = (typeof Rediscovery)[keyof typeof Rediscovery];

export interface OrientationPacket {
  /** The projected focus file, or null when nothing was delivered. */
  readonly focusFile: string | null;
  /** `<file>::<symbol>` for the focus, when present. */
  readonly focusAt: string | null;
  readonly relatedFiles: readonly string[];
}

export interface ObservedAction {
  /** Request index, so ordering against the first edit is exact. */
  readonly requestIndex: number;
  readonly kind: string;
  /** File path or search pattern, whichever the tool carried. */
  readonly target: string | null;
}

/** Path comparison that tolerates the repo-relative / absolute split. */
export function samePath(a: string | null, b: string | null): boolean {
  if (a === null || b === null) return false;
  const norm = (p: string): string => p.replace(/\\/g, "/").replace(/^\.\//, "");
  const x = norm(a);
  const y = norm(b);
  return x === y || x.endsWith(`/${y}`) || y.endsWith(`/${x}`);
}

function namedBy(packet: OrientationPacket, target: string | null): boolean {
  if (target === null) return false;
  if (samePath(packet.focusFile, target)) return true;
  return packet.relatedFiles.some((f) => samePath(f, target));
}

/**
 * The needles a query must hit to count as rediscovering delivered evidence:
 * each delivered file's basename and its extensionless stem, plus the focus
 * symbol whole and each of its dotted components.
 *
 * The stem matters because agents search for `category`, not `category.py`, and
 * the components matter because `StrCategoryConverter.convert` is searched for
 * by either half. The length floor is what keeps the test narrow — a five
 * character minimum excludes `py`, `def`, `test` and the other tokens that
 * would match everything.
 */
const NEEDLE_MINIMUM_LENGTH = 5;

export function rediscoveryNeedles(packet: OrientationPacket): readonly string[] {
  const needles: string[] = [];
  for (const file of [packet.focusFile, ...packet.relatedFiles]) {
    if (file === null) continue;
    const basename = file.split("/").pop()!;
    needles.push(basename);
    const stem = basename.replace(/\.[^.]+$/, "");
    if (stem !== basename) needles.push(stem);
  }
  if (packet.focusAt !== null) {
    const symbol = packet.focusAt.split("::").pop() ?? "";
    if (symbol !== "") {
      needles.push(symbol);
      for (const part of symbol.split(".")) needles.push(part);
    }
  }
  return Object.freeze([...new Set(
    needles.map((n) => n.toLowerCase()).filter((n) => n.length >= NEEDLE_MINIMUM_LENGTH),
  )]);
}

/**
 * Does a search query name something the orientation already delivered?
 *
 * Deliberately narrow. A broad query that happens to also match a delivered
 * file is NOT redundancy — the agent could not have known that, and M168's
 * permanent lesson is that a blocked or skipped search is not a saved one.
 * Under-counting redundancy is the safe direction, because redundancy is the
 * thing that would make the orientation look good.
 */
export function searchRediscoversDeliveredEvidence(
  packet: OrientationPacket,
  query: string | null,
): boolean {
  if (query === null || query.trim() === "") return false;
  const haystack = query.toLowerCase();
  return rediscoveryNeedles(packet).some((needle) => haystack.includes(needle));
}

export interface RediscoveryTally {
  readonly targetedConfirmation: number;
  readonly redundantRediscovery: number;
  readonly newInformationSearch: number;
  readonly classified: readonly { requestIndex: number; kind: string; target: string | null; verdict: Rediscovery }[];
}

/**
 * Classify every investigation action taken AFTER the orientation arrived.
 *
 * Actions before it are not rediscovery of anything and are excluded rather
 * than scored — in the treatment arm there should be none, and if there are
 * that is a compliance finding, not a consumption one.
 */
export function classifyRediscovery(
  packet: OrientationPacket,
  actions: readonly ObservedAction[],
  orientationRequestIndex: number,
  investigationKinds: readonly string[],
): RediscoveryTally {
  const classified: { requestIndex: number; kind: string; target: string | null; verdict: Rediscovery }[] = [];
  for (const action of actions) {
    if (action.requestIndex <= orientationRequestIndex) continue;
    if (!investigationKinds.includes(action.kind)) continue;
    const verdict: Rediscovery = namedBy(packet, action.target)
      ? Rediscovery.TargetedConfirmation
      : action.kind === "SEARCH" && searchRediscoversDeliveredEvidence(packet, action.target)
        ? Rediscovery.RedundantRediscovery
        : Rediscovery.NewInformationSearch;
    classified.push({ requestIndex: action.requestIndex, kind: action.kind, target: action.target, verdict });
  }
  return {
    targetedConfirmation: classified.filter((c) => c.verdict === Rediscovery.TargetedConfirmation).length,
    redundantRediscovery: classified.filter((c) => c.verdict === Rediscovery.RedundantRediscovery).length,
    newInformationSearch: classified.filter((c) => c.verdict === Rediscovery.NewInformationSearch).length,
    classified: Object.freeze(classified),
  };
}

export interface UseEvidence {
  readonly packet: OrientationPacket;
  readonly editedFiles: readonly string[];
  readonly inspectedFiles: readonly string[];
  /** Gold patch files, used only to separate MISLEADING from IGNORED. */
  readonly goldFiles: readonly string[];
  readonly resolved: boolean | null;
}

export interface UseVerdict {
  readonly use: OrientationUse;
  readonly editedFocus: boolean;
  readonly editedRelated: boolean;
  readonly inspectedFocus: boolean;
  readonly focusIsGold: boolean | null;
  readonly reason: string;
}

/**
 * §34 — classify from downstream behaviour, never from file overlap alone.
 *
 * The distinction the rules protect is the one §34 names explicitly: an edit to
 * a file the orientation happened to mention is not evidence of use if the
 * agent would have edited it anyway. This cannot be settled from one arm, so
 * the classifier does not pretend to: it reports what the agent DID with the
 * delivered evidence, and the counterfactual is left to the paired baseline,
 * where the same file being edited without any orientation is exactly the
 * observation that discounts the claim.
 *
 * MISLEADING is deliberately hard to earn. It requires the agent to have acted
 * on a focus that is NOT gold, and the run to have failed. A wrong pivot that
 * the agent ignored, or recovered from, is not misleading — it is a wrong
 * pivot with no measurable consequence, and §36 forbids reading one as the
 * other.
 */
export function classifyOrientationUse(evidence: UseEvidence): UseVerdict {
  const { packet, editedFiles, inspectedFiles, goldFiles, resolved } = evidence;

  if (packet.focusFile === null) {
    return {
      use: OrientationUse.Unobservable,
      editedFocus: false, editedRelated: false, inspectedFocus: false, focusIsGold: null,
      reason: "no orientation focus was delivered",
    };
  }

  const editedFocus = editedFiles.some((f) => samePath(f, packet.focusFile));
  const editedRelated = editedFiles.some((f) => packet.relatedFiles.some((r) => samePath(r, f)));
  const inspectedFocus = inspectedFiles.some((f) => samePath(f, packet.focusFile));
  const focusIsGold = goldFiles.length === 0
    ? null
    : goldFiles.some((g) => samePath(g, packet.focusFile));

  if (editedFiles.length === 0) {
    return {
      use: OrientationUse.Unobservable,
      editedFocus, editedRelated, inspectedFocus, focusIsGold,
      reason: "the run made no edit, so consumption has no downstream evidence",
    };
  }

  if (editedFocus) {
    return {
      use: OrientationUse.DirectlyUsed,
      editedFocus, editedRelated, inspectedFocus, focusIsGold,
      reason: "the agent edited the file the orientation focused on",
    };
  }

  if (editedRelated || inspectedFocus) {
    return {
      use: OrientationUse.PartiallyUsed,
      editedFocus, editedRelated, inspectedFocus, focusIsGold,
      reason: editedRelated
        ? "the agent edited a related file the orientation delivered, but not the focus"
        : "the agent inspected the focus and then edited elsewhere",
    };
  }

  if (focusIsGold === false && resolved === false) {
    return {
      use: OrientationUse.Misleading,
      editedFocus, editedRelated, inspectedFocus, focusIsGold,
      reason: "the focus was not a gold file, nothing delivered was touched, and the run failed",
    };
  }

  return {
    use: OrientationUse.Ignored,
    editedFocus, editedRelated, inspectedFocus, focusIsGold,
    reason: "no delivered file was edited or inspected",
  };
}

// ── pivot causality (§35, §36, §88) ─────────────────────────────────

export const PivotConsequence = Object.freeze({
  CausedExtraInvestigation: "CAUSED_EXTRA_INVESTIGATION",
  CausedWrongEdit: "CAUSED_WRONG_EDIT",
  IgnoredOrRecovered: "IGNORED_OR_RECOVERED",
  NoMeasurableEffect: "NO_MEASURABLE_EFFECT",
  NotApplicable: "PIVOT_WAS_CORRECT",
  Unobservable: "UNOBSERVABLE",
});
export type PivotConsequence = (typeof PivotConsequence)[keyof typeof PivotConsequence];

export interface PivotEvidence {
  readonly focusIsGold: boolean | null;
  readonly use: OrientationUse;
  readonly resolved: boolean | null;
  /** Pre-edit investigation actions, treatment minus baseline. */
  readonly preEditInvestigationDelta: number | null;
  readonly editedFocus: boolean;
  readonly editedAnyGold: boolean;
}

/**
 * §36 — a wrong pivot is not a licence on its own. This returns
 * `NO_MEASURABLE_EFFECT` unless a downstream consequence is actually observed,
 * and `PIVOT_CORRECTNESS_WORK_LICENSED` upstream requires at least one
 * CAUSED_* verdict. That threshold exists because the cheap move at the end of
 * a neutral milestone is to point at a wrong pivot and call it the bottleneck.
 */
export function classifyPivotConsequence(evidence: PivotEvidence): PivotConsequence {
  const { focusIsGold, use, resolved, preEditInvestigationDelta, editedFocus, editedAnyGold } = evidence;
  if (focusIsGold === null) return PivotConsequence.Unobservable;
  if (focusIsGold) return PivotConsequence.NotApplicable;

  // Wrong pivot, and the agent edited it instead of a gold file, and failed.
  if (editedFocus && !editedAnyGold && resolved === false) return PivotConsequence.CausedWrongEdit;

  // Wrong pivot, and the treatment arm investigated MORE before its first edit
  // than the baseline did. The threshold is a whole extra action, not a
  // fraction: a delta of one is the smallest observation that is not noise.
  if (preEditInvestigationDelta !== null && preEditInvestigationDelta >= 1) {
    return PivotConsequence.CausedExtraInvestigation;
  }

  if (use === OrientationUse.Ignored || editedAnyGold) return PivotConsequence.IgnoredOrRecovered;

  return PivotConsequence.NoMeasurableEffect;
}
