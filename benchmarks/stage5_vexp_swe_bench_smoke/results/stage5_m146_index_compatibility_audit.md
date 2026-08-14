# M146-A — Index compatibility audit

Predecessor (M145 final functional): `88de1061c23dfbb7da112861278eec730a5e848d`
M145 evidence commit: `ae5d4fec51d1ca00636e2b6d01c830d772fae716`
Branch `main`, 43 ahead of `origin/main`, nothing pushed.

## 1. The compatibility model as found

Readiness (`src/indexer/indexReadiness.ts`, M141) already decomposed usability
into five independent dimensions and evaluated all of them without
short-circuiting:

```
ready = sourceFresh
      AND schemaCompatible
      AND capabilityCompatible
      AND repositoryCompatible
      AND worktreeCompatible
```

Compatibility itself is carried by five fingerprints written into
`.vtrace/index.meta.json` and recomputed per request by
`computeIndexFingerprints` (`src/indexer/indexMeta.ts`):

| Fingerprint | Protects | Built from |
| --- | --- | --- |
| `index_format_version` | shape of `index.meta.json` | literal constant (5) |
| `schema_version` | stored table shape | `INIT_STATE_SCHEMA_VERSION` + hash of `src/db/schema.ts` |
| `parser_fingerprint` | what parsing produces | content hash of `src/parsers` |
| `indexer_fingerprint` | how the index is produced | content hash of `src/indexer` + `src/db` |
| `config_hash` | which files are in scope | 6 named `src/fs` / `src/documents` files |

The intent was already correct, and is worth stating because M146-A did not
change it: query-time surfaces (`src/capsule*`, `src/capsuleV2`, `src/mcp`,
`src/retrieval`) are *deliberately* excluded so that a ranking change does not
invalidate a valid index. The invalidation contract is semantic, not
"the VTRACE SHA moved" — `vtrace_commit` is recorded but explicitly not a
freshness field.

## 2. What the audit actually found

Coverage was defined by hand-listed directories, but the real boundary is the
**import closure of the index write path**. Two derivation-relevant modules had
drifted across that boundary.

Method: walk every import from `indexProject.ts` and `indexMeta.ts`, resolve it,
and diff the closure against the fingerprinted file set. Following *all* imports
gives 66 files, 29 of them unfingerprinted — but most of that is type-only noise
(`src/memory/types` → `src/capsule/types` → `buildCapsuleImpl` → `projectRules`).
Restricting to **value** imports, which are the only ones that can change
behaviour, gives 43 files and 6 unfingerprinted.

### Gap 1 — stored FTS text derived by query-time code (severe)

`buildFtsSearchText` lived in `src/retrieval/searchSymbolsShared.ts` — a
directory excluded from every fingerprint *by design* — and was called by
`replaceSymbolSearchIndexForFile` to build the stored `symbol_search_fts` rows.

Measured directly, not argued:

| | runtime A | runtime B (tokenizer changed) |
| --- | --- | --- |
| `indexer_fingerprint` | `f2599592d328ec68` | `f2599592d328ec68` |
| `parser_fingerprint` | `e633009f0a91e53a` | `e633009f0a91e53a` |
| `config_hash` | `4b003f2216cc9f0a` | `4b003f2216cc9f0a` |
| readiness | `ready` | **`ready`** |
| stored `local_name` | `body json jsonbody parse parsejson parsejsonbody` | `body json parse parsejsonbody` |

Every fingerprint byte-identical, `ready: true`, and a genuinely different
derivation. This is §11's danger case reached in practice.

### Gap 2 — stored identity derivation (severe)

`src/domain/types.ts` exports `normalizeFilePath`, `buildFQName`,
`computeFileId`, `computeSymbolId` and the `Language` / `SymbolKind` / `EdgeType`
enums persisted as symbol and edge rows. It is imported by value throughout the
write path and was hashed by nothing. `src/domain/guards.ts` sits behind it:
`isLanguage` decides whether a file is parsed at all.

### Gap 3 — the remediation path did not remediate (severe)

Found by following the fix through to the user's next action. `reindexRepo`
decided whether the previous snapshot could be reused from a separate,
hand-maintained ladder that compared `parser_fingerprint`, `config_hash` and
`index_format_version` — **but not `indexer_fingerprint` or `schema_version`**.

So for exactly the class of change Gap 1 and Gap 2 route through:

1. readiness correctly refuses the index (`ready: false`);
2. the user runs the recommended rebuild;
3. the planner sees a "compatible" snapshot, selects a no-op, and regenerates
   nothing;
4. the run stamps the **new** fingerprints onto the **old** content;
5. readiness now reports `ready: true` — permanently, and wrongly.

Measured before the fix: after remediation, FTS still contained `jsonbody`,
`computetotal` and `requestparser`, terms the running tokenizer cannot produce.
A correctly-refused index was converted into a silently-accepted stale one.

## 3. Non-gaps, with reasons

Six modules are reached by value and remain unfingerprinted. Each is exempt for
a stated reason and each is pinned by a behavioural control that mutates the real
file and asserts both the fingerprints and the persisted index output are
unchanged (`indexerFingerprintCoverage.test.ts`).

| Module | Why it cannot affect regenerated state |
| --- | --- |
| `src/cli/progress.ts` | Progress events are pushed, never read back. |
| `src/memory/computeFileDiff.ts` | Read-time: `listFileDiffsForRun` computes from persisted run states on demand. |
| `src/memory/computeSymbolDiff.ts` | Read-time, same shape. |
| `src/memory/types.ts` | Reached only through those read-time helpers. |
| `src/setup/types.ts` | Constants, not logic. `INIT_STATE_SCHEMA_VERSION` is embedded *by value* in `schema_version`, so bumping it already invalidates. |

`src/graph` is not in the closure at all: it holds `frontierTraversal.ts` and a
fixture, both query-time. Index-time graph construction lives in `src/indexer`
and `src/parsers`, so the M140 archetype was already covered.

## 4. What changed

1. `collectSearchTerms` / `buildFtsSearchText` moved to
   `src/indexer/searchTextDerivation.ts`. Both the write path and the query path
   import the one definition, so they cannot disagree, and the tokenizer is now
   inside a fingerprinted directory. `searchSymbolsShared` re-exports it so no
   call site moved — and is now provably query-only, which makes it the sharpest
   available control for the no-unnecessary-rebuild fixture.
2. `src/domain/types.ts`, `src/domain/guards.ts`, `src/fs/hashFile.ts` and
   `src/fs/git.ts` added to the indexer fingerprint inputs.
3. `resolveDerivationRebuildReason` in `indexMeta.ts` became the single authority
   for "may a refresh reuse stored content?", comparing every derivation-relevant
   fingerprint. `reindexRepo` now calls it instead of its own ladder.
4. Readiness reason split: `schema_changed` (representation moved) vs
   `derivation_changed` (contents produced under obsolete semantics), with
   `index_derivation_incompatible` surfaced by `index_status`.

Deliberately unchanged: `schemaCompatible`, `sourceFresh`,
`capabilityCompatible`, `repositoryCompatible`, `worktreeCompatible`, `ready`
and every readiness state keep their M141 meanings. Only the reason is finer.

## 5. Anti-drift guard

The audit above is a snapshot; the guard is what makes it durable.
`indexerFingerprintCoverage.test.ts` walks the value-import closure of the write
path on every run and fails when it reaches source that no fingerprint hashes and
no rationale exempts. Type-only imports are ignored — following them would drag
in the capsule/skeleton/projectRules graph and make ranking edits rebuild the
world, which is the opposite failure.

Verified fail-closed: restoring the original defect (importing
`buildFtsSearchText` from `src/retrieval` again) fails the guard with

```
+ "src/retrieval/searchSymbolsShared.ts (reached from src/db/repositories/symbolSearchFtsRepository.ts)"
```

naming both the file and the path that reached it.

## 6. Known imprecision (recorded, not fixed)

`config_hash` covers both scope rules (`scanRepo`, `ignoreRules`,
`languageDetection`, `worktreeExclusions`) and document *construction*
(`documentChunks`, `documentPolicy`). Readiness therefore reports a
document-chunking change as `source_stale / incremental_refresh` rather than
`derivation_changed / full_rebuild`. It fails closed and the reindex path treats
it as `configuration_incompatible` → full rebuild, so the remediation is correct;
only the label is coarse. Splitting construction out of scope would make the
reason exact and is the cheapest available follow-up.

Invalidation granularity remains coarse by design: any index-affecting change
triggers a full rebuild. Per §28/§30 that is the accepted starting point —
correctness first, granularity as later optimization.

## 7. Verdict

**M146-A: PASS.**

Three severe defects were found and closed; the compatibility contract now fails
closed on every index-producing semantic layer reachable from the write path,
query-only changes provably reuse indexes, remediation genuinely regenerates, the
reported cause distinguishes remediation, and the MCP reconnect workflow is
proven in a real subprocess in both directions.
