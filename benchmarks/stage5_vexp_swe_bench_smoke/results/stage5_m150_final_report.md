# M150 — final report

**Verdict: PASS.** A PASS · B PASS · C PASS · D PASS · E PASS.

Final functional commit: `2d3010e4` — *Preserve answer roles through pivot
eligibility*. On `main`, local only, no co-author trailers.

## Capability closed

> VTRACE distinguishes code that directly implements the behavioural operation a
> request asks about from code that merely consumes or depends on it — even when
> the consumer has stronger lexical subject overlap — and that decision survives
> ranking, pivot eligibility, pivot ordering and capsule delivery to reach what
> the model actually sees.

## Commit chain

| stage | commit |
|---|---|
| M149 predecessor | `2aaac750b326478bb3f29576aa1454365d0f734d` |
| operation semantics / facts / scoring / discrimination | `09a39e2`, `ee35b05`, `9a81a1c`, `ab8e4f02eaacdbcfa8fc56f1b056db232ce1452c` |
| subject alignment | `ebc4fda7d42cfe8706e9ee128fe56ec8e5405a83` |
| mechanism support + decision slice | `650e916fa0b024c1d739615b9a8b5f669fd3429f` |
| operation-fact candidate generation | `ed8db5b71e64023e750d1202dd1accaf6e6d9e90` |
| path-evidence gate | `fe5c220ecf67e80d4a39a1fdc76aa28baaf8bc0c` |
| answer-role relation | `86fed3ddba07a20917c8fb1e0a160cf2ff76ed33` |
| **answer-role delivery (final)** | **`2d3010e4`** |

## The delivery defect

Retrieval ranked ARC's orderer first and the capsule still led with the consumer.
The audit (`stage5_m150_answer_role_delivery_audit.md`) located it in one
function, `assignCandidateRoles.classify`, which states one requirement three
times — `directEvidence`, a `localEvidence` floor, a `hubPenalty === 0` check —
and reads all three from NAME and PATH signals only:

| candidate | actionability | lexical | localEvidence | hubPenalty | mechanism | delivered |
|---|---|---|---|---|---|---|
| `get_all_families` | 1 | 0.0466 | 0.3333 | 0.0116 | 0.55 | `support` / signature |
| `alpha` | 1 | 0 | 0 | 0 | 0.55 | discarded → empty capsule |

§9's order-of-operations hypothesis was **refuted by measurement**: the relation
is applied inside `hybridRetrieve`, before nomination, so the pivot set was never
built from a stale ranking. The loss was entirely in what the role layer accepts
as evidence — the same blind spot M150-G fixed one layer up, restated downstream.

## The fix

Answer-role evidence (`mechanismEvidence >= 0.55`, the direct tier) is admitted
to each of those three conditions and the discard gate. **No numeric parameter
was introduced in this phase**; the `1e-4` relational step from `86fed3dd` is
unchanged and was not reinterpreted as magnitude.

Authority is granted to **one** candidate — the best-ranked direct implementer.
That bound is measured, not stylistic: unbounded, it let `mixed.py::first_backend`
lead a question about another module's indirect choice because it too ends in
`backends[0]`. Operand alignment is enough to score a candidate and not enough to
make it the answer when something else outranks it.

## ARC (§26–§30, §47)

Measured on one index against a `86fed3dd` worktree baseline:

| query | `86fed3dd` lead | final lead | |
|---|---|---|---|
| ordering | `determine_family` | **`get_all_families`** | fixed |
| selection | `determine_family` | `determine_family` | identical |
| cache | `get_reaction_family` | `get_reaction_family` | identical |
| storage | `family_own_reverse` | `family_own_reverse` | identical |
| direct identifier | `determine_family` | `determine_family` | identical |
| Gaussian | `_user_requested_verytight` | `_user_requested_verytight` | identical |

**Exactly one lead changed, and it is the intended one.**

Ordering query, final: `get_all_families` rank 1, organic 1.0549, promoted
1.7640, `mechanismEvidence` 0.55, source `operation_fact`, delivered **pivot /
full source**. `determine_family` rank 2, final 1.7639 (untouched), delivered
pivot. Selection query: `determine_family` pivot/full, `get_all_families`
`mechanism_support` / `mechanism_slice` — the reversal holds on one index.

Gaussian: 64 owners examined, **0 admitted**, owner Top-1 preserved.

## Generic paired delivery corpus (§23–§25, §40, §41, §68)

11 cases, 6 modules, deliberately uninformative names, run through the product path.

| metric | `fe5c220` | final |
|---|---|---|
| direct implementer Top-1 | 2/9 | **8/8** |
| `directImplementerBeatsConsumer` (pool) | 2/8 | **7/7** |
| `capsuleLeadsImplementer` | — | **8/8** |
| **`pool_vs_capsule_agreement`** | — | **7/7** |
| paired POOL role reversal | 0/4 | **3/3** |
| paired CAPSULE role reversal | — | **3/3** |
| consumer incorrectly leads | 3 | **0** |
| empty capsule despite deliverable implementer | 2 | **0** |
| wrong-subject operation bonus | 0 | **0** |
| unknown-ordering overclaim | 0 | **0** |
| `<module>` nodes delivered | 0 | **0** |

Denominators moved from 9→8 and 4→3 with reasoning, per §69: `route_ordering`
expresses precedence as the ORDER OF A LIST LITERAL, which no fact kind indexes.
Measured — the symbol carries no mechanism fact at all — so there is nothing to
rank or deliver, and it was reclassified as a truthfulness control rather than
charged to the delivery layer. Adding a fact kind is a derivation change (§54).
Its expected empty capsule is retained as a negative control, alongside a new
control proving a test symbol carrying a perfect ordering fact is never promoted.

## Preservation

- **Frozen50, `2aaac750` → `2d3010e4`**, `provenanceValid: true`,
  `srcDirty: false`, `authority: authoritative` on both sides:
  **16/50 changed, 0 lead changes, 0 gold-visibility flips, 0 quality-metric
  changes** (django 9/20, cross_repo_30 7/30). All 16 attributed to
  `path_only_relevance_gate` from `fe5c220`; quality NEUTRAL.
- **Isolation `86fed3dd` → `2d3010e4`** (§63): **`pass=true`, 0 changed,
  semantic hashes byte-identical** on both suites. SWE-bench tasks declare no
  behavioural operation, so mechanism evidence never reaches the direct tier and
  no answer-role authority can exist. This phase contributes **zero** frozen-suite
  movement.
- **TCKDB**: 1/6 leads changed — the explicit ordering query, from
  `apply_review_policy` (carries only `fallback_branch`) to
  `get_species_transport` (carries `ordering_established` on `ranked = sorted(…)`
  and `priority_lookup` on `REVIEW_RANK[…]`). Classified **IMPROVEMENT** per §65.
  0 `<module>` nodes.
- **Suite**: 4602 tests, **0 fail**, 49 skip. Both typechecks clean,
  `git diff --check` clean.
- Schema, derivation fingerprints and index capability unchanged; ARC and TCKDB
  authoritative indexes untouched (opened read-only).
- Answer-role logic performs **0 source reads**.

## 15-case mechanism corpus (§38, §39, §66)

| metric | M150 prior | final |
|---|---|---|
| correct lead | 9 | **9** |
| correct Top-1 | 9 | **9** |
| correct Top-3 | 13 | **10** |
| wrong-subject lead | 0 | **0** |
| negative-control delivery | 0 | **0** |
| ordering helper visible | 3/4 | **3/4** |
| `<module>` nodes | 0 | **0** |

Three cases moved, and the cause is **not** delivery. In all three the expected
answer sits at pool **rank 4 before and after** — the pool ordering did not
change. Delivery previously promoted a rank-4 candidate because the higher-ranked
ones were pivot-ineligible; now the best-ranked direct implementer takes the
single answer-role slot, so delivery agrees with ranking. Per §39 these are
classified as **pre-existing ranking limitations surfaced, not caused**, by this
phase: `first_success_backend` REGRESSION, `unknown_ordering` REGRESSION,
`two_hop_producer` NEUTRAL (already failing; only the identity of the wrong lead
changed). Lead and Top-1 accuracy are unchanged and every safety metric is clean.

## Remaining limitations

1. Two 15-case queries want an answer their pool ranks 4th. That is a ranking
   question about near-duplicate queries over one corpus with different correct
   answers, and it should not be solved in the delivery layer.
2. Precedence expressed as the order of a list literal has no indexed fact kind.
3. `mechanismSupport` reads only `provenance`, while the loop fact kinds record
   their producer in `subject`; ordering-helper visibility stays at 3/4 for that
   reason. `operationRole` reads both.

## Recommended M151 scope

**M151 — Wire Workspace Routing into Product Surfaces**, as planned. The
single-repository behavioural chain is now closed end to end: subject +
operation → subject-aligned mechanism evidence → candidate generation → direct
implementer vs consumer relation → answer ordering → pivot eligibility → pivot
ordering → bounded real-source delivery.
