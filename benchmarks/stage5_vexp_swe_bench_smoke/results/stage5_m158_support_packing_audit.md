# M158-A — bounded support packing audit

**Verdict: the milestone's central hypothesis is rejected.** Bounded `max 4`
support packing is not the broad gold-loss bottleneck. No selection rule that
respects relevance authority recovers any of the nine cases, and the only thing
that does — tripling the item bound — is the benchmark fitting §56 forbids.

The audit did prove a different, independent defect, and M158 fixes that one
instead. It is recorded in `stage5_m158_corpus_manifest.json` and the final
report; this document is about the hypothesis that failed.

---

## 1. The population, reproduced

The M157 standing finding claimed **8 cases across 6 repositories** lose gold
beyond the support bound. Reproduced mechanically from the committed broad100
corpus (`stage5_m158_support_loss_population.json`), the true figures are:

| | M157 claim | measured |
| --- | ---: | ---: |
| cases | 8 | **9** |
| repositories | 6 | **5** |

Both corrections matter.

**The ninth case is `matplotlib__matplotlib-26466`** (§20). M157 excluded it
because one of its two gold-file candidates carries a second discard reason
(`no lexical/symbol/path/test/graph relevance to the task`) alongside the budget
reason. But its gold file never reaches delivery and one of its candidates *is*
packed out by the bound, so by the fate definition it belongs in the bucket. It
is classified separately below because its mechanism genuinely differs.

**Five repositories, not six** — `django/django` ×2, `matplotlib/matplotlib` ×2,
`sphinx-doc/sphinx` ×2, `sympy/sympy` ×2, `pylint-dev/pylint` ×1. This was
material: §30 asks for a 3–4 / 2–3 repository calibration/holdout split, and
five repositories carrying 9 positives cannot support one that means anything.

The whole-corpus gold fate under M157, recomputed exclusively:

| fate | cases |
| --- | ---: |
| delivered as pivot | 68 |
| delivered as support | 11 |
| **support-packed-out** | **9** |
| withheld by the no-pivot gate | 1 |
| never retrieved | 11 |

`68 + 11 = 79 = goldDelivered 0.79` reproduces M157's published rate
independently, so the buckets are trustworthy. (M157 published 67 pivot / 2
no-pivot against the M156 index; the shift of one case is M157's own
`sphinx-9320` recovery, measured here against M157 final.)

## 2. The authoritative packing path

Traced in source, not inferred from configuration names (§23):

| stage | location |
| --- | --- |
| support ordering | `buildCapsuleV2.ts:1129` — `supportTier` ascending, then `scores.final` descending |
| effective bound | `buildCapsuleV2.ts:1139` — `allocation.maxSupport` minus one when an M101 anchored cap exemption converted a slot |
| lane reordering | co-edit `:1174`, file-evidence rescue `:1226`, path completion `:1250`, mechanism support `:1395` |
| the cut | `buildCapsuleV2.ts:1421` — `support.length >= maxSupportSlots` → `beyond <tier> support budget (max N)` |
| token check | `:1425` — `renderSupport(..., maxTokens - usedTokens)`, **after** the count check |

**Packing is not simple rank truncation** (§24). Four lanes splice entries into
the ordering under displacement contracts before the cut. What *is* true is that
the cut itself is a prefix take of whatever ordering those lanes produced.

**The item count is the only bound that ever binds** (§13). Across all 100
cases, support was rejected for tokens **0 times** and for item count in 99. Four
support items cost 87–156 tokens against 403–7614 tokens of headroom. So §35's
"cheap fifth item" condition is not a special case to construct — it holds
universally, which is precisely why raising the bound was tested rather than
assumed.

## 3. Where the gold actually sits

The decisive number. Position of the best-placed gold candidate in the packed
order, past a cut at 4:

```
6, 9, 9, 11, 22, 22, 24, 26, 28
```

One case sits adjacent to the bound. The median is 22. Whatever is wrong here,
it is not that the capsule stopped one item too early.

## 4. Every candidate rule, simulated

Rather than argue case by case, each rule was run over the product's own ordered
support list — winners plus the tail it rejected, in the product's own order. No
rule changes a score, invents a candidate, or reads the gold label as an input
(`stage5_m158_packing_rule_simulation.json`).

| rule | gold recovered /9 | gold lost elsewhere | cases changed |
| --- | ---: | ---: | ---: |
| baseline (`max 4`, product order) | — | — | — |
| pure score order | 0 | **6** | 79 |
| dedupe same (file, symbol) | 0 | 0 | 15 |
| one slot per file | 0 | 0 | 60 |
| one slot per pivot-file | 0 | **2** | 38 |
| placeholder lanes last | 0 | **1** | 18 |
| dedupe + placeholders last | 0 | **1** | 30 |
| bound 4 → 5 | 0 | 0 | 99 |
| bound 4 → 6 | 1 | 0 | 99 |
| bound 4 → 8 | 1 | 0 | 99 |
| bound 4 → 12 | 4 | 0 | 99 |

Every structural packing rule recovers **zero**. Three of them cause harm. The
only lever that moves anything is the bound, and it has to triple to reach 4 of
100 — chosen from the gold ranks themselves, which is the definition of
benchmark fitting (§56) and a FAIL condition (§128).

## 5. Root-cause distribution

Classified per §8, primary cause per case, source-inspected rather than inferred
from patch membership (§27):

| cause | cases | instances |
| --- | ---: | --- |
| `SUPPORT_ORDERING_DEFECT` | 3 | `django-15037`, `matplotlib-25332`, `pylint-8898` |
| `REDUNDANT_OCCUPANCY` | 2 | `django-17084`, `sympy-16597` |
| `FILE_CONCENTRATION` | 1 | `sympy-16792` |
| `CAP_TOO_SMALL` | 1 | `sphinx-9698` |
| `GOLD_NOT_ACTUALLY_USEFUL` | 1 | `matplotlib-26466` |
| upstream of packing (ranking depth) | 1 | `sphinx-7910` |

The taxonomy is real — but note what the simulation shows: **the diagnosed cause
and the recoverable cause are not the same thing.** Three cases genuinely do put
a placeholder-scored lane entry (final 0.350) above earned support scoring
1.2–1.5, and two genuinely do spend slots on near-identical evidence. Fixing
either recovers nothing, because the gold in those cases sits at position 9, 11,
22 and 24 — far below anything the freed slot reaches.

Two cases deserve naming:

- **`sphinx-9698`** is the only near-cut case, and it argues *against* the
  ordering fix rather than for it: its gold candidate at position 6 is itself a
  placeholder-scored co-edit entry (`domains/python.py::PythonDomain`, final
  0.350). Ranking placeholder lanes last would push it further out, not closer.

- **`django-17084`** is the most visually damning and the least actionable.
  Three of four slots hold module variables from one file, and the tail holds
  **ten more copies of `window_compatible`**. Collapsing all ten lifts gold from
  position 24 to roughly 15. Still nowhere near a slot.

## 6. Why this is a ranking population, not a packing one

For each case the first stage at which useful evidence stops being deliverable
(§22) is *ranking*, not packing. The gold candidates are support-authorized and
correctly ordered relative to their own evidence — they simply carry weak
evidence:

- `django-15037` — gold symbol `table2model` is a nested function and never
  enters the pool; the best gold-file candidate is a sibling method at 1.473,
  behind four items scoring 1.5–1.8 in the ORM subsystem the task does not name.
- `matplotlib-25332` — the gold class `Grouper` is not in the pool at all; only
  `cbook.py` neighbours at 0.300–0.698 are.
- `sympy-16792` — the gold file enters only as a 0.300 graph-neighbour rescue.
- `matplotlib-26466` — the gold-file candidate `text.py::set_backgroundcolor` is
  not useful evidence for an xy-array mutation bug by any source-backed reading.

M158 owns the support-packing layer (§15, §22). These losses are upstream of it
and are recorded as residual evidence for the next milestone, not chased here.

## 7. §39 stop condition

> If the eight cases do not demonstrate a generic support-packing problem, stop.
> … the correct conclusion may be: max 4 is working as designed.

They do not, and it is. The bounded packing layer is behaving correctly: it
delivers four independently useful items and drops evidence that is genuinely
weaker. The original hypothesis is closed as **NO**.

What the audit surfaced on the way is a separate defect that has nothing to do
with gold rank — a support slot can be spent restating evidence the capsule has
already delivered. That is measured, frozen and fixed under M158-B/C/D/E; see
`stage5_m158_corpus_manifest.json` and `stage5_m158_final_report.md`.
