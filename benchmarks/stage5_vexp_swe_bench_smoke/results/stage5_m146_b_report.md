# M146-B — Cross-repository retrieval foundation: final report

**Verdict: M146-B MIXED.** All mandatory scope is complete and measured —
product integration, single-repository preservation, the paired benchmark, both
real workspace acceptances, the full 18-class corpus, and preservation. One
genuine capability ceiling remains, described in §7: symbol evidence cannot
establish uniqueness beyond the deep-probe cap, so a workspace with more ready
members than the cap abstains on symbol-only queries rather than answering.

Per §76 that is MIXED, not PASS. It is not INCOMPLETE — nothing mandatory is
missing — and not NOT PASS, since the capability works and fails closed.

**M146 overall remains INCOMPLETE and is NOT final-closed by this session.**

| | |
| --- | --- |
| M146-A functional predecessor | `a3040e19b461136d359d901edb8ddf9f6f8a34a4` |
| routing | `d7687b7b94f5122ab196d249a0a39cff421c8161` |
| aggregation | `11335a17a9bdbbf56780351a6e7e6f32a5a12a28` |
| earlier B evidence | `9af5e5d7b37e5691b49d2c116ac609ac5fce3318` |
| product integration | `f729f3d` + the truncation fix in this session |
| Branch | `main`, local commits, nothing pushed by this session |

## 1. What changed in the product path

Routing and aggregation previously existed only as tested modules, so M146-B
changed no real behaviour. They are now reached through the authoritative
`productContext` seam.

The integration **composes** `assembleProductContext` rather than modifying it.
Repository-local retrieval keeps every semantic M122–M145 established because it
is literally the same call; what is added is choosing which repositories to call
it against and merging results under one budget. There is no second capsule and
no parallel selection pipeline — M142 already measured what duplicated context
representations cost.

```
request
  ↓  workspace routing (tiered, index-free lanes first)
  ↓  readiness gate
  ↓  existing assembleProductContext, per selected repository
  ↓  bounded aggregation under ONE budget
  ↓  one authoritative productContext
```

## 2. Single-repository preservation

Two independent proofs, because output equality alone would not distinguish
"cannot happen" from "did not happen this time".

**Structural.** A test walks `src/` and fails if any production file outside
`src/workspace` imports the router, the aggregator, or the integration layer.
It also asserts `assembleProductContext` still mentions no workspace type.
Ordinary requests cannot reach the new code.

**Measured.** The mandatory paired benchmark, `a3040e1` → candidate, via the
M134 provenance-safe framework with separate git worktrees per side and each
side generating its own index from its own fixture copy:

```
provenanceValid = true
frozen50 changed = 0 / 50
django       0/20   semantic hashes byte-identical
cross_repo_30 0/30  semantic hashes byte-identical
```

| Metric | a3040e1 | M146-B | Δ |
| --- | --- | --- | --- |
| Top-1 gold file | 38 | 38 | 0 |
| Top-3 gold file | 44 | 44 | 0 |
| Gold file anywhere | 48 | 48 | 0 |
| Gold symbol anywhere | 31 | 31 | 0 |
| Missing gold | 2 | 2 | 0 |
| Mean tokens | 1832.4 | 1832.4 | 0 |

Top-1 38 and 1832.4 tokens were measured on **both** sides in this invocation.
The M145-era figures (39 / 1850.14) came from a different predecessor state and
were deliberately not copied; both sides agreeing exactly is what the gate needs.

`cross_repo_30` is recorded as a **single-repository preservation suite** — each
of its tasks targets one repository, so it is not a workspace benchmark and is
not named as one.

## 3. Real workspace acceptance

Both real indexes were found `not ready` under this runtime (ARC
`derivation_changed`, TCKDB_v2 `schema_changed`) — the expected consequence of
M146-A's fingerprint change, and a real instance of the scenario B was built
for. Both were rebuilt through the existing authoritative path (ARC 31 s,
TCKDB 123 s) before acceptance.

| Case | Result |
| --- | --- |
| ARC-specific (`get_dihedral`, symbol unique to ARC) | alone == explicit == auto, lead ARC, no TCKDB contamination |
| TCKDB-specific (`LevelOfTheory`, unique to TCKDB) | alone == explicit == auto, lead TCKDB, no ARC contamination |
| Explicit-route parity, 3 ARC + 3 TCKDB queries | **6/6 byte-identical** (M145's gate, re-run after integration) |
| Generic vocabulary (`main`, defined in both) | `ambiguous`, no context delivered, no forced winner |

Routing evidence is genuine symbol ownership, not the repository display name.
No ARC↔TCKDB two-repository task was invented; §43 permits the synthetic fixture
for the composition acceptance, and real repositories validate routing,
isolation, parity and ambiguity.

## 4. Mixed readiness through the product path

| Case | Status | Indexes opened | 
| --- | --- | --- |
| symbol only the stale member defines | `no_match` | stale member **never opened** |
| absolute path into the stale member | `not_ready` | stale member **never opened** |
| ready member beside a stale one | `selected` | ready member only |
| explicit selection beside a stale one | `selected` | none probed |

The ledger records `indexesOpened` for every stale-index case, because an
outcome-only record would pass even if the refused index had been read.

## 5. Cross-repository composition

A task spanning a backend and a client selects backend as lead (index-free path
evidence) with client as bounded support (weaker tier), opens both indexes,
delivers items from both, and stamps every item with its repository identity.

- Shared budget: three repositories offering 1000 tokens against a 300 budget
  deliver 200. N repositories never create N× context.
- Constrained budget: with room for only the direct answer, the lead survives
  and support is omitted rather than displacing it.
- Composition is **off by default**, so an ordinary workspace query keeps the
  measured zero-probe cost.
- Support is drawn only from tiers strictly weaker than the lead, so the frozen
  rule that picks the lead is untouched, and support must itself be ready.

## 6. A defect this session found and fixed

The deep-probe cap that keeps cost independent of workspace size also truncates
the pool the indexed lanes see. Measured: ten ready members, cap of eight, a
symbol defined in the first and the last — the router reported `selected` on the
first. The truthful answer is ambiguous, and reversing registration order would
have named the other one, so both §110's "ambiguous cases do not silently
choose" and §67's order invariance failed past the cap.

Fixed by failing closed: a match found in a truncated pool is reported
`ambiguous` with the reason "uniqueness is unproven", never `selected`. One
match among a prefix is not a unique match.

## 7. Remaining limitation (why MIXED)

The fix is correct but it is also a ceiling. Symbol evidence can only establish
uniqueness when every ready member was probed, so a workspace with more ready
members than `maxDeepProbes` (default 8) abstains on symbol-only queries instead
of answering them. Path containment is unaffected — it is index-free and probes
nothing — so decisive path queries still scale to 1000 members with zero indexes
opened.

Options for closure, none taken here because each needs its own measurement:
raise the cap and accept linear probe cost; add a cheap workspace-level symbol
digest so uniqueness can be refuted without opening every index; or treat the
truncated case as "selected, uniqueness unproven" and let the caller decide.

## 8. Scaling and cost

| Registered repos | Indexes opened | Deep probes | Routing |
| --- | --- | --- | --- |
| 1 | 0 | 0 | 0.065 ms |
| 10 | 0 | 0 | 0.183 ms |
| 100 | 0 | 0 | 0.342 ms |
| 1000 | 0 | 0 | 2.042 ms |

For a decisive index-free path. Probes are single bounded SQL statements against
a member's own index — zero source reads during routing. Registry resolution is
unchanged from M145's measured ~3.5 s at 1000 members and is excluded from
`routingMs`.

## 9. Preservation

`4382 pass / 49 skip / 0 fail` before the truncation fix; final counts in the
session report. Both typechecks clean, `git diff --check` clean.

- **M146-A**: closure guard and compatibility suite pass. The new workspace code
  did **not** enter the index write closure — repository routing stays
  query-time, so routing edits cannot invalidate indexes. No routing state is
  persisted in any index.
- **M145**: workspace suite unchanged; explicit ARC+TCKDB parity re-proven 6/6.
- **M144 / M143 / M142 / M141 / M140 / M139 / M138 / M137 / M136 / M132**: all
  suites pass unchanged in the full run. Frozen50's 0/50 and the byte-identical
  semantic hashes are the aggregate evidence that no retrieval semantics moved.

## 10. Recommended next action

A separate **M146 final closure** session, reconciling M146-A PASS with M146-B
MIXED into the overall milestone verdict, running the final preservation and
provenance pass across `88de106 → M146 final`. The truncation ceiling in §7 is
the first candidate for M147 scope.
