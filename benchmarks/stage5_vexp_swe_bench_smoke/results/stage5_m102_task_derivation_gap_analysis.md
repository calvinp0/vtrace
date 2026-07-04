# Stage 5 M102 — Task-Derivation Evidence-Loss Gap Analysis (pre-variant audit)

_Deterministic, offline, text-level: no capsules built, no live agents, no
Docker, no API spend. Gold vocabulary (file names, path suffixes, dotted
modules, patch symbols) is derived audit-side ONLY and never fed into any
generation path. Data: `stage5_m102_task_derivation_gap_audit.json` (script
`run_stage5_m102_task_evidence_audit.ts`). Per-term findings are emitted for
DEV cases only; holdout contributes to aggregates alone (M95 split
discipline)._

## Answers to the required questions

### 1. Where is the current 360-char derived task built?

`benchmarks/stage5_vexp_swe_bench_smoke/build_stage5_retrieval_fixture.ts` —
`deriveTaskFromProblemStatement(problemStatement, maxLen = 360)`. It is a
**benchmark-side** helper (the product `buildCapsuleV2` takes whatever task
string its caller passes); the deterministic scoreboards (M94–M101), the
retrieval-eval fixture builder, and the Stage 5 live runner all derive the
task through this one function.

### 2. What exact text does the deterministic scoreboard pass into VTRACE?

Title line + the first *substantive prose* sentence of the body — the helper
skips the `Description` marker and any line that looks like code
(`def`/`class`/decorator/traceback/`File "`/assignment/shell), extends through
a later sentence only when it carries an explicit source anchor
(`file.py#L123`), then truncates word-safe at 360 chars with an ellipsis.
Consequence: **the derivation is prose-biased by design** — a reproduction
snippet or traceback in the first lines is skipped even when it names the
gold file (e.g. matplotlib-24970's `matplotlib/colors.py` at raw offset 319,
inside a code fence).

### 3. How often does the full statement contain gold evidence beyond the derived task?

**50/100 cases** overall (dev 31/60, holdout 19/40). In the M101 miss-class
population (miss + wrong_pivot): **17/32** (dev 9/14, holdout 8/18). In the
24 `lexical_mismatch` cases: **13/24**.

### 4. What evidence is missing in the remaining miss/wrong_pivot cases? (dev detail)

Concrete dev examples: django-13590 loses `sql.query` + `resolve_lookup_value`
(prose, offset ~400); django-15572 loses `template/autoreload.py` (prose,
520); django-16256 loses `related_descriptors.py` + `get_or_create` family
(prose, 370–560); django-15731 loses `models/manager.py` (prose, 750);
matplotlib-24970 loses `matplotlib/colors.py` (code block, 319);
psf-requests-1724 loses `requests/sessions.py` (traceback, 900);
pylint-8898 loses `config/argument.py` + `_regexp_csv_transfomer` (traceback,
~2160); xarray-6992 loses `core.dataset` (prose, 89 — dropped because the
first-sentence cut ends earlier) and `set_index/reset_index` (code block).

### 5. Which evidence types are commonly lost? (miss-class term counts)

| kind | count |
| --- | --- |
| file stems (`autoreload`, `colors`) | 13 |
| file basenames (`manager.py`) | 12 |
| symbols (functions/methods/classes) | 11 |
| path suffixes (`config/argument.py`) | 10 |
| dotted modules | 2 |

Exception names / config keys / failing-test ids are captured under symbols
and by the variant extractors; the dominant loss is **file-identity evidence**.

### 6. How often is missing evidence in the first 720 chars?

Earliest-recoverable bucket per miss-class case (raw-prefix offsets): ≤360:
7/17, ≤720: +5 (cumulative 12/17), ≤1200: +3 (15/17), beyond 1200: 2/17. So a
raw 720-char prefix would *reach* the lost evidence in ~70% of the affected
miss-class cases — the ≤360 bucket exists because the prose-only sentence
selection skips early code/tracebacks that a raw prefix would keep.

### 7. How often is it only in code blocks / tracebacks / later paragraphs?

Miss-class lost-term contexts: prose 25, traceback 17, code block 6 —
roughly half the lost terms live in text the current derivation is
*structurally unable* to include (code/traceback), not merely beyond its
length cap.

### 8. Would including more text add many generic/noisy terms?

Median distinct code-like tokens per statement window (miss-class): 360→2,
720→3, 1200→5, full→5. Token noise grows slowly at these lengths; the real
noise risk of raw prefixes is *prose* words entering lexical scoring, which
this audit cannot price — the variant scoreboard (win/loss analysis) measures
it directly.

### 9. Which repos are most affected?

Cases with beyond-V0 evidence: django 21/44, sympy 8/17, xarray 5/6, pytest
4/4, matplotlib 3/7, sphinx 3/7. xarray and pytest are near-universally
affected; astropy barely (1/5 — its issues lead with the key identifiers).

### 10. Which M101 misses are derivation-limited vs true retrieval/parser limits?

- **Derivation-limited candidates (17/32)**: the 9 dev cases listed in Q4 plus
  8 holdout cases (aggregate only). These carry exact gold file/symbol text in
  the statement that V0 never sees.
- **Likely true retrieval/ranking limits (15/32)**: no gold evidence anywhere
  in the statement even at full length — e.g. django-10880 (278-char
  statement, nothing to add), django-11740 (1972 chars, zero gold terms),
  matplotlib-25332, pylint-4551. These need indirect-evidence or
  ranking/parser work, not longer tasks.

## Implication for variant design

The loss profile says: (a) raw prefix growth to 720/1200 reaches most lost
evidence but drags prose noise along; (b) a structured variant that keeps the
V0 task and appends *extracted* file paths, backticked identifiers,
exceptions, failing tests and traceback frames targets exactly the lost kinds
(file-identity + symbols + traceback) while staying capped; (c) two miss-class
cases need >1200 chars (traceback-tail cases) — only reachable by V4/V5-style
traceback extraction, not by bounded prefixes.
