# Stage 5 M128 Mixed Code/Config Retrieval and Path-Scoped Relevance

## Summary
- M127 removed the legacy runtime but missed mixed config surfaces.
- Current-schema preflight: PASS (head_mismatch → incremental refresh → fresh).
- Root cause: YAML/TOML undiscovered, embedded two-component paths dropped, generic lexical crowd-out, and no objective coverage.
- Implementation: truthful YAML/TOML document FTS, component-aware embedded paths, and bounded relevance-qualified mixed-objective selection.
- Exact acceptance: PASS.
- Verdict: MIXED.
- Recommendation: promote document indexing but continue ranking work.

## Freshness Preflight
See `stage5_m128_current_schema_refresh_preflight.json`. Current manifest/index schema refreshed an ordinary committed Python edit incrementally; the earlier schema error was transitional.

## Pre-change File Coverage
See `stage5_m128_tckdb_file_coverage_audit.json`. The Python files were parser/FTS indexed; workflow YAML and pyproject TOML were not discovered.

## Root Cause
The exact payload test ranked 12 and notebook evidence ranked 15/21/23 before selection. `clients/python` produced zero path score. Generic WorkflowTool and snapshot symbols became pivots.

## Document Index Architecture
Design A is documented in `stage5_m128_document_index_design.md`. YAML/TOML chunks carry exact line spans and never create code symbols or edges. Markdown, JSON, and notebooks are deferred.

## Path-Scoped Relevance
Embedded subtree/filename clues are additive to broad decomposition and match component boundaries. Exact subtree evidence outranks generic word matches.

## Multi-Objective Selection
Only parser-backed candidates with strong subtree plus distinctive path/objective evidence qualify. Two config documents may replace weak support without growing item budgets.

## Exact TCKDB Acceptance
- HEAD: `de644061f112eb0bf4ef0e9058840e19e8610e7f`
- Lead: `clients/python/tests/test_computed_reaction_upload_builder.py`
- Selected: `clients/python/tests/test_computed_reaction_upload_builder.py`, `clients/python/tests/test_builder_computed_reaction_demo_notebook.py`, `clients/python/src/tckdb_client/builders/kinetics.py`, `clients/python/src/tckdb_client/builders/calculation.py`, `clients/python/pyproject.toml`, `.github/workflows/python-client-ci.yml`, `clients/python/tests/test_docs_calculation_note_conventions.py`
- Evidence: `{"payloadTest":true,"workflow":true,"pyproject":true,"notebookTest":true,"implementation":true,"degeneracyConvention":true,"pytestCommand":true,"notebookDependencies":true}`
- Result: PASS

## Cross-Tool Parity
get_code_context, get_context_capsule, and run_pipeline parity: PASS. Explicit v1 remains rejected.

## Full/Incremental Equivalence
PASS; document, snapshot, and normalized graph hashes agree.

## Product Regression
Frozen 20+30: 0 selected-file, 0 lead, 0 role, and 0 rendered differences. Quality remains {"cases":50,"top1":39,"top5":46,"allGoldVisible":45,"lead":39,"missing":4,"wrongPivot":11,"noCandidates":0}. Latency: {"samplesMs":[1115.75,3437.288,6255.325,1906.17,1694.694,1004.208,2064.813,459.469,825.102,1125.427,1202.076,1510.87,1667.84,1748.993,585.115,1623.369,823.354,1734.464,2040.476,2024.991,659.537,1153.241,785.52,1048.036,2474.11,1253.438,961.441,2309.341,448.535,365.136,377.458,333.746,971.988,182.924,998.22,89.661,2039.642,2045.885,963.339,386.958,214.613,27.446,248.913,1425.603,755.501,477.343,436.169,357.688,469.829,1971.804],"medianMs":998.22,"p90Ms":2045.885}.

## Safety and Truthfulness
No fake YAML/TOML symbols or execution edges; secret/lock/binary/large files are excluded or have zero document rows. No benchmark labels enter runtime.

## Limitations
Config evidence is static lexical evidence. Markdown/JSON/notebook parsing, live-agent effects, cross-repository intelligence, and exact tokenizer accounting are not claimed.

## Deferred Work
M129: cross-repository workspace intelligence. Also deferred: JavaScript/JSX parser, tokenizer-exact accounting, and prospective product validation.

## Success Criteria Check
Recorded in the JSON/detail smoke artifacts.

## Verdict
MIXED

## Recommendation
promote document indexing but continue ranking work
