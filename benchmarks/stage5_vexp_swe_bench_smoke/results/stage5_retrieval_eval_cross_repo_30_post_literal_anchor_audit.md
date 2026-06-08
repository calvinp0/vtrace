# Stage 5R — cross-repo 30 miss audit (refresh after literal anchoring)

**Scope:** audit-only. No retrieval, scoring, candidate-generation, or role logic was
changed in this task. This refreshes
`stage5_retrieval_eval_cross_repo_30_post_title_symbol_audit.md` so the remaining
failures reflect the current system, after two changes landed since that audit:

1. **Generic-infrastructure lexical-decoy suppression** (down-weights a candidate whose
   identity is a generic infra token — `deprecation.py`, a `*Dict*` helper — with weak
   direct evidence). Recommended by the prior audit.
2. **High-signal literal/option/acronym anchoring** (a candidate generator for ALL-CAPS
   acronyms, dunders, `--options`, and backticked/quoted literals).

Source artifacts:

- `results/stage5_retrieval_eval_cross_repo_30.json`
- `results/stage5_retrieval_eval_cross_repo_30.md`
- prior: `results/stage5_retrieval_eval_cross_repo_30_post_title_symbol_audit.md`

Current headline:

| metric | prior (post-title-symbol) | current | delta |
| --- | --- | --- | --- |
| top-1 file accuracy | 60.0% | 60.0% | — |
| top-3 file recall | 73.3% | 76.7% | +3.3 pp ▲ |
| expected file as pivot | 70.0% | 73.3% | +3.3 pp ▲ |
| expected file missing | 16.7% | 13.3% | −3.4 pp ▲ |
| no_context | 2 | 2 | — |
| non-top-3 misses | 8 | 7 | −1 |

Django expanded is unchanged at **80.0 / 95.0 / 85.0 / 0.0** — both changes were gated
against it with no regression.

---

## 1. What changed after literal anchoring (and decoy suppression)

**One recovery: astropy-14369 (`missing` → `hit_top3`, gold now a pivot at rank 2).**
The prior audit filed this as a *hard wrong-subsystem name collision*: the task says
"ascii.cds" and the lexically-obvious sibling is `io/ascii/cds.py`, while the gold is the
unit grammar `units/format/cds.py` — same basename, different package. Literal anchoring
dissolved it without any cross-package reasoning: the ALL-CAPS acronyms `CDS` and `MRT`
resolve via **path segment** (`io/ascii/cds.py::Cds`, `io/ascii/mrt.py::Mrt`) *and*
**exact-case symbol** (`units/format/cds.py::CDS`), so the gold unit-grammar file is
seeded into the pool directly and lands at rank 2. This is the single source of the
+3.3 pp top-3 / −3.4 pp missing movement.

**Decoy suppression landed but is diagnostics-only on the cross-repo set.** It fires
visibly on matplotlib-24970 (`generic lexical decoys suppressed: deprecation ->
_api/deprecation.py`) but did **not** recover it: the high-in-degree `deprecation.py`
symbols (`deprecated` has 116 dependents, `warn_deprecated` 28) are protected by the
in-degree guard (strong graph-neighbourhood evidence is never suppressed), and the gold
`colors.py` is absent from the pool entirely, so there is nothing to re-rank. Net effect
on cross-repo aggregates: zero — exactly as that change's own eval reported.

**Literal anchoring also fired on astropy-14598 (`FITS`) without recovering it, and
nudged the gold one slot worse.** The `FITS` acronym surfaced `io/fits/diff.py::FITSDiff`,
`io/fits/fitsrec.py::FITS_rec`, and `units/format/fits.py::Fits` — all real FITS-named
files but none the gold `io/fits/card.py` (the FITS *card* parser). Those anchored
candidates consumed support slots, moving `card.py` from support rank 5 (prior audit) to
**rank 6** now. Same disposition (`present_but_support`), no result/metric change, but
worth tracking: a correct-domain acronym can still crowd the true edit site when the
domain has many same-prefix files. The remaining 6 misses are otherwise unchanged.

---

## 2. Current non-top-3 cases (7)

| instance | repo | gold file(s) | top-1 pivot now | disposition | taxonomy |
| --- | --- | --- | --- | --- | --- |
| matplotlib-24970 | matplotlib | lib/matplotlib/colors.py | _api/deprecation.py::MatplotlibDeprecationWarning | absent from candidates | wrong_subsystem |
| pylint-8898 | pylint | config/argument.py, utils/__init__.py, utils/utils.py | — (no_context) | absent from candidates | missing_from_candidates |
| sphinx-7910 | sphinx | ext/napoleon/__init__.py | ext/autodoc/__init__.py::DecoratorDocumenter | absent from candidates | wrong_subsystem |
| sphinx-9230 | sphinx | util/docfields.py | util/__init__.py::FilenameUniqDict | absent from candidates | wrong_subsystem |
| requests-1724 | requests | sessions.py | utils.py::stream_decode_response_unicode | present → discarded (rank 6) | present_but_discarded |
| astropy-14598 | astropy | io/fits/card.py | io/fits/diff.py::FITSDiff | present → support rank 6 | present_but_support |
| matplotlib-25960 | matplotlib | lib/matplotlib/figure.py | — (no_context) | present → discarded ("no actionable edit target") | present_but_discarded |

---

## 3. Current missing cases

**Two `no_context`** (the capsule emits no pivot):
- **pylint-8898** — the only retrieved candidates were doc-data decoys (now demoted by the
  non-source rule); the three gold production transformer files were never retrieved. A
  production near-candidate (`checkers/base/name_checker/checker.py::_BadNamesTuple`)
  reaches the discard list, confirming the pool found the right subsystem but not the gold
  files.
- **matplotlib-25960** — the gold `figure.py::subfigures` IS surfaced (top discarded) but
  the actionability gate classifies it "no actionable edit target"; the remaining
  candidates are `galleries/examples/**` non-source. A gate decision, not a retrieval gap.

**Four `role = missing`** (gold file absent from candidates): matplotlib-24970,
pylint-8898, sphinx-7910, sphinx-9230.

**Two present-but-out-of-top-3:** requests-1724 (sessions.py → discarded, rank 6),
astropy-14598 (card.py → support rank 6).

---

## 4. Candidate-generation gaps (gold never in pool) — 3

The real domain file never entered the pool, because a generic-infra decoy or a
parallel-package sibling won it. Lexical-decoy suppression has now landed and does **not**
close these — the decoys here are either high-in-degree-protected infra or a different
package, neither suppressible by design.

| instance | gold the pool missed | what the pool anchored on instead |
| --- | --- | --- |
| matplotlib-24970 | colors.py (the deprecated-numpy call site) | `_api/deprecation.py` (the literal "deprecation" module — suppressed, but high-in-degree-protected, so it stays; colors.py still absent) |
| sphinx-9230 | util/docfields.py (field rendering) | `util/__init__.py::FilenameUniqDict` + `pycode/ast.py::visit_Dict` (the "dict(str,str)" red herring) |
| pylint-8898 | config/argument.py, utils/utils.py (CSV/regex transformers) | doc-data decoys (demoted → no_context); production `checker.py` only as a non-actionable discard |

These now need **candidate generation**, not ranking: the gold is genuinely outside the
pool and no surviving lever (title-symbol, literal-anchor, decoy-suppression) reaches it.

---

## 5. Ranking / lexical-decoy gaps (gold present, mis-ranked) — 2

The gold file IS in candidates but loses to a decoy or the support budget — ranking /
eviction, not candidate generation. Both are within two slots of top-3.

| instance | gold disposition | what beat it |
| --- | --- | --- |
| requests-1724 | sessions.py reached support rank 6 → discarded (support budget max 4) | `decode`/`unicode`/`error` → `utils.py` helper + urllib3 exception/pool classes rank above it |
| astropy-14598 | card.py reached support rank 6 (was rank 5 pre-literal-anchor) | FITS-named siblings (`diff.py::FITSDiff`, `fitsrec.py::FITS_rec`, `units/format/fits.py::Fits`) + `quotechar` module-vars fill the slots ahead of it |

Note astropy-14598 regressed one support slot (5 → 6) as a side effect of FITS literal
anchoring adding correct-domain-but-wrong-file candidates. Disposition and aggregates are
unchanged, but it confirms the budget/eviction pressure on this case is now slightly
higher, not lower.

---

## 6. Wrong-subsystem / hard-semantic cases — 1

The lexically-obvious file is a sibling/parallel package; reaching the gold needs
cross-package or call-site reasoning, not a path or name rule.

| instance | lexically-obvious sibling chosen | gold (parallel package) |
| --- | --- | --- |
| sphinx-7910 | ext/autodoc/__init__.py (the obvious documenter machinery) | ext/napoleon/__init__.py (napoleon's `_skip_member` hook) |

astropy-14369 left this class (recovered via the CDS path/exact-case anchor — see §1).
sphinx-9230 is a wrong-subsystem case too, but its root cause is a candidate-generation
gap (the `*Dict*` decoy), so it is filed under §4.

---

## 7. Role / actionability-gate cases — 1

| instance | what happened |
| --- | --- |
| matplotlib-25960 | gold `figure.py::subfigures` is surfaced (top discarded) but the actionability gate suppresses it to `no_context`. Not a subsystem or retrieval error — a gate-tuning question that needs its own eval. |

---

## 8. Previous misses recovered

| instance | prior state (post-title-symbol) | current state | cause |
| --- | --- | --- | --- |
| astropy-14369 | missing / wrong_subsystem (units-vs-io/ascii cds name collision) | hit_top3 (gold pivot, rank 2) | `CDS`/`MRT` literal anchoring: path-segment + exact-case symbol resolution seeds the gold `units/format/cds.py` into the pool |

That is the only cross-repo recovery since the post-title-symbol audit. (For context, the
intervening decoy-suppression change also helped Django expanded reach 80/95/85/0 with no
regression, but produced no cross-repo result change.)

---

## 9. Recommended next implementation

The cheap, broadly-applicable retrieval levers are now largely exhausted: title-symbol,
literal/acronym/option, and decoy-suppression have each landed and the residual 7 misses
no longer share a single suppressible/extractable cause. Concretely:

- 3 are **candidate-generation gaps** where the gold is genuinely outside the pool and the
  anchoring/suppression rules already in place cannot reach it (matplotlib-24970 protected
  infra, sphinx-9230 dict decoy, pylint-8898 multi-file).
- 2 are **ranking near-misses** at rank 6, one slot beyond the support budget.
- 1 is **wrong-subsystem** needing cross-package reasoning (sphinx-7910).
- 1 is an **actionability-gate** decision (matplotlib-25960).

The single most promising next step is a **failing-test / import-graph neighbour
expansion**: seed candidates reached from the failing test's imports and call sites (and
their immediate graph neighbours), independent of lexical match. This is the only lever
that can pull a gold file into the pool when no lexical/title/literal signal names it —
which is the shape of all three §4 gaps (pylint's transformer files are imported by the
checker that IS retrieved; matplotlib's `colors.py` is the deprecated call site;
napoleon's hook is registered, not lexically obvious). It is a candidate generator, not a
scoring change, and composes with everything already in place.

**Guards (mandatory):** gate against Django expanded (80/95/85/0) and the 16-instance
cross-repo baseline before landing. A graph-neighbour generator risks flooding the pool
with low-signal neighbours, so it must (a) be bounded per seed and overall, (b) carry weak
synthesized evidence so it cannot out-rank a real lexical/title/literal anchor, and (c)
preserve the non-source and actionability gates downstream. If a bounded version cannot
show a net cross-repo gain without Django regression, prefer **no change** — the remaining
misses are individually hard and not worth a risky global rule.

Lower-priority alternative, only if the graph experiment stalls: a support-budget /
tie-break nudge for the two rank-6 near-misses (requests-1724, astropy-14598). Deferred —
see §10.

---

## 10. Do-not-fix-yet list

- **Ranking near-misses** (requests-1724 rank 6, astropy-14598 rank 6): gold is 1–2 slots
  out. A budget/tie-break nudge risks a Django regression, and astropy-14598 is now under
  *more* budget pressure (FITS anchoring added correct-domain siblings). Re-measure after
  any graph-neighbour change before touching support budget or eviction order.
- **Actionability gate** (matplotlib-25960): the gate is correct on the vast majority of
  instances; loosening it to admit `figure.subfigures` is a semantic call that needs a
  dedicated actionability eval, not an ad-hoc relaxation.
- **Hard wrong-subsystem / sibling** (sphinx-7910 autodoc-vs-napoleon): requires
  cross-package semantic/graph reasoning; no cheap rule. Candidate for the graph-neighbour
  experiment (§9), not a bespoke fix.
- **matplotlib-24970 / sphinx-9230 protected-infra & decoy gaps:** decoy suppression
  already fired (24970) or cannot fire (the `*Dict*` symbols are legitimately Dict-named);
  recovering the gold is candidate-generation work, not further suppression. Do **not**
  weaken the in-degree guard to force 24970 — it exists specifically to avoid the Django
  regression that an unguarded suppression caused.
- **pylint-8898 multi-file gold:** three production transformer files, none retrieved; part
  of the candidate-generation work above, not a separate fix.
- **astropy-14598 support-rank slip (5 → 6):** a side effect of correct FITS anchoring, not
  a bug. Do not special-case it; revisit only inside a budget/eviction experiment.
- **Generated-file label** (astropy `cds_parsetab.py`): not a bug; leave the label as-is.

**Do not** make any retrieval / scoring / candidate-generation / role change off this audit
alone — every fix above must be gated against the Django and 16-instance cross-repo
baselines before it lands. A wrong global rule that regresses Django is worse than leaving
a hard individual miss in place.

---

## Repo-hygiene note (not part of this audit)

The benchmark scripts under `benchmarks/` are **not** type-checked by `tsc`: `tsconfig.json`
sets `"include": ["src/**/*.ts"]`, so `bun run typecheck` never sees
`benchmarks/stage5_vexp_swe_bench_smoke/*.ts`. Type errors there surface only at runtime
under `bun test`. This is **not tiny/obvious to fix safely** — adding `benchmarks/**` to the
`tsc` include is likely to surface pre-existing type issues across the benchmark scripts and
needs its own pass — so it is left untouched here and **deserves a separate repo-hygiene
task** rather than a drive-by change in an audit commit.
