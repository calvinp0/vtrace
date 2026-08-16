# M150 — primary-operation fulfillment and ordering emphasis

Verdict: **MIXED**. The ranking defect is fixed and proven symmetric; delivery
emphasis and three of the mandatory preservation suites are not closed, so M150
does not close PASS.

Functional commit: `86fed3dd` — *Rank behavioral implementers above the code that
consumes them*, on `main`, local only.
Predecessor for attribution: `fe5c220ecf67e80d4a39a1fdc76aa28baaf8bc0c`.

## 1. Root cause

The ARC ordering query was never a mechanism-weight problem. Measured on the
committed checkpoint scorecard:

| candidate | lexical | domain | mechanism | final | rank |
|---|---|---|---|---|---|
| `ARCReaction.determine_family` | 0.8632 | 1.0000 | **0** | 1.7639 | 1 |
| `get_all_families` | 0.2003 | 0.3333 | 0.55 | 1.0549 | 22 |

`determine_family` carries **no ordering fact at all** — its mechanism score on
this query is zero. It led on subject signals alone. Four independent components
measure the SUBJECT (lexical, domain, path, symbol) and one measures the
OPERATION, so on a question that is entirely about the operation, the subject
still decides.

## 2. Why it is not a larger `W_mech`

Two independent measurements, taken before any rule was written:

- ARC needs **+0.709** for the orderer to cross the consumer.
- The generic `rule_candidate_selector` fixture — the same shape with useless
  names — needs **+1.83** (consumer 1.9000 vs implementer 0.0727).

No constant in the bounded-component family (`positiveObjective` 0.36,
`contrastPenalty` 0.75, `directAnswer` 0.95, `mechanismEvidence` 0.55) can
satisfy the second without dominating every other signal on every behavioural
query. §37 Option B is refuted by measurement, not by preference.

## 3. Chosen architecture

`src/retrieval/operationRole.ts` — an **answer-role relation**, adding no
magnitude. It is the only step in retrieval that compares two candidates to each
other; everything upstream scores each candidate alone, which is precisely why
none of it can see that one definition produces what another consumes.

- A **direct implementer** carries a compatible `direct` fact that passed both
  existing proofs (result-bearing/exempt, subject-aligned). The tier is reused
  from `mechanismEvidence`, so the lane and the scorecard cannot disagree.
- A causal link is discovered from the consuming side, from recorded operand
  provenance and exact `calls` edges only, depth ≤ 2 — the same bounded walk
  `mechanismSupport` uses, whose primitives are now shared rather than restated.
- Whichever side implements the **requested** operation is placed immediately
  above the other and no higher. The other side loses nothing.

Numeric parameters introduced: **none**. The placement uses a `1e-4` tie-break
step — the smallest representable score increment, not a calibrated weight. No
value was chosen from the ARC gap (§56).

Symmetry is structural, not configured: the same pair reverses between paired
queries because the promotion depends on the requested operation, never on the
fact kind or the call direction.

A second defect surfaced and was fixed: the mechanism subject floor read
`Math.max(lexical, path, symbol)` — name and path evidence only — so a direct
implementer whose author chose an uninformative name could never earn operation
evidence, even when its own operand named the subject exactly. The floor is now
waived for `direct_operand` alignment only (never `local_producer` or
`undecidable`, which are not independent evidence).

## 4. ARC results

Ordering query — `What determines the precedence/order when multiple reaction
families match?`

| candidate | before | after |
|---|---|---|
| `get_all_families` | rank 22, final 1.0549, role `null` | **rank 1**, final 1.7640, role `support` |
| `determine_family` | rank 1, final 1.7639, role `pivot` | rank 2, final 1.7639 (unchanged), role `pivot` |

The orderer is placed exactly `+0.0001` above the consumer — the minimum step —
and the consumer's score is untouched.

Preserved, byte-identical:

- **Selection** (`How does ARC decide which reaction family wins?`):
  `determine_family` rank 1 / 2.1256 / pivot; `get_all_families` delivered as
  `mechanism_support`. The paired reversal holds on one index.
- **Gaussian** (§45): operation-fact lane examined 64 owners, admitted **0**;
  `_user_requested_verytight` still leads. No unrelated parser gained a role.

## 5. Generic paired corpus

New: `m150OperationEmphasisCorpus.ts` (10 cases, 5 modules,
`fixtures/m150_operation_emphasis/`), run through the product path. Symbol names
are deliberately useless, and where a name is informative it is on the *wrong*
definition.

| metric | `fe5c220` | final |
|---|---|---|
| `directImplementerBeatsConsumer` | 2/8 | **6/8** |
| paired role reversal | 0/4 | **2/4** |
| consumer incorrectly leads | 3 | 2 |
| direct implementer Top-1 | 2/9 | 3/9 |
| direct implementer generated | 6/9 | 6/9 |
| wrong-subject operation bonus | 0 | **0** |
| unknown-ordering overclaim | 0 | **0** |
| `<module>` nodes delivered | 0 | **0** |

## 6. Preservation

- Full suite **4544 pass / 0 fail / 49 skip** — identical to the frozen baseline.
- `bun run typecheck` and `bun run typecheck:benchmarks` clean; `git diff --check`
  clean.
- 15-case mechanism corpus (§43): correct lead 9→9, Top-1 9→9, wrong-subject lead
  0, wrong-subject bonus 0, negative-control bonus 0, ordering helper visible 3/4,
  mechanism support 1, `<module>` nodes 0. **Top-3 13→12** (see §7).
- Answer-role lane: 0 source reads, bounded ≤24 consumers × ≤4 per hop × depth 2.
- No schema, index-capability or derivation change.

## 7. Changed cases, classified

Cause `primary_operation_fulfillment`:

| case | movement | class |
|---|---|---|
| `backend_vs_frequency` | lead `resolve_backend` → `choose_backend` (the expected answer) | **IMPROVEMENT** |
| `first_success_backend` | lead `resolve_backend` → `choose_backend`; expected was `resolve_backend`, rank 2→4 | **REGRESSION** |
| `two_hop_producer` | expected `indirect_choice` rank 3→4, score unchanged | **REGRESSION** (Top-3 only) |

These two queries are near-duplicates over the same corpus with different correct
answers (`which backend wins` vs `which backend to use`); the rule promoted the
same definition for both. Net on leads is zero, net on Top-3 is −1.

## 8. Why this is not PASS

1. **Delivery emphasis is not fixed.** ARC's ordering query now *ranks*
   `get_all_families` first, but the capsule still delivers `determine_family` as
   the lead pivot and the orderer as `support`. §29 requires the orderer to be the
   primary answer-bearing item. Pivot role assignment reads organic subject
   evidence and is a layer this phase did not touch.
2. **2/4 generic pairs still fail**, both because the capsule returns
   `noContextResult` for queries whose subject appears only in bodies
   (`plugin`, `channel`): the pool is populated (9–10 candidates, orderer
   promoted) but no candidate clears pivot eligibility. Same layer as (1).
3. **Mandatory preservation suites not run**: Frozen50, Django and cross_repo_30
   paired comparison against `2aaac750…` (§60) were not executed. Without them the
   frozen default path is unproven against this change and closure is not
   available regardless of the other results.
4. One measured corpus regression (§7) is unresolved.

## 9. Measured limits worth keeping

- **A list-literal precedence has no fact kind.** `routes_for` returns
  `[primary(config), fallback(config)]`; the order *is* the precedence and
  nothing indexes it. The `route_ordering` case fails for that reason, not a
  ranking one. Adding a fact kind is a derivation change (§54, §72) and was not
  attempted.
- **Producers are recorded in two columns.** The loop kinds
  (`first_success_return`) record the iterated call as the fact's `subject` with
  an empty `provenance`; only reading both finds them. `mechanismSupport` reads
  `provenance` alone, which is one reason ordering visibility sits at 3/4.
- **Pivot eligibility is the next binding constraint**, not ranking. Three
  corpus queries produce a fully populated, correctly ordered pool and an empty
  capsule.

## 10. Recommended next scope

One phase on **answer-role delivery**: carry the operation role into pivot
eligibility and pivot ordering so a rank-1 direct implementer is delivered as the
primary item rather than as support, then re-run this corpus, the 15-case corpus,
and the three mandatory paired suites. M151 should not start until that closes.
