# Stage 5 M125 TCKDB Acceptance and Product Retrieval Latency Plan

Date: 2026-07-23
Branch: `main`
Authoritative baseline: `965e561`, `1a80527`, `c678624`, `102dc37`

This plan was written before M125 source changes. The outcome ledgers were already
modified, and the worktree already contained untracked run output, logs, caches,
reports, `package-lock.json`, `AGENTS.md`, and `VTRACE_TOOLING_AUDIT.md`; all are
out of scope and will remain untouched and unstaged. M125 is local, deterministic,
and no-agent: no API, Claude/Codex subprocess, Docker, VEXP, live arm, environment
mutation, TCKDB source edit, TCKDB branch change, fetch, pull, commit, or push.

## Real TCKDB Availability

1. The filesystem search found the actual checkout at `<TCKDB_ROOT>`, ancillary
   repositories under `<HOME>/code/arc_tckdb*`, and caches/history that are not
   source checkouts. `<TCKDB_ROOT>` is the only candidate used for acceptance.
2. `<TCKDB_ROOT>` is on `main`, tracking `origin/main`, at
   `70ff50381f42551a825d75874ea2d70f6dbe08ec` (`Expose assessment public refs
   (#58)`). It is the current main checkout.
3. `git worktree list --porcelain` reports `<TCKDB_ROOT>` plus linked worktrees
   under `<TMP>/tckdb-*`. The main checkout is the sole acceptance target. The
   public-assessment feature worktree is at `97eee786...`; it is not tested in
   place because the merged current-main checkout is authoritative.
4. The original M121 incident used `<TCKDB_ROOT>` and opened its existing
   `.vtrace/index.sqlite` read-only. Its clean comparison index was built in a
   temporary `vtrace-m121-full-*` directory. This is recorded by
   `run_stage5_m121_zero_candidate_investigation.ts` and the M121 report.
5. `<TCKDB_ROOT>` is available.
6. Its `.vtrace` state is available: `config.json`, `state.json`,
   `index.meta.json`, and `index.sqlite` exist.
7. The index is not fresh before M125. Run 12 represents head `3ecc25d...`,
   958 scanned files and 957 indexed files. The checkout is at `70ff503...`;
   `vtrace status` reports `possibly_stale`, source-file-count and fingerprint
   drift, and 960 current source files.
8. The exact HEAD tested after refresh will be
   `70ff50381f42551a825d75874ea2d70f6dbe08ec`. Reports normalize the absolute
   checkout as `<TCKDB_ROOT>`.
9. Yes. `indexProject({db: temporaryDb, repoRoot: <TCKDB_ROOT>,
   refreshMode: "full"})` can build a clean SQLite index under `<TMP>` while
   only reading TCKDB, matching the established M121/M118 protocol.
10. The repository is available, so the unavailable/MIXED escape clause does
    not apply. M125 will first capture a fail-closed `auto_refresh=never` result,
    then refresh only `.vtrace` state with the normal incremental/full decision.

## Product Request Path

11. `buildAuthoritativeProductRetrieval` in
    `src/capsuleV2/authoritativeProductRetrieval.ts` is the M123 authoritative
    seam. It calls `buildCapsuleV2`, then projects the exact v2 selection without
    re-ranking.
12. `runReliableContextRetrieval` (used by `runPipelineOrchestrator`) calls it.
    `runIntentAwareCapsulePipeline` in `src/mcp/tools.ts` also calls it.
    `assembleProductContext` calls `buildCapsuleV2` directly with equivalent
    authority. The MCP/CLI `get_context_capsule` and capsule surfaces currently
    build v2 independently as well.
13. A current `run_pipeline`/`get_code_context` request executes routed FTS and
    graph reranking in `runReliableContextRetrieval`, authoritative hybrid
    retrieval and v2 selection there, additional v2 section construction in
    `runPipelineOrchestrator` when enabled, then another complete v2 build in
    `assembleProductContext`, followed by product enrichment/rendering.
    `get_context_capsule` assembles `productContext` and then independently builds
    its returned v2 capsule. Thus one user request can perform two or three hybrid
    builds plus routed FTS.
14. The common order is repository/freshness preparation; routed classification,
    FTS, and graph rerank; authoritative hybrid/v2 selection; other orchestration
    sections; product-context freshness; another hybrid/v2 selection; skeleton,
    impact, memory/rules, rendering, accounting.
15. Routed FTS/graph and `preparedAssembly` run even though M123 final selection
    ignores their candidates. The separately returned v2 section and
    `productContext` each rebuild the same selection instead of sharing it.
16. `routeQuery`, `hybridRetrieve`/v2 anchor lanes, authoritative projection,
    `sourceDraft`, skeleton rendering, impact, and accounting independently query
    files/symbols/relationships. `listSymbolsByFqName` is repeated during
    projection and product assembly.
17. Routed `resolveBroadQueryContext`/`resolveBoundaryQueryContext`/
    `resolvePathSignalQueryContext`, `shapeSweQuery`, hybrid lexical preparation,
    and `hash(input.task)` normalize or derive from the same task independently.
18. `shapeSweQuery`, `planIntent`, route classification, direct/title/literal
    anchor extraction, and the second product build repeat task derivation.
19. Routed `rerankGraph`, hybrid graph expansion/proximity, v2 graph-neighbor and
    co-edit expansion, and M120 impact attachment traverse graph data separately;
    repeated v2 builds repeat all hybrid/v2 graph work.
20. `buildCapsuleV2` loads selected symbol source, authoritative projection
    reconstructs historical content, `assembleProductContext` builds structural
    skeletons and later reads unique full files for accounting. Repeated builds
    repeat selected source loading; product skeleton/full-file accounting is
    additional work.

## Routed Rescue Behavior

21. In M123 code routed FTS never influences authoritative selection:
    `buildAuthoritativeProductRetrieval` receives no routed candidates. The
    phrase “routed rescue” exists in the ranking-version name, but only Capsule
    v2's internal second `hybridRetrieve(...enableCompoundTaskRescue: true)` can
    change v2 selection.
22. `routeQuery` is currently unconditional in `runReliableContextRetrieval` and
    `runIntentAwareCapsulePipeline`, even though its candidates are not consumed
    by the M123 authority.
23. M121 cases F/G (the long compound prose/slash query, with and without appended
    exact clues), standalone paths, exact CamelCase/snake_case identifiers, and
    bounded URL/trace/path variants genuinely exercise routed recovery. The
    normal strong hybrid corpus should not pay this cost unless coverage is weak.
24. The hybrid result exposes no candidates, candidate scorecards/direct-evidence
    signals, selected paths/fq names, and compound-rescue use. These are enough
    to detect no candidates and represented exact/path clues. A bounded clause
    extractor is needed for a documented compound-coverage decision.
25. Frozen deterministic trigger: run authoritative hybrid first; attempt routed
    rescue only for `no_candidates`, a detected exact identifier not represented
    by selected/candidate symbol or resolved target, a standalone path not
    represented by selected/candidate path, or low coverage of bounded
    high-information compound clauses. Do not require every word and do not use
    gold/final outcomes.
26. Yes. When skipped, diagnostics say `attempted:false` and
    `reason:authoritative_context_sufficient`; they must not fabricate routed
    ranks or timing. Candidate lifecycle fields are nullable/not-run.
27. Yes. Introduce one request-local clue analysis containing normalized task,
    task hash, exact identifiers, paths, and high-information clauses. Feed it
    to trigger diagnostics and reuse it where APIs safely accept prepared input;
    avoid changing hybrid score behavior.

## Latency

28. M123's stored 50-case latency is mixed per repository/process ordering and
    measures `buildCapsuleV2` after an uncounted `routeQuery`; it is not an honest
    combined product-call clock and has no cold/warm separation.
29. Database opening is outside the M123 timer. It must be measured separately,
    but preliminary code inspection says it cannot explain the recorded
    `buildCapsuleV2` median/p90.
30. Index validation is outside the M123 timer and must be separated from fresh
    retrieval. It cannot explain that timer.
31. Routed FTS variant search is performed before, but excluded from, the M123
    `product_latency_ms`; it is avoidable product overhead but not the recorded
    2.6/10.5-second core number.
32. `hybridRetrieve` and the many v2 post-retrieval anchors/backfills are the
    leading candidates inside the recorded timer. M125 instrumentation will
    distinguish core hybrid from the remaining v2 stages.
33. Hybrid graph work and later v2 graph-neighbor/co-edit work are inside the
    timer; routed `rerankGraph` is outside it. Both require separate clocks.
34. Selected source loading is inside v2 assembly; product-context full-file
    accounting is outside it. Both will be measured.
35. Product skeleton rendering is outside the M123 timer and occurs in
    `assembleProductContext`; it will receive its own clock.
36. `addImpactEvidence` is outside the M123 timer and already has a coarse
    `impactMs`; internal attachment time will remain visible.
37. `addMemoryAndRules` is outside the M123 timer and already has
    `memoryRulesMs`.
38. Deduplication/accounting is not separately timed today. Rendering is timed
    before async full-file accounting, so total minus named stages hides it.
39. Existing named product timings are non-overlapping except total. In M123,
    routed time is excluded and v2 is reported as one capsule-build interval;
    current comments explicitly keep `retrievalMs=0` to avoid double counting.
40. Freshness fingerprinting, selected source loads across repeated v2 builds,
    skeleton access, and async full-file reads can repeat. M125 will count loads
    and separate synchronous database work from filesystem reads.

## One-Case Lead Divergence

41. The frozen case is `psf__requests-1724`: legacy lead
    `requests/sessions.py`, product-v2 lead `requests/api.py`.
42. The stored arrays are not literally identical: legacy selected
    `{sessions.py,cookies.py}`, product selected
    `{api.py,sessions.py,cookies.py}`. “Product gains/losses: 0” means no
    expected-file hit-count change, not set identity.
43. The product result promotes the public API wrapper ahead of the session
    implementation while retaining the same expected implementation/support
    evidence.
44. The divergence originates in v2 pivot ordering/role evidence, not
    `productContext` reordering or path normalization. M125 will preserve the
    underlying candidate score trace and determine whether the API wrapper is a
    generic/direct-evidence tie-break artifact.
45. It may be alignable by a justified deterministic lead-role projection
    (implementation over thin forwarding wrapper) without changing the selected
    set. No change will be made unless the evidence supports the general rule.

## Cache and Reuse Safety

46. Within one request and one fresh index snapshot, normalized clues/task hash,
    worktree identity, index metadata/run ID, the open database handle, one
    authoritative `CapsuleV2Result`, its projected capsule/product response,
    symbol metadata, selected source contents, skeleton results, and impact graph
    handle are immutable and reusable.
47. Any persistent key must contain repository ID, worktree ID, index
    run/snapshot ID, normalized task hash, intent, budget policy/value,
    `include_tests`, retrieval implementation/ranking version, and parser/index
    configuration fingerprint.
48. Open database/graph handles, per-request clocks/counters, freshness overrides,
    in-flight selected content, and mutable draft arrays are request-local only.
49. No persistent retrieval cache is planned initially. Existing index tables and
    parse caches remain the persistent reuse layer. A future cache may persist
    source-free selection metadata only under the full key above.
50. Request reuse is discarded after the call. Any future persistent entry must
    be invalidated by worktree identity plus index run/snapshot, parser fingerprint,
    config fingerprint, and retrieval version; stale freshness fails closed before
    lookup. Rendered private source will not be placed in a new global cache.

## Implementation and Evaluation Sequence

1. Capture stale `auto_refresh=never` behavior, then refresh the existing TCKDB
   index through the normal stale decision and record `noop`/`incremental`/
   `full_rebuild` plus refresh latency.
2. Run the exact byte-for-byte request through the current authoritative seam and
   all three product wrappers. Record candidate lifecycle and required visibility.
3. Add nested, non-double-counted stage timing seams and run bounded cold, warm
   repeated-task, and warm different-task profiles: routed only, hybrid only,
   current combined request, and enrichment from a supplied selection.
4. Add a request-scoped authoritative retrieval object. Allow product assembly
   and product wrappers to consume it rather than rebuilding v2.
5. Evaluate a deterministic lazy routed-rescue decision after authoritative
   selection. Keep routed search source-body-free and bounded; when its results
   cannot affect selection, record honest skipped diagnostics.
6. Add focused trigger/diagnostic/reuse/parity/leakage tests and extend the M125
   no-agent smoke with the retained M123 controls.
7. Re-run the frozen 20+30/50 evaluation, M121 compound regressions, current vs
   isolated-full TCKDB equivalence, full tests, both typechecks, and diff checks.

## Decision Gates

TCKDB acceptance is PASS only if the exact query visibly contains the assessment
model, compact public projection, public-ref infrastructure, assessment schema,
and at least one migration/test/OpenAPI/client verification surface with a
directly responsible lead. Performance is PASS only if duplicate routed/repeated
hybrid work is removed or justified and quality is unchanged. If TCKDB passes but
the single authoritative hybrid core remains intrinsically slow after duplicate
work is removed, the milestone verdict is MIXED.
