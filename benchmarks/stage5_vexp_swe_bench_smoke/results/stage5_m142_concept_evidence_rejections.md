# M142 — Concept evidence: what was tried, measured, and rejected

Workstream C set out to make the concept-owner lane identify the file that *owns
a behaviour* from a request phrased in behavioural language. Two parts of that
succeeded and are frozen: objective role typing and round-robin owner allocation.
The third — actually recognising the owner from concept evidence — did not, and
this file records what was measured so the ceiling is an **investigated
architectural limitation** rather than work never attempted (§29).

Every mechanism below was implemented far enough to measure. None was rejected on
taste.

## Rejected — acronym → path

**Idea.** Map a domain acronym in the request onto a same-named module.

**Measured.** 0 true positives, 2 false positives.

**Correction worth keeping.** The phrase *"normal mode displacement"* comes from
the specification's description of the case, **not** from the user's query. The
real wording is:

> How does ARC verify that a saddle point actually connects the intended
> reactants and products by looking at how the atoms move in the imaginary
> vibration?

There is no acronym in it. Claiming acronym evidence here would have meant
matching against wording the user never wrote (§90).

## Rejected — entity ownership

**Idea.** Treat a domain entity mentioned in the request as owned by the file
that defines it.

**Measured.** Gating worked: raw nominations fell 796 → 71, a real precision
gain. But on the frozen 50 it moved **no** quality metric, cost ~29 tokens per
case, and — decisively — on the real Gaussian question it nominated the Gaussian
**parser** rather than the Gaussian **job adapter**.

**Why that is fatal rather than fixable.** Domain-entity ownership ≠ behaviour
ownership. The file that defines what a Gaussian *is* is not the file that
decides which route keywords to *emit*.

## Rejected — identifier/literal body index

**Idea.** Index symbol bodies so concept evidence can be recovered from
identifiers and literals inside them.

**Measured**, on all four ARC behavioural cases:

| Evidence class | Objectives recovered |
|---|---|
| body identifiers and literals | **0** |
| developer comments / prose | 2 (both Gaussian) |

**Consequence.** A body index would have to index developer **prose** to recover
any part of the gap, and would still close only part of it. That evidence class
has a poor precision profile, and a schema bump for a partial solution is
explicitly out of scope (§31).

This supersedes the earlier assumption that body indexing was the obvious next
step. It is not; it was measured, and it recovers nothing here.

## The remaining gap is vocabulary, not representation

On the normal-mode question, six of the twelve derived objectives — *verify,
saddle, connect, intended, look, vibration* — appear **nowhere** in
`arc/checks/nmd.py`. The single best answer,
`analyze_ts_normal_mode_displacement`, carries only 2 of the 12 and therefore
ranks low *within its own file*.

No representation of the file's existing text closes that gap, because the words
are not in the file. That is the ceiling.

## Final verdict

| Part | Verdict |
|---|---|
| Objective hygiene | **PASS** |
| Owner allocation | **PASS** |
| Concept evidence | **NOT PASS** — measured capability ceiling |
| Special support selection | **NOT NEEDED AS SPECIFIED** |

`concept_owner_support` was **not implemented**. §45 required it to be justified
by a generic omitted-support defect; the surviving candidates were `lexical`
sourced rather than owner-lane sourced, and §7 rules that a single case
(sphinx-7910) does not justify another selection role. Post-A measurement did not
produce the multiple genuine *generated → ranked → useful → not delivered* cases
that would.

The Gaussian hard acceptance (§89) is **NOT MET**. The final query result for
that case is good — `arc/job/adapters/gaussian.py` leads — but that is because
Workstream A removed the `which()` poisoning, **not** because the concept-owner
lane identified the adapter. The lane elects `arc/job/trsh.py`,
`arc/tckdb/adapter.py` and `arc/output.py` instead, and never elects the adapter
at all. Those two facts are reported separately on purpose (§27).
