# M148-B — indexed-path truth contract

## The rule

```
present > 1                      -> AMBIGUOUS
unknown > 0                      -> UNPROVEN
present = 1 && unknown = 0       -> UNIQUE
present = 0 && unknown = 0       -> ABSENT / NO MATCH
```

Identical to M147's, because it is literally M147's: `proveExactUniqueness`
consumes observations and knows nothing about what was observed. M148-B passes
the lane's noun (`indexes this path` rather than `defines this name`) so the
reasons a user reads describe the question that was actually asked, and reuses
everything else. No second lattice, no framework.

The asymmetry is deliberate and unchanged: two present repositories are
`ambiguous` even while others are unknown, because a further answer could not
reduce the count below two. `unproven` means *a missing answer could have changed
this*; here none could.

## Status mapping

The lane keeps the existing nomenclature rather than inventing an `unproven`
status:

| Proof | Router status | Reason |
| --- | --- | --- |
| `unique` | `selected` | `a selected on indexed_path evidence.` |
| `ambiguous` | `ambiguous` | `2 repositories index this path: a, b.` |
| `unproven` (present = 1) | `ambiguous`, nothing selected | `a indexes this path, but 1 eligible repository/repositories could not be checked, so it is not provably the only one: b (index_refused).` |
| `unproven` (present = 0) | `no_match`, nothing selected | `No checked repository indexes this path, but 1 ... could not be checked: b (index_refused).` |
| `absent` | `no_match` | `No repository carries evidence for this request.` |

`no_match` with unknown members is a safe OUTCOME with a truthful REASON: nothing
is selected either way, but the sentence may not assert a global negative the
scan never established. That is exactly the shape M147 settled on for the symbol
lane, kept identical here so the two lanes cannot drift apart.

## Unknown is a class of remedy

| Reason | What it means | Remedy |
| --- | --- | --- |
| `index_refused` | this runtime will not read the member's derived state — refused derivation, incompatible schema, or a source snapshot that has moved on | repair that index |
| `beyond_scan_bound` | the bound was reached before this member | raise `maxPathMembershipScans` |
| `probe_unavailable` | ready, but its index could not be opened or scoped | investigate that member |

The precise readiness verdict (`derivation_changed`, `head_changed`, ...) travels
in `reposExcludedNotReady`; the unknown reason names the class of remedy, which is
what a caller acts on.

## What did NOT change

| Property | Status |
| --- | --- |
| explicit selection is the highest authority | unchanged — needs no proof, opens no index |
| absolute-path containment outranks indexed path | unchanged — index-free identity, unaffected by unknown members |
| a stale member's index is never opened | unchanged, and now also true while it BLOCKS a claim |
| exact-symbol lane (M147) | unchanged; each lane waits on its own proof only |
| registration order does not decide anything | unchanged, re-measured both orders |
| disabled members are outside workspace routing | unchanged |
| one global lead, bounded cross-repo support | unchanged |

## Auto-repair is a separate question (§57)

When a member is unknown, the lane returns truthful state. It does not rebuild
anything: deciding to repair an index because a query wanted an answer is a
policy decision, and M146-A made the index lifecycle explicit on purpose.
