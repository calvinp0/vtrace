# M179 — monotone delivery packing

## The one-line finding

> The packer aims at `max_tokens`; delivery can afford `ceiling - metadata`, which
> is **less** than `max_tokens` whenever real metadata exceeds the flat allowance.
> So the packer selects rungs that cannot be shipped, and the envelope's only
> remaining move was to discard every piece of evidence — including rungs it had
> already proven fit. Because rung sizes are a step function, a larger budget could
> land on a rung that overflowed while a smaller one landed on one that fitted.

**1,088 of 1,088** ordered budget pairs that went orientation → decline were
**dominated**: a packet already proven deliverable at a smaller budget satisfied
every M178 fit contract at the larger one. After the repair there are **zero**.

## The known positive (§97)

`django__django-10880`, one frozen authoritative object, budgets varied alone.

| max_tokens | Before | After | semantic packet preserved from lower budget? |
| ---: | --- | --- | --- |
| 400 | orientation (212 tok) | orientation (212 tok) | — |
| 600 | orientation (212 tok) | orientation (212 tok) | yes, identical |
| 800 | orientation (212 tok) | orientation (212 tok) | yes, identical |
| 1,000 | **delivery_failure** | **orientation (212 tok)** | yes — restored |
| 1,600 | **delivery_failure** | **orientation (1,405 tok)** | yes, and strictly stronger |

Extended, the before-arm declined at 1,000 / 1,600 / 2,000 and recovered at 3,200.
After the repair every budget from 400 to 8,000 delivers an orientation, the focus
is `db/models/query.py::QuerySet.count` at every one of them, and model-visible
tokens rise monotonically 212 → 212 → 212 → 212 → 1,405 → 1,814 → 2,863 → 2,863 → 2,863.

**Boundary.** Last good 946, first bad 947 — exactly the packer's rung size. Last
bad 2,124, first recovered 2,125.

**Counterfactual (§66/§98).** Does the packet delivered at 800 satisfy the
contracts at 1,000, 1,600 and 2,000? **Yes, yes, yes** — 212 evidence tokens inside
every budget, 1,455 total inside every ceiling. At `max_tokens` 1,000 the old
degraded response occupied 1,210 tokens of a 2,000-token ceiling: the product
discarded the evidence and shipped 790 tokens of unused headroom.

## The monotonicity table (§96), both corpora, every ordered pair

| Budget pair class | Before | After |
| --- | ---: | ---: |
| orientation → decline | **1,088** | **0** |
| semantic item loss | 40 | 62 |
| priority inversion | 0 | 0 |
| representation downgrade | 0 | 0 |
| interpretation-critical qualifier evicted | 0 | 0 |
| focus substituted | 6 | 21 |
| decline → refused (throw) | 0 | 0 |
| **total** | **1,134** | **83** |

| | Broad100-A (88) | Broad100-B (81) |
| --- | --- | --- |
| violating ordered pairs | 603 → **35** | 531 → **48** |
| cases with any violation | 80 → 23 | 76 → 22 |
| orientation → decline | 580 → **0** | 508 → **0** |
| decline states across ladders | 474 → 303 | 508 → 345 |
| dominated declines (before) | 580 / 580 | 508 / 508 |

The residual item-loss and focus-substitution counts **rise**, and that is not the
repair regressing. Those pairs previously had a decline on one side, where no item
comparison is possible. Restoring the answer makes a second, pre-existing defect
measurable — see `stage5_m179_outstanding_defects.md` §1, which is the licensed
next work.

## The repair

One seam, in `src/mcp/responseEnvelope.ts`. The caller's `max_tokens` now sets the
**ceiling only**; the packer's evidence budget may be lowered beneath it, bounded,
before any evidence is discarded.

```text
if (!within_envelope)  ->  retryWithinCeiling(output, options, accounting, evidenceBudget)
                           affordable = ceiling(requested) - actual metadata
                           re-pack the SAME authoritative object at `affordable`
                           accept only a strictly deliverable, still-resolved result
if (!within_envelope)  ->  degradeOversizedProductResponse   (unchanged)
if (!within_envelope)  ->  buildBoundedEnvelopeDecline       (unchanged, M176)
```

It cannot invent anything: the ladder is a fixed sequence of ever weaker drafts,
identical at every budget, so a smaller evidence budget returns a rung the packer
would itself have published for a smaller request. It restarts from `output` rather
than from the half-compacted draft, because by then `items[].content` has been
removed as a duplicate and descending in place would render bodiless sections and
call it compaction.

Uses M178's names unchanged. No `run_pipeline_v2`, no `orientationPackerV2`, no
`responseEnvelopeV2`. Retrieval, ranking, candidate supply and candidate order are
untouched — pinned by hash on every case.

## Gates

| Gate | Result |
| --- | --- |
| totality — every budget ends in a normal response or a truthful bounded decline | **PRESERVED**. 0 throws before, 0 after, 0 totality failures across 2,028 deliveries |
| truthfulness — no orientation without a focus, no claim the packer did not build | **PRESERVED**. 0 failures |
| no refill (§48) — a budget that already worked must be untouched | **0 changed**, byte-identical, both corpora |
| default-budget identity (§64) | A 84/88, B 71/81 byte-identical; **0 unexpected** — every change is a decline becoming an answer |
| compact economics on the path that already worked | A median 921 → **921**, p90 5,131 → **5,131**. B median 1,334 → **1,334**, p90 5,360 → **5,360** |
| candidate supply / order identity | unchanged, hashed per case |

**What this changes at the budget the product actually runs at.** `run_pipeline`'s
default `max_tokens` is 8,000. At that budget **14 of 169** frozen tasks were
returning a 47-token delivery-failure notice; they now return 6,002-7,876 tokens of
evidence. Every one is classified `necessary_monotonicity_correction` and none is
`UNEXPECTED` — the affected cases are `pallets__flask-5014`,
`pytest-dev__pytest-10051`, `sphinx-doc__sphinx-7748`, `sympy__sympy-13974` on
Broad100-A and ten more on Broad100-B. These were not edge budgets: this is the
default path, failing on ordinary tasks, because metadata cost more than the flat
allowance reserved for it.

**Economics, honestly.** The whole-ladder median rises (A 265 → 494, B 47 → 458)
and the default-budget median rises (A 4,860 → 5,098, +4.9%; B 4,487 → 5,767,
+28.5%). Neither is inflation: on the path that already worked, every figure is
identical to the token. The medians move because 171 (A) and 163 (B) budgets that
used to deliver *nothing* now deliver evidence, and because 4 and 10 default
responses respectively were declines and are now answers. **Enough, then stop**
still holds — the retry only ever *lowers* the evidence budget, so it cannot fill an
envelope that was already satisfied.

## Controls

- **Detector**: 15/15 known-positive, known-negative and identity controls pass,
  including `decline_to_orientation` (not a violation), `stable_packet` (not a
  violation) and `richer_body_with_truncation_note` (not a violation).
- **Identity (§35)**: 24/24 — same object, same budget, packed twice, identical.
- **Fixture (§11)**: 88/88 and 79/81 frozen objects carry item bodies; the
  content-stripped corpus is kept as a standing control at 0/84.
- **Both arms in one process** on the same in-memory bytes, so no timing-float
  drift can be mistaken for a packing change (M178 measured that method's cost:
  20 false differences in 1,016 cases).

## Verdicts

```text
root cause:      PACKER_FALLBACK_NON_MONOTONICITY
invariant:       BUDGET_MONOTONE_DELIVERY_PARTIAL
repair:          MONOTONE_PACKER_REPAIR_VALIDATED
product:         KEEP_COMPACT_ORIENTATION_WITH_MONOTONE_PACKER
totality:        RESPONSE_TOTALITY_PRESERVED
truthfulness:    PACKER_TRUTHFULNESS_PRESERVED
economics:       COMPACT_ECONOMICS_PRESERVED
next work:       PACKER_FOLLOWUP_REQUIRED
```

`PARTIAL` rather than `VALIDATED` is deliberate. The class M179 set out to
eliminate is gone — orientation → decline is 0 on both corpora, as are priority
inversion, representation downgrade and qualifier eviction. 83 ordered pairs still
lose a related entry or move the focus, and every one of them traces to a
different component with a different contract: item metadata that the orientation
projector reads as evidence. Claiming a validated invariant while 83 pairs violate
it would be the kind of overstatement this ledger exists to prevent.

## Verification

```text
bun run typecheck              0 errors
bun run typecheck:benchmarks   1 error, PRE-EXISTING and unrelated (see outstanding defects §5)
bun test                       5,515 pass / 49 skip / 0 fail   (5,564 across 352 files)
git diff --check               clean
```

**Environmental, recorded rather than hidden (§105).** One full-suite run taken
while the machine sat at load average 21-27 under unrelated jobs reported
2 fail / 2 errors and took 478s against a 267s baseline, with `bun` holding about
20% of a core. Re-run under normal load: 0 fail. Every subset the repair can reach
was also run in isolation and is clean — `src/mcp` 228/0, `src/runPipeline` 96/0,
`benchmarks` 2,608/0. No product regression is derived from the saturated run.

The two M179 tests that pin the repair were verified to FAIL on the pre-repair
checkout and pass on this one:

```text
M179: more delivery budget never withdraws a deliverable answer
      pre-repair -> "max_tokens 800 delivered an answer and 1200 did not"
M179: the recovered packet is one the packer already builds, never a new claim
      pre-repair -> resultState 'delivery_failure'
```

## Scope note

Measured on the `run_pipeline` delivery path. `get_impact_graph` has its own
envelope with its own ladder and was not swept for monotonicity here.
