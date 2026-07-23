# M128 Document Index Design

## Decision

Design A: a shared file-document lane. YAML and TOML files are discovered by the normal scanner, persisted as file records plus bounded document chunks, and searched by a dedicated FTS5 table. The authoritative hybrid capsule merges relevant document support into its existing selection; routed diagnostics observe the same result. There is no second capsule.

## Representation

`document_chunks` stores file identity, kind, content hash, document-index version, 1-based inclusive line span, optional safe key/table path, bounded text, and truncation. `document_search_fts` indexes kind, key path, text, and tokenized repository-relative path. No document row is a symbol and document files create no calls, imports, references, inheritance, or flow edges.

Bounds are deterministic: 256 KiB/file, 32 chunks/file, and 4,096 characters/chunk. YAML top-level keys and TOML tables form logical boundaries; oversized logical sections split by complete lines. Retrieval returns at most 48 FTS rows, four candidate files, two excerpts/file, and two selected config documents in the standard capsule.

## Safety

Existing ignore rules and ignored output/vendor directories remain authoritative. Secret/credential/key paths, `.env*`, lockfiles, binary/NUL content, and over-limit documents produce no document rows. Invalid YAML/TOML remains bounded lexical text; no tag, template, include, or code is executed.

## Schema and freshness

Index format is v5, file snapshot schema is v4, and retrieval schema is v2. Snapshot entries for YAML/TOML retain `documentKind` and `documentIndexVersion`. Index fingerprints include document policy/chunking/persistence sources but exclude query-time document ranking, so a ranking-only change does not invalidate an otherwise truthful index. Older indexes rebuild explicitly.

Full and incremental paths use the same chunker and transaction. Modified/new documents replace their rows; deletes and renames remove old file-owned rows through the normal full-safe graph mutation. Unchanged/no-op indexes retain existing rows. The smoke compares the final incremental document rows, FTS-derived retrieval, source graph, and snapshot with a clean full index.

## Rendering and truth boundary

Selected YAML/TOML uses `document_excerpt`, carries exact line spans and document kind, and is labelled configuration/lexical evidence in ProductContext. Excerpts include matched logical sections, not arbitrary first-N lines. One path owns one rendered body.

## Deferred formats

Markdown remains on the existing late, bounded documentation-section path; it is not duplicated into M128 document FTS. JSON is deferred pending a narrow manifest allowlist because repositories contain many generated dumps. `.ipynb` is deferred; parser-indexed Python notebook verification tests provide the required policy evidence.

## Rejected alternatives

Design B was rejected because embedding config persistence/query mechanics directly into the symbol hybrid core would couple documents to graph types. Design C was rejected because a directly requested workflow or `pyproject.toml` is authoritative evidence, not merely a rescue after code retrieval fails.
