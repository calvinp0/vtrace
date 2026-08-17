# M157-A — delivery authority audit

Companion to `stage5_m157_no_pivot_control_flow.md`, which establishes *where*
the no-pivot collapse happens. This document answers *how much it matters* and
*what actually causes it*, from the same pinned corpus.

Corpus: `/home/calvin/bench/vtrace-m156/targets/m156` (the M156 broad100, each
target indexed by the M156 binary). Fixture:
`retrieval_eval.m155_broad_100.json`. No agents, no Docker, no network.

## 1. The no-pivot state is rare

| | cases |
| - | - |
| no-pivot (`no_context`) | **2** |
| pivot present | 98 |

The two are `django__django-11740` (django/django) and `sphinx-doc__sphinx-9320`
(sphinx-doc/sphinx). Both have candidates; neither is a zero-candidate query.

## 2. Where gold actually dies

Classified over all 100 cases by the fate of the gold file:

| fate | cases | matches published M156 metric |
| ---- | ----: | ---- |
| delivered as pivot | 67 | |
| delivered as support | 11 | 67+11 = 78 = `goldDelivered 0.78` ✓ |
| **withheld by the global no-pivot gate** | **2** | |
| role-denied or budget-evicted | 9 | 9+2 = 11 = `goldDiscarded 0.11` ✓ |
| not retrieved | 11 | = `goldMissing 0.11` ✓ |

The classification reproduces every published M156 broad100 rate independently,
so the buckets are trustworthy.

**M157's delivery-policy question can only ever move 2 of 100 cases.** The larger
discarded-gold bucket is a different mechanism: 8 of those 9 cases carry the
discard reason `beyond standard support budget (max 4)` — the gold earned support
authority and lost a *packing* slot, not an *authority* decision. That is out of
M157's scope and is recorded as a standing finding, not fixed here.

## 3. The two no-pivot cases have different causes

### `sphinx-doc__sphinx-9320` — a role-classification defect

25 candidates, **18 of them in the gold file** `sphinx/cmd/quickstart.py`, 3 of
them exact gold symbols (`ask_user`, `allow_empty`, `is_path`). Delivered:
nothing.

Recovered role reasons show why:

| rank | candidate | role decision |
| ---: | --------- | ------------- |
| 0 | `doc/conf.py::parse_event` | non-source example (path under `doc/`) — support, not an edit target |
| 1 | `doc/conf.py::setup` | non-source example (path under `doc/`) — support, not an edit target |
| 5 | `quickstart.py::_has_custom_template` | **strong target beyond the pivot budget** |
| 6 | `quickstart.py::term_input` | **strong target beyond the pivot budget** — symbol-name match |
| 9 | `quickstart.py::ask_user` (gold symbol) | **strong target beyond the pivot budget** |
| … | 14 more | 12 more `beyond the pivot budget` |

The sequence is:

1. `assignCandidateRoles(candidates, { maxPivots: 2 })` grants both pivot slots
   to the two top-ranked `doc/conf.py` candidates.
2. Every later candidate that **met the pivot bar** is demoted to support with
   the reason `strong target beyond the pivot budget` — 17 of them.
3. The non-source-example demotion (`buildCapsuleV2.ts:812`) then removes the
   pivot role from those two `doc/conf.py` candidates.
4. Nothing reclaims the vacated slots. `pivotCandidates.length === 0`.
5. The global gate discards all 25.

**A candidate disqualified from the pivot role keeps the slot it consumed.** The
cap is applied before two demotions that can invalidate it
(`buildCapsuleV2.ts:786` scoped-objective, `:812` non-source), and neither
releases the slot. `capPivots` inside `refineDebugRoles` is correctly ordered
after its own demotions; these two are not.

This is M157 hypothesis **(1) role-classification defect**, and it is generic:
no benchmark identity, no repository name, no score threshold is involved.

### `django__django-11740` — an evidence ceiling

33 candidates. Ranked support order:

| rank | candidates | kind | evidence |
| ---: | --------- | ---- | -------- |
| 0–24 | 25 × `default_error_messages` / `NON_FIELD_ERRORS` | `module_variable` / `module_constant` | lexical 0.57–0.93 on the task's `Errors: ValueError` line |
| 25–28 | 4 methods | actionable | indirect mechanism evidence (0.55) |
| **29** | `db/migrations/autodetector.py::add_operation` | method | behaviour-ownership, centrality 1.0, lexical 0.12 |
| **30** | `db/migrations/autodetector.py::arrange_for_graph` | method | behaviour-ownership, lexical 0 |
| 31–32 | 2 more | actionable | behaviour-ownership |

No candidate carries a symbol, path, failing-test or body-literal pointer. The
gold candidates rank **29th and 30th of 33** and are supported only by
behaviour-ownership evidence — the relation M143-B already closed as a measured
ceiling.

Delivering "the strongest support" here would deliver 25 `default_error_messages`
module variables and would **not** reach the gold. This case is hypothesis **(3),
an evidence ceiling**, and the empty result is the defensible outcome.

## 4. The pivot-slot leak, measured

| | cases |
| - | - |
| slot leak (candidates demoted for the budget while slots sit unused) | **2** |
| — of which no-pivot | 1 (`sphinx-doc__sphinx-9320`, 2 slots unused) |
| — of which pivot-present | 1 (`pydata__xarray-6599`, 1 slot unused) |
| gold among the budget-demoted candidates | 2 of 2 |
| repositories | pydata/xarray, sphinx-doc/sphinx |

Two unrelated repositories, and the affected candidates include gold in both.

## 5. Answer to the M157 primary question (§13)

> When VTRACE cannot identify a trustworthy actionable edit pivot, under what
> conditions may it still deliver bounded task-relevant evidence?

On the available evidence the question is **partly mis-posed for this corpus**.
Of the two no-pivot cases:

- one is not short of pivot-worthy candidates at all — it has seventeen, and
  loses them to a budget accounting defect;
- the other has no candidate with direct evidence of any kind, and its strongest
  support is noise.

So the audit supports fixing **pivot authority** (hypothesis 1) and does **not**
yet support a support-only delivery lane (hypothesis 2): the one case that would
need such a lane is precisely the case where the lane would deliver misleading
context. §22's class B ("no pivot + credible task-relevant evidence, currently
empty") is populated by exactly one case, and that case is better served by
giving it its pivots back.

## 6. A/B acceptance figures (§33)

| question | answer |
| -------- | ------ |
| how many no-pivot cases exist | 2 of 100 |
| how many have credible useful support | 1 (`sphinx-9320`) |
| how many are genuinely weak/noise-dominated | 1 (`django-11740`) |
| how many are ambiguous | 0 |
| what gate collapses useful-support and true-empty | `buildCapsuleV2.ts:985`, query-global, before packing |

## 7. Standing findings

- **The no-pivot collapse is real, global, and was unmeasurable.** Two reporting
  defects (`support_count` hardcoded to 0; role reason overwritten by the global
  discard string) meant the state could not be distinguished from "nothing was
  relevant". Fixed additively in this workstream.
- **A disqualified pivot keeps its slot.** Generic, affects 2/100 cases across 2
  repositories, and is the direct cause of one of the two empty capsules.
- **The support cap, not authority, is the bigger gold-loss mechanism.** 8 cases
  lose gold to `beyond standard support budget (max 4)` versus 2 to the no-pivot
  gate. Out of M157 scope; recommended as its own milestone.
- **Django-11740 is not a delivery-policy case.** Its capsule is empty because
  nothing in the pool carries direct evidence, and its top support is a
  25-candidate lexical explosion on the word `Errors`.
