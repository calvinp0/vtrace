# M150 — Behavioral Decision-Point and Execution-Mechanism Retrieval (final)

**Verdict: MIXED.**

A → PASS · B → PASS · C → PASS · **D → MIXED** · E → PASS.

The path-only decoy is gone: `_dihedral_angle` no longer leads the ARC ordering
query, and the root cause was found, named and fixed generically. But the ordering
*implementation* still is not the primary answer — `get_all_families` sits at rank
22 while the selection *consumer* leads. §80's third clause covers this, so the
milestone closes MIXED.

Final phase: `fe5c220` — path-evidence gate. See
`stage5_m150_path_evidence_contract.md` for the full root cause and rule.

- M149 predecessor `2aaac750b326478bb3f29576aa1454365d0f734d`
- checkpoints `ab8e4f02eaacdbcfa8fc56f1b056db232ce1452c` · `ebc4fda7d42cfe8706e9ee128fe56ec8e5405a83` · `650e916fa0b024c1d739615b9a8b5f669fd3429f`
- checkpoint `ed8db5b71e64023e750d1202dd1accaf6e6d9e90`
- **final functional `fe5c220`**
- Branch `main`, ahead 29, **nothing pushed**, no co-author trailers.

**Frozen and confirmed unchanged:** mechanism weights (0.55 / 0.20, strongest
single fact), subject-alignment policy (operand + one-hop provenance, no
path/class/domain), `mechanism_support` contract (cap 1, exact relations, depth 2),
statement-slice contract (real source, structural bounds).

---

## 1. What this phase added

An operation-fact candidate lane. It runs the pipeline backwards for one step:

```
declared behavioral operation
  -> fact kinds that DIRECTLY implement it   (partial kinds may not create candidates)
  -> the SAME subject-alignment policy       (before admission, never after)
  -> a bounded few ordinary candidates       (cap 3)
```

Admission is **not** selection, a role, or a score. An admitted definition
competes on the same evidence as everything else and can still lose.

**No access index was needed** (§56). `EXPLAIN QUERY PLAN` reports
`SEARCH ... USING INDEX idx_symbol_mechanism_facts_kind (kind=?)` — an index
search, 46 of 2566 rows in 0.73 ms on ARC. No capability or migration was invented
for symmetry.

One artifact was fixed along the way: an admitted candidate carried `fts = 0` and
was judged as though its name matched nothing, purely because a different lane
found it first. It is now scored by the same `rankSearchCandidates` the lexical
lane uses. That is not a boost — an unrelated definition still scores nothing.

## 2. Scale — measured, bounded, flat (§54, §72)

| mechanism facts | lookup ms | alignment ms | total ms | facts examined | owners considered | admitted |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 100 | 0.18 | 0.96 | 1.46 | 100 | 64 | 2 |
| 1,000 | 0.36 | 0.38 | 0.88 | 400 | 64 | 3 |
| 10,000 | 0.32 | 0.23 | 0.67 | 400 | 64 | 3 |
| **ARC 2,566** | 0.41 | 0.16 | **0.73** | 38 | 38 | 1 |
| **TCKDB_v2 2,680** | 0.28 | 0.07 | **0.51** | 64 | 60 | 0 |

Work caps at 400 facts / 64 owners and stops growing; 10,000 facts costs *less*
than 100. **0 source reads** during lookup, alignment and admission.

## 3. The generation-time negative control (§45, §46, §71)

The danger was the checkpoint regression reappearing at generation time — every
Gaussian parser carrying a first-item selection flooding a route-keyword request.

| query | examined | **rejected** | **admitted** | lead |
| --- | ---: | ---: | ---: | --- |
| Gaussian route keywords | 64 | **64** | **0** | `GaussianAdapter._user_requested_verytight` (owner, Top-1 **true**) |
| ARC precedence/order | 38 | 37 | 1 | — |
| ARC family selection | 64 | 61 | 3 | `determine_family` |

Representative refusals on the ordering query — correct operation fact, wrong
subject: `arc/common.py::dfs` (operand `visited`),
`ARCReaction.get_expected_changing_bonds` (`r_label_dict`),
`arkane.py::_all_available_years` (`years`). Each carries a genuine
result-bearing ordering fact and none is about reaction families.

## 4. ARC results

**Ordering query** — `What determines the precedence/order when multiple reaction families match?`

| symbol | rank at `ed8db5b` | **rank final** | final score | mechanism | source |
| --- | ---: | ---: | ---: | ---: | --- |
| `_dihedral_angle` | **1** (1.9000) | **out of the lead** | — | 0 | synthesized stem tier |
| `determine_family` | 3 | **1** | 1.7639 | 0 | lexical |
| **`get_all_families`** | 24 | **22** | 1.0549 | **0.55** | **`operation_fact`** |

**Generated — which it never was before, and purely from mechanism evidence.**
The path-stem decoy no longer leads (§7). But the lead is now the selection
*consumer*, not the ordering *implementation*, and §32 asks the reverse emphasis
for an ordering request. **§30/§40 partially met: decoy removed, primacy not
achieved.**

**Selection query preserved exactly** (§41): `determine_family` rank 1 lead pivot
with the decision slice; `get_reaction_family` rank 2 at **1.9000 unchanged**,
mechanism 0; `ARCReaction.family` **1.9000 unchanged**; `get_all_families`
delivered as `mechanism_support`. Cache (§42), accessor (§43) and direct
identifier (§44) contrasts all hold.

## 5. Corpus — five phases, identical fixtures

| metric | M149 | ab8e4f0 | ebc4fda | 650e916 | **final** |
| --- | ---: | ---: | ---: | ---: | ---: |
| correct lead | 7 | 9 | 9 | 9 | **9** |
| correct Top-3 | 11 | 13 | 13 | 13 | **13** |
| wrong-subject mechanism bonus | 0* | **2** | 0 | 0 | **0** |
| wrong-subject candidates admitted | — | — | — | — | **0** |
| negative-control delivered | 1 | 0 | 1 | 0 | **0** |
| ordering helper visible | 2/4 | 2/4 | 2/4 | 3/4 | **3/4** |
| mechanism support delivered | 0 | 0 | 0 | 1 | **1** |
| module nodes delivered | 0 | 0 | 0 | 0 | **0** |

\* no mechanism capability. Attribution: capability → alignment → support/slice →
candidate generation. Nothing regressed at any phase.

## 6. Preservation and gates

| gate | result |
| --- | --- |
| M142 Gaussian route keywords | owner Top-1 **true** |
| M142 NMD / reactant-index / TS-guess | unchanged (TS-guess gain held) |
| M142 `which()` + ARC-class controls | unchanged (§48) |
| M140 module invisibility | **0** `<module>` delivered |
| M140 role separation | ordinary / `mechanism_support` / `orchestration_support` all distinct |
| M139 exact relations | only exact `calls`; no potential/reference used |
| **Frozen50** M149 → final | **16/50 composition changed, every quality metric identical** — Top-1 38, Top-3 44, anywhere 48, symbol 31, missing 2 on both sides; tokens 1832.40 → 1832.48. `provenanceValid=true`, `srcDirty=false` |
| django / cross_repo_30 | 9/20, 7/30 — all quality metrics identical on both sides |
| **TCKDB** | 1/6 leads changed (ordering query), 1/6 sets, 0 module nodes |
| derivation fingerprints | **unchanged** — retrieval-only, no schema/capability change |
| ARC + TCKDB authoritative indexes | **byte-identical** |

`bun test` **4544 pass / 0 fail / 49 skip**, both typechecks and `git diff --check`
clean. Ten new candidate-generation tests (wrong-subject refusal, same-file,
same-class, producer admission, no-provenance refusal, caps, zero source reads,
direct-kinds-only).

**Changed-case attribution** (`stage5_m150_final_changed_case_ledger.json`).
Frozen50 16/50, django 9/20, cross_repo_30 7/30 and the TCKDB lead: all cause
`path_only_relevance_gate`, all quality **NEUTRAL** — support-slot composition
with gold-file and gold-symbol outcomes identical on both sides. §66 anticipated
this: cases ranked on path-only accidental evidence moved, and nothing measuring
answer quality did. Corpus across six phases: no metric regressed at any phase.
**Zero REGRESSION, zero unexpected.** One IMPROVEMENT: the ARC ordering decoy.

## 7. The path-evidence gate (final phase)

**Producer, named exactly:** `directEvidenceAnchoring.ts`, branch (a) of
`resolveFileStemWord`. Not FTS, not path scoring, not the domain lane. It resolves
the prose word `families` to `linear_utils/families.py`, picks the first top-level
def out of that file, and **synthesizes** `lexical: 1 / final: 1.9` by tier.
M142 had already fixed the sibling branch (b); branch (a) was documented as
"deliberately left alone" — sound reasoning about the FILE that silently extended
to a symbol it did not cover.

**Rule:** a weak *file-derived* mention may synthesize answer-grade relevance only
for a definition with independent relevance (`lexical | domain | bodyLiteral |
testToImpl | mechanismEvidence`). `path` and `symbol` are excluded — `symbol` is
what the mention synthesizes, so consulting it would be circular. The predicate is
caller-supplied; omitted means unknown and changes nothing.

**Result:** `_dihedral_angle` **1.9000 / rank 1 → out of the lead**. No constant
shaved, no threshold introduced, no ARC-specific exception.

**Frozen50 moved 16/50 — and every quality metric is identical:** Top-1 38, Top-3
44, gold anywhere 48, gold symbol 31, missing 2 on both sides; mean tokens 1832.40
→ 1832.48. Support-slot composition only. Cause `path_only_relevance_gate`,
quality **NEUTRAL** (§66, §68). django 9/20, cross_repo_30 7/30, same story.
TCKDB: 1/6 leads changed on the ordering query, also NEUTRAL — neither candidate
is an established gold answer there.

## 8. Remaining limitation — one, and it is precise

The ordering query now leads with `determine_family` (the selection *consumer*) at
1.7639, while `get_all_families` — the ordering *implementation*, correctly
generated via `operation_fact` — sits at rank 22 on 1.0549. §32 asks the reverse
emphasis for an ordering request: orderer primary, consumer secondary.

This is no longer a path-decoy problem, a generation problem, or a mechanism
problem. It is that an ordering fact contributes 0.55 while the consumer's own
lexical evidence is far stronger, because the query's vocabulary
(`precedence`, `order`, `families`, `match`) matches `determine_family`'s
name and docstring better than it matches `get_all_families`.

## 9. Recommended scope

Not M151. One question remains and it is a scoring-emphasis question, not a
retrieval one: for an explicit `ordering` request, should a direct
`ordering_established` fact outweigh a consumer's lexical advantage? The weights
are frozen for good reason, so this needs its own measured phase against the
existing corpus rather than a tweak here. Everything else M150 needs is built,
bounded, measured and preserved.
