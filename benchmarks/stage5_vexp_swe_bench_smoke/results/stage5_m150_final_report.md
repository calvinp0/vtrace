# M150 — Behavioral Decision-Point and Execution-Mechanism Retrieval (final)

**Verdict: MIXED.**

A → PASS · B → PASS · C → PASS · **D → MIXED** · **E → MIXED**.

The continuation did what it set out to do — the subject-alignment discriminator
exists, is derived from a corpus rather than from ARC, and closed the Gaussian
regression with no cost anywhere else. Two D requirements remain unimplemented,
so the milestone does not reach PASS. §111 is explicit that this is MIXED and not
PASS, and it is recorded as MIXED.

- M149 predecessor: `2aaac750b326478bb3f29576aa1454365d0f734d`
- M150 checkpoint: `ab8e4f02eaacdbcfa8fc56f1b056db232ce1452c`
- M150 final functional: `ebc4fda`
- Branch `main`, ahead 23, **nothing pushed**, no co-author trailers.

Functional commits: `09a39e2` operation semantics · `ee35b05` mechanism facts ·
`9a81a1c` mechanism scoring · `ab8e4f0` discrimination fixes · `ebc4fda` subject
alignment. The checkpoint's history is untouched (§2).

---

## 1. What the continuation changed

One thing: **mechanism evidence is now tied to what the request asks about**,
decided from the mechanism's own operand and one hop of provenance. Full design,
rejected alternatives and measurements: `stage5_m150_subject_alignment_design.md`.

```
operand names the subject            -> direct_operand
else producer of operand names it    -> local_producer
else request names no subject at all -> undecidable
else                                 -> none   (zero contribution)
```

Nothing about the candidate's path, file, class or domain score participates
(§8, §15). The rule was fixed against the generic corpus and frozen **before**
ARC was re-measured (§33).

Weights unchanged: direct `0.55`, partial `0.20`, ceiling = direct, strongest
single fact. The corpus said the defect was discrimination, not magnitude (§34).

## 2. Why the family case works and the Gaussian case does not

Same operation, same fact kind, same result-bearing property. Only the subject
differs (`stage5_m150_arc_family_subject_trace.json`,
`stage5_m150_gaussian_regression_trace.json`):

| candidate | operand | provenance | alignment | mech | rank |
| --- | --- | --- | --- | --- | --- |
| `determine_family` | `product_dicts` | `get_reaction_family_products` | **local_producer** | **0.55** | **1** |
| `GaussianParser.parse_cartesian_hessian_lower_triangle` | `tokens` | `line.split` | none | 0 | — |
| `GaussianParser.load_scan_pivot_atoms` | `output` | `_load_scan_specs` | none | 0 | — |
| `GaussianAdapter.write_input_file` | `species` | — | none | 0 | — |

`product_dicts` encodes neither `reaction` nor `family`; the call that produced
it encodes both. That one hop is the whole mechanism, and it is why operand-name
matching alone (§11's warning) would have failed.

## 3. Corpus (§18, §31, §61–§65)

A dedicated 15-case corpus over a committed 13-module fixture repository, run
through the **product retrieval path** (§63), against all three implementation
roots.

| metric | M149 | checkpoint | final |
| --- | --- | --- | --- |
| correct mechanism lead | 7 | 8 | 8 |
| correct definition Top-1 | 7 | 8 | 8 |
| correct definition Top-3 | 10 | 12 | 12 |
| correct anywhere | 12 | 13 | 13 |
| missing mechanism | 3 | 2 | 2 |
| same-operation wrong-subject **lead** | 0 | 0 | 0 |
| **same-operation wrong-subject bonus** | 0 (no capability) | **2** | **0** |
| negative-control bonus | 0 | 0 | 0 |
| decision statement visible | 5/9 | 6/9 | 6/9 |
| **ordering helper visible** | 1/4 | 1/4 | **1/4** |
| mechanism support used | 0 | 0 | **0** |
| module nodes delivered | 0 | 0 | 0 |

Attribution: `M149 → checkpoint` = operation-compatible mechanism capability;
`checkpoint → final` = subject-alignment discrimination. The discriminator
removed every wrong-subject bonus at zero cost to correct leads, Top-3 or
coverage.

The two flat rows are the honest headline: **ordering-helper visibility and
mechanism support did not move, because neither was implemented.**

## 4. ARC acceptance

| query | operation | lead | result |
| --- | --- | --- | --- |
| which reaction family **wins** | `selection` | `determine_family` | **PASS** |
| how is lookup **cached** | `caching` | `get_reaction_family` | **PASS** |
| where is it **stored** on ARCReaction | `storage` | `ARCReaction.family_own_reverse` | **PASS** |
| where is `determine_family` **defined** | none (suppressed) | `determine_family` | **PASS** |
| what determines **precedence/order** | `ordering` | `_dihedral_angle` | **FAIL** |

Selection-query watchlist: `determine_family` rank **1**, 2.1245, lead pivot,
mechanism 0.55; `get_reaction_family` rank 2 at **1.9000 unchanged**, mechanism
**0**, withheld with reason *"no fact implements the requested selection
operation"*; `ARCReaction.family` **1.9000 unchanged**; `product_dicts[0]`
**visible**; `get_all_families` **still never generated**.

Nothing is penalised. The cache helper and accessor hold their predecessor
scores exactly; the decider gained evidence for a question they do not answer.

§108 scorecard: 1 ✔ · 2 ✔ · 3 ✘ ordering helper not visible · 4 ✔ · 5 ✘ ordering →
selection relationship not shown · 6 ✔ · 7 ✔ · 8 ✔.

## 5. M142 preservation — regression closed (§38, §80)

| case | M149 | checkpoint | final |
| --- | --- | --- | --- |
| normal-mode displacement | top1 false | false | false (unchanged) |
| **Gaussian route keywords** | **top1 true** | **top1 false** | **top1 true — restored** |
| reactant atom index space | top1 true | true | true |
| TS-guess atom-order | anywhere false | false | **anywhere true (gain)** |
| explicit `which()` lookup | `common.py::which` | unchanged | unchanged |
| explicit `ARC` class lookup | `arc/main.py::ARC` | unchanged | unchanged |
| broad vague control | no lead | unchanged | unchanged |

M142 prose/identifier hygiene intact: `which()` is still not generated from
grammatical *which* (§81). Alignment uses no domain/path evidence, so no
centrality-style relevance creation (§82).

## 6. Gates

| gate | result |
| --- | --- |
| `bun test` | **4525 pass / 0 fail / 49 skip / 279 files** |
| `bun run typecheck` / `:benchmarks` | clean |
| `git diff --check` | clean |
| **Frozen50** M149 → final | **0/50 changed**, byte-identical hashes, `provenanceValid=true`, `srcDirty=false` |
| django / cross_repo_30 | 0/20, 0/30 — Top-1 38, Top-3 44, anywhere 48, symbol 31, missing 2, tokens 1832.4 |
| **full ≡ incremental** | **equivalent** — fact rows and normalized-graph hash byte-identical after an edit (24 → 25 facts, both sides) |
| **no-op reindex** | **stable** — fact rows and graph hash unchanged |
| **TCKDB same-checkout** | 0/6 leads changed, 1/6 delivered sets changed, 0 module nodes |
| ARC + TCKDB authoritative indexes | **byte-identical** (mtime + size) |

Frozen50 remains **preservation evidence only** (§77): those corpora predate
mechanism facts, so 0/50 shows no side effect rather than showing the gate holds
with evidence present. That was measured separately on ARC (2566 facts) and
TCKDB (fresh isolated index).

**TCKDB changed set**, attributed: *"What determines the order the records are
returned in?"* — lead unchanged, two support slots differ. Cause
`decision_point_ranking` on an `ordering` operation. Neutral: TCKDB has no gold
standard here and the lead is stable.

**Derivation fingerprint** intentionally moves (`src/indexer/` gained a module and
a column), so field indexes rebuild rather than being silently invalidated (§74).

ARC mechanism scale: 7154 callables, 1628 carry facts, 2566 facts, **619
result-bearing**. `first_item_selection` 983 facts → 59 result-bearing. Index
21.3s → 22.2s. Query-time source reads **0**; facts load via one indexed SELECT
over the already-bounded candidate pool (§93, §94).

## 7. Not done — why D and E stay MIXED

1. **`mechanism_support` role (§41–§46, §54–§56, §60).** Not implemented.
   `get_all_families` is still never generated. Investigated: the causal chain is
   `determine_family` --(provenance)--> `get_reaction_family_products` --(calls)-->
   `get_all_families`. The stored provenance reaches hop 1; the ordering fact
   lives at hop 2. A bounded two-step discovery of exactly the §55 shape would
   reach it. Failure classification for `get_all_families`: **not generated** —
   it is absent from the candidate pool entirely, not ranked-and-dropped.
2. **Statement slice (§48–§51).** Not implemented. `product_dicts[0]` is visible
   only because `determine_family` is delivered as a `full` pivot — §48 says
   explicitly not to rely on that.
3. **Ordering query (§66, §67).** Still led by `_dihedral_angle` on a symbol-name
   accident. Needs (1) and probably the §68 selection/ordering emphasis split.

Also not run: M139/M140/M141/M146/M147/M148/M149 dedicated preservation runners
(§106) — covered by the full suite, which is not the same thing and is not
claimed to be.

## 8. Recommended next scope

Still **not M151**. Finish M150-D:

1. Bounded mechanism-support discovery over the stored provenance chain, capped
   at 1 helper, admitted only when it carries an ordering/priority fact the
   decision consumes.
2. The statement slice, through the existing product-context machinery.
3. The ordering query, once (1) exists.
4. The dedicated preservation runners of §106.

The corpus now exists and discriminates, so all four are measurable rather than
argued — which is the difference between this state and the checkpoint.
