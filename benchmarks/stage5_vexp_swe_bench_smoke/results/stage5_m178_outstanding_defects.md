# M178 — outstanding defects

Everything M178 measured and did not repair. Each states what is known and what
would be required to close it.

## 1. Non-monotone delivery packing (`run_pipeline`)

```text
measured?               yes — M176, re-measured by M178-F
reproduced?             yes, unchanged, on django__django-10880
causal mechanism known? no — located in budgetDelivery.ts, not explained
repaired?               no
next work licensed?     YES — this is M179
```

Re-read under the post-split tree, identical to M176's record:

```text
max_tokens=400   orientation        model-visible 144
max_tokens=600   orientation        model-visible 144
max_tokens=800   delivery_failure   model-visible  47
max_tokens=1000  delivery_failure   model-visible  47
max_tokens=1600  orientation        model-visible 1260
```

One violation across the full 16-budget grid (at 800), two across the six-snapshot
corpus. M178 changed no packing, ordering or selection, and the sequence is
unchanged — as expected, since the fit-contract split is byte-identical.

**Dependency M178 records for M179:** the non-monotonicity is *not* caused by the
fit-predicate mismatch. It sits on the `run_pipeline` path, which M178-F showed has
no disagreement window at all (0 violations of either contract). M179 inherits a
settled definition of "fits at budget B" and a packer defect that is entirely its
own.

## 2. Related-selection instability under machine load

```text
measured?               yes — M176/M177
reproduced?             not re-measured by M178
causal mechanism known? partially — load-dependent, not code-dependent
repaired?               no
next work licensed?     no
```

M178 avoided it structurally rather than fixing it: every comparison runs both
arms in one process over the same in-memory object, so no scheduling difference
can reach a result.

## 3. The envelope floor is not perfectly deterministic (~1 token)

```text
measured?               yes — M177, re-encountered by M178-F
reproduced?             yes
causal mechanism known? YES — `timing` carries full-precision floats whose
                        decimal width varies, moving serializedCharacters by a
                        character or two
repaired?               no
next work licensed?     no
```

M178 hit this directly and it is worth recording as a methodological trap. A
naive before/after re-run of the M178-B corpus reported **20 decision differences
across 1,016 shared cases** — every one of them a specimen sitting exactly on its
envelope floor and tipping either way, and **none** of them the product change.
The paired in-process comparison then returned **1,140 of 1,140 byte-identical**.

Any milestone comparing envelope outcomes across two runs must either hold the
authoritative object fixed or expect ~2% boundary noise.

## 4. `modelVisibleEstimatedTokens` is a misnomer (NEW — measured, not repaired)

```text
measured?               yes — M178-A
reproduced?             n/a, it is a naming fact
causal mechanism known? yes
repaired?               no — deliberately
next work licensed?     no, unless a schema-versioning milestone opens
```

The field measures **five evidence keys only** (`edges`, `nodes`, `view`,
`directRelations`, `paths`). But M166 and M167 established that the *whole*
response is model-visible and billed, so the quantity that actually corresponds to
"what the model sees" is `estimatedTotalTokens`. The field name asserts the
opposite of what it measures, and it is the single most likely cause of a future
reader re-deriving M177's "the terminal is not enforcing its own condition"
reading.

**Not repaired because** the field is agent-visible output. Renaming it would make
normal responses differ byte for byte, which §53 prefers to avoid and which buys
nothing the two new predicate names do not already buy. The internal predicates
are now named for what they constrain (`impactResponseFitsEnvelope`,
`impactResponseMeetsEvidenceBudget`) and the field's true meaning is documented at
its definition.

## 5. The flat metadata allowance over-grants on small responses (NEW)

```text
measured?               yes — M178-B, mechanism derived and confirmed 60/60
reproduced?             yes
causal mechanism known? YES — width = allowance - actual metadata
repaired?               no — it is not clearly a defect
next work licensed?     no
```

`IMPACT_METADATA_ALLOWANCE_FLOOR_TOKENS` is a flat 800, so whenever real metadata
costs less, the surplus becomes headroom the evidence may occupy — which is how a
response can carry up to 41 more evidence tokens than `max_tokens` while remaining
inside every hard bound.

Recorded rather than repaired because **the alternative is worse**: tying the
allowance to measured metadata would convert the surplus from delivered evidence
into wasted envelope, and tightening the terminal to compensate would convert
bounded deliveries into declines (M178-D measured that trade at 25 delivered edges
for at most 41 tokens each). It is a design consequence with a known sign, not an
error.

## 6. Repository-wide envelope sweep still not performed

```text
measured?               no
reproduced?             n/a
causal mechanism known? n/a
repaired?               n/a
next work licensed?     no
```

M177's narrow claim stands and M178 does not widen it. M178-A inventoried the fit
predicates reachable from `run_pipeline`, `get_code_context` and
`get_impact_graph`; it did **not** sweep the repository for further envelope
implementations. `search_logic_flow` accepts a `max_tokens` and was not audited.

**The M178 claim is deliberately narrow: the audited response-fit contract is
coherent for the measured model-facing envelope paths.** Not "all VTRACE budgeting
is now correct".
