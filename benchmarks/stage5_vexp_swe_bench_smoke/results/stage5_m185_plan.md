# M185 — M183 Failure-Stage Audit (plan)

Frozen before any case was read. Product HEAD `df74cf93` (M184 SHA backfill).

## The question

> When VTRACE had already localized the correct implementation area but the
> coding agent still failed, was the decisive failure caused by a missing or
> misunderstood repository fact that VTRACE could actually derive?

M183 measured 19/30 against 19/30 with 17 shared solves, `McNemar p = 1.000`, and
a whole-run token effect whose confidence interval spans zero. It also measured
that localization was healthy: 21/30 orientations named a gold file, the focus
was a gold file 19/30, and the treatment arm edited the focus 17/30. So the
first-orientation hypothesis has already been tested and returned neutral.

M185 does not retest it. It asks what separated a correct repair from an
incorrect one **after** the agent was already in the right place.

## What M185 is not allowed to do

No product change, no retrieval change, no ranking change, no orientation
change, no live agents, no VEXP, no Docker grading, no new sweep. Packet size and
retrieval quality are explicitly out of scope: M183 measured the packet at a
median 579.5 tokens and measured the outcome effect at zero, so neither shrinking
nor growing it is licensed by anything M185 can find.

The M184 index defect is **not** used to reinterpret M183. M184 established
`M183_INDEX_CONTAMINATION_NOT_OBSERVED` on a witness M183 built during its own
preparation: all 30 counted treatment arms were `full_rebuild` with a symbol
count read from the materialized database. M183's negative result stands.

## The continuation criterion

Coding-agent utility work continues after M185 only if **all eight** hold:

    1  localization was already correct
    2  failure occurred downstream of localization
    3  a concrete repository fact was missing or misunderstood
    4  that fact materially affected the repair or validation decision
    5  successful runs recover or use equivalent evidence
    6  current VTRACE authority can derive the fact without gold leakage
    7  the mechanism repeats across enough independent tasks
    8  a narrow counterfactual intervention can be specified

"Give the model more context and hope" fails the criterion. So does a mechanism
that appears once. A negative result is a valid and expected outcome, and it is
to be stated plainly rather than euphemized.

## Evidence

M183 preserved, per arm, for all 60 arms:

    _agent_stream.first_pass.jsonl     complete assistant/user/tool transcript
    _tool_calls_with_outputs.json      ordered calls WITH tool results
    _tool_calls.json                   ordered calls, sealed
    _run.meta.json / _eval.meta.json   telemetry and grader evidence
    swebench-*.jsonl                   canonical row incl. modelPatch
    _m183_orientation/<id>.packet.json the delivered treatment bytes

Plus `stage5_m183_pair_records.jsonl` (30 sealed pair records),
`stage5_m183_gold_diagnostics.json` (focus/gold rows), and the SWE-bench Verified
dataset for reference patches and FAIL_TO_PASS.

M185 recomputes the seals rather than trusting the summaries, and re-derives the
cohorts from the row data rather than copying M183's headline counts.

## Gold discipline

Reference patches are analysis authority, never a product input and never a
query. A failed reasoning step is not "wrong" because gold differs; it is wrong
if repository evidence available at the time contradicted it. Candidate missing
facts must have a concrete repository witness — a caller, a consumer, a test, a
config, a call edge — that is derivable without reading the reference patch.

## Workstreams

    M185-A   M183 evidence authority and cohort reconstruction
    M185-B   failure-stage classifier, defined before cases, plus timelines
    M185-C   correct-focus success vs failure comparative audit
    M185-D   repository-fact addressability and VTRACE capability audit
    M185-E   counterfactual intervention feasibility (offline only)
    M185-F   strategic closure: continue or stop coding-agent utility work

STOP after F. If a mechanism is found, that licenses asking for a new milestone,
not implementing one here.

## Cohorts

    A   correct-focus VTRACE failures        expected 6    the central group
    B   correct-focus VTRACE successes       comparator controlling for focus
    C   non-gold-focus VTRACE successes      expected 6    weight of "correct focus"
    D   VTRACE-only wins                     expected 2
    E   baseline-only wins                   expected 2
    F   both-fail pairs                      expected 9    used selectively

"Correct focus" keeps M183's definition — `focusIsGoldFile`, where a gold file is
a file changed by the reference patch — and is not redefined to make a cohort
cleaner. Edge cases (gold symbol in non-gold file) are recorded separately.

## Controls

A known-positive control must exist: a case where one run demonstrably reads and
uses a concrete repository fact, the other does not, and behaviour diverges
accordingly. It validates the classifier, not VTRACE. A known-negative control
must exist: a case where both runs hold effectively identical repository evidence
and still diverge, which the classifier must label `NO_MISSING_REPOSITORY_FACT`
rather than inventing one.

## Expected end state

    product changed      NO
    retrieval changed    NO
    ranking changed      NO
    orientation changed  NO
    live spend           $0.00
    live work            NOT RUN
