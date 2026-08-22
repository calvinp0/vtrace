# M171 — architecture decision: internal authority, external orientation

## Before

```text
repository + task
  -> full authoritative VTRACE computation
  -> serialize almost everything VTRACE knows
  -> 22 top-level keys, ~21,300 characters, ~6,800 model tokens
  -> the envelope tends to fill
```

Three properties of that shape, measured on the twelve development cases:

- **895 characters of repository source in a 21,318-character response.** Actual
  code is about 4% of what the model pays for. `pivotNeighborhood` excerpt text
  is stripped before the response is emitted, so the only source that reaches the
  model is inside `productContext.modelVisibleContext`.
- **89 distinct facts asserted across 146 surfaces.** A quarter of all facts are
  asserted more than once; the task string appears on 7 surfaces, the selected
  intent on 8, a symbol identity on a median of 4 and a maximum of 9.
- **The envelope refills.** M166 removed diagnostics and watched the packer take
  the freed space back with additional evidence, so the response size was a
  property of the budget rather than of the task.

## After

```text
repository + task
  -> full authoritative VTRACE computation      (unchanged, byte for byte)
  -> internal PipelineResult                    (unchanged)
  -> AGENT ORIENTATION PROJECTOR                (new)
  -> ~580 model tokens
  -> stop when the initial decision context is sufficient
  -> the rest stays internal, reachable at detail=debug
```

The projector computes nothing about the repository. It reads the authoritative
response, selects a prefix of the pipeline's own ordering, and emits locations
with verbatim or frozen labels. It cannot show source the current default does
not already show, because it cuts its excerpt from the same rendering.

## The decision that makes it work

The milestone's real content is one distinction:

```text
INTERNAL EPISTEMIC AUTHORITY  !=  DEFAULT MODEL-FACING DISCLOSURE
```

VTRACE needs readiness, derivation, provenance, boundedness, claim boundaries,
observation state, component failures and workspace authority to avoid making
false claims. None of that implies the agent must read all of it before its first
repository decision. Forty rules classify every field of the response; seven are
`ALWAYS_MODEL_VISIBLE`, five are `VISIBLE_WHEN_NONDEFAULT`, six are
`VISIBLE_WHEN_INTERPRETATION_CRITICAL` and twenty-two are `DEBUG_ONLY`. Nothing
is deleted.

## Why "enough, then stop" is structural, not a policy

The projector has no notion of remaining space. There is no loop that adds
evidence while budget remains, so there is nothing for a raised ceiling to
attract. Two independent checks hold: a packet already complete below its ceiling
is byte-identical when the ceiling rises, and removing unrelated internal bytes
from the input leaves the packet unchanged. The second is the direct answer to
the M166 failure mode.

The consequence is visible in the numbers: at a 2,000-token ceiling, the median
packet is 582 tokens. The ceiling never binds. That is the design working, not a
budget going unused.

## What the evidence said the packet needed

The twelve M168 live transcripts pair each orientation with the behaviour it
produced. Three findings shaped the contract:

- **The packet is right or wrong per case, not partly right.** Early-phase
  support is 0% or 100% per run with nothing between. Seven runs had the first
  action, the first edit and every early-phase action supported; five had none.
- **Three quarters of what is surfaced is never opened.** Median 3 surfaced
  files, median 75% never touched.
- **A bigger packet does not rescue a wrong pivot, and a right pivot does not
  need a bigger packet.**

Which is why the contract spends its space on one focus with real code and a
short list of labelled neighbours, and why P4+ — additional support, impact
detail, memory, flow, provenance, accounting — is empty at every rung rather than
merely deprioritized.

## What was not changed

Retrieval, ranking, candidate generation, FTS, graph construction, centrality,
behaviour routing, query interpretation, support scoring and impact semantics are
untouched. `src/retrieval`, `src/capsuleV2` and the ranking path carry no M171
diff. The projected focus is the authoritative lead pivot on 99 of 99 delivered
Broad100-A cases and 12 of 12 development cases; where the packet is wrong, it is
wrong because retrieval was wrong, in exactly the same way and on exactly the
same cases as before.

## The bound that stopped it shipping

The related list is capped at five entries, so a packet names at most six
locations. On three Broad100-A cases the gold symbol sits at authoritative
position six or seven, inside a file the packet still delivers. That is a 3.0
percentage-point gold-symbol regression against a 2-point gate frozen before the
holdout ran, and it is why M171 does not integrate.

The cap and the token ceiling are two bounds doing one job, and the wrong one
binds: the ceiling is never reached, while the cap decides every packet. That is
the finding a successor milestone has to resolve — not by raising the cap after
seeing which number it would fix, but by deciding on development evidence what
"enough" means when the authoritative state offers eight locations and the
contract shows six.
