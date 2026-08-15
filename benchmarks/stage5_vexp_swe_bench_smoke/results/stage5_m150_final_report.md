# M150 — Behavioral Decision-Point and Execution-Mechanism Retrieval (final)

**Verdict: MIXED.**

A → PASS · B → PASS · C → PASS · **D → MIXED** · **E → PASS**.

D falls one requirement short: the explicit ARC ordering query still leads with a
symbol-name accident. §86 names that case exactly ("mechanism_support works but
explicit ordering query still fails"), so the milestone closes MIXED. Everything
else in D and all of E is done and measured.

- M149 predecessor `2aaac750b326478bb3f29576aa1454365d0f734d`
- checkpoint 1 `ab8e4f02eaacdbcfa8fc56f1b056db232ce1452c`
- checkpoint 2 `ebc4fda7d42cfe8706e9ee128fe56ec8e5405a83`
- **final functional `650e916`**
- Branch `main`, ahead 25, **nothing pushed**, no co-author trailers.

Functional commits: `09a39e2` · `ee35b05` · `9a81a1c` · `ab8e4f0` · `ebc4fda` ·
`650e916`. No prior commit rewritten.

**Mechanism weights unchanged** (direct 0.55, partial 0.20, ceiling = direct,
strongest single fact). **Subject-alignment policy unchanged**. Nothing in this
phase touched either (§3, §4).

---

## 1. What this phase added

**Bounded causal support discovery.** `get_all_families` was classified before
anything was built: `not_generated` — absent from the pool, not ranked-and-dropped
(§8). So it was a discovery problem, and the fix is a role, not a score.

Seeded only from already-selected pivots carrying mechanism evidence, it follows
the operand provenance recorded at index time, then one exact `calls` edge:

```
determine_family
  --operand_provenance--> get_reaction_family_products
  --exact_call---------->  get_all_families   (ordering_established, result-bearing)
```

Measured on ARC: **depth 2, 4 causal edges examined, 4 helpers examined, 1
eligible, 1 selected, 0 source reads, 2.98 ms.** Caps: seeds 3, depth 2, helpers
examined 24, selected **1**.

`resultBearing` is the negative control that makes it safe. A helper that sorts a
list and *returns* it establishes the order its caller consumes; one that sorts a
list to log it and returns something else does not. Both contain `sorted(...)`.

**The decision slice**, as its own content mode. The statement is now located
deliberately rather than being present by luck when the whole body fits (§48), and
a budget-compressed decider delivers the slice instead of a bare signature.
Slices are real source, never paraphrase (§24).

| slice | file lines | deciding line | lines | bytes |
| --- | --- | --- | --- | --- |
| `determine_family` decision | 647–650 | **648** | 4 | 171 |
| `get_all_families` ordering | 765–771 | **769** | 7 | 471 |

**Roles stay distinct.** `mechanism_support` is a separate value from
`orchestration_support`; neither is relabelled (§30, §64).

## 2. Corpus — four sides, identical fixtures

Two fixtures were lexically incoherent (a decision documented in terms of
*entries* whose helper spoke of *candidates*), so queries were being answered by
accident. The fixtures were fixed rather than the queries reworded toward
implementation vocabulary (§47), and **all four sides were re-run afterwards**, so
every column below is comparable.

| metric | M149 | `ab8e4f0` | `ebc4fda` | **final** |
| --- | --- | --- | --- | --- |
| correct mechanism lead | 7 | 9 | 9 | **9** |
| correct Top-1 | 7 | 9 | 9 | **9** |
| correct Top-3 | 11 | 13 | 13 | **13** |
| correct anywhere | 13 | 13 | 13 | 13 |
| missing mechanism | 2 | 2 | 2 | 2 |
| same-operation wrong-subject **lead** | 0 | 0 | 0 | **0** |
| same-operation wrong-subject **bonus** | 0 *(no capability)* | **2** | 0 | **0** |
| negative-control bonus | 0 | 0 | 0 | **0** |
| negative-control **delivered** | 1 | 0 | 1 | **0** |
| decision statement visible | 5/9 | 6/9 | 6/9 | 6/9 |
| **ordering helper visible** | 2/4 | 2/4 | 2/4 | **3/4** |
| **mechanism support used** | 0 | 0 | 0 | **1** |
| max support per case | 0 | 0 | 0 | **1** (cap) |
| module nodes delivered | 0 | 0 | 0 | **0** |
| mean delivered tokens | 269 | 300 | 304 | 304 |

Attribution: `M149 → ab8e4f0` = mechanism capability; `ab8e4f0 → ebc4fda` =
subject alignment; `ebc4fda → final` = support + slice. Each phase moved exactly
the rows it was built for and nothing else.

**Ordering visibility is 3/4, not 4/4, and the denominator is honest** (§38). The
fourth case is `unhelpful_operand_name`, whose *primary* is not generated either,
so there is no seed to discover support from. That is a candidate-generation
limit, not a support limit.

`support_cap` (§19) delivers exactly **1** helper out of five called, with the
logger, cache, normaliser and auditor all refused. `unknown_ordering` (§20)
delivers **no** support and claims nothing about ordering.

## 3. ARC acceptance

| query | operation | lead | verdict |
| --- | --- | --- | --- |
| which reaction family **wins** | `selection` | `determine_family` | **PASS** |
| how is lookup **cached** | `caching` | `get_reaction_family` | **PASS** |
| where **stored** on ARCReaction | `storage` | `ARCReaction.family_own_reverse` | **PASS** |
| where is `determine_family` **defined** | none (suppressed) | `determine_family` | **PASS** |
| what determines **precedence/order** | `ordering` | `_dihedral_angle` | **FAIL** |

Selection query, final:

| symbol | rank | score | role |
| --- | --- | --- | --- |
| `determine_family` | **1** | 2.1245 | **lead pivot**, `mechanism_slice` at line 648 |
| `get_reaction_family` | 2 | **1.9000 unchanged** | pivot, mechanism **0** |
| `ARCReaction.family` | 3 | **1.9000 unchanged** | support, mechanism 0 |
| `get_all_families` | — *(never generated)* | — | **`mechanism_support`**, `mechanism_slice` at line 769 |

`product_dicts[0]` visible; the ordering → selection relationship is now
model-visible through the delivered slice
(`dict.fromkeys(rmg_families)  # de-duplicate, preserving order`). Nothing is
penalised — the cache helper and accessor hold their predecessor scores exactly.

§43 ✔ · §44 ✔ · §45 ✔ · §46 ✔ · **§47 ✘**.

The ordering query fails for a reason outside this phase's mechanism: `families`
and `order` match file stems, handing `_dihedral_angle` and
`get_resonance_bond_orders` `symbol=1`, while `get_all_families` is not generated
at all. The generic `ordering_query` case **passes** — it leads with the orderer,
not its consumer — so the operation distinction itself works; ARC's instance is
blocked upstream in candidate generation.

## 4. Preservation

| gate | result |
| --- | --- |
| M142 Gaussian route keywords | owner Top-1 **true** (regression stays closed) |
| M142 normal-mode / reactant-index | unchanged |
| M142 TS-guess atom order | `anywhere` **true** (gain held) |
| M142 `which()` / ARC-class controls | unchanged (§50) |
| M140 module invisibility | **0** delivered `<module>` nodes (§65) |
| M140 `orchestration_support` | distinct value, not relabelled (§64) |
| M139 impact | untouched — only exact `calls` used, never potential (§66) |
| **Frozen50** M149 → final | **0/50**, byte-identical, `provenanceValid=true`, `srcDirty=false` |
| django / cross_repo_30 | 0/20, 0/30 — 38/44/48/31/2, tokens 1832.4 |
| **TCKDB same-checkout** | **0/6 leads changed**, 1/6 sets, 0 module nodes |
| full ≡ incremental / no-op | equivalent and stable (unchanged; retrieval-only phase) |
| ARC + TCKDB authoritative indexes | **byte-identical** |

Frozen50 remains preservation evidence only (§71): those corpora predate
mechanism facts. Positive capability evidence is the corpus and the ARC
contrasts.

**Changed-case attribution.** Frozen50/django/cross_repo: none. TCKDB: one
delivered set on *"What determines the order the records are returned in?"* —
lead unchanged, support slots differ; cause `ordering_precedence_retrieval`;
classification **NEUTRAL** (no gold standard, lead stable). Corpus movements
`ebc4fda → final`: ordering visibility 2/4→3/4 and support 0→1, cause
`mechanism_support`, **IMPROVEMENT**; negative-control delivery 1→0, cause
`mechanism_support`, **IMPROVEMENT**. No REGRESSION anywhere.

**Derivation fingerprints unchanged** — this phase is retrieval-only; no schema
or capability change (§56).

## 5. Gates

`bun test` **4534 pass / 0 fail / 49 skip / 280 files** · `bun run typecheck` and
`:benchmarks` clean · `git diff --check` clean. Nine new focused support tests
including the two-hop ARC shape, the unrelated-sort negative control, the
five-helper crowd, unknown ordering, and the cap.

## 6. Remaining limitations

1. **ARC ordering query** (§47) — the one blocker for D. Needs `get_all_families`
   generated as a candidate; the operation semantics already work generically.
2. **Ordering visibility 3/4** — the fourth case needs candidate generation for
   unhelpfully-named primaries, not more support.
3. **Two-hop producer chains** (`wrapper()` hiding the real producer) remain
   unresolved by design; one hop carries every measured real case.
4. **Dedicated preservation runners** for M139/M141/M146/M147/M148/M149 (§81) were
   not run individually; they are covered by the full suite, which is not the
   same claim.

## 7. Recommended next scope

Not M151. One focused piece of work closes M150: make an ordering-fact-carrying
definition generable for an `ordering` request, so `get_all_families` can lead the
query that asks what establishes precedence. Everything else D needs now exists,
is bounded, and is measured.
