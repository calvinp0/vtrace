# Stage 5R — Generic-token lexical down-weighting outcome

Change: extend generic-token down-weighting from query shaping (P1) into Capsule v2
**lexical scoring**. A candidate whose NAME is matched ONLY by a generic bug-report
token ("multiple", "error") has its blended lexical score scaled by
`GENERIC_ONLY_LEXICAL_FACTOR` (0.25), so a single generic word cannot carry it to a
pivot. A candidate whose name ALSO matches a meaningful token keeps full weight, so
compound identifiers are demoted by noise, not destroyed.

Implementation:
- `src/retrieval/hybridScoring.ts` — `classifyLexicalQueryTokens` (splits the query
  into meaningful vs generic), `analyzeLexicalGenericMatch` (per-candidate factor),
  `GENERIC_ONLY_LEXICAL_FACTOR`. Reuses the P1 `GENERIC_TOKEN_STOPLIST` as the single
  source of truth.
- `src/retrieval/hybridRetrieval.ts` — applies the factor to the blended lexical
  score in `assemble()`; adds an inspectable evidence line when it fires.
- Diagnostics: `downweighted_lexical_tokens`, `lexical_meaningful_token_count`,
  `lexical_generic_token_count` in Capsule v2 JSON; `downweighted_lexical_tokens` in
  Stage 5R rows/CSV and the miss report.

## Metrics (expanded fixture, 20 Django instances)

| metric | P1 baseline | after | target | met |
| --- | --- | --- | --- | --- |
| top-1 file accuracy | 65.0% | 65.0% | improve | flat |
| top-3 file recall | 80.0% | 80.0% | improve | flat |
| expected file missing | 10.0% | 10.0% | no regression | yes |

**No regressions.** Per-instance result classes are byte-identical to the P1
baseline; no top-3 hit was lost. The change is landing under the requirement's
"no improvement but no regression + diagnostics prove the mechanism" clause.

## The mechanism is working

The down-weighting fires on exactly the instance the post-P1 audit named, with zero
collateral:

- `django__django-12325`: the decoy pivot `core/files/base.py::multiple_chunks`
  (matched only by the generic "multiple") is **down-weighted out of the pivots**.
  The top-1 pivot file moved `core/files/base.py → core/checks/model_checks.py`,
  `subsystem_root` moved off `core/files`, and the gold file `options.py` rose from
  overall rank 6 → 5. Row diagnostic: `downweighted_lexical_tokens: multiple`.
- Diagnostics confirm the policy is active across the fixture (the query carried a
  generic token in 6/20 instances: `11490` change, `10973` run, `11749` command,
  `12050` changes, `12325` multiple, `13195` delete). Five of those six are clean
  hits and stayed hits — proof the factor only bites candidates whose NAME is
  generic-only, never the real targets (which match meaningful tokens).

## Why top-1 / top-3 did not improve

Removing the `multiple_chunks` decoy was necessary but not sufficient for `12325`,
and the change cannot help the other three misses at all — consistent with the
post-P1 audit's root-cause analysis:

- `12325`: the gold symbols `__new__`/`_prepare` live in `db/models/base.py`, which
  is **absent from the 25-candidate pool entirely** (a recall gap, `symbol=0` on
  every candidate). With the decoy gone, `options.py` is now rank 5, but three
  generic-infrastructure support files (`reverse_related.py`, `query.py`,
  `ddl_references.py`) — scored on graph/centrality and meaningful tokens like
  "setup", not on noise — still sit between it and the top-3. Lexical down-weighting
  cannot surface a file that was never retrieved.
- `11820` / `12858`: gold file `db/models/base.py::_check_ordering` is **not in the
  pool**; no lexical re-weighting can rank an absent candidate.
- `13112`: gold symbol `deconstruct` is never generated; the file appears only via
  an incidental graph neighbour at overall rank ~12.

In short: this change closes the **decoy-promotion** failure mode (a generic word
making the wrong file a pivot). The remaining misses are **recall** failures (the
right candidate is absent or unreachable), which are out of scope for a lexical
re-weighting and were explicitly deferred in the post-P1 audit (system-check
routing, symbol-level recall). The down-weighting is general, low-overfitting, and
leaves the 16 hits untouched, so it lands on its own merits.

## Verification

`bun run typecheck` clean; `bun test` 1402 pass / 0 fail; expanded Stage 5R eval
re-run (20/20 evaluated, metrics above).
