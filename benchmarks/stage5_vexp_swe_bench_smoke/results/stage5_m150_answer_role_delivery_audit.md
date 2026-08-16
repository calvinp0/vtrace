# Answer-role delivery audit (M150, before implementation)

Traced on `86fed3dd` with the product path, before any code was changed. Every
number below is measured; the taxonomy in §8 of the brief is applied to each.

## Where the answer was lost

| case | pool rank | pool final | delivered as | classification |
|---|---|---|---|---|
| ARC ordering — `get_all_families` | **1** | 1.7640 | `support`, `signature` | nominated but pivot-**ineligible** |
| ARC ordering — `determine_family` | 2 | 1.7639 | `pivot` (lead) | — |
| generic `plugin_ordering` — `alpha` | 1 | 1.0001 | **not delivered**, `noContextResult` | discarded before nomination |
| generic `channel_ordering` — `process` | 1 | 1.0001 | **not delivered**, `noContextResult` | discarded before nomination |

`operationRole` runs inside `assemble()`, which is inside `hybridRetrieve` — so
it executes BEFORE pivot nomination and the pivot set is not built from a stale
ranking. §9's order-of-operations hypothesis is **refuted**: `scores.final`
already carries the relation when roles are assigned. The loss is entirely in
what the role layer will accept as evidence.

## Exact gate

`src/capsule/assignCandidateRoles.ts::classify`:

```
concretePointer = symbol > 0 || path > 0 || testToImpl > 0
directEvidence  = concretePointer || lexical >= 0.5
meetsPivotBar   = actionability === 1 && directEvidence
                  && localEvidence >= 0.3 && hubPenalty === 0 && !isGenericHub
```

Measured scorecards at the moment of classification:

| candidate | actionability | lexical | symbol | path | localEvidence | hubPenalty | mechanism |
|---|---|---|---|---|---|---|---|
| `get_all_families` | 1 | 0.0466 | 0 | 0 | 0.3333 | **0.0116** | 0.55 |
| `alpha` | 1 | **0** | 0 | 0 | **0** | 0 | 0.55 |
| `genericname.process` | 1 | **0** | 0 | 0 | **0** | 0 | 0.55 |

- `get_all_families` fails `directEvidence` (lexical 0.0466 < 0.5) **and**
  `hubPenalty === 0` (0.0116, earned for having seven callers and a dull name).
- `alpha` and `process` fail `directEvidence` **and** `localEvidence >= 0.3`, and
  are removed even earlier by the discard gate `localEvidence <= 0 && !anyProximity`,
  which is why they never appear in `candidate_scores` at all.

The `why_not_pivot` strings the product itself emits say the same thing:

```
no failing-test route; no symbol-name or likely-file pointer;
weak lexical match (0 < 0.5); issue name-overlap 0 (< 2)
```

## Root cause

All three conditions ask "is this candidate tied to the task by something about
ITSELF rather than by its neighbourhood?" and all three answer it exclusively
from NAME and PATH signals. A behavioural question is routinely answered by a
definition that matches neither — which is the same blind spot M150-G fixed one
layer up in the mechanism subject floor, restated in the delivery layer.

The two failure shapes have the **same** cause, contrary to §6's caution, and the
audit is what establishes that rather than assuming it: ARC's orderer clears the
local-evidence floor on domain affinity and is merely demoted, while the generic
implementers clear nothing and are discarded outright. Same gate, different
distance past it.

## What was NOT responsible

Checked and excluded before implementing:

- **Order of operations** — the relation is applied before nomination (above).
- **Dedupe, budget, content mode** — ARC's orderer was delivered, with a
  `signature`; nothing dropped it. The generic cases produce `noContextResult`
  because the pivot set is empty, not because content was unavailable.
- **Candidate source** — no rule keys on `operation_fact`.
- **Support-role policy** — the orderer was not claimed by `mechanism_support` on
  the ordering query (that lane is seeded from selected mechanism-bearing
  candidates and is inactive here).
- **Pivot ordering / lead selection** — never reached, because the candidate was
  not in the pivot set.
