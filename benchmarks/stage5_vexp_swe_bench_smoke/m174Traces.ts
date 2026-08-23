/**
 * M174-B/C — the paired trace model: what each agent DID, and what it thereby KNEW.
 *
 * M173 measured the compact orientation's cost and found it neutral end to end:
 * the packet is 9.3x cheaper than M169's payload, the agent uses it, and the same
 * seven tasks resolve either way. What it could not measure is where the residual
 * premium goes, because its ledger counts actions and not their targets. Three
 * reads of the same file and three reads of three files are the same number.
 *
 * This module reconstructs the missing half. Every action carries WHAT it touched,
 * so a pair can be compared on information acquired rather than tool calls issued
 * — which is the only level at which "the work moved" and "the work vanished" look
 * different.
 *
 * THE ONE DISTINCTION THE WHOLE MILESTONE RESTS ON (§21). An agent that skips a
 * read before editing and performs it after has not saved the read. An agent that
 * never performs it has. Both look identical in a pre-edit request count, which is
 * exactly the statistic M173 had. So actions are placed against the first
 * MEANINGFUL edit and information units are matched across that boundary.
 *
 * WHY MEANINGFUL (§17). Five of this corpus's 46 edits write `/tmp` scratch
 * reproductions. Counting one as the first edit would date the implementation
 * phase from a debugging convenience and move the boundary by tens of requests —
 * astropy's treatment run writes `/tmp/test_cds_grammar.py` at request 39, having
 * edited the actual source at request 12.
 *
 * SOUND, NOT COMPLETE. An information unit is recorded only where the transcript
 * shows it. Nothing is inferred from reasoning text, and an unobservable action
 * yields no units rather than a guess. Undercounting both arms equally is a
 * limitation; inventing a unit for one arm is a fabricated finding.
 *
 * PURE. No I/O, no clock, no randomness. The runner supplies the transcripts.
 */

// ── identity ────────────────────────────────────────────────────────

/** The external harness's per-repo workspace prefix, stripped to repo-relative. */
const WORKSPACE_PREFIX = /^.*?\.bench-repos\/[^/]+\//;

/**
 * Normalize a path to repo-relative, or mark it as outside the repository.
 * Scratch paths keep their absolute form: conflating `/tmp/test_x.py` with a
 * repo file is exactly the error the meaningful-edit rule exists to prevent.
 */
export function normalizePath(raw: string | null): { readonly path: string; readonly inRepo: boolean } {
  if (raw === null || raw.trim() === "") return { path: "", inRepo: false };
  const value = raw.trim().replace(/\\/g, "/");
  if (WORKSPACE_PREFIX.test(value)) return { path: value.replace(WORKSPACE_PREFIX, ""), inRepo: true };
  if (value.startsWith("/")) return { path: value, inRepo: false };
  return { path: value.replace(/^\.\//, ""), inRepo: true };
}

// ── the frozen meaningful-edit rule (§17) ───────────────────────────

export const EditClass = Object.freeze({
  /** A write to a source file inside the repository under test. */
  Meaningful: "MEANINGFUL",
  /** A write outside the repository — a reproduction script, a note, a probe. */
  Scratch: "SCRATCH",
});
export type EditClass = (typeof EditClass)[keyof typeof EditClass];

/**
 * Classify a write. Applied IDENTICALLY to both arms (§17).
 *
 * KNOWN POSITIVE  astropy B r12  astropy/units/format/cds.py            MEANINGFUL
 * KNOWN NEGATIVE  astropy B r39  /tmp/test_cds_grammar.py               SCRATCH
 * KNOWN NEGATIVE  pylint  A r80  /tmp/test_type_hints.py                SCRATCH
 *
 * The rule is location, not intent: an edit to a test file that lives in the
 * repository is a real edit to the repository, and a reproduction written to
 * `/tmp` is not, whatever either is named.
 */
export function classifyEdit(filePath: string | null): EditClass {
  const { inRepo } = normalizePath(filePath);
  return inRepo ? EditClass.Meaningful : EditClass.Scratch;
}

// ── phases (§16) ────────────────────────────────────────────────────

export const TracePhase = Object.freeze({
  /** The automatic orientation call and anything before the first ordinary action. */
  Orientation: "PHASE_0_ORIENTATION",
  /** Everything before the first meaningful edit. */
  PreEdit: "PHASE_1_PRE_EDIT",
  /** First through last meaningful edit, inclusive. */
  Implementation: "PHASE_2_IMPLEMENTATION",
  /** After the last meaningful edit. */
  Verification: "PHASE_3_VERIFICATION",
});
export type TracePhase = (typeof TracePhase)[keyof typeof TracePhase];

export interface TraceLandmarks {
  readonly orientationRequest: number | null;
  readonly firstMeaningfulEditRequest: number | null;
  readonly lastMeaningfulEditRequest: number | null;
  readonly firstTestRequest: number | null;
}

/**
 * Phase of a request. Frozen before any interpretation (§16).
 *
 * A run that never makes a meaningful edit is PRE_EDIT throughout: calling its
 * later requests "implementation" would assert an implementation that never
 * happened. Five of this corpus's runs end without resolving and some of them
 * never edit at all.
 */
export function phaseOf(requestIndex: number, landmarks: TraceLandmarks, isOrientationCall: boolean): TracePhase {
  if (isOrientationCall) return TracePhase.Orientation;
  const first = landmarks.firstMeaningfulEditRequest;
  const last = landmarks.lastMeaningfulEditRequest;
  if (first === null) return TracePhase.PreEdit;
  if (requestIndex < first) return TracePhase.PreEdit;
  if (last !== null && requestIndex <= last) return TracePhase.Implementation;
  return TracePhase.Verification;
}

// ── information units (§23) ─────────────────────────────────────────

export const UnitKind = Object.freeze({
  FileSeen: "FILE_SEEN",
  SymbolSeen: "SYMBOL_SEEN",
  RangeRead: "RANGE_READ",
  RelationSeen: "RELATION_SEEN",
  TestSeen: "TEST_SEEN",
});
export type UnitKind = (typeof UnitKind)[keyof typeof UnitKind];

/**
 * The line granularity at which two reads count as the same information (§24).
 *
 * Reading lines 1-50 is not reading lines 400-500, so a range cannot collapse to
 * its file. But an agent re-reading "around line 210" after an edit shifted it to
 * 214 is re-acquiring the same knowledge, so ranges cannot be compared exactly
 * either. Fifty lines is roughly a function: coarse enough that a shifted re-read
 * matches, fine enough that opposite ends of a 5,000-line module do not.
 */
export const RANGE_BUCKET_LINES = 50;

export interface InfoUnit {
  readonly kind: UnitKind;
  /** Canonical string identity. Two units are the same information iff equal. */
  readonly key: string;
  readonly path: string;
  /** Request index at which this was acquired. */
  readonly requestIndex: number;
  readonly phase: TracePhase;
  /** How it was acquired: a tool name, or ORIENTATION for the packet itself. */
  readonly via: string;
}

export const rangeBuckets = (start: number, end: number): readonly number[] => {
  const lo = Math.max(1, Math.floor(start));
  const hi = Math.max(lo, Math.floor(end));
  const first = Math.floor((lo - 1) / RANGE_BUCKET_LINES);
  const last = Math.floor((hi - 1) / RANGE_BUCKET_LINES);
  const out: number[] = [];
  // A single read of a 5,000-line file must not manufacture 100 units of
  // "knowledge"; a whole-file read is bounded to its head, which is what the
  // agent realistically absorbed and what the orientation would have shown.
  for (let b = first; b <= Math.min(last, first + 39); b += 1) out.push(b);
  return out;
};

export const unitKey = (kind: UnitKind, path: string, detail: string): string =>
  `${kind}:${path}${detail === "" ? "" : `@${detail}`}`;

// ── unit strength ───────────────────────────────────────────────────

/**
 * Not all knowledge is equal, and the displacement measure depends on saying so.
 *
 * A search that returns forty paths teaches the agent that forty files match a
 * pattern. That is real information and it is recorded — but it is not the same
 * as having read one of them, and a displacement statistic that treats it as
 * equivalent would let one wide grep "acquire" a subsystem. So units carry a
 * strength, and the headline displacement measure is computed over STRONG units:
 * content actually seen, symbols actually named, relations actually stated.
 */
export const UnitStrength = Object.freeze({
  /** Content was seen: a range read, a named symbol, a stated relation. */
  Strong: "STRONG",
  /** Existence or relevance was learned, without content: a search hit. */
  Weak: "WEAK",
});
export type UnitStrength = (typeof UnitStrength)[keyof typeof UnitStrength];

export const strengthOf = (kind: UnitKind): UnitStrength =>
  kind === UnitKind.FileSeen ? UnitStrength.Weak : UnitStrength.Strong;

/**
 * Cap on files credited to a single search (§24 in spirit).
 *
 * A grep printing every match in a large repository does not confer knowledge of
 * every file it printed. The cap is generous enough to keep ordinary searches
 * whole and is applied identically to both arms; the number of times it binds is
 * reported rather than hidden, per the no-silent-caps rule.
 */
export const SEARCH_FILE_CREDIT_CAP = 25;

// ── extracting units from a tool call ───────────────────────────────

const SOURCE_PATH = /(?:^|[\s"'`(\[])((?:[\w.\-]+\/)*[\w.\-]+\.(?:py|pyx|pyi|txt|cfg|toml|ini|rst|md|json|yaml|yml))/g;

/**
 * Paths named anywhere in a tool result. Used for search and shell output, where
 * what the agent learned is which files matched.
 */
export function pathsInText(text: string, cap: number): { readonly paths: readonly string[]; readonly capped: boolean } {
  const found = new Set<string>();
  let capped = false;
  for (const match of text.matchAll(SOURCE_PATH)) {
    const { path, inRepo } = normalizePath(match[1] ?? null);
    if (!inRepo || path === "") continue;
    if (found.size >= cap) { capped = true; break; }
    found.add(path);
  }
  return { paths: [...found], capped };
}

/** Line ranges an agent asked for, from a Read's offset/limit. */
export function readRange(offset: unknown, limit: unknown): { readonly start: number; readonly end: number } {
  const start = typeof offset === "number" && offset > 0 ? offset : 1;
  // A Read with no limit returns the tool's own default window, not the file.
  const span = typeof limit === "number" && limit > 0 ? limit : 2000;
  return { start, end: start + span - 1 };
}

/** `path::Symbol` -> its parts, tolerating a bare path. */
export function splitFqName(fqName: string): { readonly path: string; readonly symbol: string } {
  const at = fqName.indexOf("::");
  if (at < 0) return { path: normalizePath(fqName).path, symbol: "" };
  return { path: normalizePath(fqName.slice(0, at)).path, symbol: fqName.slice(at + 2) };
}

/** `"184-408"` -> numeric bounds, or null when the record has none. */
export function parseLineSpan(lines: unknown): { readonly start: number; readonly end: number } | null {
  if (typeof lines !== "string") return null;
  const match = /^(\d+)\s*-\s*(\d+)$/.exec(lines.trim());
  if (match === null) return null;
  return { start: Number(match[1]), end: Number(match[2]) };
}

// ── the orientation packet as an information state (§28) ────────────

export interface OrientationInformation {
  readonly delivered: boolean;
  readonly focusFile: string | null;
  readonly focusAt: string | null;
  readonly relatedFiles: readonly string[];
  readonly relatedAts: readonly string[];
  readonly units: readonly InfoUnit[];
}

/**
 * Canonicalize the compact packet into the information units it CONFERS.
 *
 * This is what makes the comparison honest (§28). The treatment agent did not
 * arrive knowing nothing: it was handed a focus symbol with a line span and a
 * bounded excerpt, and a list of related symbols each carrying a stated
 * relationship. Scoring its later reads against a baseline that "acquired" the
 * same facts by reading would count the packet's own contribution as zero and
 * manufacture displacement out of nothing.
 *
 * The excerpt is a skeleton, not a file (M173 §33), so the focus confers its
 * declared span — what the packet showed of it — and never the whole file.
 */
export function orientationInformation(
  packet: unknown,
  requestIndex: number,
): OrientationInformation {
  const empty: OrientationInformation = {
    delivered: false, focusFile: null, focusAt: null,
    relatedFiles: [], relatedAts: [], units: [],
  };
  if (typeof packet !== "object" || packet === null) return empty;
  const record = packet as Record<string, unknown>;
  const focus = typeof record.focus === "object" && record.focus !== null
    ? record.focus as Record<string, unknown> : null;
  if (focus === null) return empty;

  const units: InfoUnit[] = [];
  const add = (kind: UnitKind, path: string, detail: string): void => {
    if (path === "") return;
    units.push({
      kind, key: unitKey(kind, path, detail), path,
      requestIndex, phase: TracePhase.Orientation, via: "ORIENTATION",
    });
  };

  const focusFile = normalizePath(typeof focus.file === "string" ? focus.file : null).path;
  const focusAt = typeof focus.at === "string" ? focus.at : "";
  add(UnitKind.FileSeen, focusFile, "");
  if (focusAt !== "") {
    const { path, symbol } = splitFqName(focusAt);
    add(UnitKind.SymbolSeen, path, symbol);
  }
  const focusSpan = parseLineSpan(focus.lines);
  if (focusSpan !== null) {
    for (const bucket of rangeBuckets(focusSpan.start, focusSpan.end)) {
      add(UnitKind.RangeRead, focusFile, String(bucket));
    }
  }

  const relatedFiles: string[] = [];
  const relatedAts: string[] = [];
  const related = Array.isArray(record.related) ? record.related : [];
  for (const entry of related) {
    if (typeof entry !== "object" || entry === null) continue;
    const item = entry as Record<string, unknown>;
    const file = normalizePath(typeof item.file === "string" ? item.file : null).path;
    const at = typeof item.at === "string" ? item.at : "";
    const how = typeof item.how === "string" ? item.how : "";
    if (file !== "") { relatedFiles.push(file); add(UnitKind.FileSeen, file, ""); }
    if (at !== "") {
      relatedAts.push(at);
      const { path, symbol } = splitFqName(at);
      add(UnitKind.SymbolSeen, path, symbol);
      // The relationship is the packet's distinctive contribution: a caller edge
      // is something no single read confers.
      if (how !== "" && focusAt !== "") add(UnitKind.RelationSeen, path, `${how}<-${focusAt}`);
    }
    const span = parseLineSpan(item.lines);
    if (span !== null && file !== "") {
      for (const bucket of rangeBuckets(span.start, span.end)) add(UnitKind.RangeRead, file, String(bucket));
    }
  }

  return {
    delivered: true,
    focusFile: focusFile === "" ? null : focusFile,
    focusAt: focusAt === "" ? null : focusAt,
    relatedFiles, relatedAts, units,
  };
}

// ── first-edit survival (§36) ───────────────────────────────────────

export const EditSurvival = Object.freeze({
  /** The first edit's content is present in the final patch, essentially intact. */
  FinalOrNearFinal: "FINAL_OR_NEAR_FINAL",
  /** Some of it survived; it was built on rather than replaced. */
  PartiallyCorrect: "PARTIALLY_CORRECT",
  /** The file is still in the patch but the content was replaced. */
  Superseded: "SUPERSEDED",
  /** The file the first edit touched is not in the final patch at all. */
  WrongDirection: "WRONG_DIRECTION",
  /** No meaningful edit, or no patch to compare against. */
  NotObservable: "NOT_OBSERVABLE",
});
export type EditSurvival = (typeof EditSurvival)[keyof typeof EditSurvival];

/** Lines a unified diff ADDS, normalized for comparison. */
export function patchAddedLines(patch: string): ReadonlySet<string> {
  const out = new Set<string>();
  for (const line of patch.split("\n")) {
    if (!line.startsWith("+") || line.startsWith("+++")) continue;
    const normalized = line.slice(1).trim();
    // Trivial lines match everywhere and would inflate every overlap.
    if (normalized.length < 8) continue;
    out.add(normalized);
  }
  return out;
}

export function patchFiles(patch: string): readonly string[] {
  const out = new Set<string>();
  for (const line of patch.split("\n")) {
    if (line.startsWith("--- a/")) out.add(line.slice(6).trim());
    if (line.startsWith("+++ b/")) out.add(line.slice(6).trim());
  }
  return [...out].filter((p) => p !== "" && p !== "dev/null");
}

/**
 * Did the first meaningful edit survive to the final patch?
 *
 * This is the premature-edit test's outcome half (§37). An agent that edits early
 * and ships that edit unchanged was oriented well. An agent that edits early and
 * then replaces what it wrote paid for the edit twice, and the early edit bought
 * nothing but the rework.
 */
export function firstEditSurvival(
  editedPath: string | null,
  addedContent: string | null,
  finalPatch: string,
): { readonly survival: EditSurvival; readonly overlap: number } {
  if (editedPath === null || addedContent === null || finalPatch.trim() === "") {
    return { survival: EditSurvival.NotObservable, overlap: 0 };
  }
  const files = patchFiles(finalPatch);
  const inPatch = files.some((f) => f === editedPath || f.endsWith(`/${editedPath}`) || editedPath.endsWith(`/${f}`));
  const added = patchAddedLines(finalPatch);
  const candidate = addedContent.split("\n").map((l) => l.trim()).filter((l) => l.length >= 8);
  if (candidate.length === 0) return { survival: EditSurvival.NotObservable, overlap: 0 };
  const kept = candidate.filter((l) => added.has(l)).length;
  const overlap = kept / candidate.length;
  if (!inPatch) return { survival: EditSurvival.WrongDirection, overlap };
  if (overlap >= 0.8) return { survival: EditSurvival.FinalOrNearFinal, overlap };
  if (overlap >= 0.2) return { survival: EditSurvival.PartiallyCorrect, overlap };
  return { survival: EditSurvival.Superseded, overlap };
}

// ── pairwise information comparison (§25-27) ────────────────────────

export interface PairInformation {
  /** A knew it before A's first edit; B did not know it before B's first edit; B learned it after. */
  readonly displaced: readonly string[];
  /** A acquired it; B never did. */
  readonly eliminated: readonly string[];
  /** B acquired it; A never did. */
  readonly treatmentOnly: readonly string[];
  /** Both acquired it before their own first edit. */
  readonly sharedPreEdit: readonly string[];
}

/**
 * Compare two runs on information rather than actions.
 *
 * The asymmetry is deliberate and is the whole measurement (§21). DISPLACED is
 * not "B did it later than A" — it is "B did it on the other side of its OWN
 * edit boundary", which is what distinguishes work that moved from work that
 * merely happened in a different order before the edit.
 */
export function comparePairInformation(
  baselinePreEdit: ReadonlySet<string>,
  baselineAll: ReadonlySet<string>,
  treatmentPreEdit: ReadonlySet<string>,
  treatmentPostEdit: ReadonlySet<string>,
  treatmentAll: ReadonlySet<string>,
): PairInformation {
  const displaced: string[] = [];
  const eliminated: string[] = [];
  const sharedPreEdit: string[] = [];
  for (const key of baselinePreEdit) {
    if (treatmentPreEdit.has(key)) { sharedPreEdit.push(key); continue; }
    if (treatmentPostEdit.has(key)) { displaced.push(key); continue; }
  }
  for (const key of baselineAll) if (!treatmentAll.has(key)) eliminated.push(key);
  const treatmentOnly = [...treatmentAll].filter((key) => !baselineAll.has(key));
  return {
    displaced: displaced.sort(),
    eliminated: eliminated.sort(),
    treatmentOnly: treatmentOnly.sort(),
    sharedPreEdit: sharedPreEdit.sort(),
  };
}

// ── mechanism classification (§30) ──────────────────────────────────

export const Mechanism = Object.freeze({
  WorkElimination: "WORK_ELIMINATION",
  WorkDisplacement: "WORK_DISPLACEMENT",
  ImplementationDivergence: "IMPLEMENTATION_STRATEGY_DIVERGENCE",
  OrientationInducedDownstream: "ORIENTATION_INDUCED_DOWNSTREAM_WORK",
  StochasticOrUnattributable: "STOCHASTIC_OR_UNATTRIBUTABLE",
  Mixed: "MIXED",
  NotMeasurable: "NOT_MEASURABLE",
});
export type Mechanism = (typeof Mechanism)[keyof typeof Mechanism];
