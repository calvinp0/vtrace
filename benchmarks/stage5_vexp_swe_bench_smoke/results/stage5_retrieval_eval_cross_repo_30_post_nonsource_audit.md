# Stage 5R — cross-repo 30 miss audit (refresh after non-source demotion)

**Scope:** audit-only. No retrieval, scoring, or role logic was changed. This refreshes
`stage5_retrieval_eval_cross_repo_30_miss_audit.md` so the remaining failures reflect the
current system, after (1) the task-prose abbreviation fix and (2) non-source example /
doc-data pivot demotion.

Source artifacts:

- `results/stage5_retrieval_eval_cross_repo_30.json`
- `results/stage5_retrieval_eval_cross_repo_30.md`
- prior: `results/stage5_retrieval_eval_cross_repo_30_miss_audit.md`

Current headline (unchanged by the non-source demotion):

| metric | value |
| --- | --- |
| top-1 file accuracy | 56.7% |
| top-3 file recall | 70.0% |
| expected file as pivot | 66.7% |
| expected file missing | 20.0% |
| no_context | 2 |

---

## 1. What changed after non-source demotion

The demotion (non-source example / doc-data files can be support but not pivots by default)
fired on exactly **one** instance — the only one whose pivots were doc-data files:

**pylint-8898 — reclassified, not fixed.**
- **Before:** top-1 pivot was `doc/data/messages/b/bad-dunder-name/bad.py::__hello__` — a
  shipped *example* file. The capsule confidently named a wrong, non-production edit target.
  Miss taxonomy: `wrong_subsystem`.
- **After:** both `doc/data/messages/**/bad.py` pivots are demoted to support, and with no
  actionable production pivot left the capsule returns **`no_context`**. Miss taxonomy:
  `missing_from_candidates`. The down-rank is recorded in the row's `non_source_downranked`.
- **Why this is the right outcome:** the real gold (`pylint/config/argument.py`,
  `pylint/utils/utils.py`) was never in the candidate pool, so the honest result is "no
  high-confidence target", not a doc-data decoy. The post-demotion discard list now leads with
  a *production* near-candidate (`pylint/checkers/base/name_checker/checker.py::_BadNamesTuple`),
  confirming the pool reached the right subsystem but not the gold files.

**No other instance changed.** matplotlib-25960 already ships `galleries/examples/**/subfigures.py`
candidates, but those were already non-actionable discards (never pivots), so the demotion only
tags them — it does not alter the outcome. Aggregate metrics are unchanged because pylint-8898 was
already a miss; the demotion improved *correctness* (no wrong pivot) without moving recall.

**Also reflected since the original audit:** requests-5414, an empty-capsule miss in the original
audit, was fixed by the earlier task-prose abbreviation change (now top-1). The miss set is
therefore **9** (down from 10), and requests-5414 no longer appears below.

---

## 2. Current non-top-3 cases (9)

| instance | repo | gold file(s) | top-1 pivot now | disposition | taxonomy |
| --- | --- | --- | --- | --- | --- |
| astropy-14369 | astropy | units/format/cds.py (+ generated cds_parsetab.py) | io/ascii/mrt.py::Mrt | absent from candidates | wrong_subsystem |
| matplotlib-24970 | matplotlib | lib/matplotlib/colors.py | _api/deprecation.py::MatplotlibDeprecationWarning | absent from candidates | wrong_subsystem |
| pylint-8898 | pylint | config/argument.py, utils/__init__.py, utils/utils.py | — (no_context) | absent from candidates | missing_from_candidates |
| sphinx-7910 | sphinx | ext/napoleon/__init__.py | ext/autodoc/__init__.py::DecoratorDocumenter | absent from candidates | wrong_subsystem |
| sphinx-9230 | sphinx | util/docfields.py | util/__init__.py::FilenameUniqDict | absent from candidates | wrong_subsystem |
| sympy-16766 | sympy | printing/pycode.py | utilities/lambdify.py::lambdify | absent from candidates | missing_from_candidates |
| requests-1724 | requests | sessions.py | utils.py::stream_decode_response_unicode | present → discarded (support rank 6) | present_but_discarded |
| astropy-14598 | astropy | io/fits/card.py | extern/configobj/configobj.py::_quote | present → support rank 5 | present_but_support |
| matplotlib-25960 | matplotlib | lib/matplotlib/figure.py | — (no_context) | present → discarded ("no actionable edit target") | present_but_discarded |

---

## 3. Current missing / no_context cases

**Two `no_context` instances** (the capsule emitted no pivot at all):

- **pylint-8898** — `no_context` *because of* the non-source demotion: the only pivots were
  doc-data decoys, now demoted; the gold production files are not in candidates. A genuine
  **candidate-generation gap**, now diagnosed honestly instead of masked by a wrong pivot.
- **matplotlib-25960** — `no_context` *unrelated* to the demotion: the gold `figure.py::subfigures`
  IS surfaced but the **actionability gate** classifies it "no actionable edit target", and the
  remaining candidates are `galleries/examples/**` (non-source, non-actionable). Pre-existing.

**Seven `missing`/non-top-3 with a pivot emitted** — the gold file is absent from candidates
(astropy-14369, matplotlib-24970, sphinx-7910, sphinx-9230, sympy-16766) or present but ranked
out (requests-1724, astropy-14598).

---

## 4. Which misses are now candidate-generation gaps (6)

The gold edit site never entered the candidate pool — improving ranking cannot help these; the
pool itself must reach the right file.

| instance | the gold the pool missed | what the pool anchored on instead |
| --- | --- | --- |
| astropy-14369 | units/format/cds.py (unit grammar) | io/ascii/mrt.py (the MRT reader — the task says "ascii.cds") |
| matplotlib-24970 | colors.py (the deprecated-numpy call site) | _api/deprecation.py (the literal "deprecation" module) |
| pylint-8898 | config/argument.py, utils/utils.py (CSV/regex transformers) | now no_context (doc-data decoys demoted; production near-miss `checker.py` only as a non-actionable discard) |
| sphinx-7910 | ext/napoleon/__init__.py (_skip_member) | ext/autodoc/__init__.py (the lexically-obvious sibling extension) |
| sphinx-9230 | util/docfields.py (field rendering) | util/__init__.py + pycode/ast.py (`*Dict*`-named symbols — the "dict(str,str)" red herring) |
| sympy-16766 | printing/pycode.py (PythonCodePrinter — named in the TITLE) | utilities/lambdify.py (named in the BODY) |

This is now the **dominant** bucket (6 of 9). Two sub-shapes:
- **Title-symbol lost to body/decoy lexical** (sympy-16766, sphinx-9230, and partially pylint-8898):
  the class/type/field named in the problem *title* exists as an indexable symbol but never seeds a
  candidate, because a body mention or a generic word dominates the query.
- **Hard wrong-subsystem / sibling** (astropy-14369, sphinx-7910, matplotlib-24970): the lexically
  obvious file is a sibling/infra module; reaching the gold needs cross-package or call-site reasoning.

---

## 5. Which misses are still ranking / lexical-decoy gaps (3)

The gold file IS in candidates but loses to a decoy or a gate — ranking/eviction territory, not
candidate generation.

| instance | gold disposition | the decoy / gate that beat it |
| --- | --- | --- |
| requests-1724 | sessions.py::request reached support rank 6 → discarded (budget max 4) | decode/unicode/error → urllib3 exception+pool classes and utils.py rank above it |
| astropy-14598 | card.py reached support rank 5 (one slot outside top-3) | vendored `extern/configobj/configobj.py::_quote` wins the pivot on "quote" |
| matplotlib-25960 | figure.py::subfigures is the TOP discarded item | actionability gate ("no actionable edit target") suppresses it → no_context |

requests-1724 and astropy-14598 are genuine **ranking near-misses** (gold within one or two slots).
matplotlib-25960 is a **role/actionability** decision, not a lexical decoy — grouped here because the
gold is present, not missing.

---

## 6. Recommended next implementation

**Title-symbol candidate anchoring.** When the problem *title* names a class / type / printer /
field (`PythonCodePrinter`, a `:param` field datatype, `Config`), ensure a symbol-name candidate
for it is seeded into the pool even when body lexical (`lambdify`) or a generic word (`dict`,
`deprecation`) dominates the query.

- **Why first:** candidate-generation gaps are now the dominant bucket (6 of 9), and 3 of those
  (sympy-16766, sphinx-9230, partially pylint-8898) are specifically the title-symbol-lost-to-body
  shape — the most tractable sub-class. It is additive to candidate generation (seed an extra
  symbol), not a ranking-model change, so it is lower-risk than re-weighting.
- **Guard:** gate any change against the Django expanded (75/90/80/0) and the 16-instance cross-repo
  baselines; a title-seed must not displace a correct body-driven pivot.
- **Expected:** recovers the title-symbol gaps; leaves the hard wrong-subsystem and ranking
  near-misses for later, separately-scoped work.

---

## 7. Do-not-fix-yet list

- **Ranking near-misses** (requests-1724, astropy-14598): gold is 1–2 slots out; a budget/tie-break
  nudge risks a Django regression. Re-measure after the title-anchor change before touching ranking.
- **Actionability gate** (matplotlib-25960): the gate is right most of the time; loosening it to admit
  `figure.subfigures` is semantic and risky — needs a dedicated actionability eval, not a one-off.
- **Hard wrong-subsystem / sibling** (astropy-14369 units-vs-io/ascii, sphinx-7910 autodoc-vs-napoleon):
  require cross-package semantic/graph reasoning; no cheap rule. Park for a graph-neighbour experiment.
- **pylint-8898 multi-file config gold:** three production files, none retrieved; the non-source
  demotion has done its job (no more wrong pivot). Recovering the gold is part of the candidate-generation
  work above, not a separate fix.
- **Generated-file label** (astropy `cds_parsetab.py`): not a bug; leave the label as-is.

**Do not** make any retrieval/scoring/role change off this audit alone — every fix above must be gated
against the Django and 16-instance cross-repo baselines before it lands.
