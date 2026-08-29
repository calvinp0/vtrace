# M185-B — failure-stage classifier contract

Written and committed **before** any M183 case transcript was read in detail
(§61). The cohorts were reconstructed first (M185-A) because cohort membership
is a mechanical function of M183's rows and carries no interpretation; the
labels below are the interpretive part, so they are fixed in advance.

## What is being classified

For each central case, the **first decisive divergence** (§12): the earliest
point after localization at which the run's trajectory becomes materially
inconsistent with a successful repair. Not the last failing test. Not the final
patch. The first wrong assumption, missed contract, unjustified repair decision,
or inadequate validation decision.

## Inputs the classifier may use

    _agent_stream.first_pass.jsonl     assistant reasoning and tool use, in order
    _tool_calls_with_outputs.json      what the run actually SAW, in order
    swebench-*.jsonl                   the final modelPatch
    the repository at base_commit       what was derivable at the time
    _m183_orientation/<id>.packet.json  what the treatment arm was handed

## Inputs the classifier may NOT use

The reference patch may be read by the auditor to understand the task, but it
may not be the reason a step is labelled wrong (§10/§20). A step is wrong when
**repository evidence available during the run** contradicts it. "The gold patch
does it differently" is not a classification.

`resolved` is not an input to `classifyStage`. The evidence record in
`m185Audit.ts` deliberately has no outcome field, so a stage cannot be inferred
from knowing the run failed (§36).

## Stage taxonomy and decision rules

Evaluated in this order; the first predicate that holds wins, because an earlier
wrong step makes every later one unreliable.

    S8  ENVIRONMENT
        A tooling, install, or sandbox failure consumed the run or blocked the
        edit. Witness: repeated failed commands with the same infrastructure
        error, or a turn/cost limit hit while still fighting the environment.

    S0  LOCALIZATION
        The run never meaningfully read the implementation the fix belongs in.
        "Meaningfully" = a Read/Grep whose OUTPUT contained the relevant
        definition, not merely a path mention. For cohort A this should be FALSE
        by construction; if it is true for a cohort-A case, that is a finding
        about the focus definition, not a stage assignment.

    S1  BEHAVIORAL_UNDERSTANDING
        The run states a model of the buggy behaviour that repository evidence
        it could see contradicts. Witness: the assistant asserts X about a
        function whose body, docstring, or an existing test says not-X.

    S3  CROSS_FILE_CONTRACT
        The failure turns on an obligation owned by another file — a caller's
        expectation, a consumer's branch on a return shape, a subclass override,
        a serialization or persistence effect, a test that encodes the invariant.
        Witness: a concrete second file whose content determines the correct
        repair, which the run never opened, or opened and did not use.

    S2  REPAIR_HYPOTHESIS
        The behaviour is understood and no cross-file contract is at issue, but
        the chosen repair mechanism cannot produce the required behaviour.

    S4  IMPLEMENTATION
        The repair concept is right; the code is wrong. Typo, inverted branch,
        wrong variable, wrong scope, incomplete application of a correct idea.

    S5  VALIDATION_SELECTION
        A decisive existing test was never discovered or never run, and running
        it would have shown the patch wrong.

    S6  VALIDATION_INTERPRETATION
        Validation ran and produced a signal the run read wrongly.

    S7  CORRECTIVE_REVISION
        Validation failed, budget remained, and the run did not revise, or
        revised in a direction the failing signal did not support.

    S9  STOCHASTIC_NOT_REPO_INFO
        None of the above holds. The run had the evidence, read it correctly,
        and still produced a wrong repair. This is the honest default and it is
        NOT a synonym for "we could not tell" — that is confidence LOW.

S3 is ordered before S2 deliberately. A missed cross-file contract is the
mechanism M185 is specifically hunting, so it must not be absorbed into the
broader "bad repair" bucket whenever both descriptions fit; a case is S2 only
when no concrete second-file obligation is at issue.

## Evidence-acquisition class (§14)

Assigned independently of the stage, for the decisive fact:

    EVIDENCE_NOT_ACQUIRED                          never appeared in any tool output
    EVIDENCE_ACQUIRED_BUT_MISUNDERSTOOD            appeared in output, read wrongly
    EVIDENCE_ACQUIRED_AND_UNDERSTOOD_BUT_BAD_REPAIR  stated correctly, patched wrongly
    EVIDENCE_CORRECT_BUT_VALIDATION_INSUFFICIENT   repair defensible, checking was not
    RELEVANT_EVIDENCE_NOT_PRESENT_IN_REPOSITORY    the fact is not in the repo at all
    ENVIRONMENTAL
    NOT_DETERMINABLE

"Appeared in any tool output" is decidable: `_tool_calls_with_outputs.json`
preserves what each call returned. Where an output was truncated at capture, the
case is marked `outputTruncated` and cannot be scored `EVIDENCE_NOT_ACQUIRED` on
that call alone.

## Candidate missing fact

A fact qualifies only if it is concrete and has a repository witness (§15/§37):

    acceptable    "symbol X is called by Y, which branches on X returning None"
                  "test T at path/test_t.py::case asserts B for input A"
                  "package __init__ re-exports S, so the import path is P"
                  "subclass C overrides M and does not call super()"

    rejected      "the model needed to think harder"
                  "it needed more context"
                  "the intended design was subtle"
                  "the patch should have been better"

The witness must be nameable without the reference patch. If the only way to
know the fact matters is to read gold, the fact is recorded as
`GOLD_DERIVED_ONLY` and scores `NO_COUNTERFACTUAL_SUPPORT`.

## Successful-run witness (§18)

    OBSERVED_USE       a comparator's transcript shows it reading the fact AND
                       the subsequent decision changing accordingly
    COMPATIBLE_ONLY    the comparator's patch happens to respect the fact, but
                       nothing in the transcript shows awareness
    NONE               no comparator recovered it

`COMPATIBLE_ONLY` is weak on purpose. A patch that satisfies an invariant it
never considered is not evidence that supplying the invariant would help.

## Confidence (§63)

    HIGH     the decisive step is explicit in the transcript and the counterfactual
             evidence question is answerable from the preserved tool outputs
    MEDIUM   the decisive step is inferable but not stated, or one input is
             truncated
    LOW      multiple readings survive the evidence

LOW is reported as LOW. An ambiguous transcript is not upgraded because a
verdict would be tidier.

## Controls (§34/§35)

    known-positive   a case where one run demonstrably reads a concrete
                     repository fact, the other does not, and behaviour diverges.
                     The classifier must find it. Validates the detector, and
                     says nothing about VTRACE.

    known-negative   a case where both runs hold effectively identical repository
                     evidence and still diverge. The classifier must return
                     NO_MISSING_REPOSITORY_FACT rather than inventing one.

Both are selected by a mechanical pre-filter over tool-output overlap, before
their transcripts are read, so the controls cannot be chosen to pass.

## Blinding (§36)

Stage and evidence-class labels are assigned per case before any aggregate is
computed and before the continuation verdict is drafted. The aggregate tables in
M185-C/D are produced from the labels; the labels are not revised to produce an
aggregate. Any label changed after aggregation is recorded as a revision with
its reason in `stage5_m185_outstanding_defects.md`.
