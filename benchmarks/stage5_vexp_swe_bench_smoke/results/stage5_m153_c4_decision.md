# M153-C4 — decision

```
C4 focused work   PASS
M153-C            NOT PASS
M153              INCOMPLETE   (A PASS, B PASS, C NOT PASS, D NOT RUN, E NOT RUN)
```

§49 is the operative rule: C4 was a focused closure probe, and it may pass while C
does not. It did.

## C4 stop conditions (§25)

| Condition | Result |
| --- | --- |
| first divergent stage identified | yes — the deliverable cap |
| generic cause proven | yes — M142-C's contract applied to one lane instead of the class |
| generic fix implemented | yes — `admitBoundedLanesBesideCap` |
| positive neutral control passes | yes — 3, all failing before the fix |
| negative neutral control passes | yes — 2, invariant before and after |
| Requests control preserved | yes — rank 1, byte-identical scorecard |
| Sphinx `get_filetype` propagation re-tested | yes — pool rank 65, was absent |
| oracle calibration rerun | yes — unchanged |
| taxonomy regenerated | yes — unchanged; no correction required |

## Why C still does not pass

The §76 gate C4 could have moved is *expected implementations admitted at a useful
rate*, and it did not move. Oracle `impl@1` is **1/30 (3.3%)**, identical to C3 and
to the M152 baseline, with **0 substantive per-case differences** across all 35
cases.

`get_filetype` now reaches the candidate pool at rank 65 of 66 and is still not
delivered. The bottleneck has moved one stage later — from *candidate propagation*
to *delivery selection* — and §29 is explicit that when oracle retrieval does not
materially improve, the correct action is to stop and report, not to patch the next
stage in the same pass.

Workspace routing was therefore **not rerun** (§24, §28: it is gated behind material
oracle improvement, which did not occur), and the behavioural lane **remains
default-off** (§35).

## The finding worth carrying forward

The reason this defect survived three phases is more informative than the defect.

`Session.get_adapter` — the corpus's one operation-fact success — scores `fts = 1`,
a full lexical name match, and ranks 1st on ordinary evidence alone. It never needed
the lane. So the lane's containment was invisible: the only case that exercised it
was the only case that did not depend on it.

That means the operation-fact lane has, on this corpus, **never yet delivered a
definition that ordinary retrieval could not already reach**. C4 removed the
structural reason it could not. Whether it can now is a delivery-selection question
that C4 deliberately leaves open.

## Preservation

Full suite: **4670 pass, 49 skip, 0 fail** across 292 files, including the M150
operation-fact and answer-role suites, M142 direct-evidence and concept-owner
suites, M140 module-invisibility suites and M152 store-authority suites. Both
typechecks clean; `git diff --check` clean.

Session isolation holds: 35 cases, `allArmsStartedEquivalent = true`.

## Seals

Holdout **not consumed** — no holdout case was inspected and nothing was tuned
against one. The oracle baseline runner reports holdout aggregates as it has since
C2, which is counting, not consumption; the D evaluation remains unrun.

ARC **not run, not inspected**. TCKDB **not run, not inspected**.

## Recommended next action

Trace delivery selection for `sp_parser_selection`: `get_filetype` is pooled at
rank 65 with `final = 0.6016` against a pool whose delivered head sits far above
it. The open question is whether a direct implementer with **no** lexical, symbol,
path or domain evidence can reach delivery on structural evidence alone, or whether
mechanism evidence is simply too small a share of `final` for that to be possible —
and if the latter, whether that is a defect or the honest ceiling of the current
evidence model. That question should be answered with a trace before any constant
is touched.
