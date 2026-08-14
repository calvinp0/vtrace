# M146-A — Runtime ↔ index derivation compatibility: final report

**Verdict: M146-A PASS. M146-B NOT STARTED, so M146 overall is INCOMPLETE.**

| | |
| --- | --- |
| M145 predecessor (final functional) | `88de1061c23dfbb7da112861278eec730a5e848d` |
| M145 evidence commit | `ae5d4fec51d1ca00636e2b6d01c830d772fae716` |
| M146-A functional commits | `1302a2a`, `00b47bd`, `a3040e1` |
| M146-A evidence commit | the commit that adds this file (a SHA here cannot name itself) |
| Branch | `main`, 47 ahead of `origin/main`, nothing pushed |
| Tests | 4334 pass / 49 skip / **0 fail** (4383 across 266 files) |
| Typechecks | `typecheck` and `typecheck:benchmarks` clean |
| `git diff --check` | clean |

## What M146-A was asked to prove

That every VTRACE change altering index-derived semantics reliably invalidates
old derived state, and that changes which do not alter those semantics avoid
unnecessary rebuilds. Three defects stood in the way, all found by measurement
rather than reading.

## Defect 1 — stored FTS text derived by query-time code

`buildFtsSearchText` lived in `src/retrieval/searchSymbolsShared.ts`, a directory
excluded from every fingerprint *by design*, and produced the stored
`symbol_search_fts` rows.

| | runtime A | runtime B (tokenizer changed) |
| --- | --- | --- |
| all five fingerprints | — | **byte-identical** |
| readiness | `ready` | **`ready`** |
| stored `local_name` | `body json jsonbody parse parsejson parsejsonbody` | `body json parse parsejsonbody` |

A stale semantic derivation served as current. Fixed by moving the tokenizer to
`src/indexer/searchTextDerivation.ts`, where the indexer fingerprint covers it,
with both write and query paths importing the one definition.

## Defect 2 — stored identity derivation unhashed

`src/domain/types.ts` (`normalizeFilePath`, `buildFQName`, `computeFileId`,
`computeSymbolId`, and the enums persisted as symbol/edge rows) and
`src/domain/guards.ts` (`isLanguage`, which decides whether a file is parsed at
all) were reached by value from the write path and hashed by nothing. Added to
the indexer fingerprint, together with `src/fs/hashFile.ts` and `src/fs/git.ts`.

## Defect 3 — the recommended rebuild did not rebuild

The most serious, and only visible by following the fix through to the user's
next action. `reindexRepo` decided snapshot reuse from a separate ladder that
compared `parser_fingerprint`, `config_hash` and `index_format_version` — never
`indexer_fingerprint` or `schema_version`. So readiness refused the index, the
user ran the recommended rebuild, the planner reused everything, and the run
stamped the **new** fingerprints onto the **old** content. Measured: after
remediation the FTS still contained `jsonbody` and `computetotal`.

`resolveDerivationRebuildReason` is now the single authority for both questions.
After the fix the same sequence regenerates the derivation and `ready` is true
because it is true.

## Measured results

All verdicts below are from mutating real source and asking a fresh process.

| Fixture | Artifact | Verdict |
| --- | --- | --- |
| 1. query-only change reuses index (5 files) | `query_only_reuse.json` | PASS — 0 fingerprints moved, ready |
| 2. parser semantics (3 parsers) | `parser_invalidation.json` | PASS |
| 3. graph resolution / module ownership | `graph_invalidation.json` | PASS |
| 4. document chunking | `document_invalidation.json` | PASS |
| 5. persisted schema | `schema_invalidation.json` | PASS — reported as `schema_changed` |
| 6. source edit only | `source_only_incremental.json` | PASS — `sourceFresh=false`, `schemaCompatible=true`, `incremental_refresh` |
| 7. repository replaced at same path | acceptance suite | PASS — identity failure, not masked |
| 8. unchanged runtime and source | acceptance suite | PASS — ready, no rebuild |
| reconnect, index-affecting change | `mcp_reconnect_compatibility.json` | PASS — refused, then genuinely rebuilt |
| reconnect, query-only change | `mcp_reconnect_compatibility.json` | PASS — stays ready, no rebuild |
| reason truthfulness | `readiness_reason_truth.json` | PASS — `derivation_changed` vs `schema_changed` |

Coverage: the value-import closure of the write path is 43 files; 5 are
unfingerprinted and each carries a rationale plus a behavioural control proving
a change to it moves neither the fingerprints nor the persisted index.
**0 unclassified.** The guard is verified fail-closed — reintroducing the
original defect fails it, naming the file and the path that reached it.

Following *all* imports instead of value imports gives 66 files and 29
unfingerprinted; the difference is entirely type-only chains into
capsule/skeleton/projectRules. Hashing those would make every ranking edit
rebuild the world, which is the failure §12 warns about.

## Preservation

Readiness keeps its M141 contract: `sourceFresh`, `schemaCompatible`,
`capabilityCompatible`, `repositoryCompatible`, `worktreeCompatible`, `ready`,
every state, and every recommended action are unchanged for every input. The
pre-M141 legacy freshness reason (`index_schema_changed`) is byte-identical.
Only the reason string is finer, and only where it was previously untrue.

Three M141 tests changed, all in the same direction: they mutated
`parser_fingerprint` while asserting `schema_changed`, and their own comments
already described the cause as an indexer/parser move.

M145 identity behaviour is unchanged and re-asserted by fixture 7.

## Known limitations

1. `config_hash` covers both scope rules and document *construction*, so a
   document-chunking change is reported as `source_stale / incremental_refresh`
   rather than `derivation_changed / full_rebuild`. It fails closed and
   `reindexRepo` treats it as `configuration_incompatible` → full rebuild, so
   remediation is correct; only the label is coarse. Cheapest follow-up.
2. Invalidation is all-or-nothing: any index-affecting change forces a full
   rebuild. Per §28/§30 this is the accepted starting point. Partial
   invalidation was not attempted — the dependency boundaries needed to prove
   full/partial equivalence do not exist yet, and inventing them before
   measuring real waste would be optimisation ahead of evidence.
3. This milestone edits `src/indexer`, so `indexer_fingerprint` moves and every
   pre-M146 index rebuilds once. Same accepted cost M145 recorded.

## Why M146-B was not started

§138 makes A a hard gate and A now passes, so B is permitted. It was not begun
because B is a full milestone in its own right — repository relevance evidence
audit, probe contract, routing, bounded aggregation, shared budget, collision
safety, ~18 targeted controls, a new workspace benchmark corpus, ARC+TCKDB
acceptances, and preservation across M132–M145 plus Frozen50 / Django /
cross_repo_30. Starting it here would have produced exactly the unmeasured
before/after artifacts §32 forbids.

The frozen-50 preservation run was likewise not executed: no retrieval,
ranking, or selection code was touched, and retrieval takes `(db, repoRoot)`
with no compatibility input, so movement is structurally impossible rather than
merely unobserved — but that is an argument, and M146-B must still run the
paired comparison before claiming the numbers.

## Recommended M146-B entry point

Unchanged from M145's recommendation, now with A's contract underneath it:
measure how far **explicit** evidence alone disambiguates a real multi-repo
workspace before adding any semantic signal. M145 already resolves 25/25 unique
paths through `repositoryPathMembership`. Add §89's constraint from this
milestone: a repository whose index is derivation-incompatible must not
contribute deep symbol/FTS probe evidence to routing, because that evidence was
produced under semantics the runtime has already refused.
