# M121 real-repository zero-candidate retrieval plan

## Scope and constraints

This milestone replaces the previously proposed cross-repository M121; that work is renumbered M122. M121 is limited to deterministic, local retrieval and indexing against one read-only TCKDB worktree plus a synthetic Python fixture. It will not run live agents, Claude, Codex, Docker, VEXP, network APIs, or modify TCKDB. M120 impact semantics and the frozen retrieval scoring policy remain out of scope.

The worktree starts on `main` at `d19b47d`, with unrelated dirty benchmark ledgers and untracked generated artifacts. Those files will not be modified or staged. The authoritative implementation history is `3b0baa7` (incremental indexing), `6dbd519` (product context), and `3efc964` (impact/flow evidence).

## Pipeline audit before implementation

1. **Where is `candidateFilesConsidered` computed?**

   `routeQuery` calls `searchSymbols`, then `collectPathSignalDiagnostics` deduplicates `lexicalCandidates.map(candidate => candidate.filePath)` and records that distinct-file count. Product paths copy this value through `runPipelineOrchestrator` and the MCP formatter. It is computed in `src/intent/routeQuery.ts`, before `rerankGraph`, capsule assembly, or product rendering.

2. **What does zero mean precisely?**

   It means the initial routed symbol search returned zero scored symbol rows, hence zero distinct candidate file paths. It does not mean the index contains zero files, that graph reranking rejected files, or that capsule thresholds omitted candidates. Graph reranking receives an empty symbol list in this case.

3. **Which retrieval lanes run before this counter?**

   In the FTS backend used by every intent profile: primary FTS admission; an FTS single-term recovery only when primary admission has zero rows and broad-query context exists; path-signal SQL candidates when broad/path context exists; boundary candidates for supported Cython-oriented queries; merge; score/filter; sort; and pool truncation. The legacy `routeQuery` path does not call `hybridRetrieve`, body-literal recovery, test-to-implementation expansion, or graph expansion before the counter.

4. **Which lanes can seed each requested evidence class?**

   - Paths and filenames: FTS `file_path`, plain-SQL file-path matching, and the supplemental path-signal SQL lane. Explicit likely-file seeding exists in `hybridRetrieve`, not in the routed product path.
   - Symbols: FTS fields (`local_name`, `fq_name`, `signature`, `docstring`, `file_path`) and plain-SQL equivalents. Explicit likely-symbol seeding exists only in `hybridRetrieve`.
   - FTS content: symbol metadata and file path in `symbol_search_fts`; it does not index arbitrary module source or standalone prose.
   - Documentation: only parsed/indexed symbols and their docstrings/paths. Markdown documentation is not scanned by the current parser registry and has no independent documentation lane.
   - Tests: ordinary symbol/path FTS with optional ranking penalties; the v1 routed path has no independent test lane. Test-to-implementation is a separate hybrid-only generator.
   - Graph neighbors: `rerankGraph` can only rerank the lexical pool. It cannot seed a graph neighbor into an empty pool. Bounded graph expansion exists in `hybridRetrieve`, not this product route.

5. **How is the request normalized?**

   `parseRequiredRunPipelineTask` selects `task` over legacy `query` without semantic rewriting. `normalizeSearchQuery` trims, converts backslashes to `/`, and lowercases. Intent classification has its own normalization, but routed retrieval receives the complete task. No structured task derivation is applied to `get_code_context` v1 retrieval.

6. **How is the full request represented?**

   For the incident, it is one exact full-string substring alternative plus an FTS **AND** query over every collected token. It is not an exact phrase, weighted term query, or bounded set of semantic variants. The broad-query OR-of-phrases/pairs and single-term recovery are disabled because `resolveBroadQueryContext` rejects any query containing `/`. The prose fragment `immutability/supersession` therefore disables broad decomposition for the entire task.

7. **Which terms survive normalization?**

   The normalized task preserves all lowercased prose. The incident FTS expression contains 47 sorted terms: `a`, `across`, `add`, `already`, `an`, `and`, `api`, `appropriate`, `assessment`, `builders`, `client`, `compact`, `determine`, `docs`, `exact`, `for`, `have`, `immutability`, `immutable`, `in`, `kinetics`, `migrations`, `models`, `open`, `openapi`, `projection`, `public`, `python`, `ref`, `reference`, `reproducibility`, `schemas`, `stable`, `statmech`, `summaries`, `supersession`, `surfaced`, `tests`, `the`, `thermo`, `trace`, `transport`, `types`, and `whether`. Stopwords remain in the non-broad FTS query.

8. **How are snake_case identifiers handled?**

   `collectSearchTerms` tokenizes on non-alphanumerics, so `public_ref` becomes `public` and `ref`; the exact snake_case identifier is not retained as an FTS term or separate query variant. Path-segment extraction also splits on underscore. The SWE query shaper can detect snake_case identifiers, but it is not used by this product retrieval route.

9. **How are compound domain phrases handled?**

   With broad context active, adjacent two-term phrases and every two-term combination form OR admission disjuncts, while term variants support bounded morphology. With broad context disabled, every token is joined by AND, requiring one indexed symbol row to contain the whole compound task vocabulary. There is no noun-phrase parser or objective/concern decomposition.

10. **Which thresholds can reduce a non-empty raw result to zero?**

    FTS/SQL admission can yield rows that `rankSearchCandidates` removes when `scoreCandidate` produces no match evidence, although broad/path/boundary candidates normally create their associated evidence. Candidate pool limits and final `maxResults=0` can also produce zero by configuration. Capsule profile/budget thresholds may reduce non-empty routed candidates to an empty capsule, reported separately as `all_candidates_omitted`; they do not explain `candidateFilesConsidered=0`. The incident is currently upstream at FTS admission.

11. **What fallback currently runs after zero lexical candidates?**

    `searchSymbolsFts` runs `buildFtsSingleTermRecoveryQueryForContext` only when primary FTS rows are empty **and** broad context exists. For the incident broad context is absent, so no lexical fallback runs. The product-level relaxed assembly fallback runs only for `all_candidates_omitted`, not `no_candidates`.

12. **Does incremental refresh rebuild every retrieval table/index?**

    Yes for a non-noop refresh: M118 reconstructs a complete parse-result set, then one transaction deletes and rebuilds `files`, `symbols`, `edges`, `symbol_search_fts`, and `symbol_body_literals_fts`, relinks deferred edges, validates the graph, and records run state. A proven noop intentionally leaves all live graph/retrieval tables untouched. This design makes an incremental/full parity test necessary but makes partial FTS persistence an unlikely preliminary explanation.

13. **How will incremental and full behavior be compared?**

    Preserve the read-only worktree and its current `.vtrace` index. Query and hash/count the current incrementally refreshed database. Create an isolated temporary state directory and database under `/tmp`, run a controlled full index of the same TCKDB HEAD without changing repository files, and run the identical A–G matrix. Compare live-table counts, normalized graph rows/hash, retrieval rows/hash, per-query diagnostics, candidate identities, and timing. Remove only the temporary state after recording compact normalized evidence.

14. **Are the relevant TCKDB files represented?**

    This remains an acceptance-test question, not an assumption. The investigation helper will query normalized repo-relative paths for file rows, symbol rows, `symbol_search_fts` rows, body-literal rows, and incident graph edges for the known model/schema/projection/migration/doc/test/client targets. Markdown may be absent by scanner/parser policy; that absence will be reported separately from Python coverage.

15. **What telemetry is missing?**

    Current product diagnostics expose only path terms/matches, distinct lexical candidate files, weak path coverage, a capsule-level fallback flag, and final reason. They omit normalized query, derived FTS expression, variants, identifiers, raw rows per lane, score-filter rejections, pre-filter union size, graph input/expansion counts, threshold decisions, fallback eligibility/reason, selected files, and retrieval phase timing. This makes an upstream FTS admission failure indistinguishable from an empty index in the product response.

## Preliminary causal hypothesis to test

The exact incident deterministically produces no broad context because the natural-language slash in `immutability/supersession` is treated as a path marker. The fallback FTS builder then emits a 47-term AND expression, including stopwords, and no single symbol metadata row can satisfy it. Because broad context is absent, no single-term recovery or path-signal lane runs; graph reranking receives no seeds. This identifies a precise candidate-generation stage, but no code change will be made until the A–G matrix, index coverage audit, and incremental/full isolation confirm it.

## Implementation and validation sequence

1. Add an offline M121 diagnostic runner and synthetic Python fixture. The runner will expose normalization, bounded query variants, lane raw/rejected counts, candidate union, graph input/output, fallbacks, selections, final reason, and phase timing without source contents.
2. Capture the frozen deterministic retrieval baseline before changing retrieval. Do not mutate fixtures after observing results.
3. Run A–G against the current TCKDB index and a clean full rebuild; record index coverage/count/hash parity and selected candidate parity.
4. If the hypothesis is confirmed, make the smallest bounded correction at query construction: distinguish path separators from punctuation slashes in prose and supply deterministic identifier/filename-preserving variants or a bounded zero-primary recovery. The correction must union independent strong lanes, must not require all concepts in one symbol, and must never seed arbitrary central files.
5. Add actionable diagnostics to product failures and an internal/debug result available on success. Keep default output compact and expose no source contents.
6. Add regression tests proving exact CamelCase, snake_case, filename, projection, narrow semantic, compound multi-concept, and appended-identifier behavior. Include generic-term negative controls.
7. Re-run TCKDB A–G on both indexes, the synthetic fixture, frozen retrieval evaluation, M114–M120-focused tests, both typechecks, the full Bun suite, and `git diff --check`.
8. Enumerate every changed frozen case and report top-1/top-5/any-gold/all-gold/lead-pivot/hidden-coedit recall, missing/wrong-pivot/overpacked/no-candidate counts, and median/p90 context before versus after.
9. Write the required compact Markdown/JSON artifacts with normalized repository labels only, stage intentional source/tests/helpers/reports, and commit locally on `main` without pushing.

## Acceptance decision

PASS requires a reproduced or fully explained incident, separate indexing/retrieval timing, incremental/full parity, exact-stage proof, bounded deterministic correction, actionable diagnostics, relevant TCKDB candidates, no material frozen-eval regression, complete changed-case accounting, and clean verification. MIXED is reserved for a proven root cause whose safe general fix demonstrably requires a separate milestone. A generic long-query attribution or arbitrary-file fallback is a FAIL.
