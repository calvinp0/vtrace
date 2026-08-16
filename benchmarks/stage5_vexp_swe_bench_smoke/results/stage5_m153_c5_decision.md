# M153-C5 — decision

```
C5 focused work   PASS   (one generic defect fixed; one ceiling established)
M153-C            NOT PASS
M153              INCOMPLETE   (A PASS, B PASS, C NOT PASS, D NOT RUN, E NOT RUN)
```

§72 applies: a focused PASS is not a milestone PASS, and the verdict is not
adjusted to match the effort.

## C5 stop conditions (§56)

| Condition | Result |
| --- | --- |
| delivery first divergence identified | yes — the discard gate in `classify` |
| generic evidence-authority meaning established | yes — grant vs evidence; and what the fact does not prove |
| fix implemented where justified | yes — discard gate reads the evidence |
| positive neutral control passes | yes — 1, failing before the fix |
| wrong-subject negative passes | yes |
| support-only negative passes | yes |
| M150 weak-name control preserved | yes — lead unchanged |
| `get_adapter` preserved | yes — scorecard and lead byte-identical |
| `get_filetype` re-evaluated | yes — discard → support; still not delivered |
| oracle calibration rerun | yes — unchanged |
| behavioural unique recovery metric recorded | yes — **0** |
| taxonomy regenerated | yes — unchanged |

## Outcome: §57 **and** §58, in that order

**A generic delivery defect existed and is fixed (§57).** The discard gate read the
one-per-query answer-role *grant* where it should have read the answer-role
*evidence*, so every proven direct implementer after the first was deleted under the
reason "no relevance to the task". That reason was false about them, and the fix is
the existing authoritative concept (`hasAnswerRoleEvidence`) rather than a parallel
one. No numeric tuning was needed or used.

**But the operation fact is also insufficient (§58).** The three sphinx candidates
that competed for the grant carry facts identical in *every indexed field* — same
kind, same operand, same provenance, same result-bearing flag. They differ only in
what they return, which the index does not record. `operation_fact` therefore proves
*participation in a first-success selection over `source_suffix`* and does not prove
*this is the definition the request asked for*.

So `get_filetype` is not delivered, and on the current evidence model it should not
be. Forcing it would be the corpus label deciding the ranking, which §33 forbids.

## Why C still does not pass

Behavioural unique recoveries: **0** — unchanged.

| Category | Count |
| --- | ---: |
| ordinary retrieval already sufficient | 6 |
| behavioural unique recovery | **0** |
| behavioural adds useful support only | 0 |
| behavioural no effect | 14 |
| behavioural harmful addition | 0 |

Oracle calibration is unchanged on all 35 cases. §63 is explicit: when unique
recoveries stay zero, stop — do not run workspace routing, do not consume the
holdout, and do not force another patch to manufacture a nonzero count. That is
what was done.

**Limiting factor, named as §63 requires: insufficient answer authority.** Not
activation (19/33 activate), not representation (`get_filetype` has a valid fact),
not delivery policy (the role gate is now correct and the envelope loss is
legitimate). The fact model records *that* a selection happened over *which*
operand, and not *what kind of value the selection yields* — and that last piece is
exactly what distinguishes the answer from its two siblings.

Workspace routing was **not rerun** (§48). The lane remains **default-off** (§66).

## Seals

Holdout **not consumed** — no case inspected, nothing tuned; the recovery metric
was computed over calibration repositories only. ARC **not run, not inspected**.
TCKDB **not run, not inspected**.

## Recommended next action

Do not add a fourth patch to the same chain. The measured ceiling is now specific
enough to state as a design question:

> A mechanism fact records the control-flow shape and the operand. It does not
> record the **kind of the result**. Where two definitions perform the same
> mechanism over the same operand, nothing in the index distinguishes the one whose
> result answers the request.

The candidate next step is result-kind evidence on the fact — what the returned
expression denotes, relative to the subject terms. That is a representation change,
it belongs to the REPRESENTATION bucket (7 calibration cases, the largest), and it
should be specified and negative-controlled before any code is written. It should
not be attempted as a continuation of the delivery work.
