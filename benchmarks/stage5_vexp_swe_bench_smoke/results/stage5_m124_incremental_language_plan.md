# M124 Incremental Indexing Unsupported-Language Plan

## Scope and incident

M118 made a previous manifest snapshot activate a blanket abort whenever any current source file was unreadable or did not produce an indexed parse result. Detection includes `.js` and `.jsx`, but the default registry has no JavaScript parser. Consequently a JavaScript file that the pre-M118 full path reported as `unregistered_language` became fatal during refresh, and supplying the previous snapshot even with `--mode full` activated the same abort.

This plan preserves storage, transaction, schema, graph-validation, and internal failures as fatal; makes supported-parser failures and read failures consistently fatal; and makes only honest unsupported/unregistered capability outcomes nonfatal and persisted.

## Pre-change audit

### Language detection and registry

1. `src/fs/languageDetection.ts` classifies `.ts`/`.tsx` as TypeScript, `.js`/`.jsx` as JavaScript, `.py` as Python, and `.pyx`/`.pxd`/`.pxi` as Cython. `scanRepo` calls every one of these indexable.
2. The default registry in `indexProject.ts` registers TypeScript, Python, and Cython.
3. JavaScript/JSX is the only detected/default-registry mismatch. Go and Rust exist in the domain enum but are not detected and therefore are not advertised by scanning.
4. The current TypeScript implementation is not a JavaScript implementation. It accepts only `Language.TypeScript`; chooses the TypeScript grammar for non-`.tsx` paths and TSX only for `.tsx`; and has no `.js`, `.jsx`, ECMAScript-module, CommonJS, or JavaScript-mode contract. The grammar may accept overlapping syntax, but VTRACE has not proved JavaScript extraction semantics.
5. Yes: for every non-`.tsx` input the adapter chooses `tree-sitter-typescript`'s TypeScript grammar, not a JavaScript grammar. It also rejects `Language.JavaScript` before parsing.
6. `tree-sitter-javascript@0.23.1` is present transitively in `bun.lock` through `tree-sitter-typescript`, but is not a direct dependency and no VTRACE adapter uses it.
7. The abstraction can distinguish languages (`LanguageParser.language`, registry key, and `ParseFileInput.language`), but one parser instance supports exactly one registered language and parser identity/version is currently synthesized outside the registry.
8. No honest JavaScript parser/version fingerprint exists. The current cache would synthesize `vtrace-javascript` only after a successful JavaScript parse, which cannot happen with the default registry.
9. No test currently asserts that every detected language is either registered or explicitly unsupported. Existing tests separately prove JavaScript detection and unregistered parser behavior, allowing drift.

### File outcome semantics

10. Current statuses are `indexed`, `read_failed`, `parse_failed`, `unregistered_language`, `unsupported_language`, and `persistence_failed`.
11. `ParserRegistry.parse` returns `ParserError.unregisteredLanguage` when no parser is registered; `indexProject.summaryForParserError` maps it to `unregistered_language`.
12. Before M118, the full path recorded unregistered, unsupported, read, parse, and per-file persistence outcomes and continued. It pruned the live graph and created a run even when some files were not indexed.
13. M118 added a blanket check after parsing: when `previousSnapshot` exists, any read outcome or any summary other than `indexed` throws a generic incremental-abort error.
14. With a prior snapshot, all non-indexed outcomes are fatal. Without one, none of the per-file outcomes is fatal. Transaction and validation errors are fatal. This is mode-inconsistent.
15. Only recognized-but-unavailable capabilities (`unregistered_language` and `unsupported_language`) should be tolerated. They must remain explicit skips, not parser failures. Ignored/generated/unrecognized files remain outside the current discovered-source snapshot policy.
16. Tree-sitter syntax nodes can yield diagnostics while the file remains `indexed` (for example TypeScript `Syntax error`). Parser exceptions/rejections become `parse_failed`; the old full path tolerated them while M118 refresh aborts.
17. Unreadable files are recorded and tolerated without a prior snapshot, but fatal with one. The corrected policy will make them fatal in both graph modes.
18. Ignored directories and ignore-rule matches are excluded before discovery. Common generated directories are treated as ignored; binaries/unrecognized extensions are simply not source candidates. There is no persisted generated/binary distinction.
19. Yes. A refresh can honestly succeed with explicit unsupported/unregistered skip summaries, counts, and snapshot entries while excluding those files from the graph.

### Snapshot behavior

20. Manifest file snapshot schema v2 records only successfully persisted/indexed files.
21. Unsupported/unregistered detected files are in the filesystem scan but absent from `manifest.files.files`.
22. Yes. Their absence makes them appear newly added relative to the indexed-only snapshot; with a previous snapshot the later blanket check then aborts.
23. Schema v3 will record each detected source candidate's relative path, content identity/hash, language, outcome/capability, parser identity/version/config only when indexed, and a stable diagnostic category/message for a tolerated skip. Ignored files remain excluded.
24. A registry-capability fingerprint in the snapshot will invalidate compatibility when supported languages change. Language/config fingerprint changes, extension/language changes, and content identity changes also force deterministic re-evaluation where relevant.
25. Parser implementation sources contribute to `parser_fingerprint`, but registry composition is located in `indexProject.ts` and is not explicitly represented. `languageDetection.ts` is also missing from the config source list. Thus capability compatibility is indirect and incomplete.
26. Adding an adapter changes parser sources and default-registry capability. The implementation will persist an explicit registry fingerprint and include language detection in config hashing, forcing a safe rebuild/re-evaluation.

### Full mode

27. `--mode full` asks `planIncrementalRefresh` for `full_rebuild`, invalidates every current path, reparses every readable file, and transactionally rewrites the full graph and retrieval tables.
28. `reindexRepoAndRefreshState` always supplies a local/reusable previous snapshot, regardless of requested mode, for planning and metadata/cache context.
29. Yes. The blanket non-indexed-outcome check tests only `previousSnapshot !== undefined`, so full mode still executes incremental-only fatal behavior.
30. Full mode must ignore previous graph snapshot state for delta planning, cached graph mutation, unchanged-file carry-forward, and file-outcome fatality. It may inspect it for compatibility diagnostics only.
31. Yes. Immutable parse cache keys already include content, parser ID/version/config, language, path, and binding context. Full graph correctness can be independent while cache reuse remains an optional optimization. The first correction will keep full parsing conservative; cache reuse remains permitted, not required.
32. Tests will seed a prior graph/snapshot, inject stale or unsupported prior status, request full, and assert full-rebuild diagnostics, complete transactional rewrite, no incremental carry-forward, and equality with a clean full graph.

### Diagnostics

33. The path is present in `ParserError` and `IndexedFileSummary`, but the blanket abort replaces all summaries with one generic `Error`; `indexCommand` then wraps only that message.
34. `ParserError`/`SerializedParserError` carry `filePath` and `language`; `IndexedFileSummary` carries `path`, language, status, diagnostics, and optional error. `IndexerFileError` currently carries only code/message but is nested under the path-bearing summary.
35. Successful tree-sitter parses expose `ParseDiagnostic` message/line/byte. Parser failure exposes its exception message plus path/language. Read and persistence failures expose their error messages.
36. CLI JSON already emits complete per-file records on success; human output emits only aggregate counts. MCP `index_repo` emits state aggregate counts and performance, not per-file outcomes. Failures become generic CLI/MCP handler errors and lose the structured file list.
37. Human output will list up to 20 failures/skips with path, language/status, and diagnostic, plus an omitted count. JSON/MCP will retain bounded structured per-file outcomes, while aggregate counts remain stable.

## Language-support decision

Decision B: stop advertising JavaScript and JSX as indexable parser capabilities. They remain recognized source-like languages so the scanner can snapshot and diagnose them, but default capability reports them unsupported and skips them. VTRACE will not map JavaScript to the TypeScript parser and will not claim JavaScript or JSX indexing support. Adding a real `tree-sitter-javascript` adapter with extraction tests is deferred.

## Planned file-outcome and fatality policy

- `indexed`: parser capability exists and parse/persistence succeeds; included in graph and snapshot.
- tolerated skip: `unregistered_language` or `unsupported_language`; excluded from graph, included in snapshot with content/language/capability/diagnostic.
- fatal file failure: `read_failed` or `parse_failed`; preserve path, language, parser/error diagnostics and abort before graph mutation.
- always fatal: persistence/transaction, manifest write, schema/compatibility invariant, graph validation, repository/worktree mismatch, and internal invariant errors. They remain exceptions and transaction rollback preserves the previous graph.

Ignored, generated-directory, and unrecognized/binary paths remain outside the source-candidate snapshot. This milestone will not broaden scanning to them.

## Planned manifest and compatibility changes

- Bump file snapshot schema to v3 and permit indexed and tolerated-skip entries.
- Persist an explicit outcome/capability and optional diagnostic on every detected source candidate.
- Persist a deterministic registry-capability fingerprint and compare it before reuse.
- Add `src/fs/languageDetection.ts` to configuration fingerprinting.
- Migrate v2 safely by treating it as incompatible and performing a full rebuild; do not guess missing skip state.
- Carry unchanged tolerated skips without parsing; reconsider them after content/language/capability/config changes.

## Planned full and incremental behavior

Full mode will always select `full_rebuild`, parse/evaluate every current supported candidate, independently rebuild all graph/FTS rows transactionally, and report that previous graph mutation was not used. A previous snapshot will not activate incremental failure logic.

Incremental mode will carry unchanged tolerated skips, evaluate newly added unsupported files under the same policy, drop deleted/renamed skip records, parse a file if support becomes available after capability invalidation, and remove stale graph rows through the existing complete transactional rewrite.

## Planned verification

Focused tests will cover capability drift, full/incremental unsupported-file parity, add/delete/rename/support-change behavior, v2 incompatibility and v3 skip persistence, registry invalidation, path-rich CLI and MCP diagnostics, success warnings, fatal parse/read/persistence/validation behavior, rollback, and a TCKDB-shaped fixture. A smoke helper/report will compare snapshot entries, graph/FTS hashes, representative retrieval, and basic timing/cache counters.

After local tests and typechecks, TCKDB acceptance will use its source read-only. VTRACE state will be backed up or isolated before incremental and full commands; no `.vtraceignore` or TCKDB source file will be changed or staged.
