# Stage 5 M96 — Candidate-Pool Gap Analysis (pre-change)

_Deterministic, offline. Driven by the frozen M95 scoreboard
(`stage5_m95_deterministic_scoreboard.*`) plus a per-instance pool probe
(`run_stage5_m96_candidate_pool_gap_audit.ts` →
`stage5_m96_candidate_pool_gap_audit.json`). For every M95 miss/wrong_pivot
case the probe re-runs `buildCapsuleV2` over the clean base-commit index and
classifies each scored gold file as **in_capsule**, **in_pool_not_capsule**
(retrieved, then discarded on role/budget), or **absent_from_pool** (never
retrieved). Gold labels the output only — it is never fed into generation.
No live agents, no Docker, no API spend._

_Split discipline: per-case mention detail below covers **dev** cases only;
holdout contributes aggregate counters only, so implementation decisions
cannot overfit the holdout._

## Q1. Which M95 misses have gold absent from the 25-candidate pool?

Pool status over the 38 M95 miss/wrong_pivot cases (20 dev / 18 holdout):

| cohort | cases | gold files | absent_from_pool | in_pool_not_capsule | in_capsule |
| --- | --- | --- | --- | --- | --- |
| dev | 20 | 28 | **16 (57%)** | 4 (14%) | 8 (29%) |
| holdout | 18 | 25 | **17 (68%)** | 5 (20%) | 3 (12%) |

Absent gold is the dominant remaining failure, confirming the M95 diagnosis.
Dev absent-gold cases (11): django-10880 (`aggregates.py`), django-11740
(`autodetector.py`), django-13590 (`sql/query.py`), django-15572
(`autoreload.py`), matplotlib-24870 (`tri/_tricontour.py`; `contour.py` is
in-pool), matplotlib-24970 (`colors.py`), matplotlib-25332 (`cbook.py`),
psf-1921 (`sessions.py`, capsule empty), pylint-4551 (all 4 pyreverse files),
pylint-8898 (all 3 config files), pytest-6197 (`_pytest/python.py`).

## Q2. Which misses have gold in the pool but absent from the capsule?

Four dev gold files were retrieved and then dropped before emission:

| case | gold | best pool final | fate |
| --- | --- | --- | --- |
| django-15037 | `core/management/commands/inspectdb.py` | 1.51 | discarded beyond standard support budget (max 4) |
| django-16333 | `contrib/auth/forms.py` (`UserCreationForm`) | 1.72 | discarded beyond support budget |
| matplotlib-24870 | `lib/matplotlib/contour.py` | 1.71 | discarded beyond support budget |
| psf-1724 | `requests/sessions.py` | 1.27 | discarded beyond support budget |

These need a bounded **boost** for directly-named in-pool candidates, not a new
candidate: the pool already holds gold, and the standard tier's 2-pivot /
4-support caps squeeze it out on final score.

## Q3. Which misses have gold in the capsule but the wrong lead pivot?

Eight dev gold files sit in the capsule of a `wrong_pivot` case: astropy-7166
(`utils/misc.py`, final 1.85), django-11206 (`utils/numberformat.py`, 2.00),
django-15731 (`db/models/manager.py`, 1.87), django-16256 (both gold files,
1.70/1.82), pydata-6599 (`core/computation.py`, 2.25), pydata-6992 (both,
2.87/2.03). The lead went to a competitor with a marginally higher final. A
direct-evidence signal on the named file/symbol is exactly the missing
tie-breaker.

## Q4. Among absent-gold cases, what does the issue text contain?

Mention inventory over the 360-char derived tasks of all 20 dev miss cases
(counts are mentions that resolve exactly against the index, split gold /
non-gold at the lane's ambiguity caps — files ≤3, symbols ≤5):

| mention type | dev cases with type | gold-hit mentions | low-ambiguity gold | low-ambiguity non-gold |
| --- | --- | --- | --- | --- |
| bare file-stem word (`autoreload`, `contour`, `inspectdb`, `manager`) | 20 | 11 | 10 | 33 |
| single capitalized class word (`Count`, `Dataset`) | 20 | 2 | 2 | 5 |
| dotted module path (`utils.numberformat.format`, `contrib.auth.forms.UserCreationForm`) | 7 | 2 | 2 | 4 |
| quoted/backticked identifier (`polyval`, `_coord_names`, `_variables`) | 3 | 3 | 3 | 0 |
| bare symbol name (snake/CamelCase ≥2 humps) | 4 | 2 | 2 | 6 |
| explicit `x.py` file token | 1 (`__init__.py`, 16 matches → rejected) | 0 | 0 | 0 |
| exception/error class name | 1 | 0 | 0 | 0 |
| kebab config key (`bad-names-rgxs`) | 3 | 0 | 0 | 0 |

Key structural finding: **the 360-char derived task rarely names a full path or
dotted module** (the leakage guard also excludes any case whose task carries the
gold's full path). The recoverable signal lives in *shorter* shapes — a bare
file stem, a mid-sentence capitalized class name, an exact symbol word — plus
the dotted-path shape where it survives derivation.

## Q5. Which mentions match exactly to indexed files/symbols without broad expansion?

Gold-hitting, low-ambiguity resolutions observed on dev:

- **absent → recoverable**: django-10880 `Count` → exactly 1 non-test class,
  `db/models/aggregates.py`; psf-1921 `session` → exactly 1 non-test symbol,
  `requests/sessions.py` (capsule currently EMPTY); matplotlib-24870 `contour`
  → stem match, 2 files incl. gold `lib/matplotlib/contour.py`.
- **in-pool → promotable**: django-16333 `contrib.auth.forms.UserCreationForm`
  → exactly 1 file + 1 symbol; django-15037 `inspectdb` → stem, 2 files, both
  `inspectdb.py`.
- **in-capsule → lead-fixable**: django-11206 `utils.numberformat.format` →
  exactly 1 file, symbol `format` inside it; pydata-6599 `polyval` (backticked)
  → 5 symbols, all in gold `core/computation.py`; pydata-6992 `_coord_names` /
  `_variables` → 1–2 symbols, all gold; django-15731 `manager` → 1 file.

Not recoverable at these caps (left for later milestones): pylint-4551
(`pyreverse` is a *directory* mention — expanding a directory is broad),
pylint-8898 (`bad-names-rgxs` resolves only via body-literal search),
pytest-6197 (`collect` → 13 symbols, ambiguous), django-11740/13590/15572,
matplotlib-24970/25332 (no exact low-ambiguity mention hits gold).

## Q6. Which mentions are generic and dangerous?

The bare-stem lane is the risky one: 33 low-ambiguity **non-gold** stem
resolutions on dev, e.g. `error` (2 files), `query` (2), `figure` (1),
`deprecation` (1), `field` (1), `inspect` (1), `form`/`forms` (3–5), `save`
(21 symbols), `using`, `data`, `last`. Two failure shapes:

1. **Generic vocabulary** (`error`, `query`, `field`, `save`, `data`, `type`):
   must be stoplisted — an exact file/symbol match on a generic word is
   coincidence, not evidence.
2. **Repo-ubiquitous words** (`figure` in matplotlib, `pytest` in pytest):
   uniquely resolvable yet domain-saturated. In every observed dev case the
   resolved file was *already in the pool/capsule*, so a weak-tier (non-anchor)
   boost cannot create a new wrong lead; the tier bound is the protection.

## Q7. Which generic terms must be stoplisted or downweighted?

Union of: the milestone's suggested generic list (`group field object type test
error value result data file path request response model query node item parser
manager handler wrapper base utils` — note `manager` costs the django-15731
stem hit; accepted for safety), the existing `GENERIC_TOKEN_STOPLIST`
(sweQueryShaping), and the title/literal generic term sets. Applied to
lowercase stem/symbol words only; author-marked (quoted/backticked) and dotted
mentions keep the existing literal-lane stoplists.

## Q8. Why did module-path → likelyFiles pollute the pool in M95?

The rejected M95 lever pushed **derived, unverified path strings** into the
shaped query's `likelyFiles`, which feeds `pathMatchRaw` — a *fuzzy, query-side
scoring signal* applied to every candidate. Consequences: (a) hypothetical
paths that don't exist in the repo (`requests.org` from a URL, stdlib
`inspect.signature`) still fired; (b) every candidate sharing a path token got
boosted, reshuffling the whole 25-candidate pool; (c) gold that was already
pooled got displaced by newly-boosted lookalikes (ALL recall@5 0.637→0.622).
The lesson: the mention must be **resolved against the index first** (exact or
near-exact, ambiguity-capped), and the effect must be **per-symbol bounded**
(inject/boost specific candidates), never a query-side signal change.

## Q9. Narrowest direct-evidence lane that recovers absent gold without repeating the regression

Two-tier lane, resolved wholly against the index, applied per-symbol:

- **Strong tier (anchor-grade, final 2.5 — same as title/literal anchors):**
  dotted module paths whose ≥2-segment prefix resolves to ≤2 indexed files
  (trailing segments drill into an exact symbol inside the file), and explicit
  `x.py` file tokens resolving to ≤3 non-test files. These are author-written
  near-paths; the issue names the edit file outright.
- **Weak tier (competitive, non-anchor, final 1.9):** mid-sentence capitalized
  class words, mixed-case code identifiers (`kernS`), and bare file-stem words
  ≥4 chars — each requiring an exact index match (≤5 symbols / ≤2 stem files),
  the generic stoplist, and never joining the anchor/evidence-tier machinery
  (so they cannot override multi-signal retrieval or disable pivot-ranking v2).
- **Both tiers:** candidates already in the pool are **boosted** (final →
  max(final, tier), direct-evidence pointer + evidence line) rather than
  re-injected; fresh injections are capped (≤3 files, ≤5 symbols) and deduped
  by symbol id behind line-anchor/title/literal merges.

Dev cases this predicts flipping: django-10880 (absent → pooled), psf-1921
(empty → capsule), django-16333 + django-15037 + matplotlib-24870 (pool →
capsule), django-11206 + django-15731 + pydata-6599/6992 (capsule → lead).
Holdout is untouched by the design and reserved for the final gate.
