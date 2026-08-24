# M181 — Selection-Reason Semantic Stability Across Compaction

From M180 at `189e190d`. 169 frozen authoritative cases, 12 budgets, 2,028
deliveries, 66 ordered pairs per case. Live spend **$0.00**.

## §83 — what are `selectionReasons`?

**A role claim followed by its provenance, in that order, by construction.**

The assembly layer builds the array as
`unique([item.roleReason, ...item.evidence].filter(Boolean))`, and the two halves
are declared separately where they are defined:

```ts
/** The decisive reason this item landed in its role. */
roleReason: string;
/** Ordered evidence: why this item was selected. */
evidence: string[];
```

So the array separates actionable semantics from provenance **by position**.
Position 0 answers *what part does this symbol play*; the tail answers *how did
VTRACE find it*. Measured over the corpus, the families sort along that seam:
`ROLE_DECISIVE`, `IMPACT_RELATION`, `COEDIT_HINT` and `BEHAVIORAL_MATCH` are
actionable; `LEXICAL_SIGNAL`, `FILE_LOCALITY`, `MEMORY_SIGNAL` and `PROJECT_RULE`
are provenance; `SCORING_DIAGNOSTIC` is scorer internals — matched tokens and a
float, not a claim about the repository at all.

## §84 — does position 0 have authority, or is it insertion order?

**Declared authority.** Four independent source sites agree, none written for this
milestone: `roleReason` is documented as *"The decisive reason this item landed in
its role"*; the assembly layer places it at position 0; duplicate merges APPEND so
they cannot displace it; and the orientation projector says *"The item's own first
selection reason IS the relationship claim the authoritative state makes about it.
Reused verbatim; never generalized."*

**`compactReasons` implemented a representation heuristic, not a semantic
priority**, and the permutation control proves it. One reason set `{A, B, C}` in
six orders:

| | distinct values across six orders |
| --- | ---: |
| declared decisive reason | **3** |
| `compactReasons`' choice | **1** |

A selector returning one answer for orders whose decisive reason takes three
values is not a rival contract. Its preference was a substring match on
`/preferred contrast|symbol-name match|direct evidence|exact/iu` — four substrings
copied from `answerBearing` twelve lines above, where they decide which ITEM to
keep. It had no priority enum, no ordering table, no comment stating an intent,
and no test.

## §83 — did the meaning change, or only the explanation?

**The meaning.** Of 289 measured substitutions, **277** replace the decisive role
claim with retrieval provenance and **all 277 run the same way** — the uncompacted
side carries the declared decisive reason and the compacted side never does. Zero
run the other way.

| substitution | n | agent-equivalent? |
| --- | ---: | --- |
| scoring diagnostic → role decisive | 214 | **no** |
| direct-evidence anchor → role decisive | 61 | no |
| role decisive → role decisive | 10 | yes — the 160-character ellipsis |
| scoring diagnostic → direct-evidence anchor | 2 | no |
| lexical signal → role decisive | 2 | yes — truncated prefixes of one sentence |

The central specimen: the same symbol, same frozen reason set, told the agent
`preferred contrast side matched: management, command, py (+0.18)` at one budget
and `entry point/caller delegating to local helpers — the edit site is the helper
it calls` at another. One is a bag of matched tokens and a score delta; the other
names the edit site. An agent deciding where to edit can act on the second and
cannot act on the first.

A synthetic object with hand-written reason arrays, no retrieval and no ranking
reproduces it, so there is nothing else to blame.

## The repair

One hunk in `budgetDelivery.ts`: `compactReasons` stops looking for a preferred
reason and keeps the head. **Reduction, not reselection.** §85's justification is
not that this removes the 106 — it is that reduction and reselection are different
operations and this function was only ever authorised to do the first. The residual
count falling out is a consequence, which is the order §34 requires.

`budgetDelivery.ts` had no test at all, which is how a second undeclared selector
lived here across two milestones. It has one now, covering the contract rather
than the old behaviour.

## Results — both arms, one instrument, same 169 frozen cases

| | before | after |
| --- | ---: | ---: |
| `SEMANTIC_ROLE_CHANGED` pairs | 106 | **12** |
| non-equivalent reason substitutions | 277 | **0** |
| ellipsis-only substitutions | 12 | 12 |
| `RELATED_ITEM_LOST` (ceiling) pairs | 8 | 8 |
| `ORIENTATION_TO_DECLINE` | 0 | **0** |
| `CLAIM_DOWNGRADED` / `FOCUS_CHANGED` / `PRIORITY_INVERSION` | 0 | **0** |
| unsupported claims | 0 | **0** (of 10,201) |
| claims about a symbol outside the supply | 0 | **0** |
| projector supply cut by metadata (M180) | 0 | **0** |
| throws / outside envelope | 0 | **0** |
| orientations / declines | 1,380 / 648 | 1,380 / 648 |
| packet median, delivering budgets | 542 | 542 |
| packet median, default budget | 1,225 | 1,229 |

**§52's two metrics differ, and that is the finding.** Raw presentation
preservation is *not* achieved — 12 reason strings still change with budget.
Agent-relevant semantic preservation *is* — 0 violations. The milestone exists
because those are different questions.

## §32 — did anything move that is not a reason?

At the default budget: 21 cases `PRIMARY_REASON_ONLY`, 148 byte-identical, **0**
`ITEM_CHANGED`, **0** `CLAIM_CHANGED`, **0** `UNEXPECTED`; related symbol set and
focus symbol identical **169/169**.

Across the ladder, **8 of 2,028** (case, budget) points deliver a different
evidence set — 2 gain a tail entry, 4 lose one, 2 move an item the projector never
admitted. This is a token coupling, not re-ranking, and it is measured: **0
priority inversions between arms**. `compareKeepPriority` is untouched and
`answerBearing` is computed from the full reason array before `compactReasons`
runs, so neither could have moved. What moved is the rendered byte count.

## §87 — are the 8 ceiling cases genuinely bounded?

**Yes**, and the boundary has two halves. Restoring each of the 14 lost entries
into the larger budget's packet, with its real fields, and measuring with the
projector's own accounting: **13** exceed the 2,000-token ceiling; **1**
(`sympy-23824`, `TensAdd`) would fit at 1,988 tokens but was excluded because
admission had already stopped at an earlier, larger candidate. That break is
deliberate — a prefix is what keeps a tighter bound's output a subset of a looser
one's. **0** unexplained. The ceiling was not changed.

An earlier version of this counterfactual restored a stub entry with no file and
no line span, understating the cost and reporting 4 apparent extra defects. A
counterfactual must reconstruct the thing it measures whole.

## Verdicts

```text
M181 overall:
PASS

A: PASS   19/19 source claims re-verified; mirror regex matches product exactly
B: PASS   106 / 8 / 757 / 21 reproduced exactly under M180's imported semantics
C: PASS   contract derived before any product code changed
D: PASS   only C-admissible candidates simulated; frozen before confirmation
E: PASS   one hunk; retrieval, ranking, selection, fit contract unchanged
F: PASS   15/15 closure gates

reason-contract verdict:
PRIMARY_SELECTION_REASON_CANONICAL

root-cause verdict:
COMPACT_REASON_SELECTION_BREAKS_CANONICALITY

semantic-preservation verdict:
BUDGET_MONOTONE_AGENT_SEMANTICS_VALIDATED

repair verdict:
SELECTION_REASON_REPAIR_VALIDATED

product verdict:
KEEP_COMPACT_ORIENTATION_WITH_REASON_FIX

totality verdict:
RESPONSE_TOTALITY_PRESERVED

truthfulness verdict:
SELECTION_REASON_TRUTHFULNESS_PRESERVED

economics verdict:
CURRENT_COMPACT_ECONOMICS_PRESERVED

ceiling verdict:
REMAINING_CEILING_CASES_EXPECTED_BOUNDARY_EFFECTS

next-work verdict:
CURRENT_PRODUCT_LIVE_REQUALIFICATION_REVIEW_LICENSED

product changed:        YES
retrieval changed:      NO
ranking changed:        NO
fit contract changed:   NO
ownership contract changed: NO
live spend:             $0.00
live work:              NOT RUN

commits:
14a67868672398aae8faa56901e1eb85ae5d3839   product
83163d2dd7f74ad55a44f763dc9673ae36c4cef8   evidence + ledger
pushed:                 NO
```

## §91 — where the deterministic contract now stands

Every remaining difference across budgets is one of two things: a truthful
representation change (an ellipsis shortening one claim, 12 pairs) or a genuine
hard-bound omission (the orientation ceiling and its prefix rule, 8 pairs, 14
entries, 0 unexplained). None is an algorithmic semantic regression.

`BUDGET_MONOTONE_AGENT_SEMANTICS_VALIDATED` is the strongest form §51 allows
without demanding raw byte monotonicity, which it explicitly does not.

## §92 — on live requalification

`CURRENT_PRODUCT_LIVE_REQUALIFICATION_REVIEW_LICENSED` licenses **review and
planning only**. The case for it is that the product is now materially different
from the M173 treatment that was last qualified live — M180 roughly doubled the
packet median by repairing the ownership defect, and M181 changed which claim
reaches the agent on 21 of 169 default-budget cases — while the deterministic
semantic-preservation defects that would have confounded such a run are now
classified and closed.

The case against running it yet: related-selection instability under load
(outstanding defect 3) has not been measured since its deterministic mechanism was
removed, and it is the one open item that could contaminate a live comparison.
Assessing that first is the cheaper order.

No live work was run. No money was spent. The next milestone still requires
explicit authorisation.
