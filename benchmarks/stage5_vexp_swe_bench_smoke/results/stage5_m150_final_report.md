# M150 — Behavioral Decision-Point and Execution-Mechanism Retrieval (final)

**Verdict: MIXED.**

A → PASS · B → PASS · C → PASS · **D → MIXED** · E → PASS.

The capability §79 names is delivered: a definition now enters the candidate pool
**because of its indexed, subject-aligned mechanism evidence**, when its name
gives no lexical clue at all. What it does not yet do is *win* — `get_all_families`
is generated and ranks 24 behind a lexical accident holding the pool maximum. §80's
first clause names that exactly ("becomes generated but does not become useful
answer-bearing evidence"), so the milestone closes MIXED.

- M149 predecessor `2aaac750b326478bb3f29576aa1454365d0f734d`
- checkpoints `ab8e4f02eaacdbcfa8fc56f1b056db232ce1452c` · `ebc4fda7d42cfe8706e9ee128fe56ec8e5405a83` · `650e916fa0b024c1d739615b9a8b5f669fd3429f`
- **final functional `ed8db5b`**
- Branch `main`, ahead 27, **nothing pushed**, no co-author trailers.

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

| symbol | rank | final | lexical | mechanism | source |
| --- | ---: | ---: | ---: | ---: | --- |
| `_dihedral_angle` | **1** | 1.9000 | **1.0000** | 0 | symbol |
| `determine_family` | 3 | 1.7639 | 0.8632 | 0 | lexical |
| **`get_all_families`** | **24** | 1.0549 | 0.2003 | **0.55** | **`operation_fact`** |

**Generated — which it never was before, and purely from mechanism evidence.**
But `_dihedral_angle` holds `lexical = 1.0` (the pool maximum) from a file-stem
coincidence: the query says *families* and *order*, and it lives in
`linear_utils/families.py`. Closing a 0.85 gap would require either penalising it
by name — which §25 forbids — or an M142-class lexical-decoy fix that §2–§4
freeze. **§40 not met.**

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
| **Frozen50** M149 → final | **0/50**, byte-identical, `provenanceValid=true`, `srcDirty=false` |
| django / cross_repo_30 | 0/20, 0/30 — 38/44/48/31/2, tokens 1832.4 |
| **TCKDB** | **0/6 leads changed**, 1/6 sets, 0 module nodes |
| derivation fingerprints | **unchanged** — retrieval-only, no schema/capability change |
| ARC + TCKDB authoritative indexes | **byte-identical** |

`bun test` **4544 pass / 0 fail / 49 skip**, both typechecks and `git diff --check`
clean. Ten new candidate-generation tests (wrong-subject refusal, same-file,
same-class, producer admission, no-provenance refusal, caps, zero source reads,
direct-kinds-only).

**Changed-case attribution.** Frozen50/django/cross_repo: none. TCKDB: one
delivered set on the ordering query, lead unchanged — cause
`operation_fact_candidate_generation`, **NEUTRAL**. Corpus `650e916 → final`: no
metric moved; the lane admits candidates that then compete normally. No
REGRESSION anywhere across all five phases.

## 7. Remaining limitation — one, and it is precise

`get_all_families` is generated and carries correct ordering evidence; it loses to
a candidate whose `lexical = 1.0` comes from a file-stem coincidence. This is a
**lexical-decoy** problem of the M142 class, not a mechanism problem: every M150
lane behaved correctly on this query. Closing it means letting the decoy lose on
its own evidence — the M142 generic-token down-weighting already does this for
*name* matches and does not currently cover *path-stem* matches.

That is a self-contained next step and it is the only thing standing between M150
and PASS.

## 8. Recommended scope

Not M151. Extend M142's generic-token lexical down-weighting to path-stem-only
matches, so a candidate explained solely by a directory name cannot hold the pool
maximum. Then re-run the ARC ordering acceptance and the §75 preservation runners.
Everything else M150 needs is built, bounded, measured and preserved.
