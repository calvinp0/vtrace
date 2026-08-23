# M176 — Response Envelope Totality and Truthful Degradation

**PASS.** A: PASS · B: PASS · C: PASS · D: PASS · E: PASS · F: PASS

```text
defect verdict        ENVELOPE_TOTALITY_DEFECT_CONFIRMED
degradation verdict   TRUTHFUL_BOUNDED_DEGRADATION_VALIDATED
totality verdict      VALID_REQUEST_RESPONSE_TOTALITY_CONFIRMED
product verdict       KEEP_COMPACT_ORIENTATION_WITH_TOTALITY_FIX
live verdict          LIVE_WORK_NOT_LICENSED

product changed       YES — the terminal state of the response envelope only
retrieval changed     NO
live spend            $0.00
live work             NOT RUN
```

## What was wrong

`compactProductResponse` ran a degradation ladder and, when the ladder was
exhausted and the response still would not fit, threw. The MCP server's catch-all
turned that into `handler_failed` with `isError: true`, so a predictable product
condition reached the caller as an implementation fault carrying no evidence, no
orientation and no decline.

It is reachable on ordinary input. On `pytest-dev__pytest-10081` — a real
workspace, the real SWE-bench problem statement, through the real MCP stdio
transport:

```text
max_tokens=100  ok=false  handler_failed / product_response_envelope_unreachable
max_tokens=150  ok=false  handler_failed / product_response_envelope_unreachable
max_tokens=200  ok=true   run_pipeline.orientation.none/1
```

The threshold sits at 193 — exactly where M176-A's offline floor search predicted
it, from a measurement taken without ever changing the ceiling on the specimen
being measured.

## Why the ladder could be exhausted

M176-A grew one field at a time on real authoritative captures and read the
**envelope floor** — the smallest `max_tokens` at which the response still
terminates. Ten default model-facing fields grow the floor without limit:

| field | supplier | takes an ordinary response past the *default* ceiling at |
| --- | --- | ---: |
| `request.repoRoot` | caller | 32,001 chars |
| `productContext.leadPivot` | repository | 25,077 chars |
| `productContext.freshness.reason` | product | 32,020 chars |
| `productContext.repository.worktreeId` | repository | 32,051 chars |
| `workspaceRouting.reason` | product | 32,073 chars |
| `workspaceRouting.perRepository[]` | repository | 32,600 chars |
| `intent.reason` | derived | 32,000 chars |
| `savedObservation` | product | 32,017 chars |
| `warnings` | product | 31,999 chars |
| `flow.skipReason` | derived | 32,036 chars |

M175's `request.task` is `CONSTANT`, as designed — the one field that used to
dominate no longer moves the floor at all. But the irreducible residue of an
ordinary response is around 4,000 characters against a *minimum* ceiling of 1,000
estimator tokens, so on two of four real specimens the floor already exceeds the
smallest ceiling before anything unusual happens.

The deeper reason is architectural, and is recorded rather than acted on: the
envelope is enforced on the **authoritative** result at `tools.ts:9252`, and the
compact orientation the model actually receives is projected from it afterwards at
`tools.ts:9282`. On the known positive the model-facing answer is 445 characters,
and the call died because the *authoritative* payload behind it would not fit.

## What changed

The ladder now ends in a bounded terminal record instead of an exception. Fixed
shape; every field a frozen constant, a boolean, a non-negative integer, or a
string with a declared limit. It carries the facts the ladder had already
established, in the field names `decideDecline` already reads — so the model
receives the decline it would have received had the ladder stopped one rung
earlier, in the **same public vocabulary**:

```json
{
  "schemaVersion": "run_pipeline.orientation.none/1",
  "state": "evidence_found_but_undelivered",
  "summary": "Relevant evidence was found, but none of it survived the response budget.",
  "boundary": "No focused orientation was selected from the current authoritative repository evidence. This is not an assertion that relevant code does not exist.",
  "nextStep": "Increase max_tokens or narrow the request.",
  "topMatch": "src/_pytest/debugging.py::_enter_pdb"
}
```

445 characters, ~141 billed tokens — and byte-identical to what that same case
already returned at a budget that fitted.

Ladder exhaustion gets **no new agent-facing state**. It changes nothing a coding
model can infer or act on differently, so a second state would be vocabulary the
agent cannot use. The one distinction a maintainer needs is internal:
`productContext.diagnostics.envelopeDecline`, set only where the ladder was
exhausted, absent from the graceful degradation one rung above.

## Required table — terminal states

| state | before | after |
| --- | --- | --- |
| normal compact orientation | `run_pipeline.orientation/1` | unchanged, byte-identical |
| empty retrieval | `no_relevant_evidence` | unchanged |
| repo not ready | readiness refusal | unchanged; readiness now survives budget pressure |
| envelope pressure with evidence | `handler_failed` / `product_response_envelope_unreachable` | `evidence_found_but_undelivered` + `envelopeDecline`, 445 chars |
| invalid request | `invalid_request` | unchanged |
| unexpected tool error | `handler_failed` | unchanged — deliberately |

## Required table — corpora

Fresh derivation-valid indexes; two checkouts, one corpus, one index, real MCP
transport. Denominators are the cases with a task and a workspace, and the two
budgets are separate measurements of different questions.

| metric | Broad100-A | Broad100-B |
| --- | ---: | ---: |
| valid requests | 100 | 100 |
| normal orientations (default) | 100 | 96 |
| empty retrievals (default) | 0 | 2 |
| bounded delivery declines (default) | 0 | 0 |
| readiness refusals (default) | 0 | 2 |
| invalid requests | 0 | 0 |
| tool errors | 0 | 0 |
| **envelope-induced handler failures (default)** | **0** | **0** |
| envelope-induced handler failures (pressured, before) | 9 | 10 |
| **envelope-induced handler failures (pressured, after)** | **0** | **0** |
| recovered | 9 | 10 |
| fabricated absence | 0 | 0 |
| max model-facing response tokens (pressured) | 150 | 152 |

Aggregate: **19 → 0** envelope-induced handler failures across 200 valid requests.

## Two things the raw tallies say that the gates do not

Both were re-measured rather than explained away.

**11 of 200 default responses were not byte-identical** between the arms. The
repair cannot produce that shape of difference — it replaces a response that
*failed* to fit, wholesale, and all 11 were orientation packets before and after,
with the focus unchanged and only `related` items added. Broad100-A and
Broad100-B ran concurrently, so within each case the two arms were separated by
minutes and by a different machine load. Re-measured with the checkouts
**interleaved**, twice each: all 11 byte-identical in both arms, both arms
self-stable. `NO_IDENTITY_MISS_ATTRIBUTABLE_TO_THE_REPAIR`.

**§48 monotonicity does not hold on this corpus, and M176 does not make it hold.**
`django__django-10880` delivers an orientation at 400 and 600, a
`delivery_failure` at 800 and 1,000, and an orientation again at 1,600. Both
checkouts were loaded into one process and run over the same snapshot bytes — no
transport, no index, no clock, no load between the arms — and the rank ladders are
byte-for-byte identical apart from the four budgets where `throw` became
`decline`. The violation is in the progressive delivery packer, not in the
envelope's terminal state. `MONOTONICITY_VIOLATIONS_PRE_EXISTING_AND_UNCHANGED`.

## The four required answers

**Totality.** *Can every valid, authoritative `run_pipeline` request now return a
bounded product-level response even when useful repository evidence cannot be
represented inside the orientation envelope?* — **Yes, for every case measured.**
19 envelope-induced handler failures across two corpora at a pressured budget
become 0; 0 at the default budget in both arms; the known positive recovers at
every budget that used to fail, and `get_code_context`'s re-measure path with it.
The claim is bounded by what was measured: two hundred SWE-bench workspaces, two
budgets, plus adversarial fixtures at 300,000 characters in every field the
contributor sweep found unbounded.

**Truthfulness.** *When evidence exists but cannot fit, does VTRACE distinguish
"could not deliver a bounded orientation" from "no relevant evidence exists"?* —
**Yes.** `retrievalFound` is read from the record rather than defaulted, so an
empty retrieval stays `no_relevant_evidence` and evidence that could not be
delivered stays `evidence_found_but_undelivered`. 0 fabricated absences in 19
recoveries. The `boundary` sentence, which states in as many words that this is
not an assertion that relevant code does not exist, is on every declined response.

**Unexpected errors.** *Does the new degradation path preserve genuine
implementation and runtime errors as errors?* — **Yes.** The fallback is reachable
from exactly one place, a failed measurement, and never from a `catch`. A throwing
getter on `productContext.items` still propagates and is still `handler_failed`,
in both the unit test and the control corpus.

**VEXP-class product relevance.** *Does M176 make compact automatic orientation
more robust as a default-on product without increasing its normal model-facing
cost or weakening its evidence semantics?* — **Yes, on both counts, and no
benchmark claim is made.** Normal cost is unchanged because the fallback is
unreachable from a response that fits: 189 of 200 byte-identical as measured, and
all 11 exceptions attributed away from the repair. Evidence semantics are
unchanged because no evidence rule, ranking rule or projection rule was touched.
No agent was run, so nothing here says anything about solve rate, agent utility or
cost.

## The invariant, and exactly how far it now holds

> **Every expected product-pressure state must have a bounded truthful terminal
> representation. Envelope exhaustion is a product condition, not an exceptional
> transport failure.**

- **Established architecturally.** Stated, implemented, controlled, and frozen as
  a precedence matrix any future envelope can be held to.
- **Satisfied for the repaired instance — `run_pipeline`** (and
  `get_code_context`, which shares the envelope).
- **One known outstanding violation — `get_impact_graph`.**
  `src/impact/impactResponseEnvelope.ts:340` throws
  `impact_response_envelope_unreachable` at the end of its own ladder. Reproduced
  deterministically on a real symbol: `max_tokens` of 1, 50, 200 and 400 all fail,
  1,200 succeeds. **Recorded, not repaired** — §34 bounds the product diff to the
  measured `run_pipeline` envelope, and repairing an envelope this milestone has
  not otherwise measured would ship a change with no control corpus behind it.

M176 does **not** establish that the invariant holds repository-wide.

## Next work

Only from concretely measured defects, ranked by what is now known:

1. **`get_impact_graph` envelope totality.** The same defect class, the same
   repair shape, now with a deterministic reproduction. A narrow milestone.
2. **Progressive delivery packing is non-monotone.** A larger budget can deliver
   less. Measured on 2 of 4 specimens, pre-existing, in
   `src/productContext/budgetDelivery.ts`.
3. **`related` selection is not stable across runs separated in time or load.**
   Observed on 11 of 200 responses under concurrent load and 0 of 11 interleaved;
   focus never moved. Mechanism not investigated.

Bounded declines are **rare** on ordinary input — 0 of 200 at the default budget —
and reachable at all only under a deliberately pressured budget or an adversarial
field. That closes the correctness branch: no projection work is licensed by this
milestone.

## Verification

```text
bun run typecheck              exit 0
bun run typecheck:benchmarks   exit 0
bun test                       5497 pass, 49 skip, 0 fail (5546 tests, 352 files)
git diff --check               clean
```

Nine new tests in `src/mcp/responseEnvelope.test.ts`. The M176-B control corpus
passes 14/14, including the known positive reproducing the crash on the pre-repair
checkout and recovering on this one.

## A measurement trap, recorded so it is not walked into again

`compactProductResponse` is not idempotent across delivery states.
`applyProgressiveContextBudget` derives retrieval success from
`resolved || items.length > 0` and never consults a `retrievalFound` a previous
pass wrote, so replaying compaction over an already-compacted `delivery_failure`
response reclassifies it as `no_result` — a fabricated absence. The live product
compacts once, so this is not a shipped defect. But it makes M175's 8,000-token
`.debug` captures unusable as specimens for delivery-state analysis, and every
M176 specimen is a single-pass authoritative capture at 120,000 tokens instead.
