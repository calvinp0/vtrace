# M171 — agent-facing orientation contract redesign

```text
M171 overall:            MIXED

A:                       PASS
B:                       PASS
C:                       PASS
D:                       PASS
E:                       MIXED
F:                       NOT RUN — not licensed by E

orientation verdict:     COMPACT_ORIENTATION_PLAUSIBLE
economics verdict:       PROACTIVE_PIPELINE_ECONOMICS_MATERIALLY_CHANGED
                         (for the measured candidate; the shipped default is unchanged)
product verdict:         DEFAULT_ORIENTATION_REDESIGN_NOT_LICENSED

product changed:         NO   (src/ diff = 0 lines)
retrieval changed:       NO

current default median model-visible tokens:   6,766
selected orientation median:                     582   (development 544)
selected orientation p90:                        850
projected attributable cost:                  $0.0079  per task
M169 baseline localization reference:         $0.0524  median
economics gate (50% of that):                 $0.0262

pivot identity:          99/99 A, 98/98 B, 12/12 development
action-support preservation:  7/7 of the cases the current contract supports
Broad100-A holdout:      every gate passes except gold symbol, −3.00pp full / −3.41pp remainder
Broad100-B:              every gate passes, gold symbol 0.00pp
unsupported claims:      0 over 96 audited packets
false absence:           0
debug preservation:      detail=debug unchanged; 22 of 40 disclosure rules retain there

live spend:              $0.00
live requalification:    NOT LICENSED
```

---

## What M171 asked

M169 closed the mandatory proactive pipeline as an economic proposition:
$0.0985 per task to displace $0.0026, ten economic losses, no wins. M170 closed
transparent mediation: a 4.81% whole-run oracle ceiling with no safe rung.

Neither result condemns the product category. M171 asked whether the price is a
property of the category or of the disclosure:

> Can VTRACE keep its full authoritative internal evidence model while sending
> the agent only the minimum sufficient decision-oriented orientation?

The answer, on the evidence below, is **yes at one twelfth of the price** — and
the contract still did not ship, because a delivery gate frozen before the
holdout missed by three cases.

## A — what the model is actually handed

Measured on `structuredContent`, the channel M167 proved the client consumes,
on twelve development cases re-captured against fresh indexes.

```text
median model-visible characters       21,318
median model-visible tokens            6,766    (M166 calibration, 0.3174 tok/char)
p90                                    8,795
median projected attributable cost    $0.1035
```

Three findings shaped everything after.

**The response is 21,318 characters and carries 895 characters of repository
source.** Actual code is about 4% of what the model pays for. `productContext`
alone is 39.7% of the response; `capsuleResult`, `responseBudget`, `deferred`,
`diagnostics` and `context` together add another 30%. The
`pivotNeighborhood` excerpt bodies are stripped before the response is emitted,
so the only source that reaches the model is inside
`productContext.modelVisibleContext`.

**89 distinct facts asserted across 146 surfaces.** A quarter of all facts are
asserted more than once. The task string appears on 7 surfaces, the selected
intent on 8, a symbol identity on a median of 4 and a maximum of 9. Nothing here
is deduped by string equality — M166/M167's permanent rule is that duplicate
accounting is not semantic duplication, so every surface is claimed by a named
extractor that knows what the value means.

The repetition is concentrated in exactly the material an agent needs — identity,
role, restatement — while the epistemic and provenance fields are each asserted
once. That inverts the §8 hypothesis: repeated *claim boundaries* were not the
problem. Repeated *identity* was.

**`detail=debug` is 1.24x the default and adds no keys.** The two modes carry the
same 22 top-level keys; debug expands fields rather than adding them. There was
no "internal" tier to move things to — everything VTRACE knew was already being
sent.

## B — the contract

Forty rules classify every field of the response, and the classification is
enforced rather than asserted: `unclassifiedPaths` walks a real response and
reports any path no rule covers. It found two whole top-level keys missing from
the first draft. It now reports zero across 24 responses.

```text
ALWAYS_MODEL_VISIBLE                     7 rules
VISIBLE_WHEN_NONDEFAULT                  5
VISIBLE_WHEN_INTERPRETATION_CRITICAL     6
DEBUG_ONLY                              22
INTERNAL_ONLY                            0    nothing currently emitted is deleted
```

Three `DEBUG_ONLY` decisions rest on measurement rather than judgement: durable
memory on this corpus is VTRACE's own prior tool calls ("Built context capsule
for query with 2 pivots and 4 supports") and M164 measured zero voluntary reuse;
no active rule fired on any development case; impact is skipped by intent and
flow resolves no endpoints across the whole corpus.

The shape:

```text
Focus
path::Symbol  lines 184-408  [skeleton]
why: <authoritative selection reason, verbatim>

<bounded source excerpt>

Related
path::Symbol  lines 411-414 — direct caller of path::Symbol
path::Symbol  lines 78-83  — calls the focus symbol (indexed call edge)

Focused orientation: task-relevant evidence selected from the indexed worktree,
not an exhaustive repository listing. Items not shown are not thereby absent.
```

**What the live transcripts said the packet needs.** The twelve M168
`vtrace_clean` runs pair each orientation with the behaviour it produced. The
current contract supports the agent's first repository action on 7 of 12 runs.
Early-phase support is 0% or 100% per run with nothing in between — the packet is
right or wrong, not partly right. Median 3 files surfaced, median 75% never
opened. A bigger packet does not rescue a wrong pivot, and a right pivot does not
need a bigger packet.

That is why the priority classes stop at P3 and P4+ is empty at every rung,
rather than merely deprioritized.

## C — the projector

Four rungs, every one projected from the SAME captured authoritative response, so
internal state is identical across rungs by construction rather than by
assertion. Five proofs, all passing at corpus scale:

```text
monotonicity       a location named at a smaller rung is named at a larger one
excerpt prefix     each rung's excerpt is a prefix of the next
no refill          a packet complete below its ceiling does not grow when the
                   ceiling rises, and does not move when unrelated internal
                   bytes are freed  (the direct answer to M166's failure mode)
projector purity   the projector does not mutate the state it reads
pivot identity     the projected focus is the authoritative lead pivot
```

```text
rung      median   p90    cost     evidence density   locations
CURRENT    6,766  8,795  $0.1035        24.4%             —
R1000        373    522  $0.0056        63.9%             3
R1500        430    728  $0.0062        65.7%             4
R2000        544    859  $0.0076        68.3%             6
R2500        544    922  $0.0076        68.3%             6
```

The ceiling never binds. At a 2,000-token ceiling the median packet is 582 tokens
across 188 holdout cases and the maximum is 1,007. That is "enough, then stop"
working structurally: the projector has no notion of remaining space, so there is
nothing for spare budget to attract.

Evidence density is measured with the same instrument on both sides — characters
spent asserting identity, source, role or relationship facts, over total
model-facing characters — and the comparison is conservative, because the
current-response numerator counts JSON keys and punctuation that the packet's
numerator does not.

**Rung selection, frozen before the holdout.** R2000 is the smallest rung with
zero file-delivery loss: of the 38 files the current default surfaces across the
twelve development cases, R1000 drops 9 (24%), R1500 drops 5 (13%), R2000 and
R2500 drop none. Cost was never the constraint — every rung passes the economics
gate by a factor of three or more — so the rung was chosen on evidence
preservation alone.

## D — truthfulness

```text
packets audited                                 96   (4 rungs x 12 cases x 2 sources)
unsupported claims                               0
false absence / exhaustive claims                0
exact-or-potential strengthening                 0
control suites                            42 tests, 0 fail
```

Soundness is structural rather than checked after the fact: every string in a
packet is either copied verbatim from the authoritative state or drawn from a
declared frozen phrase list. There is no code path that composes a new sentence
about the repository.

The pivot-neighborhood relationship enum is rendered through an exhaustive phrase
table that fails **closed** — a reason absent from the table carries no claim and
the neighbour is dropped, so a newly added internal token can neither leak as an
opaque label nor be read as a stronger relationship than it is.
`fallback_symbol_window` — a same-file symbol reached by no edge at all — renders
as *"in the same file as the focus symbol; no indexed relationship to it"*,
stating the absence of a relationship rather than implying one.

Eleven adversarial fixtures (exact callers, potential callers, a bounded caller
set, an authoritative absence, not-observed, a component unavailable, a component
that errored, omitted support, one item in several roles, one skip reason at two
scopes, `repo_not_ready`) all audit clean. Eight known-positive corruptions are
all caught. Two identity controls confirm the auditor is not vacuous.

**Preservation, on the twelve live envelopes agents were actually handed:**

```text
                          CURRENT   R1000  R1500  R2000  R2500
first action supported      7/12      7/12   7/12   7/12   7/12
first edit supported        7/12      7/12   7/12   7/12   7/12
early-phase supported      13/25     13/25  13/25  13/25  13/25
gold file delivered         5/8       5/8    5/8    5/8    5/8
pivot identical            12/12     12/12  12/12  12/12  12/12
```

Every rung, including the smallest, keeps every location the agent actually used.
The preservation denominator is the cases the current contract already supports —
a projection cannot be credited for a case the status quo also misses — and the
absolute rate is reported beside it so a high ratio over a weak denominator does
not read as strength.

## E — holdout

Contract frozen in `stage5_m171_frozen_selection.json` before the first holdout
case ran. Fresh derivation-valid indexes; `workspaces/cross_repo` untouched.

```text
                          A remainder (88)  A full (100)   B (100)
delivered                        87              99            98
median tokens                   582             582           582
p90 tokens                      827             850           827
projected cost               $0.0079         $0.0079       $0.0079
reduction vs current            11.4x           11.5x         11.8x
pivot identity                 87/87           99/99         98/98
gold file delta                0.00pp          0.00pp        0.00pp
gold symbol delta             -3.41pp         -3.00pp        0.00pp
soundness violations               0               0             0
```

Five gates pass on both corpora with large margins. **Gold-symbol delivery misses
on Broad100-A** against the 2-percentage-point gate frozen in the plan.

Three cases, all the same shape: the gold symbol sits at authoritative position
six or seven and the packet names six locations. In all three the packet still
delivers the gold **file** — the agent is pointed at the right file and loses a
symbol name inside it. Broad100-B, independent and disjoint, shows no regression
at all.

The development set showed 0.00pp on this measure. The regression is visible only
on the non-development remainder, which is the §32 split earning its place.

## F — not run

§66 makes integration conditional on the preservation gates as well as the
economic ones. One preservation gate does not pass, so the contract is not
eligible and `src/` carries a zero-line diff. The full reasoning, including why
R2500 was not simply adopted, is in `stage5_m171_integration_decision.md`.

## Before and after

```text
BEFORE
  authoritative result
    -> serialize almost everything VTRACE knows
    -> 22 keys, 21,318 characters, 6,766 model tokens, 24.4% evidence
    -> the envelope tends to fill

AFTER (measured candidate, not shipped)
  authoritative result
    -> minimum-sufficient orientation projection
    -> 4-6 keys, 582 model tokens, 68.3% evidence
    -> stop when the initial decision context is sufficient
    -> the rest stays internal and at detail=debug
```

## The four strategic questions

**Can VTRACE preserve its authoritative internal evidence model while disclosing
dramatically less by default?** Yes. Forty rules classify every field with a
reason, nothing is deleted, 22 rules retain at `detail=debug`, and 96 audited
packets carry zero unsupported claims.

**Can the default orientation fit a VEXP-class envelope without materially
degrading the initial repository decision?** It fits with an order of magnitude
to spare — 582 tokens against a 2,000-token target — and preserves 100% of pivot
identity, 100% of first-action support, and 100% of gold-file delivery. It loses
a gold symbol on three of 188 holdout cases, in files it still delivers. That is
a real regression against a real gate, and it is smaller than the gate's own
framing anticipated.

**Does the redesign lower first-call economics enough that M169's result must be
requalified?** For the candidate, yes: $0.0079 against the $0.0884 M169 priced, an
11.6x change, inside half the baseline localization cost. It is worth stating
plainly that it still costs more than the $0.0014 of investigation M169 measured
it displacing. What changed is not that the pipeline now pays for itself in
displaced searching; it is that the first-call price is no longer the reason a
live retest would be uninformative. Since nothing shipped, no requalification is
licensed.

**Is the result still recognizably a VEXP competitor?** In shape, yes — index
once, connect an agent, get an automatic compact first orientation. Nothing was
removed to resemble VEXP: the deterministic local architecture, revision and
worktree authority, truthful readiness, derivation validation, cross-repository
support, graph relationships and full provenance all remain, internally and at
debug. No solve-rate or cost parity is claimed, and M168 established the
published VEXP benchmark could not be faithfully attributed in any case.

## Standard verification

```text
bun run typecheck              clean
bun run typecheck:benchmarks   clean
bun test                       5390 pass, 49 skip, 0 fail, 347 files
git diff --check               clean
src/ diff                      0 lines
live spend                     $0.00
```
