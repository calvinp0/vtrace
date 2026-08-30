/**
 * M189 evidence core — post-edit decision points, corpus adequacy, and candidate
 * obligation derivation for the I5 / I6 hypotheses.
 *
 * PURE. No fs, no subprocess, no clock, no randomness.
 *
 * WHAT THIS MODULE IS FOR. M189 asks whether the preserved corpus can witness a
 * mechanism of the shape
 *
 *     current agent diff + repository authority + observed validation state
 *         -> post-edit decision support
 *
 * and the single largest threat to that question is hindsight. M185 solved the same
 * problem by giving `classifyStage` an evidence record with no `resolved` field, so a
 * stage label could not be derived from knowing the run failed. This module applies the
 * same construction one level harder, because M189 has to derive a *candidate obligation*
 * — a thing the agent supposedly should have been told — and the temptation to derive it
 * from the gold patch is overwhelming.
 *
 * THE CONSTRUCTION (§11, §12). `DecisionPointEvidence` is the entire input surface of
 * `deriveCandidateObligations`. It has:
 *
 *   no gold patch, no reference edit set, no reference test set
 *   no `resolved` flag and no grader verdict
 *   no tool call with an ordinal at or after the decision point
 *
 * The third is the one people forget. A derivation that may read the agent's later
 * actions can smuggle the answer in through "the agent went there next, so it was
 * relevant". `sliceAtDecisionPoint` is the only constructor, it truncates the trace, and
 * the truncation is what makes the future unavailable rather than merely off-limits.
 *
 * Gold and outcome re-enter in `scoreCandidate`, which is a SEPARATE function taking a
 * SEPARATE record, applied to candidates that were already frozen.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Trace primitives
// ─────────────────────────────────────────────────────────────────────────────

/** How a tool call acts on the repository, as the preserved telemetry categorises it. */
export type CallCategory = "read" | "search" | "edit" | "other";

/**
 * One preserved tool call. `args` comes from `_tool_calls.json` and `output` from
 * `_tool_calls_with_outputs.json`; they are joined on `index`, which is the trace's
 * ordering and the only clock M189 has.
 */
export interface TraceCall {
  readonly index: number;
  readonly tool: string;
  readonly category: CallCategory;
  /** Absolute or repo-relative path the call names, when it names one. */
  readonly path: string | null;
  readonly command: string | null;
  readonly output: string | null;
  readonly args: Readonly<Record<string, unknown>>;
}

/** A single mutation of the working tree, in trace order. */
export interface EditOp {
  readonly callIndex: number;
  readonly tool: string;
  readonly file: string;
  readonly kind: "replace" | "write" | "unknown";
  readonly oldString: string | null;
  readonly newString: string | null;
  readonly replaceAll: boolean;
}

/** Why an edit could not be turned into a replayable mutation. */
export type EditDefect = "NO_FILE_PATH" | "NO_PAYLOAD" | "UNRECOGNISED_TOOL";

export interface EditChronology {
  readonly ops: readonly EditOp[];
  readonly defects: readonly { readonly callIndex: number; readonly defect: EditDefect }[];
  /** every edit call carried a replayable payload */
  readonly complete: boolean;
}

const EDIT_TOOLS = new Set(["Edit", "MultiEdit", "Write", "NotebookEdit", "str_replace_editor"]);

const asString = (v: unknown): string | null => (typeof v === "string" ? v : null);

/**
 * Reconstruct the ordered mutation list. A `MultiEdit` expands to one op per replacement so
 * that the chronology's ordinal is a mutation ordinal, not a tool-call ordinal — two edits
 * issued in one call are still two changes to the tree.
 */
export function reconstructEditChronology(calls: readonly TraceCall[]): EditChronology {
  const ops: EditOp[] = [];
  const defects: { callIndex: number; defect: EditDefect }[] = [];
  for (const call of calls) {
    if (call.category !== "edit" && !EDIT_TOOLS.has(call.tool)) continue;
    const args = call.args;
    const file = asString(args.file_path) ?? asString(args.path) ?? call.path;
    if (file === null) {
      defects.push({ callIndex: call.index, defect: "NO_FILE_PATH" });
      continue;
    }
    const edits = Array.isArray(args.edits) ? (args.edits as readonly unknown[]) : null;
    if (edits !== null) {
      for (const raw of edits) {
        const e = (raw ?? {}) as Record<string, unknown>;
        ops.push({
          callIndex: call.index,
          tool: call.tool,
          file,
          kind: "replace",
          oldString: asString(e.old_string),
          newString: asString(e.new_string),
          replaceAll: e.replace_all === true,
        });
      }
      continue;
    }
    const oldString = asString(args.old_string);
    const newString = asString(args.new_string);
    const content = asString(args.content);
    if (oldString !== null && newString !== null) {
      ops.push({ callIndex: call.index, tool: call.tool, file, kind: "replace", oldString, newString, replaceAll: args.replace_all === true });
    } else if (content !== null) {
      ops.push({ callIndex: call.index, tool: call.tool, file, kind: "write", oldString: null, newString: content, replaceAll: false });
    } else {
      defects.push({ callIndex: call.index, defect: "NO_PAYLOAD" });
    }
  }
  return { ops, defects, complete: defects.length === 0 && ops.length > 0 };
}

// ─────────────────────────────────────────────────────────────────────────────
// Decision points (§13)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The natural post-edit moments the trace actually supports. No fixed milestone is
 * invented where the trace does not carry one (§13): `AFTER_VALIDATION` exists only for
 * arms that observed a runner, and `BEFORE_FIRST_VALIDATION` only for arms that attempted.
 */
export type DecisionPointKind =
  | "AFTER_FIRST_EDIT"
  | "BEFORE_FIRST_VALIDATION"
  | "AFTER_FIRST_VALIDATION"
  | "BEFORE_FINALIZATION";

export interface DecisionPoint {
  readonly kind: DecisionPointKind;
  /** the trace ordinal the decision point sits AT: calls with index < this are visible. */
  readonly atIndex: number;
  /** mutations applied strictly before `atIndex`. */
  readonly editsApplied: number;
}

export interface DecisionPointInputs {
  readonly calls: readonly TraceCall[];
  readonly chronology: EditChronology;
  /** trace ordinals at which a validation command was issued, in order. */
  readonly validationAttemptIndices: readonly number[];
  /** trace ordinals at which a test runner demonstrably started, in order. */
  readonly validationStartedIndices: readonly number[];
}

export function decisionPoints(inputs: DecisionPointInputs): readonly DecisionPoint[] {
  const { calls, chronology } = inputs;
  if (chronology.ops.length === 0 || calls.length === 0) return [];
  const editsBefore = (at: number): number => chronology.ops.filter((o) => o.callIndex < at).length;
  const out: DecisionPoint[] = [];
  const firstEdit = chronology.ops[0]!.callIndex;
  out.push({ kind: "AFTER_FIRST_EDIT", atIndex: firstEdit + 1, editsApplied: editsBefore(firstEdit + 1) });

  const firstAttemptAfterEdit = inputs.validationAttemptIndices.find((i) => i > firstEdit);
  if (firstAttemptAfterEdit !== undefined) {
    out.push({ kind: "BEFORE_FIRST_VALIDATION", atIndex: firstAttemptAfterEdit, editsApplied: editsBefore(firstAttemptAfterEdit) });
  }
  const firstStartAfterEdit = inputs.validationStartedIndices.find((i) => i > firstEdit);
  if (firstStartAfterEdit !== undefined) {
    out.push({ kind: "AFTER_FIRST_VALIDATION", atIndex: firstStartAfterEdit + 1, editsApplied: editsBefore(firstStartAfterEdit + 1) });
  }
  const last = calls[calls.length - 1]!.index;
  out.push({ kind: "BEFORE_FINALIZATION", atIndex: last + 1, editsApplied: chronology.ops.length });
  // De-duplicate by ordinal, keeping the earliest-named kind, so a one-edit trace does not
  // report the same moment twice under two names.
  const seen = new Set<number>();
  return out.filter((d) => (seen.has(d.atIndex) ? false : (seen.add(d.atIndex), true)));
}

// ─────────────────────────────────────────────────────────────────────────────
// Corpus adequacy (§10, §23)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The observability facts about one arm. Deliberately contains no outcome: whether a trace
 * can WITNESS a mechanism is a property of what was recorded, and letting `resolved` reach
 * this record is how a corpus quietly becomes "adequate wherever we already have a story".
 */
export interface ArmObservability {
  readonly orderedToolTrace: boolean;
  readonly editCalls: number;
  readonly editOps: number;
  readonly editChronologyComplete: boolean;
  readonly baseTreeAvailable: boolean;
  readonly finalPatchAvailable: boolean;
  readonly inspectionCalls: number;
  readonly callsAfterFirstEdit: number;
  /** every reconstructed mutation applied cleanly to the base tree */
  readonly diffReplayClean: boolean;
  readonly validationAttempts: number;
  readonly validationRunnerStarts: number;
  readonly validationResultsObserved: number;
  readonly editsAfterValidationStart: number;
}

export type I5Blocker =
  | "NO_ORDERED_TRACE"
  | "NO_EDIT"
  | "EDIT_CHRONOLOGY_INCOMPLETE"
  | "NO_BASE_TREE"
  | "DIFF_NOT_REPLAYABLE"
  | "NO_FINAL_PATCH";

export type I6Blocker =
  | "I5_UNUSABLE"
  | "NO_VALIDATION_ATTEMPT"
  | "NO_RUNNER_START"
  | "NO_VALIDATION_RESULT";

export interface AdequacyVerdict<B> {
  readonly usable: boolean;
  readonly blockers: readonly B[];
}

/**
 * I5 needs the change set and the moment it existed. It does NOT need a test runner —
 * that separation is the whole reason M189 keeps the two classes apart (§5).
 */
export function assessI5(o: ArmObservability): AdequacyVerdict<I5Blocker> {
  const blockers: I5Blocker[] = [];
  if (!o.orderedToolTrace) blockers.push("NO_ORDERED_TRACE");
  if (o.editOps === 0) blockers.push("NO_EDIT");
  else if (!o.editChronologyComplete) blockers.push("EDIT_CHRONOLOGY_INCOMPLETE");
  if (!o.baseTreeAvailable) blockers.push("NO_BASE_TREE");
  else if (o.editOps > 0 && !o.diffReplayClean) blockers.push("DIFF_NOT_REPLAYABLE");
  if (!o.finalPatchAvailable) blockers.push("NO_FINAL_PATCH");
  return { usable: blockers.length === 0, blockers };
}

/**
 * I6 needs the agent's validation choices to be ATTRIBUTABLE TO THE AGENT. An arm whose
 * every test command was refused by the environment cannot tell us whether a repository-
 * derived validation obligation would have changed a decision, because the decision the
 * agent actually faced was "the runner does not work here" (M187). Requiring an observed
 * runner start is therefore not a convenience threshold, it is the attributability
 * condition, and it is the reason §22's `CURRENT_CORPUS_INADEQUATE_FOR_I6` is a real
 * possible verdict rather than a formality.
 */
export function assessI6(o: ArmObservability, i5: AdequacyVerdict<I5Blocker>): AdequacyVerdict<I6Blocker> {
  const blockers: I6Blocker[] = [];
  if (!i5.usable) blockers.push("I5_UNUSABLE");
  if (o.validationAttempts === 0) blockers.push("NO_VALIDATION_ATTEMPT");
  else if (o.validationRunnerStarts === 0) blockers.push("NO_RUNNER_START");
  else if (o.validationResultsObserved === 0) blockers.push("NO_VALIDATION_RESULT");
  return { usable: blockers.length === 0, blockers };
}

// ─────────────────────────────────────────────────────────────────────────────
// Changed-symbol derivation (§14)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * How confidently a changed line range was attributed to a symbol. §14 forbids forcing
 * every hunk into a symbol, so `MODULE_LEVEL` and `UNMAPPED` are outcomes, not failures.
 */
export type SymbolAttribution =
  | "EXACT_FUNCTION"
  | "EXACT_METHOD"
  | "EXACT_CLASS"
  | "MODULE_LEVEL"
  | "MULTIPLE_OVERLAPPING"
  | "UNMAPPED";

export interface ChangedSymbol {
  readonly file: string;
  readonly fqName: string | null;
  readonly kind: string | null;
  readonly attribution: SymbolAttribution;
  /** the 1-based line the change was attributed from */
  readonly anchorLine: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Candidate obligations (§15, §16, §30)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * An authoritative, index-backed relationship between a changed symbol and another symbol,
 * taken verbatim from `getImpactGraph`'s `directRelations` — the product's own relation
 * surface, which carries the edge kind, the direction and the strength the indexer proved.
 * `strength` is passed through rather than collapsed: §36's "exact callers are not potential
 * callers" is only enforceable if the derivation can still see the difference.
 */
export interface AuthoritativeRelation {
  /** the changed symbol the relation starts from */
  readonly fromFqName: string;
  readonly toFqName: string;
  readonly toFile: string;
  readonly toKind: string;
  /** verbatim from the index: 'calls' | 'references' | 'imports' | 'contains' | 'inherits' */
  readonly edgeType: string;
  /** verbatim from the product: 'exact' | anything weaker */
  readonly strength: string;
  /** which way the edge points relative to the changed symbol */
  readonly direction: "dependent_of_change" | "dependency_of_change";
}

export type ObligationClass = "I5" | "I6";

/**
 * The derivation's whole input surface. THERE IS NO GOLD FIELD AND NO OUTCOME FIELD, and
 * there is no field carrying a tool call at or after `atIndex`. `sliceAtDecisionPoint` in
 * the driver is the only constructor; because it truncates, "the agent read that file
 * later" is not merely disallowed here, it is unrepresentable (§12, §35).
 */
export interface DecisionPointEvidence {
  readonly atIndex: number;
  readonly kind: DecisionPointKind;
  /** identifier-ish terms from the derived task text (M103 derivation, problem statement only) */
  readonly taskTerms: readonly string[];
  readonly changedFiles: readonly string[];
  readonly changedSymbols: readonly ChangedSymbol[];
  /** repo-relative files the agent read, searched or edited strictly before `atIndex` */
  readonly inspectedFiles: readonly string[];
  readonly relations: readonly AuthoritativeRelation[];
  /** repo-relative test files the index relates to the changed symbols */
  readonly relatedTestFiles: readonly { readonly file: string; readonly viaFqName: string; readonly edgeType: string }[];
  /** test targets the agent has demonstrably RUN before `atIndex` (runner observed to start) */
  readonly validatedTargets: readonly string[];
  readonly anyRunnerStartedBefore: boolean;
}

export interface CandidateObligation {
  readonly obligationClass: ObligationClass;
  readonly targetFile: string;
  readonly targetFqName: string | null;
  readonly fromChangedSymbol: string;
  readonly edgeType: string;
  readonly provenance: "index_edge" | "index_edge_task_relevant";
  readonly taskRelevant: boolean;
}

/** Identifier-ish tokens; short and generic tokens are dropped so relevance is not free. */
const STOPWORDS = new Set([
  "self", "test", "tests", "true", "false", "none", "null", "return", "class", "def", "import",
  "from", "with", "this", "that", "when", "then", "should", "value", "values", "error", "type",
  "python", "django", "sympy", "code", "line", "file", "files", "using", "used", "name", "data",
]);

export function taskTermsFrom(text: string): readonly string[] {
  const out = new Set<string>();
  for (const raw of text.split(/[^A-Za-z0-9_.]+/u)) {
    for (const part of raw.split(".")) {
      const t = part.toLowerCase();
      if (t.length < 4 || STOPWORDS.has(t) || /^\d+$/u.test(t)) continue;
      out.add(t);
    }
  }
  return [...out].sort();
}

const baseName = (p: string): string => p.split("/").pop() ?? p;

/** Task relevance is a SHARED TERM between the task text and the candidate's own identity. */
const isTaskRelevant = (rel: AuthoritativeRelation, taskTerms: ReadonlySet<string>): boolean => {
  const identity = `${rel.toFqName} ${baseName(rel.toFile).replace(/\.[^.]+$/u, "")}`;
  for (const raw of identity.split(/[^A-Za-z0-9_]+/u)) {
    if (raw.length >= 4 && taskTerms.has(raw.toLowerCase())) return true;
  }
  return false;
};

/**
 * I5 — "is the current change set probably incomplete?"
 *
 * The rule, preregistered before any specimen was inspected:
 *
 *   a candidate is an index-backed DEPENDENT of a symbol the agent has already changed,
 *   living in a file the agent has neither changed nor inspected before this moment.
 *
 * Two things this deliberately does NOT do. It does not rank by centrality — an obligation
 * is created by a relation or not at all, and no hub bonus may promote an unrelated symbol
 * into the set. And it does not filter to the task by default: the unfiltered arms return
 * everything the relation licenses, so §18's "inspect these 19 files" failure mode is
 * MEASURED rather than defined away. Task relevance is applied as a second, narrower
 * derivation whose output is a subset, and both are reported.
 */
/**
 * The three derivation arms.
 *
 * `DEPENDENTS` and `DEPENDENTS_TASK_RELEVANT` were preregistered before any specimen was
 * inspected, because I5 as stated in §5 is about *affected consumers* of a change.
 *
 * `DEPENDENCIES` WAS ADDED AFTER A PILOT, and saying so is the point. The pilot over the
 * first 78 arms returned a candidate set naming an unaddressed gold file in 0 of 255
 * decision points, and the post-hoc reachability diagnostic then showed that the few
 * missed gold files that were reachable at all were reachable as things the change DEPENDS
 * ON, not as things that depend on the change. The arm is therefore added for edge-direction
 * coverage — the derivation was blind to half the graph — and NOT tuned in any other way.
 * It is reported alongside the preregistered arms, never merged into them, and it does not
 * change the §21 threshold it has to clear (M189 §19).
 */
export function deriveI5Candidates(
  evidence: DecisionPointEvidence,
  derivation: "DEPENDENTS" | "DEPENDENTS_TASK_RELEVANT" | "DEPENDENCIES",
): readonly CandidateObligation[] {
  const wanted = derivation === "DEPENDENCIES" ? "dependency_of_change" : "dependent_of_change";
  const changed = new Set(evidence.changedFiles);
  const inspected = new Set(evidence.inspectedFiles);
  const terms = new Set(evidence.taskTerms);
  const out = new Map<string, CandidateObligation>();
  for (const rel of evidence.relations) {
    if (rel.direction !== wanted) continue;
    if (changed.has(rel.toFile) || inspected.has(rel.toFile)) continue;
    const relevant = isTaskRelevant(rel, terms);
    if (derivation === "DEPENDENTS_TASK_RELEVANT" && !relevant) continue;
    const key = `${rel.toFile}::${rel.toFqName}`;
    if (out.has(key)) continue;
    out.set(key, {
      obligationClass: "I5",
      targetFile: rel.toFile,
      targetFqName: rel.toFqName,
      fromChangedSymbol: rel.fromFqName,
      edgeType: rel.edgeType,
      provenance: derivation === "DEPENDENTS_TASK_RELEVANT" ? "index_edge_task_relevant" : "index_edge",
      taskRelevant: relevant,
    });
  }
  return [...out.values()].sort((a, b) => (a.targetFile < b.targetFile ? -1 : a.targetFile > b.targetFile ? 1 : 0));
}

/**
 * I6 — "has the change actually been validated against the affected behaviour?"
 *
 * A candidate is a test file the INDEX relates to a changed symbol (or to a dependent of
 * one) and which the agent has not been observed to run. §16 forbids the two cheap rules
 * that would inflate this: no "test file in the same directory" obligation, and no generic
 * "run the suite" recommendation — every candidate here carries the edge that produced it.
 */
export function deriveI6Candidates(evidence: DecisionPointEvidence): readonly CandidateObligation[] {
  const validated = new Set(evidence.validatedTargets);
  const out = new Map<string, CandidateObligation>();
  for (const t of evidence.relatedTestFiles) {
    if (validated.has(t.file)) continue;
    if (out.has(t.file)) continue;
    out.set(t.file, {
      obligationClass: "I6",
      targetFile: t.file,
      targetFqName: null,
      fromChangedSymbol: t.viaFqName,
      edgeType: t.edgeType,
      provenance: "index_edge",
      taskRelevant: true,
    });
  }
  return [...out.values()].sort((a, b) => (a.targetFile < b.targetFile ? -1 : a.targetFile > b.targetFile ? 1 : 0));
}

// ─────────────────────────────────────────────────────────────────────────────
// Scoring — the ONLY place gold and outcome are allowed (§11, §20)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Post-hoc diagnosis of an ALREADY-FROZEN candidate set. Separate function, separate
 * record, applied after derivation, so that "would this have helped" can never leak into
 * "what would have been said" (§12).
 */
export interface CandidateScoreInput {
  readonly candidates: readonly CandidateObligation[];
  readonly goldFiles: readonly string[];
  /** files the agent's FINAL patch actually changed */
  readonly finalPatchFiles: readonly string[];
  readonly resolved: boolean;
}

export interface CandidateScore {
  readonly candidateCount: number;
  /** gold files named by the candidate set */
  readonly goldHits: readonly string[];
  /** gold files the final patch never touched, named by the candidate set — the I5 target */
  readonly unaddressedGoldHits: readonly string[];
  readonly precision: number;
  readonly hasUnaddressedGoldHit: boolean;
}

export function scoreCandidates(input: CandidateScoreInput): CandidateScore {
  const gold = new Set(input.goldFiles);
  const patched = new Set(input.finalPatchFiles);
  const named = [...new Set(input.candidates.map((c) => c.targetFile))];
  const goldHits = named.filter((f) => gold.has(f));
  const unaddressed = goldHits.filter((f) => !patched.has(f));
  return {
    candidateCount: named.length,
    goldHits,
    unaddressedGoldHits: unaddressed,
    precision: named.length === 0 ? 0 : goldHits.length / named.length,
    hasUnaddressedGoldHit: unaddressed.length > 0,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Mechanism taxonomy (§19) — preregistered
// ─────────────────────────────────────────────────────────────────────────────

export type MechanismClass =
  | "I5_EDIT_SET_MISS"
  | "I5_AFFECTED_CONSUMER_MISS"
  | "I5_NO_REPOSITORY_DERIVABLE_OBLIGATION"
  // ADDED AFTER THE PILOT, and it REDUCES the I5 specimen count rather than raising it. The
  // preregistered taxonomy had no bucket for the state the data actually contains most
  // often: the index does connect the changed symbol to the missed file, but only at a depth
  // the bounded derivation does not search, so no obligation was ever emitted. Folding that
  // into I5_AFFECTED_CONSUMER_MISS would have counted a candidate nothing produced (§19).
  | "I5_REACHABLE_BUT_NOT_NAMED_BY_DERIVATION"
  | "I6_RELEVANT_VALIDATION_NOT_SELECTED"
  | "I6_VALIDATION_SELECTED_BUT_NOT_EXECUTED"
  | "I6_VALIDATION_EXECUTED_BUT_REASONING_FAILED"
  | "I6_NO_REPOSITORY_DERIVABLE_VALIDATION"
  | "MODEL_REASONING_FAILURE_WITH_EVIDENCE_VISIBLE"
  | "INSUFFICIENT_TRACE"
  | "OTHER";

/**
 * Post-hoc mechanism classification for ONE failing arm.
 *
 * Unlike `deriveCandidateObligations`, this is allowed to see gold and outcome — it is a
 * diagnosis of a failure, not a derivation of an intervention, and §20 requires the two to
 * be told apart rather than merged. What it must NOT do is let the diagnosis rewrite the
 * candidate set: every field below that mentions a candidate is a verdict computed while
 * the derivation was still blind, passed in already frozen.
 *
 * The rule order is the contract, and it encodes M189's actual question. A failure only
 * reaches an I5 label if the final patch LEFT A GOLD FILE UNTOUCHED — an arm that edited
 * every reference site and still failed did not have an edit-set problem, however tempting
 * its transcript is. And a missed gold file the agent had already opened is scored as a
 * reasoning failure, not as a missing obligation: §20's django-13195 lesson is that
 * derivability and utility come apart, and telling an agent to look at a file it has open
 * is not an intervention.
 */
export interface MechanismEvidence {
  /** the final patch touched none of the reference files */
  readonly touchedNoGoldFile: boolean;
  /** reference files the final patch never touched */
  readonly missedGoldFiles: readonly string[];
  /** a FROZEN candidate set named one of them */
  readonly candidateNamedMissedGold: boolean;
  /** the frozen set that named it came from the consumer (dependent) arm */
  readonly namedByDependentArm: boolean;
  /** the agent had already opened every missed reference file */
  readonly allMissedGoldAlreadyInspected: boolean;
  /** any missed reference file is reachable from a changed symbol over indexed edges */
  readonly anyMissedGoldReachable: boolean;
  /** the arm can witness validation at all (M189-A's I6 predicate) */
  readonly i6Usable: boolean;
  /** the agent demonstrably ran a reference test module */
  readonly ranReferenceTest: boolean;
  /** the index, at depth 1, named a reference test module the agent did not run */
  readonly derivedUnrunReferenceTest: boolean;
  /** the agent attempted validation but no runner ever started */
  readonly validationAttemptedNeverStarted: boolean;
}

/**
 * I5 and I6 are classified INDEPENDENTLY and every failing arm receives one label from each.
 * §5 and §21 require each hypothesis to earn its own case, and a single mutually-exclusive
 * taxonomy would silently make them compete: an arm that both missed a reference file and
 * ran its validation would be counted for whichever rule happened to be written first.
 */
export function classifyI5Mechanism(e: MechanismEvidence): MechanismClass {
  if (e.touchedNoGoldFile) return "OTHER";
  if (e.missedGoldFiles.length === 0) return "MODEL_REASONING_FAILURE_WITH_EVIDENCE_VISIBLE";
  if (e.candidateNamedMissedGold) {
    return e.namedByDependentArm ? "I5_AFFECTED_CONSUMER_MISS" : "I5_EDIT_SET_MISS";
  }
  // A missed file the agent already had open is a reasoning failure, not a missing
  // obligation. §20's django-13195 lesson: derivability and utility come apart, and telling
  // an agent to look at a file it has open is not an intervention.
  if (e.allMissedGoldAlreadyInspected) return "MODEL_REASONING_FAILURE_WITH_EVIDENCE_VISIBLE";
  if (!e.anyMissedGoldReachable) return "I5_NO_REPOSITORY_DERIVABLE_OBLIGATION";
  return "I5_REACHABLE_BUT_NOT_NAMED_BY_DERIVATION";
}

export function classifyI6Mechanism(e: MechanismEvidence): MechanismClass {
  // An arm whose validation was never observable cannot witness an I6 mechanism at all;
  // saying INSUFFICIENT_TRACE here is what stops M189 counting an absence as evidence (§3).
  if (!e.i6Usable) {
    return e.validationAttemptedNeverStarted ? "I6_VALIDATION_SELECTED_BUT_NOT_EXECUTED" : "INSUFFICIENT_TRACE";
  }
  if (e.ranReferenceTest) return "I6_VALIDATION_EXECUTED_BUT_REASONING_FAILED";
  if (e.derivedUnrunReferenceTest) return "I6_RELEVANT_VALIDATION_NOT_SELECTED";
  return "I6_NO_REPOSITORY_DERIVABLE_VALIDATION";
}
