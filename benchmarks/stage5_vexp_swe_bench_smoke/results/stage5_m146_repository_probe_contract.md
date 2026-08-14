# M146-B — Repository probe contract

## What a probe may do

A repository probe answers two bounded questions against a member's **own**
index, and nothing else:

```
indexedPaths()          -> the member's indexed relative paths
hasExactSymbol(name)    -> does this member define this exact local or FQ name?
```

Both are single SQL statements. **Zero source reads**, no graph traversal, no
retrieval, no scoring. Nomination must be cheaper than retrieval or the routing
stage would cost what it exists to avoid.

## When a probe may run

Only when both hold:

1. the member's index is **ready** — `EVIDENCE_REQUIRES_READY_INDEX` decides
   this per evidence kind, and the member pool a lane draws on is derived from
   that same table, so a lane added later cannot omit the gate;
2. no index-free tier already decided, unless composition was explicitly
   requested.

Consequence: a decisive absolute path opens **zero** indexes regardless of
workspace size, and a derivation-incompatible member is never opened at all —
not for paths, not for symbols, not for retrieval.

## Bounds

| Bound | Default | Purpose |
| --- | --- | --- |
| `maxDeepProbes` | 8 | ready members the indexed lanes may open |
| `maxReportedCandidates` | 4 | nominees reported when ambiguous |

Probes are counted **per member**, not per lane: consulting one index for both
the path and the symbol lane is one probe.

## Truncation is not uniqueness

When `maxDeepProbes` truncates the pool, a single match proves only that one
member among those probed defines the name. The unprobed remainder is exactly
where a rival would hide, so the result is reported `ambiguous` with
"uniqueness is unproven" rather than `selected`. Measured before this rule
existed: ten ready members, cap of eight, a symbol in the first and last —
reported `selected` on the first, and reversing registration order would have
named the other.

## No global workspace index

None was created. A second persisted store would inherit its own
derivation-compatibility, membership-invalidation, duplicate-identity and
provenance problems — the failure classes M146-A spent a milestone closing. The
existing per-repository indexes proved sufficient for bounded routing.
