# M146 — Workspace limitations at closure

Separates what M146 ships from what it demonstrably cannot do, and from what it
deliberately refuses to do. The distinction matters because the central
limitation below is a *measured architectural ceiling*, not unfinished work.

## 1. The central ceiling — global exact-symbol uniqueness

### Shipped

- Bounded exact-symbol probing across ready repositories (`maxDeepProbes`, 8).
- Truthful ambiguity: two repositories matching in the deciding tier is
  `ambiguous`, never a winner.
- Registration-order invariance within the probe bound.
- Zero indexes opened when index-free evidence decides.

### Limitation

Global exact-symbol uniqueness **cannot be proven from a truncated ready-repository
set**. When more ready members exist than the probe bound, a single match among
those probed establishes only that one *probed* repository defines the name — the
unprobed remainder is exactly where a rival would hide.

Measured counterexample, which is now a permanent regression guard:

```
10 ready repositories, probe cap 8
symbol defined in repository #1 AND repository #10
probe sees #1..#8 only

pre-fix   -> selected(#1)      wrong, and order-dependent
post-fix  -> ambiguous         "uniqueness is unproven"
```

Reversing registration order changed the apparent unique owner, so this also
broke registration-order invariance past the cap.

### Rejected unsafe behaviours

Each of these would have "resolved" the case by inventing authority:

- first observed match wins;
- registration-order, path-length or alias tiebreak;
- raw local retrieval-score comparison across repositories;
- silently reporting `selected` while the search space was truncated.

### Next evidence requirement

A cheap way to establish that a symbol is **definitely absent** from the
unprobed ready repositories. Finding one match is cheap; proving uniqueness
requires proving every other eligible repository does *not* match, and a bounded
deep search cannot make that global negative claim without another evidence
source.

## 2. What does not share the ceiling

Path and identity evidence need no deep probe, so they scale independently:

| Registered repositories | Indexes opened | Deep probes | Routing |
| --- | --- | --- | --- |
| 1 / 10 / 100 / 1000 | 0 | 0 | 0.065 / 0.183 / 0.342 / 2.042 ms |

The ceiling is specifically about **bounded index-derived uniqueness proof**, not
about workspace scalability. Explicit selection, absolute-path containment and
repository identity remain decisive at any workspace size.

## 3. M146-A residual imprecision

`config_hash` still conflates scope rules (`scanRepo`, `ignoreRules`,
`languageDetection`, `worktreeExclusions`) with document *construction*
(`documentChunks`, `documentPolicy`). A chunking change therefore surfaces as
`source_stale / incremental_refresh` rather than `derivation_changed /
full_rebuild`.

This is **diagnostic imprecision, not a stale-index safety failure**: it fails
closed, and `reindexRepo` escalates a `config_hash` mismatch to
`configuration_incompatible` → full rebuild. Deliberately not fixed during
closure.

## 4. Inherited debt M146 did not touch

- **M145 Workstream H** stayed MIXED: only the central workspace-selection seam
  was integrated. M146-B added the product retrieval seam that auto-routing
  needs and nothing more; the remaining MCP tools stay explicit-repository-only.
- **M145 workspace load** is ~3.5 s at 1000 members while routing is ~2 ms.
  These are separate concerns and must not be conflated — the B ceiling is about
  uniqueness proof, not workspace load.
- **`get_impact_graph` and `get_skeleton`** remain repository-scoped. No
  cross-repository call, reference or import relationships were synthesised;
  that requires dependency truth the index does not contain.

## 5. Scope M146 deliberately refused

- No global workspace index. A second persisted store would inherit its own
  derivation-compatibility, membership-invalidation, duplicate-identity and
  provenance problems — the failure classes M146-A spent a milestone closing.
- No cross-repository graph edges inferred from aligning import or package names.
- No blended cross-repository score.
- No persisted routing state: repository relevance stays query-time, so a routing
  edit cannot invalidate an index. Re-verified by the anti-drift closure guard.
