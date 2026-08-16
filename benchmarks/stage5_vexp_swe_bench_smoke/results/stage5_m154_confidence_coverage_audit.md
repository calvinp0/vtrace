# M154 — confidence and coverage audit

The decision record behind `productContext.coverage`: what was already there, what
each existing field actually means, and why M154 added three constants instead of
a fourth number.

## Every confidence an agent can see

| Field | Where | What it actually means | Coverage claim? |
| --- | --- | --- | --- |
| `inspectFirst.confidence` | retrieval responses | How **specific the lead signal** is: did the winner carry an edit-site phrase and/or behaviour vocabulary | none |
| impact edge `confidence` | `get_impact_graph` | Always `null` — "no probabilistic confidence is claimed" | none |
| local-evidence `confidence` | impact relations | `high / medium / unresolved`, paired with `evidenceKind` naming its source | none |
| `intentConfidence` | planner diagnostics | How firmly intent classification landed | none |
| rule `confidence` | project rules | Rule strength | none |

Checked against `buildInspectFirst`: the retrieval confidence is derived only from
`editSiteSignal(roleReason)` and `behaviorHits(item)` on the winning candidate. It
is an honest name for what it computes.

**So no existing confidence field overclaimed.** The problem was the absence of
anything else: with completeness unstated, the only visible quality signal was
free to be read as confidence in relevance, in interpretation, in evidence
sufficiency, *and* in search completeness at once.

> Confidence that the returned lead is useful is not confidence that the search
> was exhaustive.

## Why not another number

§12's preference, and the right call. `confidence` + `coverageConfidence` +
`absenceConfidence` + `searchConfidence` would be four overlapping scales, three of
which have no measurement behind them. Ranked retrieval's inability to settle
absence is not probabilistic — it is **structural**, true of every response
regardless of how good the lead is. Structural facts belong in structural state.

## Coverage vocabulary already in the product

Audited before adding anything (§13, §76):

| Concept | Where | Meaning |
| --- | --- | --- |
| `not_observed` / `bounded_absence` / `authoritative_absence` | `workspace/evidenceClaims.ts` | How firmly a negative is settled |
| `CAPABILITY_SETTLES_MEMBER_ABSENCE` | same | Which capability may state which strength |
| `EvidenceCoverage` | same | considered / answered / refused / omittedByBound / complete |
| `coverageComplete` | workspace census | Every selected member returned an answer |
| `omittedByBound` | workspace census | Member **detail records** not serialized — a display bound |
| `resultState` | product response | `resolved` / `no_result` / `delivery_failure` |
| `delivery.status` | product response | `complete` / `compacted` / `failed` / `no_result` |

The vocabulary was sufficient and well-reasoned. What was missing is that **none
of it was attached to a `get_code_context` answer**: the tool agents actually call
was the one tool that said nothing about what its result settled.

`resultState` came closest and is a *delivery* fact, not an epistemic one.
`no_result` correctly means "retrieval missed" — but nothing said what a miss does
and does not prove.

## What M154 added

```
coverage: { mode: "selective_task_retrieval",
            absenceClaim: "not_observed",
            enumerationComplete: false }
```

Additive, optional-shaped, on the existing `ProductContextResponse` — no parallel
response type, no `SearchContractV2`. `absenceClaim` reuses `NegativeClaimStrength`
rather than inventing a second scale, and `not_observed` is exactly where
`CAPABILITY_SETTLES_MEMBER_ABSENCE[RankedRetrieval] = false` already placed this
lane.

Three constants, on purpose. They are not a measurement; they are the contract
made visible. The failure being prevented is a reader inferring the opposite from
a response that never stated either way.

## Axes kept apart

| Axis | Question | Field | May it be read as retrieval completeness? |
| --- | --- | --- | --- |
| Workspace coverage | Which repositories were accounted for? | `coverageComplete` | **No** |
| Retrieval coverage | What task evidence came back? | `productContext.coverage` | it *is* this axis |
| Exact absence scope | What has exact lookup ruled out? | `NegativeClaimStrength` | **No** |

M149's `coverageComplete` was **not** repurposed. A complete member scan says every
repository answered; it says nothing about whether the returned code evidence is
complete. `searchContract.test.ts` pins both readings, including that the exact
lanes keep `true` and ranked retrieval keeps `false`.

## Response size

Three short fields, once per response. Mean rendered bytes across the 19-case
reuse corpus: **50,867 → 51,213 (+0.68%)**, and part of that is the coverage
sentence replacing a longer anti-search paragraph. No per-result caveat text was
added — the tool description explains the semantics once (§74).
