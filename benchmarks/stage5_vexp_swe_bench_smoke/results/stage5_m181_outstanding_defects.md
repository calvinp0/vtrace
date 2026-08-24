# M181 — outstanding defects

§99. Everything known to remain after M181, with what is actually established
about each.

## 1. Ellipsis-shortened reasons still vary with budget — 12 pairs

| | |
| --- | --- |
| measured | yes — 12 of 12 remaining `SEMANTIC_ROLE_CHANGED` pairs |
| reproduced | yes, deterministically |
| mechanism known | yes — `compactReasons` cuts a reason past 160 characters to a 159-character head plus `…`; loose budgets render it whole |
| semantic consequence | **none measured.** Same claim, shortened. `reasonEquivalent` classifies these as `REPRESENTATION_ONLY`, and the family cross-tab confirms both sides are the same reason family |
| repaired | no |
| next work licensed | **no.** §53 requires reporting it, not removing it. Removing it means either shipping unbounded reason strings or making the projector reconstruct a full reason from a truncated one; neither is worth 12 pairs of presentation drift |

## 2. Orientation ceiling residuals — 8 pairs, 14 lost entries

| | |
| --- | --- |
| measured | yes |
| reproduced | yes |
| mechanism known | yes, and it has **two** halves |
| repaired | no — §49 forbids it |
| next work licensed | discussion only |

The counterfactual restores each lost entry into the larger budget's packet, in
`assemble`'s exact shape and with the entry's real fields, and measures it with
`orientationTokens` against `ORIENTATION_POLICY.ceilingTokens`:

- **13 of 14** — restoring exceeds 2,000 tokens. Genuine bounded omission.
- **1 of 14** — `sympy-23824`, `sympy/tensor/tensor.py::TensAdd` at 6,400 → 8,000.
  Restored, the packet is **1,988** tokens and would fit. It was excluded because
  admission had **already stopped**: `TensAdd` is candidate 17 and the loop broke
  at candidate 16.

That break is deliberate. `orientationProjection.ts:345` breaks rather than
skipping, because admitting a prefix is what keeps a tighter bound's output a
subset of a looser one's — the property M179 and M180 both depend on. Skipping the
oversized candidate and continuing would recover one entry and put budget-monotone
subset admission at risk. Recorded, not repaired.

**A methodological note worth keeping.** The first version of this counterfactual
restored a stub entry with an empty `file` and null `lines`, which understated the
cost and reported **4** entries as fitting — an apparent second defect. Using the
entry's real fields from the smaller budget's own packet reduced that to 1. A
counterfactual that reconstructs the thing it is measuring must reconstruct it
whole.

## 3. Related-selection instability under load

| | |
| --- | --- |
| measured | **no** — not re-measured since the deterministic mechanism was removed |
| reproduced | no |
| mechanism known | no |
| semantic consequence | unknown |
| repaired | n/a |
| next work licensed | **yes, for assessment.** M180 deferred it behind the claim-selection defect, which is now closed |

Nothing in M181 touched it. Every M181 measurement is a pure function of a frozen
JSON object and a budget, so none of them would have detected it.

## 4. `modelVisibleEstimatedTokens` naming and accounting

| | |
| --- | --- |
| measured | partly — M168 recorded a 23.5% accounting disagreement |
| reproduced | yes, at M168 |
| mechanism known | partly |
| semantic consequence | none to the agent; it misleads readers of the accounting |
| repaired | no — explicitly out of scope for M181 (§6) |
| next work licensed | not by M181 |

## 5. `get_impact_graph` envelope monotonicity

| | |
| --- | --- |
| measured | yes, at M177 |
| mechanism known | yes |
| repaired | totality yes (M177); monotonicity repair was **not authorised** |
| next work licensed | not by M181 |

## Closed by M181

**Budget-dependent selection-reason identity.** 277 non-equivalent substitutions
over 169 frozen cases → 0, with retrieval, ranking, item selection, the fit
contract, the M179 fallback correction and the M180 ownership separation all
measured unchanged, and 0 unsupported claims in 10,201 delivered.
