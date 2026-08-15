# M147 — Bounded Repository Presence Proof

**Verdict: PASS.**

Functional predecessor `d2a8254ef4f9f9a1524fda323cb23c6ab168fec8` (M146).

M146 closed on a measured ceiling: finding one exact-symbol match is cheap, but
proving it is the *only* match means proving every other eligible repository does
not match, and a search truncated at eight members cannot make that global
negative claim. M147 asked whether a cheaper presence-evidence layer could close
the gap. It can — and the layer turned out not to be a new persisted structure.

## 1. The finding

The cost that forced M146's bound was not "opening indexes is expensive". It was
that the routing query had no access path:

```sql
SELECT 1 FROM symbols WHERE local_name = ? OR fq_name = ? LIMIT 1
-> SCAN symbols
```

`symbols` was indexed on `(file_id, start_byte, id)` and on nothing else. A
present name could exit at the first matching row; an **absent** name had to
consider every row. So absence — the only direction a uniqueness proof needs —
was the expensive one, and it was expensive in proportion to the repository:

| | present | **absent** |
| --- | ---: | ---: |
| psf__requests-1142 (1,336 names) | ~5 µs | **42 µs** |
| ARC (15,805 names) | ~5 µs | **1,332 µs** |
| TCKDB_v2 (49,218 names) | ~9 µs | **4,974 µs** |

Opening SQLite, the suspected cost, is 0.02–0.14 ms even for TCKDB's 539 MB
index — two orders of magnitude below the scan it was blamed for.

## 2. What shipped

**A presence proof over every eligible member, not a prefix of the ready ones.**
`src/workspace/repositoryPresence.ts` decides what a set of answers entitles a
caller to conclude:

```text
|present| > 1                    -> AMBIGUOUS
|unknown| > 0                    -> UNPROVEN
|present| = 1 and |unknown| = 0  -> UNIQUE
|present| = 0 and |unknown| = 0  -> ABSENT
```

`UNKNOWN` is a refused index, a member past the scan bound, or a probe that would
not open — and one of them withholds the claim. The eligible population widened
from ready members to **all enabled members**, which is the clause M146 was
missing: it filtered refused members out of the pool and then reported uniqueness
over what remained, silently converting "we did not ask them" into "they do not
have it".

**An explicit, versioned, atomic, additive access-path migration.**
`src/access/symbolNameAccessPath.ts` installs `idx_symbols_local_name` and
`idx_symbols_fq_name` into an index that already exists. Same derived content,
new physical capability, **no rebuild**. It lives outside `src/indexer` and
`src/db` so it moves no derivation fingerprint, and it is never invoked during a
query.

**Observed, not assumed, performance.** One membership statement serves both
worlds — with the access path SQLite answers it with keyed lookups, without it
scans — so the two paths cannot disagree; the equivalence is structural. Which
path was taken is read from the database catalogue and reported per member, so
the router never bounds its cost on a speed it has not checked for.

## 3. Frozen50 — single-repository preservation

| Metric | M146 | M147 | Δ |
| --- | ---: | ---: | ---: |
| Top-1 | 38 | 38 | 0 |
| Top-3 | 44 | 44 | 0 |
| Gold file anywhere | 48 | 48 | 0 |
| Gold symbol anywhere | 31 | 31 | 0 |
| Missing gold | 2 | 2 | 0 |
| Mean tokens | 1832.4 | 1832.4 | 0 |

**0 / 50 changed**, with byte-identical CSVs on both `django` (20) and
`cross_repo_30` (30). `cross_repo_30` is recorded, as M146 recorded it, as a
single-repository preservation suite rather than a workspace benchmark.

Provenance: `d2a8254..HEAD` touches only `src/workspace/*.test.ts`, so HEAD's
production tree *is* the M146 functional predecessor. The predecessor side was
executed by stashing the candidate's tracked source at HEAD — a true paired
comparison against the declared predecessor. The committed retrieval baselines
are stale (generated at `7b29882`, before M140–M146 moved `src/`), so a
committed-baseline diff would not have been authoritative; the stash A/B proof
needs no baseline.

## 4. Workspace improvement

| Case | M146 | M147 | Proof basis | Deep probes | Verdict |
| --- | --- | --- | --- | ---: | --- |
| >8 ready, unique exact symbol | ambiguous / no_match | **selected** | 1 present + 11 proven absent | 12 | correct |
| >8 ready, duplicate exact symbol | ambiguous | ambiguous | 2 present | 12 | correct |
| >8 ready, no owner | no_match | no_match | 0 present, 12 checked | 12 | correct |
| stale unknown member | selected (unsafe) | **ambiguous** | 1 present + 1 unknown | 11 | correct |
| 1000 ready, unique symbol | no_match | **selected** | 1 present + 999 proven absent | 1000 | correct |
| 1000 ready, common symbol | ambiguous | ambiguous | 1000 present | 1000 | correct |

No row says `selected` without a complete absence proof: every one of them
reports `unknown = 0`.

The 1000-member unique-symbol case is the primary acceptance (§54). The owner is
member 742 — past any prefix bound — so M146 reported `no_match`: not a wrong
answer exactly, but a claim ("no repository carries evidence") made over 992
members it never asked. M147 selects it in **240 ms** with the access path,
650 ms without.

## 5. Real repository acceptance

A staged workspace of **10 ready real repositories** (ARC, TCKDB_v2, and eight
copied benchmark checkouts, freshly indexed outside the repository tree), against
a deep-probe cap of 8:

| Control | Result |
| --- | --- |
| ARC-only symbol `ACTIONS_PATTERN` | **selected(ARC)** in 3.19 ms; 9 proven absent, 0 unknown |
| — same query, bound at the M146 cap | `no_match` — ARC was never asked |
| TCKDB-only `ACTIVE_MACHINE_REVIEW_PROMPT_VERSION` | **selected(TCKDB_v2)**, no ARC contamination |
| `main`, `setup`, `run`, `get`, `parse` | ambiguous, present-set equal to an independent SQL census every time |
| absent identifier | `no_match`, all 10 checked |
| one member made derivation-incompatible | selected → **ambiguous** → selected after repair |
| registration order (4 permutations) | **1 distinct outcome**, proof fields identical |

Every routing verdict was checked against an independent census computed by plain
SQL over the same indexes — the router is not permitted to be its own oracle.

## 6. Cost

Access-path migration on the ten real repositories: **132 ms total**, including
39.7 ms for TCKDB's 570 MB index. Storage 0.67–3.34 % of index size, 7.7 MB in
total. No repository was reindexed.

Absent-name sweep under the router's own access pattern (every opened probe held
for the request):

| Ready members | small (3.8 MB) | medium (22 MB) | large (98 MB, ARC) |
| --- | --- | --- | --- |
| 10 | 5.0 → 2.8 ms | 29.7 → 3.6 ms | 29.0 → 2.5 ms |
| 100 | 91.8 → 44.2 ms | 214.4 → 35.3 ms | **11,951 → 65.7 ms** |
| 1000 | 771.5 → 354.6 ms | — | — |

The fallback is adequate to about ten members of any size. Beyond that it is not:
at 100 ARC-sized members it costs twelve seconds and degrades superlinearly as the
working set outgrows page cache, while the keyed path stays flat. **That
measurement, and only that measurement, is why the access path exists.**

## 7. Correctness controls

| Property | Result |
| --- | --- |
| False negatives (name defined but reported absent) | **0** over 65,023 real names, both access paths |
| False positives (near-miss and wildcard names) | 0 |
| Uniqueness claimed while any member unreached | **0** at bounds 1, 4, 8, 11 |
| False unique repository selections | **0** across every deterministic control |
| Registration-order dependence | none, in verdict or in any reported field |
| Refused index supplying absence truth | prevented; contributes `unknown / index_refused` |
| Incremental add / remove / rename | no stale PRESENT, no stale ABSENT |
| Migration content neutrality | derived rows byte-identical; no fingerprint moved |

Full suite **4411 pass / 0 fail / 49 skip**; both typechecks clean;
`git diff --check` clean.

## 8. What changed in the M146 corpus

Two of the eighteen classes changed expectation, both toward withholding a claim:

1. **"a stale member never blocks a ready member's answer"** now reports
   `ambiguous`. M146's `selected` asserted that the ready member was the *only*
   definer — a statement about the refused member, which was never asked.
   Mandated by §40. Repairing the index restores selection.
2. **truncation soundness** keeps the identical invariant but is now governed by
   `maxPresenceScans` rather than `maxDeepProbes`, and names the members it could
   not reach instead of reporting a bare ambiguity.

Sixteen classes are unchanged; eleven new classes were added.

One defect was found and fixed during acceptance: a bounded scan that found
nothing reported "No repository carries evidence for this request" — itself a
global negative over members it had not asked. The status stays `no_match`
(nothing was found, no repository is selected) but the reason now names the
unreached members.

## 9. Bounds

| Bound | Default | Governs |
| --- | ---: | --- |
| `maxDeepProbes` | 8 (unchanged) | indexed-**path** lane |
| `maxPresenceScans` | 1024 | exact-**symbol** membership questions |

The cap was **not** raised. Raising a cap moves the cliff; the ceiling was never
about the number 8. A member past `maxPresenceScans` is `unknown` and fails
closed exactly as a truncated deep search did.

## 10. Limitations

- **The `indexed_path` tier still has the eligibility hole.** It nominates over
  ready members only, so a refused member cannot refute a path-uniqueness claim
  either. It retains M146's truncation guard, so it fails closed on the bound —
  but it does not yet have the rule M147 gave the symbol lane. Scoped out by §16
  and §45; this is the top follow-on.
- **No invocation surface for the migration.** It is a first-class tested
  operation with no CLI or MCP command in front of it, so a user cannot yet run
  it. Fresh indexes also do not receive the access path, because wiring it into
  the indexer would place it in the anti-drift closure and require an exemption
  plus its behavioural control — deliberately left for review rather than added
  late in this milestone.
- **Common names remain ambiguous, correctly.** A presence proof helps with
  sparse identifiers. `main` in 1000 repositories is 1000 owners, and saying so
  is the right answer.
- **1000 members of ARC size were not materialised** (~98 GB). The large class is
  measured to 100 and the omission is recorded rather than extrapolated.
- **The router holds every opened probe for the request.** At 1000 members that
  is 1000 open SQLite connections. Bounded and measured, but the presence lane
  needs nothing after its answer, so releasing probes as it goes is available and
  unimplemented.

## 11. Artifacts

Audit: `stage5_m147_identifier_population{_audit.md,.json}`,
`stage5_m147_presence_mechanism_comparison.md`,
`stage5_m147_presence_mechanism_metrics.json`,
`stage5_m147_presence_proof_contract.md`.

Mechanisms: `stage5_m147_{exact_set,hashed_set,bloom,direct_db_probe}_measurement.json`.

Correctness: `stage5_m147_{false_negative_controls,summary_freshness,incremental_summary_equivalence,summary_compatibility,stale_repo_presence_guard}.json`.

Routing: `stage5_m147_{presence_routing_controls,truncated_maybe_set,registration_order,large_workspace_uniqueness,common_symbol_ambiguity}.json`.

Real acceptance: `stage5_m147_{real_large_workspace,arc_unique_symbol,tckdb_unique_symbol,real_common_symbol}.json`.

Performance: `stage5_m147_{presence_performance,presence_storage,workspace_scaling}.json`.

Benchmark: `stage5_m147_{checkpoint_paired,changed_case_ledger,workspace_changed_case_ledger,preservation}.json`.
