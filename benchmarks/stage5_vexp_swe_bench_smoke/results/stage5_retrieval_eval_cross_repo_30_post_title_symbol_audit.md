# Stage 5R — cross-repo 30 miss audit (refresh after title-symbol anchoring)

**Scope:** audit-only. No retrieval, scoring, or role logic was changed. This refreshes
`stage5_retrieval_eval_cross_repo_30_post_nonsource_audit.md` so the remaining failures
reflect the current system, after title-symbol candidate anchoring.

Source artifacts:

- `results/stage5_retrieval_eval_cross_repo_30.json`
- `results/stage5_retrieval_eval_cross_repo_30.md`
- prior: `results/stage5_retrieval_eval_cross_repo_30_post_nonsource_audit.md`

Current headline:

| metric | prior (post-nonsource) | current |
| --- | --- | --- |
| top-1 file accuracy | 56.7% | 60.0% |
| top-3 file recall | 70.0% | 73.3% |
| expected file as pivot | 66.7% | 70.0% |
| expected file missing | 20.0% | 16.7% |
| no_context | 2 | 2 |

---

## 1. What changed after title-symbol anchoring

Title-symbol anchoring seeds the index symbols named in the problem TITLE into the candidate
pool. It recovered exactly the title-symbol-shaped candidate-generation gaps:

**sympy-16766 — recovered (`missing` → `hit_top1_pivot`).** The title "PythonCodePrinter doesn't
support Indexed" now seeds `sympy/printing/pycode.py::PythonCodePrinter` into the pool with direct
"title mentions `PythonCodePrinter`" evidence; it is the lead pivot, beating the body decoy
`lambdify`. Cross-repo misses drop from 9 to **8**.

**Cross-cutting (Django expanded, for context):** django-13112 recovered
(`hit_discarded` → `hit_top1_pivot` via `ForeignKey`), and Django top-1 rose 75.0% → 80.0%, top-3
90.0% → 95.0%, with no regression. The same generator helps both repo sets.

**The 8 remaining cross-repo misses are unchanged — and none produced a title-symbol term.**
Their titles carry no symbol-shaped clue the generator can use: uppercase acronyms (`MRT`, `CDS`,
`FITS`), an exception name (`UnicodeDecodeError`, filtered by design), a hyphenated option name
(`bad-names-rgxs`), bare lowercase words (`dict`, `subfigures`, `deprecation`), or a dunder
(`__init__`). So title anchoring correctly left them untouched — the residual gaps are a different
shape, not a title-symbol failure.

---

## 2. Current non-top-3 cases (8)

| instance | repo | gold file(s) | top-1 pivot now | disposition | taxonomy |
| --- | --- | --- | --- | --- | --- |
| astropy-14369 | astropy | units/format/cds.py (+ generated cds_parsetab.py) | io/ascii/mrt.py::Mrt | absent from candidates | wrong_subsystem |
| matplotlib-24970 | matplotlib | lib/matplotlib/colors.py | _api/deprecation.py::MatplotlibDeprecationWarning | absent from candidates | wrong_subsystem |
| pylint-8898 | pylint | config/argument.py, utils/__init__.py, utils/utils.py | — (no_context) | absent from candidates | missing_from_candidates |
| sphinx-7910 | sphinx | ext/napoleon/__init__.py | ext/autodoc/__init__.py::DecoratorDocumenter | absent from candidates | wrong_subsystem |
| sphinx-9230 | sphinx | util/docfields.py | util/__init__.py::FilenameUniqDict | absent from candidates | wrong_subsystem |
| requests-1724 | requests | sessions.py | utils.py::stream_decode_response_unicode | present → discarded (support rank 6) | present_but_discarded |
| astropy-14598 | astropy | io/fits/card.py | extern/configobj/configobj.py::_quote | present → support rank 5 | present_but_support |
| matplotlib-25960 | matplotlib | lib/matplotlib/figure.py | — (no_context) | present → discarded ("no actionable edit target") | present_but_discarded |

---

## 3. Current missing cases

**Two `no_context`** (the capsule emits no pivot):
- **pylint-8898** — the only candidates were doc-data decoys (now demoted by the non-source rule);
  the gold production files were never retrieved. A production near-candidate
  (`checker.py::_BadNamesTuple`) reaches the discard list, confirming the pool found the right
  subsystem but not the gold transformer files.
- **matplotlib-25960** — the gold `figure.py::subfigures` IS surfaced (top discarded) but the
  actionability gate classifies it "no actionable edit target", and the rest are
  `galleries/examples/**` non-source. Unrelated to title anchoring.

**Five `role = missing`** (gold file absent from candidates): astropy-14369, matplotlib-24970,
pylint-8898, sphinx-7910, sphinx-9230.

**Two present-but-out-of-top-3:** requests-1724 (sessions.py → discarded), astropy-14598
(card.py → support rank 5).

---

## 4. Candidate-generation gaps (gold never in pool) — 3

Driven by a generic-infra lexical decoy winning the pool, so the real domain file never entered it.

| instance | gold the pool missed | decoy the pool anchored on |
| --- | --- | --- |
| matplotlib-24970 | colors.py (the deprecated-numpy call site) | `_api/deprecation.py` (the literal "deprecation" module) |
| sphinx-9230 | util/docfields.py (field rendering) | `util/__init__.py` + `pycode/ast.py` (`*Dict*`-named symbols — the "dict(str,str)" red herring) |
| pylint-8898 | config/argument.py, utils/utils.py (CSV/regex transformers) | doc-data decoys (now demoted → no_context); production `checker.py` only as a non-actionable discard |

matplotlib-24970 and sphinx-9230 are the tractable sub-class: the bug's domain word matches an
infra/utility module name far more strongly than the real edit site. pylint-8898 additionally
spans three production files, none retrieved.

---

## 5. Ranking / lexical-decoy gaps (gold present, mis-ranked) — 2

The gold file IS in candidates but loses to a decoy or the support budget — ranking/eviction, not
candidate generation.

| instance | gold disposition | the decoy that beat it |
| --- | --- | --- |
| requests-1724 | sessions.py::request reached support rank 6 → discarded (budget max 4) | decode/unicode/error → urllib3 exception+pool classes and utils.py rank above it |
| astropy-14598 | card.py reached support rank 5 (one slot outside top-3) | vendored `extern/configobj/configobj.py::_quote` wins the pivot on "quote" |

Both are within one or two slots of top-3.

---

## 6. Wrong-subsystem / hard semantic cases — 2 (+1 role/actionability)

The lexically-obvious file is a sibling/parallel package; reaching the gold needs cross-package or
call-site reasoning, not a path or name rule.

| instance | lexically-obvious sibling chosen | gold (parallel package) |
| --- | --- | --- |
| astropy-14369 | io/ascii/mrt.py (the MRT reader; task says "ascii.cds") | units/format/cds.py (the unit grammar — a NAME COLLISION with io/ascii/cds.py) |
| sphinx-7910 | ext/autodoc/__init__.py (the obvious documenter machinery) | ext/napoleon/__init__.py (napoleon's `_skip_member` hook) |

**Role/actionability (separate):** matplotlib-25960 — gold surfaced but the actionability gate
suppressed it to `no_context`. Not a subsystem error; a gate-tuning question.

---

## 7. Recommended next implementation

**Generic-infrastructure lexical-decoy suppression.** When a query token matches the NAME of an
infrastructure/utility module (`deprecation`, a `*Dict*` utility, vendored `configobj`) that is not
the bug's domain, down-weight that lexical contribution so the real domain file can enter / climb
the pool — extending the existing exception-symptom de-anchoring to infra-module-name decoys.

- **Why next:** it is the direct cause of the two tractable candidate-generation gaps
  (matplotlib-24970 "deprecation", sphinx-9230 "dict") and a contributing factor in the
  ranking near-misses (requests-1724 urllib3 decoys, astropy-14598 vendored `_quote`). It is a
  ranking-input correction (which token earns lexical weight), not a new generator, and it composes
  with the title-symbol and non-source work already in place.
- **Guard:** gate against Django expanded (now 80/95/85/0) and the 16-instance cross-repo baseline —
  de-anchoring a token that a Django gold legitimately matches would regress. Build the infra-name
  signal from path/centrality conventions, not a hardcoded word list.

---

## 8. Do-not-fix-yet list

- **Ranking near-misses** (requests-1724, astropy-14598): gold is 1–2 slots out; a budget/tie-break
  nudge risks a Django regression. Re-measure after the decoy-suppression change before touching
  budget/ranking.
- **Actionability gate** (matplotlib-25960): the gate is right most of the time; loosening it to
  admit `figure.subfigures` is semantic and risky — needs a dedicated actionability eval.
- **Hard wrong-subsystem / sibling** (astropy-14369 units-vs-io/ascii name collision, sphinx-7910
  autodoc-vs-napoleon): require cross-package semantic/graph reasoning; no cheap rule. Park for a
  graph-neighbour experiment.
- **pylint-8898 multi-file gold:** three production transformer files, none retrieved; the
  non-source demotion already removed the wrong doc-data pivot. Recovering the gold is part of the
  decoy-suppression + candidate-generation work, not a separate fix.
- **Generated-file label** (astropy `cds_parsetab.py`): not a bug; leave the label as-is.

**Do not** make any retrieval/scoring/role change off this audit alone — every fix above must be
gated against the Django and 16-instance cross-repo baselines before it lands.
