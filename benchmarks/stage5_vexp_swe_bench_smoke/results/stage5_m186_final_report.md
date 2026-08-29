# M186 — Materialized Index Lifecycle Correctness

```text
M186 overall      PASS  (case B: current HEAD already contained the repair)

A  PASS   start-state record + current-head defect probe
B  PASS   authority model + no-op decision path traced
C  PASS   9-row state matrix, both arms, with a known-positive control
D  PASS   runtime-readiness proof on the rematerialized index
E  PASS   no-change proof on healthy semantics
F  PASS   three missing lifecycle regressions added; gates green

defect probe      DEFECT_NOT_PRESENT_ON_CURRENT_HEAD
repaired by       7b10dcd06bcf036c1b85ce475dcf23d630b93d5e  (M184)
probe validity    KNOWN_POSITIVE_CONTROL_REPRODUCES_DEFECT_AT_7b10dcd0~1
false noop        0 / 9 rows on HEAD      5 / 9 rows pre-M184
healthy noop      PRESERVED (mode noop, 0 files parsed, graph untouched)
runtime proof     REMATERIALIZED_INDEX_CONSUMABLE
no-change proof   HEALTHY_SEMANTICS_UNCHANGED
manifest honesty  SUCCESS_DOES_NOT_STRENGTHEN_REALITY

product changed   NO       tests changed  YES (3 lifecycle regressions)
retrieval changed NO       ranking changed NO       index format changed NO

live spend        $0.00    live work  NOT RUN    docker  NOT RUN
pushed            NO
```

## 1. Current-head finding

`DEFECT_NOT_PRESENT_ON_CURRENT_HEAD`. The M183 sequence was executed verbatim
against `e9c98c49`, on `fixtures/python` copied into its own git repository so the
durable registry under `.git/vtrace` is real and per-case:

```text
vtrace index .            -> full_rebuild, 20 indexed / 50 symbols / 21 edges
rm -rf .vtrace            -> registry under .git/vtrace deliberately left intact
vtrace index .            -> refresh mode: incremental
                             fallback: materialization_missing
                             symbols 50, relationships 21
                             parse cache 20 hit(s), 0 miss(es), parsed files 0
```

The no-op was refused, the graph was rebuilt from the durable parse cache, and the
result is byte-identical to the pre-deletion index.

**The probe is a validated detector, not a vacuous one.** The identical sequence
run against `7b10dcd0~1` (`142ad112`, extracted with `git archive`) reproduces the
M183 specimen exactly:

```text
                          pre-M184 (142ad112)        HEAD (e9c98c49)
exit code                 0                          0
refresh mode              noop                       incremental
reported status           indexed, coverage complete  indexed with 1 failure
manifest indexed entries  20                         20
database files/symbols    0 / 0                      20 / 50
impact-graph              unknown_symbol             ok, symbol resolved
capsule                   "Repo not indexed"         pivot delivered
```

Nothing in this milestone was inferred from historical M183 data.

## 2. Root cause and authority model

The two authorities, as traced in the current implementation:

| Domain | Owner on disk | Owner in code | Answers |
|---|---|---|---|
| Source state | `<gitCommonDir>/vtrace/repositories/<id>/snapshots` + `.vtrace/index.meta.json` | `selectReusableSnapshot`, `readIndexMeta`, `planIncrementalRefresh` | has the indexed source changed; is prior derivation reusable |
| Materialization | `.vtrace/index.sqlite` (`files`/`symbols`/`edges` + FTS) | `evaluateMaterializedGraph` (`src/indexer/materializationAuthority.ts`) | does the graph a query will read actually exist, and does it belong to this source state |

Decision path behind `vtrace index`:

```text
runIndexCommand (src/cli/commands/indexCommand.ts:46)
  -> reindexRepoAndRefreshState (src/runtime/reindexRepo.ts:89)     worktree lock, DB open
     -> computeIndexFingerprints / resolveWorktreeIdentity / readIndexMeta / scanRepo
     -> resolveDerivationRebuildReason        derivation compatibility (M146)
     -> selectReusableSnapshot                shared registry, only when no local manifest
     -> indexProject (src/indexer/indexProject.ts)
        -> planIncrementalRefresh             SOURCE equivalence only  -> mode noop|incremental|full
        -> evaluateMaterializedGraph          MATERIALIZATION validity  (indexProject.ts:179)
           mode noop && !usable -> mode incremental, fullRebuildReason "materialization_missing"
        -> noop early-return (never enters the persist transaction)  |  persist transaction
     -> recordIndexMeta / recordReusableSnapshot / ensureIndexAccessCapability
```

The pre-M184 defect was precisely the missing second predicate: `planIncrementalRefresh`
proves only that source content hashes match, and `noop` is the single mode that never
enters the persist transaction. `indexProject` did hold a guard, but it fired only on
`options.hasExistingGraph === false`, which only `src/setup/initRepo.ts` ever passed —
correct and unreachable from `vtrace index`. The current seam evaluates materialization
for every planned no-op regardless of caller, so `NOOP_ELIGIBLE = SOURCE_STATE_EQUIVALENT
&& MATERIALIZATION_READY` now holds on the CLI path.

The predicate is structural rather than a `symbolCount > 0` proxy: it asks whether every
file the snapshot calls `indexed` has a `files` row at the content hash the snapshot
records. A repository with no parsable symbols matches an empty graph and stays a
legitimate no-op — verified as row R1's empty-repository sibling in the existing suite.

## 3. Implementation

**No product repair was necessary.** Current HEAD already satisfies the invariant, and
duplicating the repair or refactoring the seam was declined per §2.

One test file changed: `src/indexer/materializationAuthority.test.ts` gains three
lifecycle-layer regressions (14 -> 17 tests) covering states the M184 suite exercised
only at predicate level, plus the reporting property the M183 specimen actually violated:

| Added test | Covers | Fails at `7b10dcd0~1`? |
|---|---|---|
| a completed index never reports more indexed files than the graph materializes | §16 manifest/status truthfulness | yes |
| a database that cannot answer for the graph is not a no-op | matrix row R5a (foreign schema) | yes |
| a graph materialized from different content than the snapshot records is not a no-op | matrix row R7 (wrong source state) | yes |

All three are known-positive detectors, confirmed by running them against the extracted
pre-M184 tree. That run also independently reproduces M184's own claim: 5 of its
lifecycle tests fail there, and the two legitimate-no-op controls pass.

## 4. State matrix

Nine rows, each in a freshly indexed isolated repository, both arms.
Machine-readable: `stage5_m186_lifecycle_matrix.json`.

| Row | Source | Materialization | Required | HEAD result | Pre-M184 | Verdict |
|---|---|---|---|---|---|---|
| R1 | unchanged | valid + compatible | no-op | `noop`, graph untouched, usable | `noop` (correct) | PASS |
| R2 | unchanged | `.vtrace` removed | rebuild | `incremental` / `materialization_missing`, usable | `noop`, 0/0/0, **BROKEN** | PASS |
| R3 | unchanged | `index.sqlite` removed, manifest intact | rebuild | `incremental` / `materialization_missing`, usable | `noop`, 0/0/0, **BROKEN** | PASS |
| R4 | changed | valid old graph | normal indexing | `full_rebuild` / `closure_uncertain`, 51 symbols | same (correct) | PASS |
| R5a | unchanged | foreign-schema database | no false no-op | `incremental` / `materialization_missing`, usable | `noop`, 0/0/0, **BROKEN** | PASS |
| R5b | unchanged | partial graph, rows dropped | no false no-op | `incremental` / `materialization_missing`, usable | `noop`, 2/0/21, **BROKEN** | PASS |
| R6 | unchanged | incompatible indexer fingerprint | rebuild, never false no-op | `full_rebuild` / `derivation_incompatible` | same (correct) | PASS |
| R7 | unchanged | graph attached to wrong source state | reject / rematerialize | `incremental` / `materialization_missing`, hashes restored | `noop`, stale graph accepted | PASS |
| R8 | fresh repo | none | initial index | `full_rebuild` / `snapshot_missing` | same (correct) | PASS |

`0/9` false-healthy no-ops on HEAD; `5/9` pre-M184. Every HEAD row ends runtime-usable.
R4 plans `full_rebuild` rather than `incremental` because appending a symbol makes the
affected closure uncertain — pre-existing planner behaviour, identical in both arms, and
outside this milestone's scope.

The one matrix state not exercised is a genuinely corrupt database file (torn bytes
rather than a foreign schema): M184 recorded that as failing loudly with a non-zero exit
and a truthful message, which is a valid architecture outcome and not a false no-op.

## 5. Runtime-readiness proof

Readiness is proven by consumption, not by the directory reappearing. After the
`rm -rf .vtrace` recovery, four canonical surfaces were re-executed against the rebuilt
index (`stage5_m186_index_equivalence.json`):

```text
impact-graph core_symbols.py::my_function --depth 2   ok: symbol resolved, structural coverage
capsule "my_function returns a greeting"              intent debug, pivot delivered with source
skeleton core_symbols.py                              status ok, declarations enumerated
run-pipeline "my_function greeting"                   capsuleMode micro, pivot P1 with body
status --json                                         identical to the pre-deletion capture
```

The same four surfaces against the pre-M184 broken index return `unknown_symbol` and
`Repo not indexed` — the failure mode the recovery has to prevent.

## 6. No-change proof

Healthy semantics before deletion vs after rematerialization, volatile fields excluded:

```text
files table (path + content_hash, 20 rows)      IDENTICAL
symbols table (fq_name, kind, line span, 50)    IDENTICAL
edge count (21) and full table set              IDENTICAL
.vtrace/index.meta.json fingerprints/manifest   IDENTICAL
impact / skeleton / status payloads             SEMANTICALLY IDENTICAL
capsule / run-pipeline payloads                 one field moved (below)
```

The single non-volatile difference is `productContext.repository.indexMode`,
`full_rebuild` -> `incremental`: truthful provenance describing how the graph was last
materialized, which the recovery is designed to change (§10 recovers rather than forcing
a full rebuild). No retrieval candidate, ranking position, pivot, support item, selection
reason, graph result or orientation field moved. `responseBudget.serializedCharacters`
differs by one character in the impact payload, which is the serialized width of
`latencyMs`; `estimatedOutputTokens` is identical at 1447.

## 7. Performance

```text
healthy no-op, steady state    HEAD 162 / 168 ms      pre-M184 159 / 167 / 169 ms
recovery after rm -rf .vtrace  189 ms  (20 parse-cache hits, 0 reparses, 0 files parsed)
cold full rebuild, same repo   1134 ms (0 hits, 21 misses, 21 files parsed)
```

The healthy path is indistinguishable between arms, so the invariant is not being bought
by discarding no-op behaviour. Recovery costs a re-materialization (~6x cheaper than a
cold rebuild here) rather than a reparse, because the persist transaction rewrites the
graph wholesale for both non-no-op modes while the durable parse cache serves the files.

## 8. Verification gates

```text
bun run typecheck              PASS (exit 0)
bun run typecheck:benchmarks   PASS (exit 0)
bun test                       PASS  5595 pass / 49 skip / 0 fail, 357 files, 283s
git diff --check               clean
bun test src/indexer/materializationAuthority.test.ts   17 pass / 0 fail
```

No gate was skipped and no failure was inherited.

## 9. Remaining issues

- **Manifest scope.** The invariant proven here is that success cannot claim indexed
  files the graph does not hold on the `vtrace index` lifecycle path. The `edge_call_sites`
  orphan state M184 recorded remains unrepaired; it fails loudly with a non-zero exit
  rather than producing false success, so it does not weaken this invariant.
- **No live work is licensed by this milestone.** `NO_FURTHER_AGENT_UTILITY_PRODUCT_WORK_LICENSED`
  from M185 stands, and a lifecycle repair is not grounds to rerun M183.
