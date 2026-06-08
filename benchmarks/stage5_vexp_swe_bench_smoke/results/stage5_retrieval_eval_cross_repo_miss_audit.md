# Stage 5R — Cross-Repo Retrieval Miss Audit

Audit of every non-top-3 case in the first cross-repo Capsule v2 retrieval
baseline. **Analysis only** — no retrieval logic was changed. The one evaluator
issue found (a miss-taxonomy misattribution on astropy-14369) is documented with
a precise fix and deferred to a follow-up, per the task's "audit before changing
retrieval" directive.

Inputs:
- `results/stage5_retrieval_eval_cross_repo.json`
- `results/stage5_retrieval_eval_cross_repo.md`
- the indexed cross-repo workspaces (used to confirm candidate eligibility,
  literal locations, and symbol extraction)

## Executive summary

The cross-repo baseline is 16/16 evaluated, top-1 62.5%, top-3 81.3%, missing
6.3%, 0 workspace errors. Three instances fell outside top-3; **none** is a
workspace or indexing failure — in all three the expected file is present in the
index, so these are *ranking / candidate-generation* outcomes, not plumbing bugs.

| # | instance | surface category | true root cause |
|---|----------|------------------|-----------------|
| 1 | astropy-14369 | `body_literal_not_resolved` (missing) | **Wrong-subsystem candidate gap** — an I/O-framed task whose fix lives in the units parser. The body-literal label is an **evaluator misattribution**. |
| 2 | sphinx-7462 | `present_but_support` | **Exception-name lexical false-friend** (`IndexError` → `index`). |
| 3 | requests-1724 | `present_but_discarded` | **Exception-name lexical false-friend** (`UnicodeDecodeError` → `decode`/`unicode`) + support-budget cutoff. |

Two of the three (sphinx, requests) share one underlying, repo-agnostic pattern:
**a CamelCase exception/error type named in the task prose contributes its
non-`error` segment as a strong lexical anchor, pulling symptom-named symbols
above the code that actually produces the value.** `error`/`bug` are already
down-weighted; the symptom noun (`index`, `decode`, `unicode`) is not.

The third (astropy) is a genuinely hard cross-subsystem case **and** exposes one
evaluator bug (eager `body_literal_not_resolved` classification) plus a
fixture-label quality caveat (PLY-generated parser tables / nested grammar
closures as expected symbols).

No repo-specific retrieval rule is warranted yet. The highest-value, fully
general next step is exception-symptom lexical de-anchoring.

## Miss table

Fields are drawn from the per-row artifact; flags not persisted in the row
(`line_anchor_resolution_used`, `body_literal_search_used`,
`edit_risk_directives`) are marked n/p ("not persisted in row") — the row carries
`body_literal_matches`, `filtered_generic_symbols`, `filtered_runner_files`,
`downweighted_lexical_tokens` only.

| field | astropy-14369 | sphinx-7462 | requests-1724 |
|-------|---------------|-------------|---------------|
| repo | astropy/astropy | sphinx-doc/sphinx | psf/requests |
| label source | gold_patch | gold_patch | gold_patch |
| result | missing | hit_support | hit_discarded |
| miss taxonomy | body_literal_not_resolved | present_but_support | present_but_discarded |
| expected files | units/format/cds.py, units/format/cds_parsetab.py | domains/python.py, pycode/ast.py | sessions.py |
| expected symbols | _lr_action_items, _lr_goto_items, _lr_signature, _make_parser, p_division_of_units, p_product_of_units | unparse | request |
| expected file disposition | **absent from candidates** | present but support (rank 5) | **present but discarded** (beyond support budget) |
| expected file rank | — (null) | 5 | — (null) |
| expected symbol rank / role | null / missing | null / missing | 6 / support |
| top pivots | io/ascii/mrt.py::Mrt, ::MrtSplitter | addnodes.py::index, application.py::add_object_type | utils.py::stream_decode_response_unicode, urllib3/exceptions.py::DecodeError |
| top support | io/ascii/mrt.py::{MrtData,MrtHeader,MRT_TEMPLATE,write} | domains/__init__.py::Index, domains/index.py::{entries,run}, **domains/python.py::_parse_annotation** | structures.py::CaseInsensitiveDict, urllib3 PoolError, urllib3 HTTPConnectionPool, api.py::request |
| top discarded (head) | io/ascii/cds.py::CdsData, mrt.py::_set_column_val_limits, cparser.pyx::* | domains/__init__.py::IndexEntry, roles.py::{indexmarkup_role,Index,index_role} | **models.py::Request**, urllib3 HTTPError, urllib3 _get_timeout, … |
| candidate count | 25 | n/p (≥ surfaced; expected present) | n/p (≥ surfaced; expected present) |
| pivot / support / discarded counts | 2 / 4 / 19 | 2 / 4 / 19 | 2 / 4 / 19 |
| body_literal_matches | [] | [] | [] |
| filtered_generic_symbols | [] | [] | [] |
| filtered_runner_files | [] | [] | [] |
| downweighted_lexical_tokens | [] | error, bug | error |

## Per-miss analysis

### 1. astropy-14369 — `missing` / labelled `body_literal_not_resolved`

**Task:** "Incorrect units read from MRT (CDS format) files with astropy.table —
… with `format='ascii.cds'`, astropy.table incorrectly parses composite units."

**Gold fix:** `astropy/units/format/cds.py` (the CDS *units* grammar — PLY rule
functions `p_product_of_units` / `p_division_of_units`, plus `_make_parser`) and
the regenerated `astropy/units/format/cds_parsetab.py`.

**What the capsule did:** pivoted entirely on `astropy/io/ascii/mrt.py`
(the MRT *reader*) and its neighbours; `units/format/cds.py` never entered the
25 candidates.

**Why `body_literal_not_resolved` is the wrong label (evaluator bug):** the
classifier fires this category whenever (a) the task contains a quoted token and
(b) no body-literal resolved. The task's `'ascii.cds'` satisfies (a). But:

- The literal `ascii.cds` **does not occur** in the expected file
  `units/format/cds.py` (verified: that file only references the format name
  `"cds"` in a docstring and `get_format_name("cds")`). The string
  `'ascii.cds'` is the *reader* registration in `io/ascii/cds.py`. So
  body-literal search, even if it had matched, would have pointed at the I/O
  reader, **not** the units parser. The label implies a fixable literal-search
  gap; there is none.
- The expected files **are indexed** (confirmed in the workspace DB), so this is
  not a parser/indexer or non-Python gap.

**The real cause** is a wrong-subsystem candidate-generation gap. Every salient
token in the task — "MRT", "ascii.cds", "astropy.table", "reading files" —
points at the `io/ascii` reader subsystem. The fix lives one subsystem away in
`units/format`, reachable only by knowing that *composite-unit* parsing is
delegated to the units-format PLY grammar. The single shared token "cds" matches
`io/ascii/cds.py` just as well, and the "MRT" emphasis dominates ranking, so
`units/format/cds.py` is never surfaced.

**Fixture-label caveat (not a retrieval failure):** the expected symbols are
largely non-recoverable at this commit — `_lr_action_items` / `_lr_goto_items` /
`_lr_signature` are **PLY-generated** module data in `cds_parsetab.py`, and
`p_product_of_units` / `p_division_of_units` are **nested closures defined inside
`_make_parser`**, which the indexer does not extract as top-level symbols (it
extracts top-level defs + class methods). So symbol-level recovery here is
structurally impossible; only file-level recovery of `units/format/cds.py` is a
fair target.

**Bucket:** wrong-subsystem candidate gap (hard, general) + evaluator
misclassification (evaluator bug) + fixture-label quality (caveat).

### 2. sphinx-7462 — `hit_support` / `present_but_support`

**Task:** "`IndexError: pop from empty list` for empty tuple type annotation".

**Gold fix:** `sphinx/pycode/ast.py::unparse` (handle the empty-tuple annotation)
and `sphinx/domains/python.py`.

**What the capsule did:** pivoted on `addnodes.py::index` and
`application.py::add_object_type`; support was dominated by `Index`-named
symbols (`domains/__init__.py::Index`, `domains/index.py::{entries,run}`).
`domains/python.py` *was* surfaced — at support rank 5 via `_parse_annotation`
(the right neighbourhood) — but `pycode/ast.py::unparse` (the actual fix) was not
in the selection. `pycode/ast.py` **is indexed and does contain `unparse`**
(verified), so this is pure ranking, not a candidate gap.

**Why:** the lead token of the task is the exception type `IndexError`. Its
non-`error` segment, `index`, is a strong lexical anchor that matches a whole
cluster of legitimately `index`-named symbols (sphinx's indexing domain). Those
out-ranked the annotation-parsing code that actually raises the error. `error`
and `bug` were down-weighted; `index` was not. This is the same symptom-noun
false-friend as case 3.

**Bucket:** exception-name lexical false-friend (general).

### 3. requests-1724 — `hit_discarded` / `present_but_discarded`

**Task:** "Unicode method names cause UnicodeDecodeError for some requests in
Python 2.7.2".

**Gold fix:** `requests/sessions.py::Session.request` (the method name is built /
encoded there).

**What the capsule did:** pivoted on `utils.py::stream_decode_response_unicode`
and `urllib3/exceptions.py::DecodeError`; support filled with `decode`/`error`
neighbours. `requests/sessions.py` was a candidate but landed **beyond the
support budget (max 4)** and was discarded; the symbol `request` matched at rank
6 (via `api.py::request`, a thin wrapper, not the Session method).
`sessions.py` **is indexed and contains `request`** (verified) — again ranking,
not a candidate gap.

**Why:** the lead token is the exception type `UnicodeDecodeError`. Its segments
`unicode` and `decode` are strong anchors that match the decode/unicode helpers
(`stream_decode_response_unicode`, `DecodeError`) — i.e. the *symptom surface* —
rather than the request-construction code that *triggers* it. `error` was
down-weighted; `unicode`/`decode` were not.

**Bucket:** exception-name lexical false-friend (general) + support-budget
cutoff.

## Root-cause grouping

| group | instances | nature | generalizes? |
|-------|-----------|--------|--------------|
| A. Exception-name lexical false-friend | sphinx-7462, requests-1724 | The non-`error` segment of a CamelCase exception in the task (`index`, `decode`, `unicode`) anchors ranking onto symptom-named symbols above the cause code. | Fully general (repo-agnostic, language-agnostic). |
| B. Wrong-subsystem candidate gap | astropy-14369 | Task framed in one subsystem (I/O reader), fix in an adjacent one (units parser) with no lexical/graph bridge. | General but hard; needs cross-subsystem reach, not a quick win. |
| C. Evaluator misclassification | astropy-14369 | `body_literal_not_resolved` fires on any quoted task token regardless of whether the literal is relevant to the expected file, and outranks `missing_from_candidates` / `wrong_subsystem` in precedence. | Evaluator bug — fixable, taxonomy-only. |
| D. Fixture-label quality | astropy-14369 | Expected symbols are PLY-generated tables + nested grammar closures not extractable as top-level symbols; only file-level recovery is a fair target. | Fixture caveat — affects scoring fairness, not retrieval. |

## General product fixes vs repo-specific fixes

**General (recommended — do these, in a later task):**

- **G1 — Exception-symptom lexical de-anchoring (group A).** Treat the segments
  of a recognized exception/error type name in the task (`IndexError`,
  `UnicodeDecodeError`, `KeyError`, …) the way `error`/`bug` are already treated:
  down-weight the symptom noun (`index`, `decode`, `unicode`, `key`) as a lexical
  anchor, since it names the failure surface, not the cause. This is the single
  change that addresses 2 of 3 misses and is purely lexical/heuristic — no repo
  knowledge.
- **G2 — Evaluator: fix `body_literal_not_resolved` over-firing (group C).**
  Only classify `body_literal_not_resolved` when the cited literal plausibly
  belongs to an expected file; otherwise fall through to
  `wrong_subsystem` / `missing_from_candidates`. At minimum, lower its precedence
  below `missing_from_candidates` so an absent-from-candidates miss is not
  mislabelled as a literal-search gap. Taxonomy-only; does not touch retrieval.
- **G3 — Fixture hygiene (group D).** Flag generated files (PLY `*_parsetab.py` /
  `*_lextab.py`) and nested-closure-only symbols in expected labels so scoring
  judges them at file level, not symbol level. Builder/label change only.

**Repo-specific (explicitly NOT recommended):**

- No `astropy`/`sphinx`/`requests`-keyed rules. The astropy cross-subsystem case
  is real but must be solved generally (graph/domain bridging), and a hand rule
  would over-fit a 16-instance set. The task forbids repo-specific tuning, and
  the audit gives no reason to override that.

## Recommended next implementation

1. **G1 first** — exception-symptom lexical de-anchoring. Biggest coverage gain
   (2 misses), lowest risk, fully general. Re-run the cross-repo eval and
   confirm sphinx-7462 lifts `pycode/ast.py`/`domains/python.py` into top-3 and
   requests-1724 lifts `sessions.py` out of discard, **and** that the existing
   Django expanded set does not regress.
2. **G2** — correct the miss-taxonomy precedence so astropy-14369 reports as
   `wrong_subsystem` / `missing_from_candidates` (its true cause), making future
   audits trustworthy.
3. **G3** — mark generated/nested-only expected symbols in the fixture builder.
4. Only after G1/G2/G3, consider **B** (cross-subsystem candidate reach) as a
   larger, separate piece of work — measure first whether it matters beyond this
   one instance.

## Do-not-fix-yet list

- **B (astropy cross-subsystem reach).** One instance; a real but large problem
  (bridging an I/O-framed query to an adjacent parser subsystem). Do not build
  speculative cross-subsystem expansion off a single data point — revisit with a
  larger non-Django set.
- **Support-budget size (requests-1724).** Raising the support budget would
  "fix" this case but is a global ranking lever that risks diluting strong
  capsules everywhere. Do not change it to chase one row; G1 should re-rank
  `sessions.py` upward on its own.
- **Any repo-specific rule.** Out of scope and over-fit risk.
- **Body-literal search engine changes.** Despite the label, astropy-14369 is not
  a literal-search defect; do not invest in literal extraction/search for it.
- **Indexer nested-closure extraction.** Extracting PLY rule closures as symbols
  is a deep parser change with broad blast radius; not justified by one fixture.
