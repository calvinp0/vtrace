# Stage 5 M118 Incremental Worktree Indexing Plan

## Scope and decision

M118 will separate a repository-scoped, immutable parse cache from each
worktree's `.vtrace/index.sqlite`, manifest, state, and retrieval indexes. The
current parsers combine syntax extraction with repository-aware resolution, so
their complete `ParseResult` is path- and neighbor-sensitive. The safe first
implementation will cache only complete results under a key that includes the
normalized repository-relative path and a dependency-context fingerprint, and
will use prior-snapshot equality plus conservative invalidation to decide when
reuse is provable. When that proof is unavailable, the planner will perform a
full graph rebuild (which may still use compatible cache entries only when the
dependency context matches). Correctness and normalized full-build equivalence
are the release gates.

Graph snapshot cloning between worktrees is deferred: current SQLite records
contain path-bound file IDs, symbol IDs, FQ names, and mutable run history. New
worktrees receive a distinct database and manifest and reuse only immutable
cache entries.

## Existing indexing pipeline

1. `src/fs/scanRepo.ts::scanRepo` recursively discovers indexable files,
   applies nested ignore rules, detects language, stats every file, and hashes
   every file's current bytes.
2. `src/indexer/indexProject.ts::indexProject` reads every discovered file as
   UTF-8 and constructs a registry whose TypeScript, Python, and Cython parsers
   receive the complete `(path, content)` set as `knownFiles`.
3. `parseFile` invokes the registered parser for every readable file.
4. Each parser performs syntax parsing and symbol extraction. TypeScript uses
   tree-sitter; Python invokes an AST helper process; Cython invokes its Python
   tokenizer helper.
5. Each parser emits file-local `contains` edges and repository-aware
   `imports`, `calls`, and `references` edges. Import/module resolution is thus
   currently part of parsing, not a later independent linker.
6. `persistParseResult` transactionally replaces one file, its symbols, FTS
   symbol records, body literals, and file-local edges. `indexProject` strips
   cross-file edge types before this per-file persistence.
7. `pruneRemovedFiles` deletes disappeared files and explicitly removes the two
   FTS surfaces; SQLite cascades symbols and graph edges.
8. `persistResolvableInterFileEdges` filters the deferred edges to targets in
   the successfully persisted symbol set and inserts them in a transaction.
9. `recordIndexRunState` snapshots all current files and symbols into run
   history in a transaction.

Filesystem discovery, reading, parsing, persistence/FTS construction, and run
snapshot construction currently process every file. Cross-file resolution also
occurs for every parsed file. Retrieval-index construction is the per-file
`symbol_search_fts` and `symbol_body_literals_fts` replacement; there is no
separate vector index.

The dominant expected cost is parsing, especially Python/Cython because each
file spawns an interpreter, followed by repeated target export parsing during
cross-file resolution. A direct current-repository timing attempt did not
produce a usable completed sample, so M118 will add phase diagnostics and use
the required no-agent synthetic/VTRACE benchmarks before selecting a policy.
No speed claim or threshold will be made from architectural expectation alone.

### Parser determinism and sensitivity

- File bytes alone determine the syntax tree/token stream, diagnostics,
  signatures, line/byte spans, docstrings, decorators, and unlocalized symbol
  shapes.
- The current public `ParseResult` is not byte-only. It depends on the
  normalized repository-relative path because `FileRecord.id`, every FQ name,
  every symbol ID, parent IDs, and edge IDs contain or derive from the path.
- TypeScript language selection is also extension/path-sensitive (`.tsx`).
- Python/Cython module identity depends on the complete known path set,
  package-chain `__init__.py` membership, and repository layout.
- Imports, re-exports, calls, and references depend on neighboring file paths,
  target bytes/exports, and parser configuration/interpreter behavior.
- Parser results do not embed worktree-root absolute paths, but they do embed
  repository-relative paths and path-derived stable IDs.
- Package root and module names are computed while constructing parser context
  and resolving each file, not in a distinct post-parse linker.

Therefore a rename cannot reuse a complete cached result under its old key.
M118 will include relative path and dependency-context identity in the cache
key. A future split into byte-only IR plus path/module binding would permit more
rename reuse, but is not required for a correctness-first M118.

## Existing storage

After M114, each worktree owns `.vtrace/index.sqlite`, `.vtrace/index.meta.json`,
`.vtrace/config.json`, and `.vtrace/state.json`. `resolveWorktreeIdentity`
identifies a repository by the canonical Git common directory and a worktree by
that common directory plus canonical worktree root. A repository cache can be
placed beneath the canonical common directory without sharing mutable worktree
graph state. Non-Git repositories will use their repository identity plus a
local repository-scoped cache location.

SQLite storage is:

- source files: `files`, historical `file_run_states`;
- symbols/exports: `symbols` (`exported`), historical `symbol_run_states`;
- imports/calls/references/contains: `edges` with `edge_type`;
- retrieval: `symbol_search_fts`, `symbol_body_literals_fts`;
- run/capsule history: `index_runs`, `capsule_manifests`, and related tables.

There are no persisted import descriptors, export declarations distinct from
symbols, unresolved-import rows, or unresolved-reference rows. Unresolved
relationships are represented by omission. This is the most important closure
limitation: an added file can make an old omitted relationship resolvable, but
the current database cannot query that old unresolved descriptor.

Records originating from a file are deterministically removable by normalized
path/file ID. `edges` has indexes on both symbol endpoints, and foreign-key
cascades remove edges targeting deleted symbols. Both FTS tables require
explicit path-based deletion. Per-file writes, removed-file pruning,
cross-file-edge insertion, and run-snapshot insertion use transactions, but the
whole index operation is not one transaction; a mid-run failure can leave a
mixed graph today. M114 supplies an atomic directory lock keyed per worktree;
different worktrees use distinct locks.

## Existing refresh behavior

`reindexRepoAndRefreshState` and `initRepo` both invoke the same full
`indexProject` pipeline. Consequently `head_mismatch`,
`working_tree_changed`, and `configuration_changed` all lead to a full scan,
read, parse, persist, relink, and retrieval rebuild when refresh is requested.
`missing_index` initializes and fully indexes. `manifest_invalid` is considered
rebuildable by explicit/opt-in refresh. Repository/worktree mismatch remains
blocked. There is no incremental indexing implementation.

The v2 M114 manifest records repository/worktree identity, HEAD, branch,
detached/dirty state, dirty fingerprint, run ID, parser fingerprint, index
schema version, and configuration fingerprint. It does not contain per-file
identity or a snapshot hash. Historical `file_run_states` can reconstruct file
records for successful runs but not parser configuration/cache identity,
parse failures, unresolved descriptors, exports separate from symbols, or a
complete graph snapshot. A safe incremental base therefore cannot be inferred
from a legacy manifest and must be created by one full rebuild.

## Safety audit

- Renames appear from Git status when detectable, but the scanner/pipeline
  otherwise sees old-path deletion plus new-path addition. Deleted files are
  pruned after replacement persistence.
- Python package `__init__.py` membership changes canonical module naming and
  exact re-export traversal; package changes are repository-context changes.
- Unresolved imports/references are omitted. Addition of a matching module can
  change old parser results with no persisted reverse lookup.
- A symbol rename changes its path/FQ/span-derived ID; incoming edges must be
  recomputed or removed by cascade.
- Parser/schema/indexer fingerprint changes already invalidate the index.
  Parser and schema incompatibility will force a full rebuild and use a distinct
  cache namespace. Scan/ignore configuration changes also force full rebuild.
- Package roots, path include/exclude behavior, language detection, parser
  fingerprint/version, and graph/retrieval schema changes require full rebuild.
- The normalized equivalence helper will compare sorted file records, symbols,
  edges, both FTS-derived retrieval surfaces, and deterministic retrieval/capsule
  projections while excluding timestamps, run IDs, row IDs that are not semantic,
  temporary absolute paths, and timings. It will produce a SHA-256 graph hash.

Until unresolved descriptors exist, additions/deletions/renames and package
surface changes will conservatively broaden to a full relink/rebuild where
needed. M118 will never retain stale cross-file edges merely to report an
incremental mode.

## M118 architecture

### Shared immutable cache

For Git repositories the cache root will be repository-scoped under the
canonical common Git directory, namespaced by repository ID, parser ID/version,
and cache key. Entries will contain a schema-versioned metadata envelope and a
serialized parse result. Creation uses a same-directory temporary file followed
by atomic rename; existing valid entries win races. Readers validate schema,
key, metadata, payload hash, path/language, and file content identity. Partial
or corrupt entries are ignored and regenerated. Ordinary indexing never deletes
entries; reachability/age-based pruning is deferred.

The key includes:

- SHA-256 file content identity (`git_blob` when safely known, otherwise
  `working_tree_hash`);
- parser ID and parser fingerprint/version;
- parser configuration fingerprint;
- language;
- normalized repository-relative path;
- a deterministic dependency-context fingerprint for the known indexable file
  set and the target contents that can influence resolution.

Including dependency context is conservative and reduces reuse after changes,
but makes complete current `ParseResult` reuse safe. The implementation may
later narrow that context to explicit file-local dependency descriptors only
after those descriptors are persisted and tested.

### Per-file snapshot

Manifest format will be bumped and will record sorted per-file snapshots with
relative path, language, content hash, optional Git blob SHA/content kind,
parser ID/version/config fingerprint, parse-cache key, byte size, and optional
mode. Aggregate metadata records HEAD, dirty fingerprint, file count, snapshot
hash, graph schema, and retrieval schema. Snapshot validation recomputes the
hash over canonical sorted fields.

### Planner and modes

The deterministic planner compares the stored snapshot with current scanner
output and classifies added, modified, deleted, and detectable same-content
renames. It returns `noop`, `incremental`, or `full_rebuild`, sorted file lists,
cache hit/miss predictions, initial invalidation, affected closure, and a precise
fallback reason before mutation.

- `noop`: compatible schema/config/parser, identical aggregate/per-file
  snapshot; parse zero files and perform zero graph writes.
- `incremental`: only when every reused result's complete cache key still
  matches and the affected closure can be proven from current persisted graph
  plus change classification.
- `full_rebuild`: legacy/missing/invalid snapshot, parser/schema/config or
  repository mismatch, uncertain closure, validation failure, or measured cost
  estimate at least full cost.

The initial cost model will use measured per-language parse costs and estimated
files requiring parse/relink. No fixed percentage is selected before the
benchmark. If samples are too noisy, the safe policy remains `estimated
incremental work >= estimated full work => full rebuild` with documented input
counts.

### Mutation, invalidation, and rollback

Worktree locking remains outside planning/mutation. Mutating refreshes will be
built in an isolated temporary SQLite database and atomically replace the live
database only after graph validation, so the previous valid graph survives
parse, persistence, or validation failure. The manifest/state will be written
only after database replacement succeeds. Full rebuild and conservative full
relink are acceptable fallbacks; direct mutation of another worktree's database
is forbidden.

Changed paths remove old FTS rows, body literals, files/symbols, outgoing edges,
and incoming edges through explicit deletion/cascades. Closure begins with
changed paths and existing cross-file neighbors. Package initializers,
add/delete/rename, changed exports, and omitted unresolved relationships broaden
the closure or force full relink. A failed validation reports
`graph_validation_failed` and retries a clean full rebuild where safe.

Validation checks snapshot/file parity, no deleted-file records, edge endpoint
existence, unique symbol IDs, FTS references, snapshot hash, and repository/
worktree identity.

## Current-state discovery

The authoritative current snapshot remains the actual scanner output, so it
includes staged and unstaged content, tracked deletions, and indexable untracked
files. Git status/tree/blob information may annotate content kind and detect
renames but does not replace hashing current worktree bytes. Existing ignore
rules exclude `.git`, `.vtrace`, generated/cache/vendor directories, ignored
paths, and unsupported languages.

## Worktree reuse

Candidate snapshots must have the same repository ID and compatible graph,
retrieval, parser, and configuration versions. Candidate preference is exact
commit, then compatible nearest/maximum shared cache keys; branch name is never
an identity. Because cache entries are repository-scoped, exact-commit linked
worktrees should hit every compatible file entry despite having a separate graph.
Nearby and detached worktrees reuse only entries whose complete keys match.
The source worktree's SQLite database and manifest are read-only and verified
unchanged by tests.

## Instrumentation and performance evaluation

`IndexPerformanceDiagnostics` will expose mode/base snapshot, change counts,
cache hits/misses, parsed/reused counts, invalidation/closure counts, optional
row counts, fallback reason, and discovery/planning/parsing/invalidation/linking/
persistence/retrieval/validation/total timings. `index_repo`, CLI indexing,
status, and `get_code_context(auto_refresh="if_stale")` will retain old fields
and add these diagnostics.

The no-agent benchmark will exercise 0%, one-file, 1%, 5%, 10%, 20%, 30%, and
50% changes in TypeScript/mixed and Python-heavy synthetic repositories, plus
VTRACE when safe. It will report repository/scenario-specific timings, parsed
files, hit rate, closure, normalized graph/retrieval equivalence, and optionally
peak memory. The measured crossover will parameterize or justify the cost model.

## Required test matrix

Focused tests will cover key stability/invalidation/path sensitivity, atomic
creation/corruption/races; deterministic planner classifications and fallbacks;
stale graph deletion; package/re-export/add/delete/rename behavior; no-op;
dirty/untracked/ignored content; linked/detached/concurrent worktrees; legacy
rebuild; isolated rollback on parse/persistence/validation failures; and
normalized graph plus retrieval/capsule equality against clean full rebuilds.

Where the current omitted-unresolved representation prevents a bounded closure,
the expected result will be a precise full fallback with equivalent graph, not
an unsafe selective update.

## Deferred work

- byte-only parse IR plus path/module localization;
- persisted unresolved descriptor indexes enabling narrower added-file closure;
- graph snapshot seeding/copy-on-write;
- parse-cache reachability/age pruning;
- background watcher;
- remote cache service;
- exhaustive sparse-checkout/submodule optimization.

## Pre-change verdict

The existing implementation is correct-by-full-rebuild but reparses every file
and has no immutable shared cache or per-file manifest. M118 can safely deliver
repository-scoped parse reuse, true no-op refresh, isolated worktree graphs,
transactional replacement, diagnostics, and selective reuse only when complete
dependency context proves equivalence. Broader graph incrementality must remain
conservative until unresolved/path-independent IR is represented explicitly.
