# M177 — measured defects NOT repaired

Each of these was observed while measuring the impact envelope. §5 and §79 require
them recorded and left alone; none was promoted to a fix.

## 1. `fits()` and the terminal check test different conditions

**Measured.** `impactResponseEnvelope.ts:183` gates every rung of the ladder on
three conditions; `impactResponseEnvelope.ts:338` — the check that decides whether
the response can be returned at all — tests only two of them.
`modelVisibleEstimatedTokens <= requestedMaxTokens` drives all the compaction and
then has no say in the outcome.

**Observable consequence.** A response can be RETURNED while still exceeding the
model-visible bound the caller asked for. On the known positive at
`max_tokens=477` the delivered model-visible content is **484** tokens. The tool's
own schema describes `max_tokens` as bounding model-facing content "with an
800-token minimum metadata allowance for the complete serialized response", and
`responseBudget.modelVisibleEstimatedTokens` reports the real number, so nothing
is concealed — but the bound is advisory in a way the description does not say.

| | reproduced? | repaired? | licensed next? |
| --- | --- | --- | --- |
| | yes, deterministically | no | not licensed — tightening the check would start rejecting responses the product returns today |

## 2. The envelope floor is not perfectly deterministic

**Measured.** `timing` carries full-precision floats
(`totalImpactMs: 18.883726999999993`) whose decimal length varies between runs, so
`serializedCharacters` moves by a few characters and the floor jitters by about
one token. Directly observed: `max_tokens=476` on the known positive answered on
one real-transport run and declined on another, with no code change in between.

**Why it does not affect M177's result.** The threshold is reported as a location,
never used as a gate; every acceptance number in this milestone is a count of
states, not a boundary. But it does mean the pre/post table's 476 row is not
attributable to the repair, and it is marked as such.

| | reproduced? | repaired? | licensed next? |
| --- | --- | --- | --- |
| | yes | no | not licensed |

## 3. Non-monotone progressive delivery packing (inherited from M176)

**Measured by M176, not by M177.** `django__django-10880` on the `run_pipeline`
path delivers an orientation at `max_tokens` 400 and 600, a `delivery_failure` at
800 and 1,000, and an orientation again at 1,600. Located in
`src/productContext/budgetDelivery.ts`.

**M177's own observation.** §36 required the impact ladder to be checked for the
same property and the result recorded, not acted on. Over a 20-rung ladder on the
known positive there are **zero** violations: `retainedEdges` is non-decreasing in
the budget and no rung converts a delivered response back into a decline. That is
an observation about one ladder on one specimen, not a proof about the packer.

| | reproduced? | repaired? | licensed next? |
| --- | --- | --- | --- |
| | yes, by M176 | no | §80 — explicitly NOT to be started without authorization |

## 4. `related`-selection instability under load (inherited from M176)

**Measured by M176.** 11 of 200 responses differed between arms run concurrently;
re-run interleaved, all 11 were byte-identical. Mechanism never investigated.

**M177's exposure.** Nil, and deliberately so: both arms were loaded into one
process and called on the same in-memory snapshot, so no scheduling difference
could reach the comparison. 92 of 92 comparable responses are identical.

| | reproduced? | repaired? | licensed next? |
| --- | --- | --- | --- |
| | not by M177 | no | not licensed |

## 5. An invalid `format` crashes the envelope rather than being refused

**Measured incidentally.** Calling `getImpactGraph` with a format outside
`list | tree | mermaid` produces an output whose `view.lines` is absent, and
`rebuildCanonicalNodeAndViewProjections` then throws
`undefined is not an object (evaluating 'draft.view.lines[index]')`.

**Not reachable from the product.** `tools.ts:10158` validates `format` against
`IMPACT_FORMATS` and returns `invalid_request` before the engine is called, and
the CLI parses the same set. This is reachable only by a direct in-process call
with an invalid argument, which is why it is recorded rather than repaired: it is
a missing internal precondition, not a product defect, and repairing it would put
a guard on a path no caller can reach.

| | reproduced? | repaired? | licensed next? |
| --- | --- | --- | --- |
| | yes | no | not licensed |

## 6. No other envelope implementation was audited

M177 repaired the one instance M176 had already measured. It did **not** sweep the
repository for further envelope implementations, so the repository-wide verdict is
stated as *all currently known instances are repaired*, never as *no other
instance exists*.
