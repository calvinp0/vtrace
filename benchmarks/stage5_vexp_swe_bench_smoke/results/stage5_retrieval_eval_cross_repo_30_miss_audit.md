# Stage 5R — 30-instance cross-repo retrieval miss audit

**Scope:** audit-only. No retrieval logic was changed. No evaluator/fixture bug was
found (all expected labels are gold-accurate, all 30 workspaces indexed, 0 workspace
errors). This report explains *why* the harder 30-instance cross-repo set dropped, so
we can decide what to fix next.

Source artifacts:

- `results/stage5_retrieval_eval_cross_repo_30.json`
- `results/stage5_retrieval_eval_cross_repo_30.md`
- `retrieval_eval.cross_repo.30.json`

---

## 1. Executive summary

| metric | 16-instance | 30-instance |
| --- | --- | --- |
| top-1 file accuracy | 62.5% | 53.3% |
| top-3 file recall | 87.5% | 66.7% |
| expected file as pivot | 81.3% | 63.3% |
| expected file missing | 6.3% | 23.3% |

**10 of 30 instances** missed top-3. They are not a single failure mode — they split
into ranking near-misses (the gold file *was* surfaced, just past the cut) and
candidate-generation failures (the gold file never entered the top candidates at all):

- **6 missing-from-candidates** (gold file never surfaced): astropy-14369, matplotlib-24970,
  pylint-8898, sphinx-7910, sphinx-9230, sympy-16766.
- **2 present-but-evicted** (gold file surfaced but past top-3 / support budget):
  requests-1724 (discarded), astropy-14598 (support rank 5).
- **2 empty/suppressed capsule** (no_context): matplotlib-25960 (gold file+symbol found but
  role-gated to "non-actionable"), requests-5414 (0 candidates from thin task prose).

The single most repeated, most fixable cause is **non-source example / documentation-data
files polluting the candidate set** (pylint `doc/data/messages/**/bad.py` ranked as the #1
pivot; sphinx `doc/usage/extensions/example_*.py` crowding support). The second is **generic
lexical decoys** — an infrastructure module whose name matches a task keyword ("deprecation",
"dict", "quote") out-ranking the real domain file. Both are candidate-set problems, not
ranking-model problems, which makes them lower-risk to address later.

The misses are concentrated: **4 repos account for 8 of 10 misses** (astropy 2, matplotlib 2,
sphinx 2, requests 2), while pytest/xarray/scikit-learn/seaborn/flask are 100% top-1.

---

## 2. Miss table

| instance | repo | gold file(s) | what vtrace picked (top-1) | gold-file disposition | miss taxonomy | cand. | piv/sup/disc |
| --- | --- | --- | --- | --- | --- | --- | --- |
| astropy-14369 | astropy | units/format/cds.py (+ generated cds_parsetab.py) | io/ascii/mrt.py::Mrt | absent from candidates | wrong_subsystem | 25 | 2/4/19 |
| matplotlib-24970 | matplotlib | lib/matplotlib/colors.py | _api/deprecation.py::MatplotlibDeprecationWarning | absent from candidates | wrong_subsystem (generic-lexical decoy) | 25 | 2/4/19 |
| pylint-8898 | pylint | config/argument.py, utils/__init__.py, utils/utils.py | doc/data/messages/b/bad-dunder-name/bad.py::__hello__ | absent from candidates | wrong_subsystem (doc-data pollution) | 25 | 2/4/19 |
| sphinx-7910 | sphinx | ext/napoleon/__init__.py | ext/autodoc/__init__.py::DecoratorDocumenter | absent from candidates | wrong_subsystem (sibling module) | 25 | 2/4/19 |
| sphinx-9230 | sphinx | util/docfields.py | util/__init__.py::FilenameUniqDict | absent from candidates | wrong_subsystem (generic-lexical decoy "dict") | 25 | 2/4/19 |
| sympy-16766 | sympy | printing/pycode.py | utilities/lambdify.py::lambdify | absent from candidates | missing_from_candidates (title-symbol lost to body) | 25 | 2/4/19 |
| requests-1724 | requests | sessions.py | utils.py::stream_decode_response_unicode | present → discarded (support rank 6, budget max 4) | present_but_discarded | 25 | 2/4/19 |
| astropy-14598 | astropy | io/fits/card.py | extern/configobj/configobj.py::_quote | present → support rank 5 | present_but_support | 25 | 2/4/19 |
| matplotlib-25960 | matplotlib | lib/matplotlib/figure.py | — (no_context) | present → discarded ("no actionable edit target") | present_but_discarded | 0 | 0/0/25 |
| requests-5414 | requests | models.py | — (no_context) | absent (empty capsule) | unknown | 0 | 0/0/0 |

---

## 3. Per-miss analysis

Each answers: (1) what vtrace chose, (2) what gold edited, (3) gold-file disposition,
(4) which signal should have found it, (5) problem class.

### astropy-14369 — wrong subsystem (units/format vs io/ascii) + generated label
1. **vtrace chose** `astropy/io/ascii/mrt.py` (Mrt/MrtSplitter/MrtData) — the MRT *reader*.
2. **Gold edited** `astropy/units/format/cds.py` (`p_product_of_units`, `p_division_of_units`)
   plus the PLY-generated `cds_parsetab.py` — the *unit grammar*, not the table reader.
3. **Disposition:** absent from candidates (io/ascii/cds.py appears in discarded, but the
   `units/format/cds.py` that holds the fix never surfaced).
4. **Signal that should have found it:** symbol/path — the bug is "composite units parsed
   wrong", and `units/format/cds.py` defines the unit-product/division grammar rules. The task
   string "ascii.cds" lexically anchors on io/ascii; the real fix is one package over.
5. **Class:** hard semantic / wrong-subsystem. There are *two* `cds.py` files (io/ascii vs
   units/format) and the task names the io path. Genuinely hard. (Note: `cds_parsetab.py` is a
   generated artifact — not a meaningful retrieval target; `cds.py` is the real one.)

### matplotlib-24970 — generic-lexical decoy ("deprecation warning")
1. **vtrace chose** `lib/matplotlib/_api/deprecation.py` (the entire pivot+support set is this
   one infra module).
2. **Gold edited** `lib/matplotlib/colors.py::__call__` — the site that *makes* a NumPy-1.24
   deprecated call.
3. **Disposition:** absent from candidates.
4. **Signal that should have found it:** lexical/symbol — but the task ("NumPy 1.24 deprecation
   warnings") matches the literal `deprecation` module name far more strongly than `colors.py`.
   No signal in the prose points at colors specifically.
5. **Class:** generic lexical decoy → wrong subsystem. The keyword "deprecation" maps to the
   infra module, not the call site.

### pylint-8898 — non-source doc-data pollution + multi-file patch
1. **vtrace chose** `doc/data/messages/b/bad-dunder-name/bad.py::__hello__` — a shipped *example*
   file used to document a pylint message. Both pivots and most support are `doc/data/messages/**`.
2. **Gold edited** `pylint/config/argument.py` (`_regexp_csv_transfomer`), `pylint/utils/utils.py`
   (`_check_csv`, `_check_regexp_csv`) — CSV/regex argument transformers (3 files).
3. **Disposition:** absent from candidates (the real source files never surfaced).
4. **Signal that should have found it:** lexical/symbol — task "bad-names-rgxs mangles regular
   expressions with commas" → CSV-splitting of a regexp option → `_check_csv` / `_regexp_csv_transfomer`.
   Confirmed present in `config/argument.py` and `utils/utils.py`.
5. **Class:** **candidate pollution** by non-source example files (general) + multi-file patch
   under-representation. The `bad-dunder-name/bad.py` example lexically matches "bad name" and is
   indexed as if it were source. This is the clearest, most actionable miss.

### sphinx-7910 — sibling-module confusion (autodoc vs napoleon)
1. **vtrace chose** `sphinx/ext/autodoc/__init__.py` (Documenter / DecoratorDocumenter).
2. **Gold edited** `sphinx/ext/napoleon/__init__.py` (`_skip_member`, `Config`).
3. **Disposition:** absent from candidates.
4. **Signal that should have found it:** graph neighbors / semantic — napoleon hooks into autodoc
   via `autodoc-skip-member`; "decorated `__init__` won't be documented" is a napoleon skip-logic
   bug. The lexical signal points squarely at autodoc's Documenter machinery.
5. **Class:** hard semantic / wrong-subsystem (parallel extension). autodoc is the lexically
   obvious but wrong sibling.

### sphinx-9230 — generic-lexical decoy ("dict")
1. **vtrace chose** `sphinx/util/__init__.py::FilenameUniqDict` and `sphinx/pycode/ast.py::visit_Dict`
   — symbols that literally contain "Dict".
2. **Gold edited** `sphinx/util/docfields.py::transform` — field-list rendering for `:param ... dict(str,str)`.
3. **Disposition:** absent from candidates.
4. **Signal that should have found it:** symbol/path — ":param" + "datatype rendering" → docfields.
   The body literal "dict(str,str)" is a red herring that pulled `*Dict*`-named symbols.
5. **Class:** generic lexical decoy. "dict" matched Dict-named utilities instead of the field renderer.

### sympy-16766 — title symbol lost to body lexical
1. **vtrace chose** `sympy/utilities/lambdify.py::lambdify` (+ `plotting/experimental_lambdify.py`).
   Support is the sibling code printers (glsl/julia/octave/rust) but **not** pycode.
2. **Gold edited** `sympy/printing/pycode.py` (`_print_Indexed`, `_print_Not`) — the `PythonCodePrinter`.
3. **Disposition:** absent from candidates. Confirmed `pycode.py:350 class PythonCodePrinter` exists
   at base; the two gold *methods* are added by the patch, but the class/file are indexable.
4. **Signal that should have found it:** symbol/path — the *title* says "PythonCodePrinter doesn't
   support Indexed" → `PythonCodePrinter` lives in `pycode.py`. The *body* ("I use `lambdify()`")
   dominated and anchored on lambdify.
5. **Class:** title-symbol-vs-body-lexical confusion. The strongest path-symbol clue is in the title
   but was out-weighed by a body mention of a helper.

### requests-1724 — present but support-budget-evicted
1. **vtrace chose** `requests/utils.py::stream_decode_response_unicode`; support is urllib3 exception/
   pool classes + `requests/api.py::request`.
2. **Gold edited** `requests/sessions.py::Session.request` (the `method` arg handling).
3. **Disposition:** **present** — `sessions.py` symbol `request` reached support **rank 6**, past the
   max-4 support budget, so it landed in discarded ("beyond standard support budget").
4. **Signal that should have found it:** symbol/path — it *did* find `request`, just ranked it below
   lexical decoys (decode/unicode/error → urllib3 + utils). Tokens decode/error were down-weighted,
   "decode" de-anchored, but not enough.
5. **Class:** ranking/budget near-miss (generic lexical decoy pushed the gold past the cut).

### astropy-14598 — present but ranked just outside top-3
1. **vtrace chose** `astropy/extern/configobj/configobj.py::_quote` (a vendored lib) and `hdulist.py::fitsopen`.
2. **Gold edited** `astropy/io/fits/card.py` (`Card._split`).
3. **Disposition:** **present** — `card.py::_value_FSC_RE` reached support **rank 5**, one slot outside top-3.
4. **Signal that should have found it:** symbol/path — the gold symbol `_split` was not surfaced; card.py
   reached support only via a module-level regex var. The decoy `_quote` in vendored configobj won the pivot.
5. **Class:** ranking near-miss + vendored-code decoy ("quote" matched `extern/configobj`).

### matplotlib-25960 — right file+symbol found but role-gated to no_context
1. **vtrace chose** nothing — capsule returned `no_context` (0 pivots, 0 support, 25 discarded).
2. **Gold edited** `lib/matplotlib/figure.py::subfigures`.
3. **Disposition:** **present in discarded** — `figure.py::subfigures` is the *top discarded* item, tagged
   "support-only: no actionable edit target". The rest are `galleries/examples/subfigures.py` (example pollution).
4. **Signal that should have found it:** symbol/path — it *did* surface the exact gold file+symbol; the
   actionability gate judged `subfigures` non-actionable and the capsule emptied to no_context.
5. **Class:** role/actionability gate too strict (suppressed a correct target) + example-dir pollution.

### requests-5414 — empty capsule from thin/truncated task prose
1. **vtrace chose** nothing — `no_context`, **0 candidates** total.
2. **Gold edited** `requests/models.py::prepare_url` (raise `InvalidURL` instead of `UnicodeError`).
3. **Disposition:** absent — empty capsule.
4. **Signal that should have found it:** body literal / line anchor — the *full* problem statement even
   cites `requests/models.py#L401`. But the derived `task` truncates at "Attempting to get e.g." (the
   sentence splitter cuts on "e.g."), and the distinctive tokens (unicode/error) were down-weighted/de-anchored,
   collapsing the lexical signal to nothing.
5. **Class:** noisy/truncated task prose → lexical collapse. The fixture's `task` derivation lost the useful
   content; not a retrieval-ranking failure so much as no usable query.

---

## 4. Root-cause grouping

| bucket | instances | count |
| --- | --- | --- |
| Generic lexical decoy (infra/vendored module name matches a task keyword) | matplotlib-24970, sphinx-9230, requests-1724, astropy-14598 | 4 |
| Wrong subsystem / sibling-module confusion | astropy-14369, sphinx-7910, (matplotlib-24970) | 2–3 |
| Non-source example / doc-data pollution in candidates | pylint-8898, matplotlib-25960, (sphinx-9230) | 2–3 |
| Present but ranking/budget-evicted (near-miss) | requests-1724, astropy-14598 | 2 |
| Role/actionability gate suppressed a correct target | matplotlib-25960 | 1 |
| Title-symbol lost to body lexical | sympy-16766 | 1 |
| Empty capsule from thin/truncated task prose | requests-5414 | 1 |
| Multi-file patch under-representation | pylint-8898, astropy-14369 | 2 |
| Fixture/gold-label note (generated file in labels) | astropy-14369 (cds_parsetab.py) | 1 |

(Buckets overlap: several misses have a primary + secondary cause, e.g. matplotlib-24970 is both a
generic-lexical decoy and a wrong-subsystem outcome.)

---

## 5. General product fixes vs repo-specific fixes

**General product fixes (would help across multiple repos):**

1. **Exclude / strongly down-rank non-source example & documentation-data directories** from candidate
   generation: `doc/data/**`, `doc/usage/**`, `galleries/examples/**`, `examples/**`, doc example_*.py.
   Directly causes pylint-8898 (#1 pivot is a doc-data file) and pollutes sphinx-9230 and matplotlib-25960.
   Pure candidate filtering — no ranking-model change.
2. **Title-symbol anchoring over body lexical:** when the problem *title* names a class/type/printer
   (`PythonCodePrinter`), weight that path-symbol match above a helper merely mentioned in the body
   (`lambdify`). Fixes sympy-16766; helps the title-vs-body tension generally.
3. **Generic-infra lexical-decoy suppression (extend the existing de-anchor list):** infra/vendored
   module names that match a task keyword — `deprecation`, `Dict`/`*Dict`, `quote` (vendored configobj) —
   should not out-rank a domain file. Helps matplotlib-24970, sphinx-9230, astropy-14598, requests-1724.
4. **Support-budget eviction of a recovered gold file (near-miss ranking):** requests-1724 and astropy-14598
   both surfaced the gold file at rank 5–6. A small budget/tie-break change would recover them — but this is
   ranking-tuning and risks Django regression; defer.
5. **Task-prose derivation robustness (fixture-builder, not retrieval):** don't split sentences on
   `e.g.`/`i.e.`; fall back to more body text when the first sentence is degenerate. Fixes requests-5414's
   empty capsule at the source.

**Repo-specific (or narrowly-scoped) observations:**

- **pylint** ships example sources under `doc/data/messages/**` — the worst offender; covered by general fix #1.
- **sphinx** has parallel extensions (autodoc ↔ napoleon) that lexically alias; recovering napoleon (sphinx-7910)
  needs cross-extension semantic/graph reasoning, not a path rule.
- **astropy** has a name collision (`io/ascii/cds.py` vs `units/format/cds.py`); the task names the io path while
  the fix is in units — genuinely hard, not a quick rule.
- **astropy-14369** label includes the PLY-generated `cds_parsetab.py`; accurate to the gold patch and harmless
  to scoring (any-file match), but it is not a meaningful retrieval target. Leave as-is.

---

## 6. Recommended next implementation

**Pick #1: filter non-source example / documentation-data directories out of candidate generation.**

- **Why first:** highest leverage and lowest risk. It is the *direct* cause of the pylint miss (a doc-data
  example file is the #1 pivot), it pollutes sphinx-9230 and matplotlib-25960, and it is candidate-set
  filtering only — it cannot perturb the learned ranking on the Django set. Likely recovers ≥1 miss outright
  and de-noises 2–3 more.
- **Shape (when we do tune, not now):** a path-pattern exclusion (or hard down-rank) for `doc/data/**`,
  `doc/usage/**`, `galleries/examples/**`, `examples/**`, and clearly-marked doc example modules, applied at
  candidate collection. Guard with a regression run on the Django + 16-instance cross-repo sets to confirm no drop.

**Then #2: title-symbol anchoring** (sympy-16766) — weight a class/type named in the problem title above a
body-mentioned helper. Slightly higher risk (touches ranking), so sequence it after #1 with a regression gate.

---

## 7. Do-not-fix-yet list

- **Support-budget / near-miss ranking** (requests-1724, astropy-14598): only 1 slot off; a budget/tie-break
  nudge could regress Django. Hold until #1/#2 land and we re-measure.
- **Actionability gate suppressing `figure.subfigures`** (matplotlib-25960): the gate is correct most of the
  time; loosening it is semantic and risky. Revisit only with a dedicated actionability eval.
- **Wrong-subsystem semantic cases** (astropy-14369 units-vs-io/ascii, sphinx-7910 autodoc-vs-napoleon): require
  cross-package semantic/graph reasoning; no cheap rule. Park for a future graph-neighbor experiment.
- **Task-prose truncation** (requests-5414): real, but it's a fixture-builder concern, not retrieval; fix
  separately so it doesn't muddy a retrieval-tuning diff.
- **Generated-file label** (astropy `cds_parsetab.py`): not a bug; leave the label as-is.

**Do not** make any retrieval/ranking change off this audit alone — every fix above must be gated against the
Django and 16-instance cross-repo baselines before it lands.
