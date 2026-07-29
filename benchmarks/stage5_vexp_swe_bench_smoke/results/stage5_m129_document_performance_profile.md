# Stage 5 M129 Document-Aware Retrieval Performance Convergence

## Summary
- M128 functional status: authoritative and preserved.
- Latency regression: historical 998.22/2045.885 ms.
- Dominant cause: cold/warm benchmark mismatch, not document FTS.
- Optimization: batched chunks plus request-local path/objective reuse and optional profiling.
- Semantic equivalence: 0 selected, 0 lead, 0 role, 0 rendered differences.
- Final latency: frozen 581.322/1173.442 ms; exact 906.378 ms.
- Verdict: PASS.
- Recommendation: promote optimized document retrieval.

## Pre-change Architecture
M128 ran document relevance and bounded FTS before hybrid retrieval, rescored the capped hybrid candidates with embedded paths, applied mixed-objective coverage after role assignment, and inserted line-bounded YAML/TOML support after ordinary packing.

## Measurement Method
Pristine M127/M128 detached code and M129 were compared without agents. Cold, warm-different-task, and warm-same-task protocols are reported separately. Frozen workspaces and TCKDB indexes were opened read-only.

## Stage Profile
```json
{
  "timingsMs": {
    "path_clue_extraction": 0.022820000000137952,
    "objective_decomposition": 0.03579199999967386,
    "document_relevance_detection": 0.012912999999571184,
    "document_fts_query": 1.8095239999993282,
    "document_chunk_excerpt_loading": 0.24372799999946437,
    "objective_to_candidate_matching": 0.156050999998115,
    "document_candidate_materialization": 1.68641099999968,
    "m128_integration_total": 4.099079999999049,
    "path_candidate_retrieval_scoring": 0.15926800000033836,
    "mixed_surface_coverage_selection": 0.026142000000618282,
    "document_rendering": 0.08267700000033074,
    "document_accounting_deduplication": 0.10248200000023644
  },
  "counters": {
    "path_clues": 1,
    "task_objectives": 5,
    "document_fts_queries": 1,
    "document_fts_variants": 1,
    "document_chunk_rows_returned": 48,
    "document_chunk_batch_queries": 1,
    "document_excerpts_loaded": 48,
    "document_bytes_loaded": 34083,
    "files_path_scored": 45,
    "path_clue_comparisons": 75,
    "path_component_comparisons": 172,
    "candidate_objective_comparisons": 240,
    "document_candidates_materialized": 29,
    "candidate_sorts": 3,
    "document_candidates_surviving_cap": 4,
    "document_files_eligible": 29,
    "path_objective_affinities_computed": 10,
    "candidate_array_copies": 1,
    "coverage_candidates_considered": 25,
    "document_items_rendered": 2,
    "selected_document_count": 2
  },
  "documentLane": {
    "attempted": true,
    "reason": "supported_document_clue",
    "trigger": [
      "project_configuration_objective",
      "workflow_objective"
    ]
  }
}
```

## SQL and Scaling Profile
Counts: {"files":1008,"symbols":23121,"documentFiles":44,"documentChunks":527,"documentFtsRows":527}. FTS uses the FTS5 virtual index and a bounded 48-row result; the deterministic order uses a temporary B-tree. The batch lookup uses document/file primary keys. No all-files path scan occurs.

## Root Cause
benchmark_measurement_mismatch. M127 warmed each frozen database twice before timing; M128 timed the first retrieval. Identical-protocol M127/M128 exact medians differed by only about 15 ms. Document FTS plus materialization is a few milliseconds.

## Optimization Design
Deterministic clue gating is retained. Candidate paths, components, task tokens, and affinities are request-local. Up to 48 chunk lookups are replaced by one batch. Duplicate document evidence remains merged by file. No persistent/result cache was added.

## Semantic Equivalence
Frozen differences: selected=0, lead=0, roles=0, modes=0, rendered=0, accounting=0. Exact TCKDB equal=true.

## Performance Results
- Frozen cold: 574.059/1167.298 ms median/p90.
- Frozen warm different task: 581.322/1173.442 ms.
- Frozen warm same task: 593.223/1187.544 ms.
- Exact TCKDB warm: 906.378 ms.
- Python-only M128 integration: 0.056 ms.
- Document-only M128 integration: 2.363 ms.

## Exact TCKDB Acceptance
HEAD 8f0d84bbf09179c941d4988bab641af69d712d86; lead clients/python/tests/test_computed_reaction_upload_builder.py. Selected: clients/python/tests/test_computed_reaction_upload_builder.py, clients/python/tests/test_builder_computed_reaction_demo_notebook.py, clients/python/src/tckdb_client/builders/kinetics.py, clients/python/src/tckdb_client/builders/calculation.py, clients/python/pyproject.toml, .github/workflows/python-client-ci.yml. Workflow, pyproject, notebook, payload, implementation, and pytest evidence: PASS.

## Product Regression
Quality: {"cases":50,"top1":39,"top5AnyGold":46,"allGoldVisible":45,"leadPivot":39,"missing":4,"wrongPivot":11,"noCandidates":0}. No-candidates=0; unversioned authority preserved.

## Full/Incremental Equivalence
PASS across YAML/TOML edits, rename, deletion, source edit, and no-op. Worktree isolation remains covered by the dedicated identity suite.

## Limitations
Timings retain OS/SQLite noise. No live-agent effect is claimed. Candidate scoring still reads bounded FTS-hit text before final selection because exact M128 token/objective semantics depend on it. The committed retrieval-eval CSVs differ in three rows from the current workspace indexes because those pre-existing indexes and baselines have drifted; a like-for-like run of pristine M128 and M129 against the same current indexes produced byte-identical 20-case and 30-case CSVs.

## Deferred Work
M130 cross-repository workspace intelligence; JavaScript/JSX; Markdown/JSON policy; notebook parsing; tokenizer-exact accounting; prospective validation.

## Success Criteria Check
Stage profile, query plans, scaling counters, semantic hashes, exact acceptance, frozen quality, performance bounds, indexing equivalence, and offline controls are recorded in the sibling JSON artifacts.

## Verdict
PASS

## Recommendation
promote optimized document retrieval
