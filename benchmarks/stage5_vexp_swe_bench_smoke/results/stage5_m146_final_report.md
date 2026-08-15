# M146 — Final report

**M146 overall: MIXED.**

| Workstream | Verdict | Reason |
| --- | --- | --- |
| M146-A — Runtime ↔ index derivation compatibility | **PASS** | Three severe defects found and closed; compatibility now fails closed on every index-producing semantic path, query-only changes provably reuse indexes, and remediation genuinely regenerates. |
| M146-B — Cross-repository retrieval foundation | **MIXED** | All mandatory scope complete and measured; exact-symbol uniqueness cannot be proven beyond the bounded ready-repository probe set. |
| **M146 overall** | **MIXED** | A complete milestone with one measured architectural ceiling. |

Not PASS: the >8-ready-repository symbol-uniqueness ceiling is real and
unresolved. Not INCOMPLETE: every mandatory implementation, benchmark,
acceptance and preservation step ran. Not FAIL: when uniqueness cannot be
proven the system abstains rather than returning a wrong repository.

## Commits

| Role | SHA |
| --- | --- |
| M145 functional predecessor | `88de1061c23dfbb7da112861278eec730a5e848d` |
| M146-A functional | `1302a2a`, `00b47bd`, `a3040e19b461136d359d901edb8ddf9f6f8a34a4` |
| M146-A evidence | `a95e0d4adba5a9b1bd90a60a4aad482f7fbe0165` |
| M146-B functional | `d7687b7`, `11335a1`, `f729f3d`, `d2a8254ef4f9f9a1524fda323cb23c6ab168fec8` |
| M146-B evidence | `9af5e5d7b37e5691b49d2c116ac609ac5fce3318`, `2ee3765f38c3dd5781d782c382bae1ba3103dbaf` |
| **M146 final functional** | **`d2a8254ef4f9f9a1524fda323cb23c6ab168fec8`** |

`2ee3765` and `a95e0d4` touch zero files under `src/`, so the final functional
candidate is `d2a8254` — the truncation fix — not the later evidence commits.
Branch `main`, nothing pushed by these sessions, no co-author trailers.

## M146-A — what it proved

The milestone question was distinct from identity and freshness: *can the
running VTRACE prove an existing index was derived under compatible semantics?*
Three severe defects said no.

1. **Persisted FTS came from skipped query-time code.** `buildFtsSearchText`
   lived in `src/retrieval/`, excluded from the fingerprints *by design* so
   ranking edits would not rebuild indexes — yet it generated stored
   `symbol_search_fts` rows. Measured: every fingerprint byte-identical,
   `ready: true`, and a rebuilt derivation that had silently lost `parsejson`
   and `computetotal`. Fixed by moving the tokenizer into `src/indexer/`, with
   write and query paths sharing one definition.
2. **Stored identity derivation was unfingerprinted.** `computeSymbolId`,
   `computeFileId`, `buildFQName`, `normalizeFilePath` and `isLanguage` decide
   which files exist in an index and what their identities are. Now covered.
3. **Rebuild could falsely certify stale state** — the most severe. A refused
   index, followed through the *recommended remediation*, had its fingerprints
   updated while its derivation was reused, making stale content permanently
   ready. `resolveDerivationRebuildReason` is now the single authority for both
   "may this index be consumed?" and "may a refresh reuse its derivation?".

Supporting work: a fail-closed value-import closure guard (all-import closure 66
files / 29 uncovered vs value-import 43 / 5 reviewed exemptions, each with a
rationale and a behavioural proof), and the `schema_changed` vs
`derivation_changed` split so `index_status` stops telling users the database
schema changed after a parser edit.

Residual: `config_hash` still conflates scope rules with document construction.
Diagnostic imprecision, not a safety failure — deliberately not fixed here.

## M146-B — what it shipped

Repository relevance is **tiered, not scored**:

```
explicit selection  >  absolute-path containment  >  indexed path  >  exact symbol
```

Highest tier producing candidates decides; more than one repository inside that
tier is `ambiguous`. No blended score, because cross-repository score
comparability was never established, and every available tiebreak — registration
order, path length, alias — is a semantic decision in disguise.

The split between tiers 2 and 3 and the rest carries M146-A into routing: a
derivation-incompatible index may not supply the evidence that selects it.
Tiers 0–1 remain available to a refused member, which is what makes
`not_ready` — "the right repository, repair it first" — expressible rather than
the misleading `no_match`.

Integration **composes** `assembleProductContext` once per selected repository
rather than modifying it, so repository-local retrieval cannot move.

## The truncation defect and the ceiling

The deep-probe cap that bounds query cost also truncated the pool the indexed
lanes saw, and a match in that prefix was reported as unique.

```
10 ready repositories, cap 8, symbol in #1 AND #10
pre-fix  -> selected(#1)   wrong, and reversing order named the other
post-fix -> ambiguous      "uniqueness is unproven"
```

Fixed to fail closed. That fix is also the ceiling that makes B MIXED: exact
symbol evidence can only establish uniqueness when every eligible ready member
was probed, so workspaces with more ready members than the cap abstain on
symbol-only queries.

Path and identity evidence do not share the ceiling — they open no index at all.

## Final M145 → M146 paired benchmark

M134 provenance-safe protocol, separate worktrees per side, each generating its
own index from its own fixture copy against the same immutable target corpus.

```
provenanceValid = true
sameFixtureHash = true   sameTargetCorpusHash = true
isolatedIndexes = true   authoritative = true
frozen50 changed = 0 / 50
```

| Metric | M145 | M146 | Δ |
| --- | ---: | ---: | ---: |
| Top-1 gold file | 38 | 38 | 0 |
| Top-3 gold file | 44 | 44 | 0 |
| Gold file anywhere | 48 | 48 | 0 |
| Gold symbol anywhere | 31 | 31 | 0 |
| Missing gold | 2 | 2 | 0 |
| Mean tokens | 1832.4 | 1832.4 | 0 |

Both suites' semantic hashes are byte-identical (django 0/20, cross_repo_30
0/30). The staged `a3040e1 → d2a8254` checkpoint is also 0/50 with
`provenanceValid=true`, so the M145 → M146-A span is 0/50 by construction.

**0 changed cases**, therefore nothing to attribute.

These numbers were re-executed; the M145-era 39 / 1850.14 came from a different
functional predecessor and runtime state. M145 itself measures 38 / 1832.4 in
this harness, which is why mixing historical metrics into a paired comparison
would have manufactured a regression that does not exist.

`cross_repo_30` is a **single-repository preservation suite** despite its name;
the workspace corpus is named separately.

## Real workspace acceptance

| Case | Result |
| --- | --- |
| ARC-specific (`get_dihedral`) | alone == explicit == auto, lead ARC, no TCKDB contamination |
| TCKDB-specific (`LevelOfTheory`) | alone == explicit == auto, lead TCKDB, no ARC contamination |
| Explicit-route parity (3 ARC + 3 TCKDB) | **6/6 byte-identical** — M145's gate, re-run after integration |
| Generic `main` (defined in both) | `ambiguous`, no context delivered |

Both real indexes were found refused under this runtime before acceptance could
run (ARC `derivation_changed`, TCKDB_v2 `schema_changed`) — the expected M146-A
consequence, and the first real instance of the case B was built for. Rebuilt
through the existing authoritative path (ARC 31 s, TCKDB 123 s). Their repaired
indexes remain current; restoring the refused state would regress readiness.

## Workspace corpus and acceptance table

18 / 18 case classes, corpus `m146_workspace_routing_corpus`.

| Case | Expected | Verdict |
| --- | --- | --- |
| explicit repo selection | selected repo | PASS |
| unique absolute path | owner repo | PASS |
| stale absolute-path owner | `not_ready`, index unopened | PASS |
| unique symbol within probe set | selected | PASS |
| ambiguous symbol | ambiguous | PASS |
| truncated symbol probe | ambiguous (both orders) | PASS |
| same relative path | ambiguous | PASS |
| identical clone | ambiguous | PASS |
| unrelated repo added | invariant | PASS |
| reversed registration order | invariant | PASS |
| failure path | owner repo | PASS |
| failure path, stale owner | `not_ready`, unopened | PASS |
| external failure path | `no_match` | PASS |
| fork divergence | evidence-driven; ambiguous where undiverged | PASS |
| no relevant repo | `no_match` | PASS |
| 2-repo composition | lead + support, both contribute | PASS |
| constrained budget | direct answer survives | PASS |
| 1000-repo path routing | 0 deep probes, 2.042 ms | PASS |

## Mixed readiness through the product path

| Case | Status | Indexes opened |
| --- | --- | --- |
| symbol only the stale member defines | `no_match` | stale member **never opened** |
| absolute path into the stale member | `not_ready` | stale member **never opened** |
| ready member beside a stale one | `selected` | ready member only |
| after repair, same symbol query | `selected` | repaired member |

## Preservation

| Suite | Result |
| --- | --- |
| M146-A compatibility + anti-drift | 25 / 25 |
| M141 readiness + cross-tool parity | 20 / 20 |
| M145 workspace + M146-B (`src/workspace`) | 108 / 108 |
| M132 worktree routing | 12 / 12 |
| Full suite | **4384 pass / 49 skip / 0 fail**, 4433 across 269 files |

Both typechecks clean; `git diff --check` clean. M132/M136/M137/M138/M139/M140/
M141/M142/M143/M144/M145 suites all pass in the full run, and the 0/50
byte-identical paired result is the aggregate evidence that no retrieval
semantics moved anywhere in the milestone.

The anti-drift closure guard confirms router, aggregator and the workspace
productContext integration remain **outside** the index write value-import
closure — repository routing stays query-time, so a routing edit cannot
invalidate an index.

A suite-stability regression appeared during closure (six load-induced 5 s
timeouts in unrelated pre-existing suites) and was traced to the cost of the new
workspace fixtures. Fixed by caching read-only fixtures and driving the
truncation invariant with an explicit small cap instead of the default: the file
went from 34 s to 5.7 s while gaining a reversed-order assertion, and the full
suite from 260 s to 137 s with 0 failures.

## Architectural conclusions

```
REPOSITORY IDENTITY          where does this data belong?
DERIVATION COMPATIBILITY     can this runtime trust how it was derived?
REPOSITORY RELEVANCE         does this ready repository matter to this query?

A STALE INDEX CANNOT PROVIDE THE EVIDENCE THAT SELECTS IT.
A REFUSED INDEX CANNOT BE REPAIRED BY REUSING ITS REFUSED DERIVATION.
QUERY-TIME ROUTING MUST REMAIN OUTSIDE PERSISTED INDEX DERIVATION.
FINDING A MATCH DOES NOT PROVE UNIQUENESS.
TRUNCATED SEARCH CANNOT PROVE GLOBAL NON-MEMBERSHIP.
WHEN UNIQUENESS IS UNPROVEN: ABSTAIN.
N REPOSITORIES DO NOT CREATE N × MODEL CONTEXT.
CROSS-REPOSITORY CONTEXT MAY COMBINE SOURCES; IT MAY NOT ERASE AUTHORITY.
```

## Recommended next milestone

**M147 — Bounded Repository Presence Proof** (investigation, not implementation).

> Can VTRACE cheaply establish that an exact symbol, path or entity is
> *definitely absent* from unprobed ready repositories, allowing bounded deep
> retrieval while still making truthful uniqueness claims?

Mechanisms to audit before building anything: per-repository exact-name
summaries, negative-presence filters (a Bloom-style summary can prove *definitely
absent* while *possibly present* still requires opening the index), manifest-level
name digests, workspace-level cached presence maps, lazy presence lookup.

Requirements any candidate must satisfy: false uniqueness impossible; routing
stays outside index derivation semantics unless a summary is deliberately
persisted *and* fingerprinted; workspace updates invalidate summaries correctly;
the same symbol in multiple repositories stays detectable; derivation-
incompatible members supply no presence truth; large-workspace routing stays
bounded.

Explicitly **not** recommended: raising the cap from 8 to 16, which moves the
cliff without addressing the architecture. Also out of scope: M145 Workstream H
(re-plumbing every MCP tool) absent a real task requiring it, and the ~3.5 s
1000-member workspace load, which is a separate concern from uniqueness proof.
