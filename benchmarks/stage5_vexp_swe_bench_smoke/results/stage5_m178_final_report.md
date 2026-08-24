# M178 — Response Fit Contract Consistency and Budget-Semantics Alignment

```text
M178 overall:      PASS

A:                 PASS
B:                 PASS
C:                 PASS
D:                 PASS
E:                 PASS
F:                 PASS

contract verdict:      MULTI_SURFACE_FIT_CONTRACT_CONFIRMED
root-cause verdict:    FIT_CONCEPTS_CONFLATED
alignment verdict:     FIT_CONTRACT_ALIGNMENT_VALIDATED
product verdict:       KEEP_CURRENT_RESPONSE_CONTRACT_UNCHANGED
totality verdict:      RESPONSE_TOTALITY_PRESERVED
monotonicity verdict:  NON_MONOTONE_DELIVERY_STILL_CONFIRMED
next-work verdict:     MONOTONE_DELIVERY_PACKER_WORK_LICENSED

product changed:            YES (naming and routing only; output byte-identical)
retrieval changed:          NO
impact computation changed: NO
live spend:                 $0.00
live work:                  NOT RUN

commits:                    <filled in below>
pushed:                     NO
```

## The finding in one paragraph

`max_tokens` was never one bound. `get_impact_graph`'s schema publishes two — one
on model-facing impact content, one on the complete serialized response — and so
does `run_pipeline`'s. `run_pipeline` enforces them in two separate components,
each with its own predicate, and its ladder tests exactly what its terminal tests.
`get_impact_graph` reaches both through a single ladder, and computed both with a
single boolean called `fits()`. M177 read the resulting asymmetry as the terminal
failing to enforce one of its own conditions. It was not: both callers were
already correct, and the terminal was testing the only condition that may withhold
a response. The defect was that one name stood for two contracts. M178 gives them
two names and changes nothing else.

## What `fits()` meant today, condition by condition (§77)

| | Expression | Really measures | Really governs |
| --- | --- | --- | --- |
| C1 | `estimatedTotalTokens <= totalCeiling` | the complete serialized response | **whether the response may be returned** |
| C2 | `serializedCharacters <= 80_000` | the complete serialized response, in characters | nothing — **provably implied by C1** at every budget (0 counterexamples over 1..20,000) |
| C3 | `modelVisibleEstimatedTokens <= requestedMaxTokens` | **five evidence keys only**, not "what the model sees" | **how hard the ladder keeps compacting** |

After M178 the authoritative model-facing contract is stated as two predicates
that cannot be confused:

- `impactResponseFitsEnvelope` — the **hard delivery constraint** (C1, with C2 as
  a pinned backstop). The terminal tests this and only this.
- `impactResponseMeetsEvidenceBudget` — the **compaction target** (C3). The ladder
  pursues it; nothing withholds a response over it.

## Was the terminal too permissive, `fits()` too strict, or two concepts conflated? (§78)

**Two concepts conflated.** Both alternatives are refuted by evidence rather than
by preference:

- *Terminal too permissive* would mean C3 is a delivery constraint. Enforcing it
  would convert **564** bounded deliveries into declines and destroy **25**
  delivered edges, each to reclaim at most **41** tokens — tokens that are surplus
  metadata allowance, not the caller's evidence budget.
- *`fits()` too strict* would mean C3 does not belong in the ladder. Removing it
  leaves evidence bounded only by `max_tokens + allowance - metadata`, so a
  400-token request could return ~700 — abandoning a bound the schema publishes.

## Should unshrinkable metadata be able to fail an acceptable response? (§79)

**No — and the metadata allowance already prevents it.** Answered by class, since
the classes differ:

- **Metadata inside its allowance:** must not count against the evidence budget.
  This is exactly what `max(800, 15%)` exists to grant.
- **Surplus allowance beyond actual metadata cost:** currently spendable on
  evidence, and this *is* the disagreement window. Its width is exactly
  `allowance − metadata`, confirmed on **60 of 60** corpus symbols with the
  measured excess never exceeding the surplus bound. Reclaiming it would mean
  wasting envelope or declining deliverable evidence.

## Which non-model-visible bytes must still constrain emission? (§80)

**For the proven client: none identified.** C2 — the only transport-shaped
condition in the inventory — is dead. M167 established that `content[0].text` is a
duplicate costing 0 model tokens in that client and is unremovable under protocol
2024-11-05, and the JSON-RPC wrapper sits outside every predicate.

**For other clients: UNKNOWN.** No client-specific payload limit was measured, and
M178 makes no claim about one.

## Did fit consistency alter any default-budget response? (§81)

**No.** Zero at every level of evidence available:

- Frozen corpus, envelope-isolated: **60/60 `agree_normal`** at the default, 0
  disagreements.
- Same corpus, engine-coupled: **0** disagreements at the default.
- Paired pre/post comparison: **1,140 of 1,140 byte-identical**, decline count
  unchanged at 496.
- `run_pipeline` qualification: **0** delivery-contract and **0** envelope-contract
  violations across 6 snapshots × 16 budgets.
- Real MCP stdio: 0 handler failures, 0 unreachable states, all controls as M177
  recorded them.

## Does the Django sequence still reproduce? (§82)

**Yes, unchanged.**

```text
400 → orientation        600 → orientation
800 → delivery_failure  1000 → delivery_failure
1600 → orientation
```

One violation across the 16-budget grid, two across the six-snapshot corpus. M178
touched no packing, ordering or selection, and the paired identity proves the
envelope output is byte-identical, so this cleanly licenses **M179**. It is
reported as an observation; nothing in M178 was scored on it (§38).

## Before/after (§76)

| Metric | Before | After |
| --- | ---: | ---: |
| valid requests (paired, 60 symbols × 19 budgets) | 1,140 | 1,140 |
| normal responses | 644 | 644 |
| truthful declines | 496 | 496 |
| envelope handler failures | 0 | 0 |
| unreachable states | 0 | 0 |
| canonical-fit disagreements (default budget) | 0 | 0 |
| canonical-fit disagreements (pressure budgets) | 564 | 564 |
| default-budget output changes | — | 0 |
| attributable identity mismatches | — | 0 |
| fabricated absences | 0 | 0 |

The pressure-budget disagreements are **retained deliberately**. Under the
contract derived in C they are not inconsistency: the constraint that dominates is
the delivery constraint, which holds in every one of them, and §57's exception is
invoked explicitly rather than by silence.

## Contract disagreement tally after implementation (§57)

```text
canonical model-facing fit predicate false, normal response emitted:   0
canonical fit true, fit-contract decline emitted:                      0
```

Both zero under the final contract, in which `impactResponseFitsEnvelope` is the
canonical model-facing fit predicate. The 564 cases are deliveries where the
*compaction target* was unmet, which the contract explicitly permits the delivery
constraint to dominate.

## Instrument controls (§25, §14, §15)

| Control | Result |
| --- | --- |
| known positive (budget 477, inside the window) | PASS — reached `normal(bounded_truncated, edges=1, c3=F)` |
| known negative (default budget 1,200) | PASS — reached `normal(bounded_truncated, edges=5, c3=T)` |
| identity (same input twice) | PASS |
| `limits.maxTokens` echo trap | PASS — content identical, full identity differs |
| fixture trap (`max_tokens=1` must decline) | PASS — reached `decline(bounded_truncated)` |
| classifier not degenerate | PASS — 3 distinct labels |
| window prediction | 60/60 hold, 0 fail |
| residue constant below floor | 60/60 hold |
| monotonicity of the impact ladder | 60/60 monotone |

Two instrument errors were found and fixed before they became findings: the M176
snapshots are wrapped under `.snapshot` (compacting the wrapper reported a
meaningless flat ladder), and varying the request budget moves the **engine**'s
spend of `max_tokens` as well as the envelope's (which produced a bogus "residue
constant on 14/60" and 18 false window-prediction failures). Holding the
authoritative object fixed resolved both to 60/60.

## Verification (§84)

```text
bun run typecheck              pass   (0 errors)
bun run typecheck:benchmarks   pass   (0 errors)
bun test                       5511 pass, 49 skip, 0 fail   (352 files, 372.73s)
git diff --check               clean
```

## Product diff (§45)

```text
src/impact/impactResponseEnvelope.ts        two named predicates; ladder and
                                            terminal routed through them
src/impact/impactResponseEnvelope.test.ts   five tests pinning which caller uses
                                            which predicate
src/mcp/responseEnvelope.ts                 documentation only
src/productContext/budgetDelivery.ts        documentation only
```

No retrieval, ranking, graph, scoring or selection file is touched. No public
schema field added, removed or renamed. The two envelope implementations were
**not** merged (§46).

## Architecture invariants carried forward (§92)

> A response-budget predicate must identify the exact semantic surface it
> constrains. Model-visible budget, transport compatibility, internal accounting
> and product soft targets must not be collapsed into an ambiguous single fit
> concept.

> Compaction may only be held responsible for constraints it can actually
> influence — and a constraint it cannot reach must not be allowed to withhold
> the response it produced.

> Budget exhaustion is a normal bounded state, never an unreachable state.

## Stop condition

M178-F is complete. **M179 is licensed and NOT started.** No packing behaviour, no
related selection, no Django tuning, no live replication.
