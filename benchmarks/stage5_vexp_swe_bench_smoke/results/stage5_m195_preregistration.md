# M195 — preregistration

**Milestone.** M195 — gold-blind I6 validation-decision mechanism audit.
**Status at authoring.** Frozen before any candidate rule was scored against any
M194 arm. Nothing in this document was chosen after seeing which arms miss.
**Corpus.** The M194 observational corpus, frozen. No live spend. No new arms.

---

## 0. The question this milestone answers

> At the exact moment before an agent chose whether and how to validate, could a
> deterministic repository-derived rule — without gold, outcome, or future
> action — identify a small, truthful validation obligation that was meaningfully
> different from what the agent selected; and does that same rule show repeated
> success-side evidence that the distinction matters?

The burden is on the mechanism. A negative answer is an acceptable result and is
scored PASS if the audit itself is clean.

## 1. What was known before this document was written

Freezing a design requires knowing the shape of the corpus and the shape of the
repositories. The following were inspected before writing, and are declared here
so that the reader can see exactly how much was known:

- the M194 artefact layout, event schema and per-arm lifecycle fields;
- the M194 headline counts (33 valid, 13 I6-usable, 8 I6 repositories, 23
  resolved) and the per-arm lifecycle table;
- the SWE-bench dataset column names, including the names of the columns this
  milestone forbids itself from reading during derivation;
- the test-layout and native-runner conventions of the twelve repositories,
  probed from the frozen images (`runtests.py`, `bin/test`, `tox.ini`, central
  vs. mirrored test trees).

The following were **not** inspected before writing: any arm's validation command,
any arm's candidate outcome, any gold patch, any test patch, any FAIL_TO_PASS
list, and any relationship between a derived candidate and an arm's fate.

## 2. Corpus authority

The primary discovery set is exactly the 33 paid, valid M194 arms. Before
scoring, M195 mechanically verifies:

- the M193C manifest hash chain that M194 declared as its frozen authority;
- the byte hashes of `m194/acquisition_ledger.jsonl`, `m194/corpus_accounting.json`
  and every arm's `raw/adapter_events.jsonl`, `raw/prompt.txt`, `raw/final.patch`
  and `raw/snapshots/*.patch`;
- that the runs directory holds 35 arm directories, that exactly 2 never launched
  a model, and that the remaining 33 are the accounting's 33 lifecycles;
- that recomputing the lifecycle classification from raw events with M193/M194's
  own committed classifiers reproduces 33 valid, 13 I6-usable, 8 I6
  repositories, 7 runtime-diagnosis-usable, 5 runtime repositories, 23 resolved.

A mismatch on any of these is INCOMPLETE, not a repair opportunity.

Historical M183/M189/M190 arms are **excluded** from the primary set. They may be
used only as explicitly labelled secondary context after the primary verdict is
frozen, and may not change it.

## 3. Repository source authority

Candidate derivation needs the repository as it stood at the decision point, not
the local VTRACE HEAD. For each instance M195 materialises the benchmark base
state deterministically from the frozen SWE-bench image
(`swebench/sweb.eval.x86_64.<key>:latest`), checks out the arm's declared
`baseCommit`, and records:

- the observed `git rev-parse HEAD`, which must equal `arm.json.baseCommit`;
- the tracked path inventory, the test-file inventory, the native-runner
  inventory, and the import edges of every test file.

This is read-only extraction. No agent runs, no evaluation, no model call. An
instance whose base commit cannot be checked out is reported as a derivation
abstention, never silently skipped.

The static repository evidence provider is regex-based import extraction over the
materialised source. It is deterministic and reviewer-reproducible. VTRACE's own
symbol graph is *permitted* by the milestone but is not used, because the
question is whether **any** bounded repository-derived rule exists: if none
exists over exact import edges and exact path inventories, none exists over a
richer index either, and if one does exist, M196 is the place to bind it to a
product primitive.

## 4. Decision-point extraction rule (frozen)

Events are `raw/adapter_events.jsonl`, ordered by `sequence` ascending.

- **Edit event** — `kind=patch_snapshot`, `boundary=AFTER_EDIT`.
- **Validation attempt** — a `bash_pre`/`bash_post` pair whose command is a
  validation attempt under M194's committed `isValidationAttempt`.
- **Trustworthy validation result** — a validation attempt where
  `runnerStarted` is true, `classifyValidationProvenance` is usable and
  `classifySourceVersion` is usable, using M193's committed functions unchanged.

Two decision-point kinds are emitted, and only two:

- **`DP_EDIT`** — for each maximal run of edit events containing no intervening
  validation attempt, exactly one decision point, anchored at the **last** edit
  of the run. Collapsing the run is what keeps micro-points from inflating the
  sample: an agent that makes six edits and then decides how to validate made
  one validation decision, not six.
- **`DP_POST_FAILED_VALIDATION`** — one decision point at each trustworthy
  validation result whose semantic outcome is `FAILED` or `MIXED`, provided at
  least one further event exists in the trajectory.

No per-arm cap is applied. Inflation is controlled instead by making the **task**
the primary replication unit (§13 below), so an arm with twenty decision points
still counts once for replication.

Each decision point binds: `decisionPointId = <armId>#<sequence>`, `armId`,
`instanceId`, `repo`, `sequence`, `kind`, `diffHash`, `changedSourcePaths`,
`tracePrefixHash`, `derivationInputHash`, `candidateSetHash`.

## 5. Blindness architecture (frozen)

Derivation consumes exactly one object, `I6DecisionPointEvidence`, constructed by
copying whitelisted fields into a fresh structure. It contains:

- identity: `decisionPointId`, `armId`, `instanceId`, `repo`, `sequence`, `kind`;
- `taskText` — the bytes of `raw/prompt.txt` (the untreated baseline prompt);
- `currentDiffText` — the bytes of the anchored snapshot's `patchPath`;
- `changedSourcePaths`, `changedSymbols` — parsed from that diff only;
- `priorEvents` — strictly earlier events, redacted to a field whitelist;
- `observedFailureText` — for `DP_POST_FAILED_VALIDATION` only, the stdout and
  stderr of *that* validation, which the agent had already seen;
- `repoFacts` — base-commit path inventory, test-file inventory, test-file import
  edges, native runner inventory.

It structurally lacks, and the derivation code cannot reach: the next tool call,
the next validation command, later edits, later test results, the final patch,
the arm's resolution, the gold patch, the reference test patch, `FAIL_TO_PASS`,
`PASS_TO_PASS`, `hints_text`, and every event at or after the decision point's
own successor.

Derivation is `deriveCandidates(evidence)`. Evaluation is
`evaluateCandidate(candidate, revealed)`. No full arm object is passed to any
derivation helper.

## 6. Blind replay control (frozen)

Every decision point is derived twice:

1. **sighted corpus** — the normal offline corpus;
2. **stripped corpus** — a corpus rebuilt with the gold patch, the reference test
   patch, the official outcome, all events at or after the decision point, and
   all future validation actions physically removed before evidence
   construction.

The candidate-set hash of every decision point must be identical between the two.
The required verdict is `DERIVATION_IS_GOLD_OUTCOME_AND_FUTURE_ACTION_BLIND` with
**0 differing fingerprints**. Any difference is a hindsight leak and stops the
milestone.

## 7. Candidate mechanism families (frozen — exactly four)

No family may be added after scoring. There is no I6-E.

**I6-A — changed-source test affinity.** For each changed non-test source path
`p`, propose, in rank order, only paths that exist at the base commit:
A1 sibling mirror `dirname(p)/tests/test_<stem>.py`;
A2 package mirror — nearest ancestor package directory with a `tests/` child,
   then `test_<stem>.py` within it;
A3 central mirror — for a repository with a central test root, the path formed by
   re-rooting `p` below that root with a `test_` stem prefix, and `<root>/test_<stem>.py`;
A4 Django app-label mirror — for `django/**`, existing `tests/<label>/` directories
   whose label equals the changed module stem or its parent package name.

**I6-B — affected-consumer validation.** Test files whose import edges name a
changed module (dotted module path of `p`), ranked above test files that
`from <changed module> import <sym>` a changed symbol. Module granularity and
imported-name granularity only. This proposes a *validation target*; it never
proposes an edit, and does not reopen I5.

**I6-C — task/repository test cue.** From `taskText`, extract (i) explicit test
node ids and test paths, and (ii) dotted API identifiers. Map each to an existing
test path. Class (i) is `EXPLICIT_TEST_NAME`; class (ii) is
`IDENTIFIER_DERIVED`. Behavioural prose alone never produces a candidate.

**I6-D — prior-failure refinement.** At `DP_POST_FAILED_VALIDATION` only: parse
the already-observed failure text for test node ids, collected-error paths and
file paths, and propose the narrowed target.

A fifth reported row, **I6-UNION**, is the deduplicated union of A–D truncated to
the same bound. It is a reported aggregate, not a new family.

## 8. Boundedness (frozen)

`maxTargets = 3` per family per decision point. Reported per family: median, p90,
maximum and empty rate. Specificity ladder, strongest first:
`EXACT_TEST` (`path::name`) > `TEST_FILE` > `TEST_DIRECTORY` > `SUITE` > `UNKNOWN`.
A candidate is never upgraded past what its derivation actually establishes.

## 9. Native validation command derivation (frozen)

- `django/django` → `./tests/runtests.py <label>`
- `sympy/sympy` → `bin/test <path>`
- every other repository in the corpus → `python -m pytest <target>`

A candidate that cannot be expressed as an executable command in its repository's
own convention is reported as `UNKNOWN` specificity and does not count toward any
gate.

## 10. Natural-agent relation (frozen)

For each candidate-producing decision point, the agent's own next validation
decision inside the credit window is classified as exactly one of:

- `EXACT_MATCH` — the agent's target set contains the candidate node id, or names
  exactly the candidate file;
- `EQUIVALENT` — the agent names a test file in the same directory sharing the
  changed module stem, or, for Django, a label whose directory contains the
  candidate;
- `BROADER_THAN_CANDIDATE` — the agent runs a directory or whole suite containing
  the candidate;
- `DIFFERENT_VALIDATION` — a runner started, but its target set does not contain
  the candidate;
- `NO_VALIDATION` — no validation attempt inside the credit window.

A whole-suite run is `BROADER_THAN_CANDIDATE` and is never counted as
`EXACT_MATCH` or `EQUIVALENT`.

**Credit window (frozen).** For a decision point at sequence `s`, credit any
validation attempt at sequence `> s` occurring before the next edit event that
changes the diff hash, or before end of trajectory. A validation run after the
trajectory has moved on does not satisfy the original decision.

## 11. Relevance oracle (evaluation-only, frozen)

`RELEVANT(candidate)` iff the candidate's test file is touched by the instance's
`test_patch`, **or** the candidate names a node id appearing in `FAIL_TO_PASS`.
`PASS_TO_PASS` is deliberately excluded: it would make nearly every pre-existing
test "relevant" and would inflate every gate that depends on relevance.

This oracle may only *evaluate* a candidate that was already frozen. It may never
originate one. The prohibited shortcut — "gold test was X, the agent did not run
X, therefore I6 helps" — is not evidence in this milestone.

## 12. Classification (frozen)

Decision-point level:

- `I6_VALIDATION_SELECTION_MISS` — candidate non-empty; relation is
  `DIFFERENT_VALIDATION` or `NO_VALIDATION`; and the relevance oracle confirms
  the candidate.
- `I6_RELEVANT_VALIDATION_ALREADY_SELECTED` — candidate non-empty; relation is
  `EXACT_MATCH` or `EQUIVALENT`.
- `I6_NO_REPOSITORY_DERIVABLE_VALIDATION_OBLIGATION` — every family empty.
- `VALIDATION_EVIDENCE_UNUSABLE` — a validation exists inside the credit window
  but is not trustworthy under M193's committed provenance and source-version
  authorities. Kept strictly separate from agent selection; M194 already
  established acquisition truthfulness and M195 does not relitigate it.

Arm level:

- `I6_VALIDATION_EXECUTED_BUT_REASONING_FAILED` — the arm ran at least one
  trustworthy validation on a relevant target, observed its result, and the task
  is unresolved.

## 13. Replication units and thresholds (frozen)

The primary replication unit is the **task** (instance). Repository breadth is
the second dimension. Multiple decision points inside one arm never count as
independent replication.

`I6_INTERVENTION_MECHANISM_WITNESSED` requires a **single family** to pass **all
nine** gates:

| Gate | Requirement |
| ---- | ----------- |
| G1 | blind replay: 0 differing candidate-set fingerprints |
| G2 | boundedness: median ≤ 3 **and** p90 ≤ 3 candidates |
| G3 | ≥ 3 distinct **tasks** with `I6_VALIDATION_SELECTION_MISS` |
| G4 | those misses span ≥ 3 distinct **repositories** |
| G5 | ≥ 2 success-side witnesses across ≥ 2 distinct repositories |
| G6 | false-positive pressure: on resolved arms, candidate fires and is *not* relevant in ≤ 50% of candidate-producing decision points |
| G7 | redundancy: redundant-recommendation rate < 80% |
| G8 | concentration: the largest single task contributes < 50% of the family's selection-miss specimens |
| G9 | miss precision ≥ 0.50, where precision = `I6_VALIDATION_SELECTION_MISS` ÷ (candidate non-empty ∧ relation ∈ {`DIFFERENT_VALIDATION`, `NO_VALIDATION`}) |

If no family passes all nine: `I6_NO_INTERVENTION_MECHANISM_WITNESSED` and
`I6_CLOSE_RECOMMENDED`. Thresholds may not be relaxed after scoring, and no
family may be tuned to the corpus.

## 14. Success-side witness criteria (frozen)

A **success-side witness** requires all of:

1. the arm resolved;
2. a family derived a non-empty bounded candidate at some decision point;
3. the relation at that decision point is `EXACT_MATCH` or `EQUIVALENT`;
4. the validation was trustworthy and produced an observable semantic result;
5. the relevance oracle confirms the candidate.

A **strong** witness additionally requires the observed result to be `FAILED` or
`MIXED` and a subsequent edit to change the diff hash inside the same episode —
the post-validation revision shape. Witnesses are reported as `same-task` when a
failing and a resolving arm exist for the same instance, and `cross-task`
otherwise; M194 acquired one arm per instance, so `same-task` witnesses are
expected to be zero and pairing will not be fabricated.

## 15. False-positive and redundancy accounting (frozen)

Reported per family:

- **candidate intervention rate on resolved arms** — candidate-producing decision
  points ÷ all decision points, restricted to resolved arms;
- **unnecessary-fire rate** — candidate fires, relevance oracle rejects it,
  restricted to resolved arms;
- **redundant-recommendation rate** — candidate fires and the agent had already
  selected an equivalent validation ÷ all candidate-firing decision points;
- **intervention burden** — additional validation recommendations per arm.

## 16. Scope prohibitions

- No product implementation. `NO_VTRACE_I6_PRODUCT_IMPLEMENTATION_AUTHORIZED`
  holds regardless of the result.
- The 7 runtime-diagnosis-usable arms are corpus metadata only. Their traces are
  not inspected for a runtime mechanism.
  `NO_RUNTIME_REPAIR_INTERVENTION_AUTHORIZED`.
- `I5_REMAINS_CLOSED`. No family may propose an edit target.
- No live agent, no Docker evaluation, no LLM API call, no additional arms.
- A validation-selection mechanism is not a "force a test after every edit"
  scaffold. M195 measures only the former; the latter is a separate hypothesis.

## 17. Milestone verdict rule

- **PASS** — the audit is clean: corpus verified, design frozen before scoring,
  derivation blind with 0 fingerprint differences, all 33 arms accounted for,
  every gate evaluated mechanically, zero live spend, standard gates green. PASS
  does not require a positive mechanism; a clean falsification is PASS.
- **MIXED** — broadly valid but an important evidence class stayed only partially
  observable. Not to be used merely because the result is negative.
- **INCOMPLETE** — M194 artefacts unreconstructable, extraction unfinished, or a
  blindness control missing.
- **FAIL** — gold, outcome or future action entered derivation; rules changed
  after results; historical data used to tune the primary mechanism; product
  behaviour implemented; any live model call.
