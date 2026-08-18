# M158 — Support packing and bounded evidence selection

**M158 is MIXED.**

The central bounded-support-packing hypothesis was **rejected**, but the audit
exposed and M158 corrected an independent generic support-slot defect in which
byte-identical evidence could consume multiple scarce support positions.

| workstream | verdict |
| --- | --- |
| A — support-loss population and packing audit | **PASS** (hypothesis rejected on evidence) |
| B — frozen duplicate-support population and controls | **PASS** |
| C — canonical delivered-identity dedupe | **PASS** |
| D — consumer parity, envelope, runner hygiene | **PASS** |
| E — broad100, frozen50, frozen30, clean27 preservation | **PASS** |

> **SUPPORT PACKING AS BROAD GOLD-LOSS BOTTLENECK: NO.**

---

## 1. The question M158 was convened to answer, and the answer

> When several candidates already have legitimate support authority, does VTRACE
> select the best bounded evidence set, or does a fixed rank-first support cap
> allow redundant/weaker evidence to crowd out independently useful support?

It selects well. The nine cases that lose gold past `max 4` are not a packing
population. Gold sits at packed positions **6, 9, 9, 11, 22, 22, 24, 26, 28** —
one case adjacent to the bound, a median of 22. Every conservative packing rule,
simulated over the product's own ordered support list, recovers **zero**:

| rule | recovered /9 | gold lost elsewhere |
| --- | ---: | ---: |
| pure score order | 0 | 6 |
| dedupe same (file, symbol) | 0 | 0 |
| one slot per file | 0 | 0 |
| one slot per pivot-file | 0 | 2 |
| placeholder lanes last | 0 | 1 |
| bound 4 → 5 | 0 | 0 |
| bound 4 → 6 | 1 | 0 |
| bound 4 → 12 | 4 | 0 |

Only the bound moves anything, and only by tripling to reach 4 of 100 — a number
read off the gold ranks, which is the fitting §56 forbids and §128 makes a FAIL.
So no diversity packing, no role balancing, no token-aware packing, no support
score change and no larger bound was implemented. Full detail:
`stage5_m158_support_packing_audit.md`.

Three corrections to the inherited framing, all verified:

- The population is **9 cases across 5 repositories**, not 8 across 6. The ninth
  is `matplotlib-26466`, whose gold-file candidate (`text.py::set_backgroundcolor`,
  score 0.511) is not useful evidence for an xy-array mutation bug — a
  `GOLD_NOT_ACTUALLY_USEFUL` case, kept separate rather than merged.
- The **item count is the only bound that ever binds.** Support was rejected for
  tokens 0 times in 100 cases; four support items cost 87–156 tokens against
  403–7614 of headroom. §35's cheap-fifth condition holds universally.
- Five repositories carrying nine positives **cannot support the repo-level
  calibration/holdout split §30 asks for.** Reported before implementing, per §32.

## 2. What M158 fixed instead

Support renders signature-only, so two genuinely distinct candidates can deliver
byte-identical text — a method overridden in four classes of one file, a flag
assigned in ten. Measured on the frozen M157 baseline:

```
cases delivering byte-identical support   10 / 99
bounded support slots wasted              12
repositories                              3   (django, matplotlib, sphinx)
```

`django-16819` spends three of four slots on the literal text
`def reduce(self, operation, app_label):`.

**The rule:** one canonical delivered identity — path + content mode + rendered
text — may consume at most one support slot. It is dropped *before* the bound is
consumed, so the freed slot refills from the existing support-authorized order.

It keys on the delivered evidence and nothing else. Not the file (`§45`), not the
symbol name, not the relation. `sympy-16597` delivers `sympy/core/numbers.py::is_finite`
twice and keeps both, because the two say different things.

**Zero free parameters.** No threshold, weight, bound or ranking input. That is
why no calibration/holdout split is declared for it (§31 policy recorded in
`stage5_m158_corpus_manifest.json`): there is nothing a calibration set could
tune and nothing a holdout could catch being overfitted. What replaces the split
is a whole-corpus measurement plus frozen negative controls a looser rule would
visibly destroy.

## 3. Measured outcome

| | M157 | M158 |
| --- | ---: | ---: |
| cases with duplicate support slots | 10 | **0** |
| bounded slots wasted on restatement | 12 | **0** |
| restatements refused (recorded) | 0 | 15 |
| support slots filled (100 cases) | 380 | **380** |
| gold delivered | 79 | **79** |
| within global envelope | 100/100 | **100/100** |
| support tokens (total, 100 cases) | 15540 | 15635 |

`380 → 380` is the load-bearing number: the capsule did not shrink. Every
reclaimed slot went to the next support-authorized candidate.

`79 → 79` is the honest one: **useful_support_recovery = 0** by the gold measure.
The rule was never expected to recover gold — the A audit predicted exactly this
— and it did not.

| new core metric | value |
| --- | ---: |
| `useful_support_recovery` (gold) | 0 |
| `useful_support_displaced` | **0** |
| `misleading_support_added` | **0** |
| `redundant_support_selected` | 12 → **0** |

## 4. Broad100 — M157 final → M158 final

Fresh paired evaluation, both arms run by their own binary over the same
derivation-valid M156 corpus. The M157 arm independently reproduces M157's
published rates (top-1 0.58, top-3 0.74, delivered 0.79).

| metric | M157 | M158 |
| --- | ---: | ---: |
| Top-1 | 0.58 | 0.58 |
| Top-3 | 0.74 | 0.74 |
| gold delivered | 0.79 | 0.79 |
| gold anywhere | 0.89 | 0.89 |
| symbol anywhere | 0.64 | 0.64 |
| empty contexts | 0.01 | 0.01 |
| tokens mean / median / p90 | 1658.15 / 1165 / 3750 | 1659.10 / 1181 / 3750 |

Gold fate recomputed, and the M157 combined bucket finally split — under M158's
instrumentation, `role_denied` is **empty**: the gold in all nine earned support
authority and lost a slot.

| fate | M157 | M158 |
| --- | ---: | ---: |
| delivered as pivot | 68 | 68 |
| delivered as support | 11 | 11 |
| support-packed-out | 9 | 9 |
| withheld by the no-pivot gate | 1 | 1 |
| never retrieved | 11 | 11 |
| role-denied | 0 | 0 |

`never retrieved` is unchanged, as §91 requires: M158 does not touch acquisition.

**Changed cases: 3 scorer-visible, 10 by delivery.** Both are reported, because
one alone would mislead. The broad100 scorer measures the gold file's fate and is
mostly blind to support composition; the delivery instrument measures what the
model is shown.

- All 3 scorer-visible cases are `REDUNDANT_SUPPORT_REDUCTION` / `IMPROVEMENT`,
  0 unexplained, 0 regressions. Each **gained a distinct file** in top-3:
  `django-11133` (+`http/multipartparser.py`), `matplotlib-25960`
  (+`lib/matplotlib/axes/_axes.py`), `sphinx-7748` (+`sphinx/ext/napoleon/__init__.py`).
- 0 gold-delivery regressions and 0 shrunk capsules across all 10.

## 5. Preservation

| gate | result |
| --- | --- |
| frozen50 fast gate | 50/50 derivation-valid, `gateUsable=true`; top1 0.76, top3 0.86, delivered 0.90, discarded 0.06, missing 0.04 — **identical to M157**; 3 changed cases, all the same distinct-file gains; meanTokens 1779 → 1780 |
| frozen30 availability | **30/30 usable, 0 unavailable, 3 degraded** — identical set (`psf__requests-1142`, `pylint-dev__pylint-4551`, `pytest-dev__pytest-5262`); 0 changed cases; candidate measured from a clean tree at `f51b9609` |
| clean27 structural equivalence | **27/27** structurally identical (file, symbol and edge counts) |
| M156 recovered repositories | requests, pytest, pylint all still usable-degraded, unchanged |
| `sphinx-9320` M157 pivot refill | **preserved** — lead `sphinx/cmd/quickstart.py::_has_custom_template`, standard mode, byte-identical state |
| `django-11740` no-pivot | **unchanged** — 33 candidates, 0 pivots, 0 support, 33 discarded, 0 tokens |
| `xarray-6599` M157 neutral case | **unchanged**, and a live negative control: it delivers `computation.py::polyval` three times on distinct evidence, all preserved |
| `<module>` deliveries | **0** before, **0** after |
| index writes during retrieval | **0** before, **0** after |
| behavioural routing | OFF (test-asserted) |
| quarantine | 0 |

## 6. Benchmark hygiene (§80–§84)

`run_stage5_m156_broad_comparison.ts` wrote one hardcoded destination, so reusing
it for a later checkpoint silently replaced M156's committed evidence. The
preservation runner had the identical defect. Both now take an explicit `--out`,
default to a milestone-derived filename, and **fail closed** when the target
already holds another milestone's artifact.

Controls, both directions (`stage5_m158_runner_safety_test.json`): an M158 run
aimed at committed M156 evidence is refused; the same run at its own destination
succeeds; the M156 artifact is byte-unchanged after both attempts. A
same-milestone rewrite is deliberately still allowed. Kept in its own commit so
it stays out of M158's support-packing attribution.

## 7. Verification

```
bun run typecheck              clean
bun run typecheck:benchmarks   clean
bun test                       4832 pass · 49 skip · 0 fail (4881 across 311 files)
git diff --check               clean
```

`.vtrace` staged: 0 · tracked ignore-file changes: 0 · global Git config
mutations: 0 · no live agents, no Docker, no network.

## 8. Strategic interpretation

**Was support packing actually a meaningful broad bottleneck? NO.**

The `max 4` rank-first layer is largely behaving correctly. The omitted gold is
weaker, redundant or not useful, and it sits far below the cut rather than just
past it. The nine cases are a **ranking/acquisition** population wearing a
delivery population's clothes — the same mistake M157 caught with `django-11740`,
one layer down. They are recorded as residual evidence, not chased here.

What M158 did deliver is real but narrow: within the same bounded context, the
model no longer sees the same line of evidence twice at the cost of a slot that
could carry something else. That is an evidence-composition improvement the
gold-centric benchmark cannot see, which is why it is reported with an explicit
`useful_support_recovery = 0` rather than dressed up as a retrieval gain.

## 9. Next

Per §151/§152, delivery tuning did **not** generalize into gold recovery, so the
next milestone should not be another delivery milestone. The residual population
after M158 — unchanged from M157, because M158 moved no case between buckets — is:

```
never retrieved                 11   <- acquisition
support-packed-out               9   <- ranking depth, NOT packing (M158-A)
withheld by the no-pivot gate    1   <- M157 closed as unmeasurable at 2%
```

The 11 never-retrieved cases are the acquisition population §151 points to. The 9
are now understood well enough to be re-read as a ranking question rather than a
delivery one.
