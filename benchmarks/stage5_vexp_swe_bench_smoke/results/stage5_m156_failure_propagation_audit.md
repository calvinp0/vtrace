# M156-A — Per-file index failure propagation audit

Predecessor: `d39871de` (M155 close). Read before any M156 code change.

The question this audit answers is not "why does the parser reject these three
files". It is: **which stages of the index lifecycle let one file decide the fate
of the whole repository, and which already fail locally.**

---

## 1. The lifecycle, stage by stage

`indexProject` (`src/indexer/indexProject.ts`) runs the whole repository through
seven phases. Below, *file* means the failure is confined to one file and the run
continues; *repository* means one file ends the run for every file.

| # | Stage | Source | Current failure scope | Notes |
|---|---|---|---|---|
| 1 | Enumeration | `scanRepo` → `scanDirectory` (`src/fs/scanRepo.ts:107`) | **repository** | `stat` + `hashFile` are unguarded. A file removed between `readdir` and `stat`, or one whose bytes cannot be read, rejects the entire scan. |
| 2 | Language detection | `detectLanguage` (`src/fs/languageDetection.ts`) | file | Returns `undefined` and the file is dropped before it is ever a candidate. Never throws. |
| 3 | Exclusion / policy | `isPathIgnored`, `isSafeDocumentPath`, worktree exclusions | file | Pure predicates, evaluated per entry. |
| 4 | Content read | read loop (`indexProject.ts:107-138`) | **repository** | Per-file `try/catch` records `read_failed` correctly — and then `if (files.length > 0) throw` at line 136 discards that per-file bookkeeping and aborts. |
| 5 | Parser invocation | `parseFile` (`indexProject.ts:706`) | file | Already fully contained: every throw becomes `ParserError.parserFailed`, and the loop keeps going. |
| 6 | Parse-outcome gate | `isFatalFileOutcome` (`indexProject.ts:324-327`) | **repository** | **The seam M155 hit.** Every `parse_failed`/`read_failed` summary is collected, then thrown as `IndexingFileFailuresError`. |
| 7 | Symbol / edge extraction | inside the language parsers | file | Runs within the parser call, so stage 5's containment already covers it. |
| 8 | Body literals / mechanism facts | `buildSymbolBodyLiterals`, `buildSymbolMechanismFacts` | **repository** | Pure functions, but called *inside* the persist transaction (`indexProject.ts:367-368`). A throw rolls back every file. |
| 9 | Document extraction | `buildDocumentChunks` (`indexProject.ts:373-385`) | **repository** | Same transaction. |
| 10 | SQLite insertion | `persistParseResult` (`indexProject.ts:369`) | **repository** | Same transaction. |
| 11 | Cross-file resolution | `persistResolvableInterFileEdges` (`indexProject.ts:392`) | **repository** | Same transaction. Correctly so — it is a whole-graph operation. |
| 12 | Integrity validation | `validateGraph` (`src/indexer/normalizedGraph.ts:69-82`) | **repository** | Correctly repository-fatal (§31). Checks file-count agreement and dangling edges/FTS rows. |
| 13 | Run-state recording | `recordIndexRunState` (`indexProject.ts:401`) | **repository** | Same transaction. |
| 14 | Metadata / provenance | `index.meta.json` write, post-transaction | **repository** | Correctly fatal: without a manifest, readiness reports `index_corrupt`. |

### The single decisive fact

Stages 8-13 all execute inside **one** `db.transaction(...)` opened at
`indexProject.ts:351`. That transaction begins by deleting every live graph table
and then re-inserts every successful parse result. So:

- there is no such thing as a partially-written repository index today — the
  transaction either commits everything or rolls back everything;
- **stage 6 throws before that transaction is ever opened.**

That second point is the reason M156 is a small, safe change rather than a
rewrite. The pre-M156 failure leaves *zero* rows behind, which the baseline
confirms empirically (§3 below). Containment does not have to undo partial
writes at the parse seam, because there are none.

---

## 2. Recoverable vs repository-fatal

The boundary M156 adopts, stated once:

**File-local recoverable** — the repository is fine; one file's *content* cannot
be turned into semantic evidence.

- `parse_failed` — syntax the parser rejects (`SYNTAX_ERROR`)
- parser threw unexpectedly on plausible input (`PARSER_EXCEPTION`)
- encoding / tokenization refusal (`ENCODING_ERROR`, `TOKENIZATION_ERROR`)
- `read_failed` — the file's bytes could not be read (vanished, permissions)

**Repository-fatal** — the *index* cannot be trusted, so no degraded answer is
honest.

- SQLite corruption, I/O failure, or a failed transaction
- schema incompatibility / derivation incompatibility
- `validateGraph` refusing the committed graph (dangling edges, count mismatch)
- missing or unreadable `index.meta.json`
- programmer invariant violations

The rule that separates them: *a malformed source file is a fact about the
repository; a broken database is a fact about our own state.* We may serve the
first truthfully. We may not serve the second at all.

---

## 3. What the pre-M156 failure actually leaves behind

Measured on the three frozen M155 cases (`stage5_m156_live_availability_baseline.json`):

```
index.sqlite            present  (192512 bytes — schema initialised)
index.meta.json         ABSENT
files / symbols / edges 0 / 0 / 0
index_runs              0
exit code               1
```

So the current behaviour is *clean* fail-closed, not corrupt: the schema is
created, nothing is written, no manifest is emitted, and every readiness surface
therefore reports `index_missing`. The product harm is entirely in the
all-or-nothing policy, not in data integrity.

---

## 4. Why the benchmark preparer can continue and the product cannot

M155 recorded that the deterministic preparer "quarantines the offending file and
continues", and inferred the product could do the same. Reading
`run_stage5_m134_prepare_targets.ts:46-78` shows what that quarantine actually
is:

1. run `vtrace index`; on failure, parse the failing paths out of stderr;
2. `rename` each failing file **out of the repository** into `.vtrace/m134-unsupported/`;
3. re-run indexing, up to 8 attempts;
4. restore the files afterwards.

The preparer does not contain the failure — it **removes the file from the tree**
so the product never sees it. The resulting index is complete *for a repository
that does not exist*: it claims full coverage of a corpus with 16 files silently
missing, and nothing in the index records their absence.

This is exactly the skipping §6 warns is "more than product truthfulness
permits". M156 therefore does **not** port this mechanism. The product keeps the
file in scope, records that it failed, and marks its own coverage degraded.

---

## 5. Consumers that assume "indexed" means "all files indexed"

Audited for §45.

| Consumer | Assumption | Required M156 change |
|---|---|---|
| `evaluateIndexReadiness` (`indexReadiness.ts:180`) | `ready` is five dimensions, none about coverage | Add a **coverage axis that does not flip `ready`** — a degraded index is usable (§18: freshness ≠ completeness) |
| `summarizeIndexOutcomes` (`indexOutcomeSummary.ts:70`) | already counts `parse_failed` as `failed`, bounded detail | **None.** The bounded machinery §20 asks for already exists and is already correct |
| `formatIndexResultHuman` (`cli/formatters.ts:167`) | already renders `indexed with N failures` | **None** — the string is already written and merely unreachable today |
| `runIndexCommand` (`indexCommand.ts:69-72`) | `IndexingFileFailuresError` ⇒ command failure | Only genuinely fatal classes may still fail the command |
| MCP `index_repo` (`tools.ts:6768`) | same | same |
| `proveExactUniqueness` / exact-symbol tier (`repositoryRelevance.ts:640-670`) | a miss ⇒ `DefinitelyAbsent` | A miss in a repository with relevant failed files is `Unknown`, not absent (§21, §22) |
| `composeCoverage` (`evidenceClaims.ts:206`) | `complete` derives from members answering | Reusable as-is; a degraded member is a member that did not fully answer |
| Stage 5 live injection | index failure ⇒ `TREATMENT_UNAVAILABLE` | A degraded index must proceed to context generation (§26) |

The vocabulary M156 needs mostly already exists. `PresenceUnknownReason` gains
one value — a degraded index is neither `IndexRefused` (nothing to repair in the
index) nor `BeyondScanBound` (no bound was hit), and the remedy is different from
both: fix the source file.

---

## 6. Storage placement (§60)

Failed-file records are derived from repository source by `index_repo`, so they
belong in `index.sqlite` and must be classified `repository_derived` in
`src/db/indexTableFamilies.ts`. Writing them to `session.sqlite` would break the
M152 split, because a re-index would no longer fully determine the store.

Adding a table to `src/db/schema.ts` moves `schema_version` (the file's content
is hashed into it), so existing indexes become `schema_incompatible` and rebuild.
That is the correct, non-suppressed outcome under §46/§47.
