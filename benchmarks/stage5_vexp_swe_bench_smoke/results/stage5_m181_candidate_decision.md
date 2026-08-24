# M181-D — candidate decision

Policy frozen before confirmation. §39.

## Admissible candidates

M181-C concluded `PRIMARY_SELECTION_REASON_CANONICAL`, which rules three of the
five §31 candidates out before any simulation. §31 forbids simulating candidates
C has rejected, so they are recorded with their grounds rather than measured.

| Candidate | Status | Grounds |
| --- | --- | --- |
| `C_CURRENT` | simulated (baseline) | — |
| `C_CANONICAL_REASON` | **simulated, selected** | one authoritative decision, made once, before the paths diverge |
| `C_COMPACT_CANONICAL` | rejected without simulation | Makes `compactReasons`' preference the shared selector. It contradicts the only declared contract in the source, and the permutation control shows the preference is order-blind: **one** distinct choice across six orders whose declared decisive reason takes **three** distinct values. That is not a competing contract. |
| `C_REASON_SET_AUTHORITY` | rejected without simulation | The §35 no-change outcome. Admissible only if the primary reason is presentational. It is not: four independent source sites treat position 0 as the claim, and the measured substitutions cross from `DEBUG_ONLY` scorer output into `SEMANTIC_ROLE`. |
| `C_STABLE_INSERTION` | subsumed | On this codebase it *is* `C_CANONICAL_REASON`: the source ordering already places the decisive reason first. |

## What the selected candidate is

One hunk in `budgetDelivery.ts`. `compactReasons` stops looking for a preferred
reason and keeps the head of the array.

The justification §85 asks for is **not** that this removes the 106. It is that
reduction and reselection are different operations, and this function was only
ever authorised to do the first. The array it receives is already ordered by a
declared contract — `unique([roleReason, ...evidence])`, with `roleReason`
documented at its definition as *"The decisive reason this item landed in its
role"*. Nothing gave a budget-driven reducer standing to overrule that, and what
it overruled it with was four substrings copied from `answerBearing`, which
decides which *item* to keep. The residual count falling to zero is a consequence,
which is the order §34 requires.

## Measured, both arms, same instrument, same 169 frozen cases

| | before | after |
| --- | ---: | ---: |
| `SEMANTIC_ROLE_CHANGED` pairs | 106 | **12** |
| non-equivalent reason substitutions | 277 | **0** |
| ellipsis-only substitutions | 12 | 12 |
| `RELATED_ITEM_LOST` pairs (the ceiling residual) | 8 | 8 |
| `ORIENTATION_TO_DECLINE` | 0 | 0 |
| `CLAIM_DOWNGRADED` / `FOCUS_CHANGED` / `PRIORITY_INVERSION` | 0 | 0 |
| claims delivered | 10,203 | 10,201 |
| unsupported claims | 0 | **0** |
| claims about a symbol outside the supply | 0 | **0** |
| projector supply cut by metadata (M180) | 0 | **0** |
| throws / responses outside the envelope | 0 | **0** |
| orientations / declines | 1,380 / 648 | 1,380 / 648 |

The 12 that remain are all one mechanism and it is not reselection: a decisive
reason longer than 160 characters is rendered under `compactReasons`' ellipsis at
tight budgets and in full at loose ones. Same claim, shortened. §53 says report it
anyway, so it is in the table.

## What moved that is not a reason

At the default budget: **21** cases classified `PRIMARY_REASON_ONLY`, **148**
byte-identical, **0** `ITEM_CHANGED`, **0** `CLAIM_CHANGED`, **0** `UNEXPECTED`.
The related symbol set and the focus symbol are identical on **169/169**.

Across the whole ladder, **8 of 2,028** (case, budget) points deliver a different
evidence set — 2 gain a tail entry, 4 lose one, 2 move a delivered item the
projector never admitted. This is the coupling flagged in advance: a reason string
has a length, `render()` includes it and `fits()` reads the rendered size, so
preserving a longer decisive reason instead of a shorter scorer diagnostic can
move where the byte budget runs out.

It is a token coupling and not a ranking change, and that is measured rather than
asserted: **0 priority inversions between arms**. At every one of the 8 points the
symbols the two arms share come back in the same relative order.
`compareKeepPriority` is untouched, and `answerBearing` is computed in
`mutableItem` from the FULL reason array *before* `compactReasons` runs, so
neither could have moved.

## Economics

Median packet over delivering budgets **542 → 542** tokens; at the default budget
**1,225 → 1,229** (+0.33%). §54's 10% investigation threshold is not approached.
No attempt was made to recover M172's ~600-token regime — §55, and M180 showed
that regime was partly the ownership defect starving the packet.
