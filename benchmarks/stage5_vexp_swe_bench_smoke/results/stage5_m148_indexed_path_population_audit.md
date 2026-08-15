# M148-B — indexed-path eligibility audit

## 1. The defect, reproduced before any code changed

Fixture: three enabled members; `b`'s derivation refused by this runtime; both
`a` and `b` index `shared/pipeline.py`.

```
readiness   a ready | b not ready: schema_incompatible (derivation_changed) | c ready
query       pathHints: ["shared/pipeline.py"]

status      selected
selected    ["a"]
reason      a selected on indexed_path evidence.
decidingTier indexed_path
indexesOpened [a, c]
```

`b` was dropped from the population and the single ready match was reported as
the owner. "a owns this path" is a claim about `b`, which was never asked and
could not have answered. This is the exact logical error M147 removed from the
exact-symbol lane, surviving in the tier above it.

The defect was real, not merely architecturally suspected — which is why it was
measured first.

## 2. Why the lane had it

`nominateRepositories` derived every indexed lane's pool from one table:

```ts
EVIDENCE_REQUIRES_READY_INDEX[IndexedPath] === true
  -> pool = readyMembers
  -> probeTargets = readyMembers.slice(0, maxDeepProbes)
```

That table answers the right question — *may this lane READ derived state?* — and
`b`'s index must indeed never be read. What it silently also decided is *whose
answers the proof requires*, and those are different questions:

```
MAY NOT BE READ        is a safety rule about b's index.
CONTRIBUTES NO ANSWER  is a fact about what we know.
NOT ASKED IS NOT ABSENT.
```

The `maxDeepProbes` prefix had the same shape: a bound that existed for latency
quietly decided what could be concluded (the M146 finding, in a second lane).

## 3. Population, after

Eligible population = **every enabled member**.

| Member state | Contribution | Index opened? |
| --- | --- | --- |
| enabled, ready, within bound | `present` or `definitely_absent` | yes |
| enabled, refused / stale / schema-incompatible | `unknown (index_refused)` | **no** |
| enabled, ready, past `maxPathMembershipScans` | `unknown (beyond_scan_bound)` | no |
| enabled, ready, no worktree identity or unopenable | `unknown (probe_unavailable)` | attempted |
| **disabled** | outside the population entirely | no |

`present` means "carried decisive path evidence" — the same thing the lane
nominates on. M145's rule that an exact absolute-path match outranks a suffix
match is preserved: counting an outranked member as present would make an
unambiguous absolute path ambiguous the moment a similarly laid-out repository
joined the workspace.

## 4. Other lanes audited (§110)

| Lane | Derived? | Verdict |
| --- | --- | --- |
| `explicit_route` | no — registration identity | safe; explicit selection is not a uniqueness claim |
| `path_containment` | no — filesystem identity + registered roots | safe; an unknown member's indexed paths cannot cloud a location |
| `indexed_path` | yes | **defective, fixed by M148-B** |
| `exact_symbol` | yes | fixed by M147, unchanged here |
| supporting evidence (`collectSupportingEvidence`) | yes | safe: support is additive context, never a lead and never a uniqueness claim, so a prefix bound remains sound |
| M144/M145 failure-path routing | no — traceback frames route on absolute-path containment | safe; unaffected |
| M139 impact graph | repository-scoped | not applicable |

No other derived lane makes a uniqueness or absence claim over a ready-filtered
population. Nothing was broadened beyond the two lanes.

## 5. Bound justification (§49, §50)

The lane's access pattern was measured rather than assumed — the M146 mistake was
assuming a cost:

```
EXPLAIN QUERY PLAN SELECT path FROM files ORDER BY path
  SCAN files USING COVERING INDEX sqlite_autoindex_files_2
```

| | ARC (325 files) | TCKDB_v2 (1,232 files) |
| --- | ---: | ---: |
| read the whole path set | 63.4 us | 308.4 us |
| open + read + close (the router's real pattern) | 280.8 us | 754.2 us |
| projected 100 members | 28.1 ms | 75.4 ms |
| projected 1000 members | 280.8 ms | 754.2 ms |

`files` already carries a UNIQUE covering index on `path`, so **no new migration
was needed** for this lane — the correctness fix required no schema or access
change at all. The bound moved off the 8-member support cap onto
`maxPathMembershipScans` (default 1024), which is the same order of cost as the
exact-name lane's 1024 and is what lets a decisive answer survive an unrelated
repository joining the workspace (§53).
