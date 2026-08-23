# M177 — `get_impact_graph` response totality and truthful bounded degradation

M176 proved the response-totality invariant for `run_pipeline` and recorded, without
acting on it, a second measured violation of the same defect class in
`get_impact_graph`: `impactResponseEnvelope.ts:340` threw
`impact_response_envelope_unreachable`, which the MCP server's catch-all reported
as `handler_failed`. M177 repaired that one instance and nothing else.

```text
A PASS   path traced from source and measurement; line 340's reachability explained;
         computation separated from delivery; repair seam identified
B PASS   known positive reproduced through real MCP stdio; 6 controls established
C PASS   decline contract derived; terminal construction proven; no new public state
D PASS   one function, one return where there was one throw; 8 new tests
E PASS   300 paired offline requests + 18 real-transport observations
F PASS   verdicts reached

defect          IMPACT_ENVELOPE_TOTALITY_DEFECT_CONFIRMED
degradation     IMPACT_TRUTHFUL_BOUNDED_DEGRADATION_VALIDATED
totality        IMPACT_VALID_REQUEST_RESPONSE_TOTALITY_CONFIRMED
product         KEEP_GET_IMPACT_GRAPH_WITH_TOTALITY_FIX
repository-wide KNOWN_ENVELOPE_TOTALITY_INSTANCES_REPAIRED
live            LIVE_WORK_NOT_LICENSED        spend $0.00
retrieval       UNCHANGED
impact graph    UNCHANGED
```

## The mechanism

The ladder's gate and its terminal check do not test the same conditions.

| site | expression | conditions |
| --- | --- | --- |
| `:183` `fits()` | `estimatedTotalTokens <= totalCeiling && serializedCharacters <= 80000 && modelVisibleEstimatedTokens <= requestedMaxTokens` | 3 |
| `:338` the throw | `estimatedTotalTokens > totalCeiling \|\| serializedCharacters > 80000` | 2 |

Every rung of compaction is driven by the model-visible bound; the throw fires on
the total. And the ladder can only shrink the model-visible channel. Read at the
floor — the smallest budget at which the pre-repair envelope still terminates —
the split is:

```text
metadata       745 tokens   61.2%    ← no rung touches any of it
model-visible  472 tokens   38.8%
```

So the ladder shed evidence to exhaustion while most of what would not fit was
never reducible. The decisive control: a symbol with **no impact at all** also
threw, at `max_tokens=1`, through the real transport. There was never any evidence
to shed.

## The repair

One site. The failed final measurement returns a bounded terminal record built
from the draft the ladder already exhausted, instead of throwing. The record is
returned unconditionally — never re-measured against a gate that could reject it —
so there is no path from the decline back to an unreachable state.

## Required before/after table

300 valid requests: 60 symbols (15 each of empty / small / medium / large impact)
× 5 budgets, both envelope implementations called on the *same* in-memory
authoritative snapshot in one process.

| Metric | Before | After |
| --- | ---: | ---: |
| valid requests | 300 | 300 |
| envelope-induced handler failures | 208 | **0** |
| truthful bounded declines | 0 | 208 |
| fabricated absences | 0 | **0** |
| default-budget declines | 0 | **0** |
| normal successful responses | 92 | 300 |
| attributable identity mismatches | — | **0** |

Through the real MCP transport (18 observations, one session per binding):

| Metric | Before | After |
| --- | ---: | ---: |
| envelope-induced handler failures | 7 | **0** |
| truthful bounded declines | 0 | 6 |
| `invalid_request` preserved | 2 | 2 |
| `repo_not_ready` preserved | 2 | 2 |
| valid `structuredContent` | 18/18 | 18/18 |
| valid JSON in `content[0].text` | 18/18 | 18/18 |

## Required known-positive table

`pytest-dev__pytest-10081 :: _enter_pdb`, only `max_tokens` varying. Both arms on
one snapshot per rung, so "authoritative impact same?" compares the two arms at
equal budget — the only comparison that is meaningful, because
`getImpactGraph.ts:705` spends `max_tokens` on path selection and the
authoritative result legitimately differs *across* the ladder.

| max_tokens | Before | After | authoritative impact same? |
| ---: | --- | --- | --- |
| 1 | `impact_response_envelope_unreachable` | bounded decline, 0/55 edges | yes |
| 50 | `impact_response_envelope_unreachable` | bounded decline, 0/55 edges | yes |
| 100 | `impact_response_envelope_unreachable` | bounded decline, 0/55 edges | yes |
| 200 | `impact_response_envelope_unreachable` | bounded decline, 0/55 edges | yes |
| 400 | `impact_response_envelope_unreachable` | bounded decline, 0/55 edges | yes |
| 476 | `impact_response_envelope_unreachable` | bounded decline, 0/55 edges | yes |
| 478 | response, 1/55 edges | response, 1/55 edges | yes, byte-identical |
| 600 | response, 1/55 edges | response, 1/55 edges | yes, byte-identical |
| 800 | response, 2/55 edges | response, 2/55 edges | yes, byte-identical |
| 1000 | response, 4/55 edges | response, 4/55 edges | yes, byte-identical |
| 1200 | response, 5/55 edges | response, 5/55 edges | yes, byte-identical |

Threshold: largest budget producing a decline **476**, smallest producing a
response **478**. 477 sits on a jitter of about one token — `timing` carries
full-precision floats whose decimal length varies run to run, so
`serializedCharacters` moves by a few characters. Reported as a location, never
used as a gate.

## The five required answers

**Did `get_impact_graph` compute authoritative impact evidence before failing
solely because the response envelope could not represent it?**
**Yes.** At `max_tokens=200` — a budget at which the tool threw — the engine
returned `ok`, a resolved symbol, 5 direct relations, 5 edges, 6 nodes and a
populated `summary.consumers`. The classification is
`IMPACT_COMPUTATION_SUCCEEDED + RESPONSE_COULD_NOT_FIT`.

**After M177, can every covered valid request reach a valid model-facing terminal
state rather than an internal unreachable?**
**Yes, over the measured coverage**: 300 paired offline requests across four impact
size classes and five budgets, plus 18 real-transport observations. 0
envelope-induced handler failures and 0 unexpected errors in the after arm. This
is a statement about that coverage, not about every possible request.

**When impact evidence exists but cannot be delivered, does the terminal response
avoid implying that no impact exists?**
**Yes.** The decline reports `retainedEdges: 0` beside `omittedEdges: 55` and
`resultState: "bounded_truncated"`, keeps `summary.consumers`, `richSummary`'s
counts and `callerCoverage.exactCallerCount` untouched, zeroes only the
`delivered*` counts, and clamps `callerCoverage.status` away from `complete`. A
genuinely empty impact instead reports `omittedEdges: 0` and
`resultState: "response_compacted"`, so the two are distinguishable: 191
evidence-exists declines and 17 empty-impact declines, never collapsed. 0
fabricated absences, 0 false-empty claims, 0 false-exhaustive claims, 0 ownership
strengthening across all 300 requests in both arms.

**Did the repair change any normal-budget impact result, graph relation, ordering,
path, or authoritative computation when the safety net did not fire?**
**No.** All 92 rows the pre-repair path could already deliver are identical
between arms, with only the clock fields (`timing`, `accounting.latencyMs`)
excluded and object keys canonically sorted. The engine is upstream of the repair
and its only changed file adds one optional response field and no computation.
`compactImpactProductResponse` clones its input, and a test asserts the
authoritative object is not mutated.

**What remains measured and unrepaired?**
Six items in `stage5_m177_outstanding_defects.md`: the `fits()`/terminal-check
condition mismatch; the floor's one-token jitter; M176's non-monotone delivery
packer in `budgetDelivery.ts` (§80 — explicitly not to be started without
authorization); M176's `related`-selection instability under load; an invalid
`format` crashing the envelope on a path no product caller can reach; and the fact
that no repository-wide sweep for other envelope implementations was performed.

## Monotonicity — observed, not repaired

§37's weak property over a 20-rung ladder on the known positive: **0 violations**.
`retainedEdges` is non-decreasing in the budget and no rung converts a delivered
response back into a decline. That is an observation about one ladder on one
specimen and is **not** an M177 acceptance gate. M176's genuine non-monotone
packer is a different component and remains unrepaired.

## Scope

```text
retrieval changed            NO
impact computation changed   NO
ranking / scoring changed    NO
candidate generation changed NO
public schema changed        NO   (diagnostics.envelopeDecline is additive under
                                   an additionalProperties:true block)
files changed                src/impact/impactResponseEnvelope.ts
                             src/impact/getImpactGraph.ts   (one optional field, type only)
                             src/impact/impactResponseEnvelope.test.ts
live spend                   $0.00
```
