# M121 real-repository zero-candidate retrieval investigation

## Outcome: PASS

The TCKDB incident was reproduced against the existing incrementally refreshed index without modifying TCKDB. The precise failure was in **lexical/FTS query construction**, before graph reranking, capsule thresholds, or rendering:

1. `resolveBroadQueryContext` treated any `/` as proof that the complete task was a path query.
2. The prose phrase `immutability/supersession` therefore disabled broad decomposition for the entire request.
3. The fallback builder emitted one 47-term FTS AND expression, including stopwords and split forms of `public_ref`.
4. No symbol metadata row contained every term, so primary lexical admission returned zero rows.
5. Single-term recovery was conditional on broad context, so it did not run.
6. Path-signal retrieval was also conditional on broad context, so it did not run.
7. `rerankGraph` received no seeds. `candidateFilesConsidered` was consequently zero and the product returned `no_candidates`.

This was not an index-coverage or M118 persistence defect. The relevant Python files, symbols, FTS rows, and graph relationships were present in both index forms.

## Reproduction and correction

The exact incident text was preserved byte-for-byte as query F. Before the fix it produced:

- normalized terms: 47;
- derived query: all 47 terms joined by `AND`;
- raw lexical rows: 0;
- candidate union: 0;
- distinct candidate files: 0;
- graph expansions: 0;
- fallback attempted: false;
- final reason: `no_candidates`.

The bounded correction is limited to routed FTS product retrieval:

- A slash disables decomposition only for a standalone path-like query; punctuation inside natural-language prose no longer changes the whole query mode.
- Compound tasks over 16 terms use adjacent phrases plus high-information adjacent AND pairs, bounded to 96 variants. The complete pairwise expansion is not used.
- CamelCase, snake_case, and filename terms are retained as explicit variants. At most one best candidate per exact identifier is unioned before broad candidates.
- Exact identifiers receive a deterministic lane bonus; filename and snake_case bonuses are stronger because punctuation otherwise loses identity under the FTS tokenizer.
- No centrality-based, random-file, or arbitrary fallback was added.
- The legacy plain-SQL/hybrid path used by frozen Capsule v2 evaluation retains its previous query construction byte-for-byte.

After the fix, query F returned 37 candidate files. The selected set includes `public_ref` infrastructure, reproducibility services, public assessment schemas, Python client types, tests, OpenAPI, and the initial-schema public-reference migration. Query G additionally returns the exact assessment model and `public_assessments.py` projection. Exact queries A–C resolve their intended model/stem/projection evidence; D and E return model, schema, projection, migration, and public-reference support.

Full normalized A–G diagnostics—including normalized task, derived expression, terms, variants, identifiers, path terms, FTS terms, lane counts, rejected counts, union size, graph work, thresholds, fallbacks, selected files/symbols, final reason, and phase timings—are in `stage5_m121_zero_candidate_query_matrix.json`.

## Incremental versus clean full isolation

The existing TCKDB `.vtrace/index.sqlite` was opened read-only. A second database was built under isolated temporary state from the same TCKDB HEAD and deleted after measurement. TCKDB files and its `.vtrace` state were not changed.

| measure | incrementally refreshed | clean full | equal |
|---|---:|---:|:---:|
| file rows | 957 | 957 | yes |
| symbol rows | 23,064 | 23,064 | yes |
| edge rows | 47,734 | 47,734 | yes |
| symbol FTS rows | 23,064 | 23,064 | yes |
| body-literal FTS rows | 6,134 | 6,134 | yes |
| total retrieval rows | 29,198 | 29,198 | yes |
| normalized graph hash | `25bb3d…1676` | `25bb3d…1676` | yes |
| retrieval-index hash | `00dafe…43bb` | `00dafe…43bb` | yes |
| A–G selected files/symbols | same | same | yes |

The clean full rebuild scanned 958 paths, indexed 957 parser-supported files, and took 43.6 seconds in the final run. The one unsupported path is consistent with Markdown documentation not being part of the Python/TypeScript/Cython symbol index. Documentation remains an honest coverage limitation; the fix does not pretend Markdown is searchable.

Known relevant coverage in each database:

| path | files | symbols/FTS | incident graph edges |
|---|---:|---:|---:|
| `backend/app/db/models/reproducibility_assessment.py` | 1 | 18 / 18 | 45 |
| `backend/app/schemas/entities/reproducibility_assessment.py` | 1 | 34 / 34 | 55 |
| `backend/app/schemas/reads/scientific_assessment.py` | 1 | 15 / 15 | 23 |
| `backend/app/services/scientific_read/public_assessments.py` | 1 | 12 / 12 | 55 |
| `backend/app/services/public_refs.py` | 1 | 27 / 27 | 57 |

Thus incremental and full indexes are retrieval-equivalent; M118 correctly rebuilds the complete live graph and both FTS tables for non-noop refreshes.

## Diagnostics and product behavior

`routeQuery` now carries source-content-free retrieval diagnostics for success and failure:

- normalized query and bounded query variants;
- detected exact identifiers, path terms, and FTS terms;
- path, symbol, lexical, documentation, test, and graph counts;
- pre-filter union, threshold/scope rejections, and graph additions;
- fallback attempted/reason and search-level final reason;
- normalization, lane-search, merge, graph, and total retrieval timings.

`run_pipeline` and its `get_code_context` alias expose these under `diagnostics.retrieval.search`. The stable product projection zeros nondeterministic phase timings so repeated product calls remain byte-deterministic; measured timings remain available from the internal route result and benchmark artifacts. An empty response now says which lanes ran, which identifiers were detected, whether fallback ran, and whether zero arose before or after filtering.

## Synthetic regression fixture

`fixtures/m121_compound_retrieval_repo` contains independent Python files for model, schema, public projection, public-ref service, migration, client type, test, and Markdown docs plus a generic-term negative control. It contains no TCKDB source.

Under the existing 12-result test budget, the original-shaped compound task retrieves:

- `models/reproducibility_assessment.py`;
- `schemas/reproducibility_assessment.py`;
- `services/public_assessments.py`;
- `migrations/versions/add_assessment_ref.py`;
- `tests/test_public_assessments.py`.

The unrelated file containing only `public`, `reference`, `assessment`, and `current` does not displace stronger evidence. Exact CamelCase, snake_case stem, filename, and appended-identifier queries are deterministic across repeated calls.

## Frozen retrieval quality

The 20-case Django-expanded and 30-case cross-repository fixtures were run before from detached commit `d19b47d` and after from the M121 worktree, using the same frozen indexed workspaces. Both CSVs are byte-identical; no fixture was changed and the changed-case list is empty.

Combined 50-case metrics are unchanged:

| metric | before | after |
|---|---:|---:|
| top-1 | 40/50 (80.0%) | 40/50 (80.0%) |
| top-5 | 46/50 (92.0%) | 46/50 (92.0%) |
| any-gold recall | 47/50 (94.0%) | 47/50 (94.0%) |
| all-gold visible recall | 45/50 (90.0%) | 45/50 (90.0%) |
| lead-pivot recall | 40/50 (80.0%) | 40/50 (80.0%) |
| hidden/co-edit all-visible | 4/6 (66.7%) | 4/6 (66.7%) |
| missing | 3 | 3 |
| wrong pivot | 10 | 10 |
| overpacked | 0 | 0 |
| `no_candidates` | 0 | 0 |
| median context | 1,208 tokens | 1,208 tokens |
| p90 context | 4,046 tokens | 4,046 tokens |

The exact per-suite definitions and values are in `stage5_m121_retrieval_before_after.json`.

## Performance

Index refresh and retrieval are reported independently. In the final read-only TCKDB matrix, exact A–C queries took roughly 2–31 ms, D–E roughly 52–92 ms, and compound F–G roughly 217–221 ms. F decomposes as approximately 0.4 ms normalization, 205 ms lane search, 8 ms merge/scoring, and 1 ms graph reranking. Render time is zero in the route-level matrix. These retrieval numbers are not conflated with the 43.6-second clean full graph rebuild.

## Acceptance accounting

- Exact incident reproduced: yes.
- Precise zero-candidate stage proven: yes.
- Index coverage and incremental/full parity proven: yes.
- Exact identifier/path/filename and compound behavior tested: yes.
- Deterministic bounded correction with no arbitrary fallback: yes.
- Actionable empty-result product diagnostics: yes.
- Relevant TCKDB candidates after correction: yes.
- Frozen deterministic retrieval regression: none; both CSVs byte-identical.
- Changed frozen cases: none.
- M120 impact semantics: untouched.
- Live agents, APIs, Docker, and VEXP: not run.

Machine-readable evidence is in the four required JSON artifacts; verification results are recorded at commit time.
