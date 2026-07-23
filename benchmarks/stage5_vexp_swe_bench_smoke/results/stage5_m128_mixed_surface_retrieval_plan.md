# Stage 5 M128 Mixed-Surface Retrieval Plan

## Preconditions and authority

Work is confined to `main`; HEAD is `b882909` and the authoritative lineage includes `fdcda9a`, `1272d2b`, `c678624`, `102dc37`, `965e561`, `a4b7cf6`, `3b0baa7`, `6dbd519`, and `3efc964`. M127's one unversioned capsule and hybrid selection authority remain unchanged. Pre-existing outcome-ledger edits and unrelated untracked artifacts are excluded from M128.

The current-schema gate passed: a fresh process classified committed HEAD B as `head_mismatch`, and `get_code_context(auto_refresh=if_stale)` completed an incremental refresh. No `index_schema_changed` occurred.

## TCKDB file coverage (questions 1–20)

The exact audit is in `stage5_m128_tckdb_file_coverage_audit.json`. `scanRepo` and `detectLanguage` discover and parser-index all three Python paths. Their manifest entries report `language=python`, `indexOutcome=indexed`, `parserCapability=supported`; they exist in `files`, symbols, and symbol FTS. `kinetics.py` and the notebook test also have body-literal rows; the payload test has none. There is no generic document index.

The YAML workflow and TOML manifest are not ignored: they are never recognized. Consequently they are absent from the scanner output, manifest snapshot, `files`, all FTS indexes, both candidate generators, graph expansion, and capsule consideration (`not_discovered`).

Pre-change hybrid ranks are payload test 12, notebook test 15/21/23/25, and `kinetics.py` 5. The implementation is visible as signature support. The two tests are `excluded_before_capsule`: neither the file cap nor token budget sees them because role selection/packing first chooses generic `WorkflowTool` and `FetchResult`. YAML/TOML are entirely unsearchable.

## Current document/config coverage (questions 21–35)

21–25. No non-parser generic documents are indexed. Markdown, YAML, TOML, and JSON are not scanner inputs. The existing `capsuleV2/docRetrieval.ts` reads selected Markdown from disk late and is not an index/search lane.

26–28. GitHub Actions and `pyproject.toml` have no special handling; project manifests are not even filename-searchable unless their extension is a recognized source extension.

29–31. A new `documents` table plus contentless/file-level `document_search_fts` is safer than attaching text to `symbols`. Body-literal FTS requires parser-produced symbol IDs, so it cannot truthfully represent config. A file-level lane avoids fake symbols.

32. Document chunks use deterministic 1-based inclusive `start_line`/`end_line`. Matched excerpts are selected by FTS/key/path evidence rather than the first N lines.

33. Add document tables/FTS, bump database/index content schema and the manifest/file snapshot version, and include a document policy fingerprint. Old indexes rebuild honestly.

34. Full refresh replaces document rows transactionally. Incremental refresh deletes rows for changed/deleted/renamed paths and inserts bounded rows for new/modified supported documents. Unchanged snapshots carry forward. Rename is delete+add by stable path-derived file identity. Final full/incremental hashes must match.

35. Existing ignored-directory and `.vtraceignore` rules remain authoritative. Add explicit text safety, binary/NUL detection, secret/lockfile exclusions, a 256 KiB file cap, at most 32 chunks/file, and at most 4 KiB/chunk.

## Path clue behavior (questions 36–50)

36–41. `shapeSweQuery` currently extracts recognized source filenames and repository paths with at least three components. Thus `clients/python`, `clients/python changes`, `.github/workflows`, and YAML filenames disappear. M121 correctly keeps broad decomposition for natural-language slashes, but it has no additive embedded-subtree representation.

42–44. Current path signals tokenize components and normalize variants, but candidate boosts are symbol-file based and `clients/python` produces no shaped clue. A short `python` token can overmatch lexically; it must not receive subtree strength.

45–48. Extend shaped diagnostics with normalized embedded clues and attach `clue`, `matchType`, `subtree`, `filename`, and score contribution. Authoritative code candidates and document candidates use the same component-aware matcher. Routed diagnostics consume the same clues. File aggregation preserves the best exact match.

49. Yes: generic backend `workflow`/`snapshot` files currently receive exact-looking weak direct-evidence boosts while all `clients/python` candidates have path score zero.

50. Bounded correction: exact path > filename > directory-prefix > component sequence > weak basename. Only component-boundary matches qualify. Additive embedded path evidence cannot replace broad task decomposition and does not change global hybrid constants.

## Multi-objective handling (questions 51–60)

51–54. Current shaping retains one first-sentence lead plus identifiers. The exact task retains `degeneracy_convention` but loses all config paths and has no clause provenance; generic `workflow`/`snapshot` can dominate.

55–58. Existing pivot/support roles provide bounded diversity, but not artifact/objective coverage. M128 will derive deterministic objective evidence from clauses and recognized clues: implementation, test/snapshot, workflow, dependency/configuration, notebook verification, documentation. Candidates record matched objective terms. Only candidates above a direct-evidence threshold qualify.

59. Selected document items will carry `kind`, `document_excerpt`, line spans, and configuration/lexical evidence; code/test items retain parser-backed source semantics.

60. After document coverage and path relevance, reserve bounded mixed-surface support slots only when a strong uncovered artifact objective has a direct candidate. One file may satisfy multiple objectives. This cannot promote weak role fillers and is not a global score retune.

## Performance (questions 61–68)

61–62. The checkout has 123 YAML and 7 TOML files totaling 3,684,542 bytes before policy exclusions.

63. At 32 chunks/file the theoretical cap is 4,160 rows; measured normal files should be much lower because chunks are bounded logical blocks.

64–66. Unconditional generic config retrieval could add latency/noise. Query the document lane only for config/workflow/dependency/CI/TOML/YAML clues, explicit supported filenames, or embedded paths. Keep FTS results at 20 and merged documents at four. Exact path/key search remains bounded.

67. Use 256 KiB/file, 32 chunks/file, 4 KiB/chunk, and a bounded matched-excerpt renderer.

68. Exclude lockfiles, `.env*`, keys/certificates/credentials/secrets, ignored/vendor/build/node_modules paths, binary/NUL files, and over-limit files. Invalid YAML/TOML may be indexed lexically because no parser executes it.

## Architecture decision

Choose **Design A — shared file-document lane**. `documentIndex` owns safe recognition/chunking/persistence; `documentRetrieval` owns bounded FTS/path/objective ranking. Authoritative hybrid assembly merges document candidates into its one candidate/selection result. Routed rescue reports the same provider when its existing triggers apply. Provenance is preserved and each path renders once.

Reject Design B because embedding all document SQL directly in the symbol hybrid core couples truthful file documents to symbol graph types. Reject Design C because the exact workflow/config evidence should be authoritative when directly requested, not available only after a rescue failure.

## Format decision

Support YAML and TOML now. Defer Markdown: current late bounded documentation support exists and M128 acceptance does not require a second Markdown representation. Defer JSON: broad JSON includes generated dumps and needs a narrower manifest policy. Defer notebooks: the indexed Python notebook-policy test supplies truthful evidence without parsing `.ipynb`.

## Planned implementation and tests

1. Add safe document policy, deterministic YAML/TOML logical chunks, line spans, repositories, FTS, schema/version fingerprints, and full/incremental persistence.
2. Add component-aware embedded path clues without changing standalone-path or broad decomposition behavior.
3. Add gated document retrieval and diagnostics, then merge bounded document support into the authoritative capsule.
4. Add relevance-qualified artifact coverage so exact tests/notebook evidence survive generic distractors.
5. Extend product rendering/accounting with document excerpts and lexical/configuration truth labels; do not create code symbols or edges.
6. Add synthetic mixed-surface, safety, path, full/incremental equivalence, cross-tool, and exact TCKDB acceptance tests/smoke.
7. Run frozen 20+30 through the unversioned product path. Any changed case is enumerated; unchanged non-document tasks should never invoke the lane.

## Stop conditions

Stop on fabricated code semantics, a freshness regression, unexpected general hybrid SQL/scoring changes, loss of M127 authority, frozen gold loss, or latency outside the required bounds.
