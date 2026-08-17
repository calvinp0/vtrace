# M156 — Per-file failure containment contract

The rule everything below serves:

> A malformed source file is a fact about the REPOSITORY. We may serve it
> truthfully. A broken database is a fact about OUR OWN STATE. We may not serve
> it at all.

---

## 1. Recoverable, file-local failures

Recorded against the path that produced them; indexing continues.

| Status | Class | Meaning |
|---|---|---|
| `parse_failed` | `SYNTAX_ERROR` | Source is not valid in its language. The file is at fault. |
| `parse_failed` | `PARSER_EXCEPTION` | The parser threw where it should have returned a diagnostic. **VTRACE** is at fault — recorded distinctly so a parser bug is not filed as invalid source (§32). |
| `parse_failed` | `ENCODING_ERROR` | Bytes could not be decoded in the declared encoding. |
| `parse_failed` | `TOKENIZATION_ERROR` | Folded into `SYNTAX_ERROR`; Python raises both as `SyntaxError` and inventing a distinction we cannot detect would be a lie about precision. |
| `read_failed` | `READ_ERROR` | Bytes unreadable: removed mid-scan, permissions. |
| — | `UNKNOWN` | Recoverable but unmatched. Kept so the set is total. |

Implemented in `src/indexer/fileFailureClassification.ts`.

## 2. Repository-fatal failures

These end the run. No degraded index is produced.

- `persistence_failed` — a write against the index. The persist step is one
  transaction, so there is no honest way to attribute it to a single path.
- `validateGraph` refusal — dangling edges, dangling FTS rows, file-count
  disagreement. The index cannot prove its own consistency (§31).
- SQLite corruption, disk I/O failure, transaction failure.
- Schema or derivation incompatibility — handled upstream by readiness, which
  refuses the index and requires a rebuild.
- Missing/unreadable `index.meta.json`.

**Per-file containment must never convert one of these into a silent omission.**
That is the §95 FAIL condition, and it is the reason the recoverable set is a
closed allow-list rather than a catch-all.

## 3. Transaction semantics

Unchanged, and the reason the change is small:

```
scan → read → parse (ALL files)          ← failures collected here, no writes yet
  ↓
ONE db.transaction:
    DELETE every live graph table
    persist each successful parse result
    resolve inter-file edges
    validateGraph                        ← throws ⇒ whole transaction rolls back
    replaceFileIndexFailures             ← failed set committed WITH the successful set
    recordIndexRunState
```

Two consequences matter:

- **There is no partial write to undo.** Parsing completes before the transaction
  opens, so a failed file contributes zero rows by construction rather than by
  cleanup. The pre-M156 abort left `files`/`symbols`/`edges` at 0 and no
  manifest, which the M156-A baseline confirms empirically.
- **Stale evidence cannot survive a regression to unparseable.** The transaction
  begins by deleting every live graph table and re-inserting only successful
  results, so a file that used to parse and now does not loses its symbols in the
  same commit that records its failure (§36).

## 4. Failed-file evidence policy

A failed file gets **no authoritative leftovers**: no `symbols`, `edges`,
`edge_call_sites`, `symbol_mechanism_facts`, `document_chunks`, FTS rows, module
nodes or references.

It also gets **no `files` row**. `files` is the authority M148 reads for path
membership through its UNIQUE covering index, and it is what `symbols.file_id`
joins against. A row there would claim we index a path we hold no evidence for,
and would make a failed file indistinguishable from a file that defines nothing.

What it does get is one row in `file_index_failures` (`path`, `language`,
`status`, `failure_class`, bounded `message`, `content_hash`, `size_bytes`) —
classified `repository_derived` in `src/db/indexTableFamilies.ts`, so it lives in
`index.sqlite` and never in `session.sqlite` (§60).

A `failed` entry is also retained in the file snapshot, so an incremental run
knows the file exists and previously failed rather than treating it as new.

## 5. Coverage semantics

Coverage is a **second axis**, not a readiness dimension.

```
ready    = sourceFresh ∧ schemaCompatible ∧ capabilityCompatible
           ∧ repositoryCompatible ∧ worktreeCompatible      ← UNCHANGED by M156
coverage = complete | degraded                               ← NEW, independent
```

A degraded index is `ready: true, coverageComplete: false`. Freshness answers
"does this index correspond to the current source revision"; coverage answers
"did we succeed on everything in scope". Collapsing them is how *fresh* quietly
starts meaning *complete* (§18, §67).

Arithmetic invariant, enforced in tests (§76, §77):

```
filesEligible = filesIndexed + filesFailed + filesSkipped
returnedFailureDetail ≤ failedTotal
```

Skipped (unregistered/unsupported language, excluded, generated) stays distinct
from failed (§16): the first is policy declining to attempt a file, the second is
an attempt that did not succeed.

## 6. Absence semantics

The asymmetry is the whole design:

- **A hit is self-supporting.** A file that failed to parse cannot retract a
  symbol we actually found, so a positive is unaffected.
- **A miss is a claim about everything we did not see.** So it is only as strong
  as the coverage behind it.

Therefore an exact-symbol miss in a repository with at least one failed
**symbol-bearing** file is `Unknown / coverage_incomplete`, not
`definitely_absent`, which downgrades the workspace claim from
`authoritative_absence` to `bounded_absence` through the existing M149 machinery.

`coverage_incomplete` is a new `PresenceUnknownReason` because its remedy differs
from every existing one: not "repair the index" (`index_refused`) and not "raise
the bound" (`beyond_scan_bound`), but "fix the source file".

**Where absence is NOT weakened** (§24): a failed file whose language emits no
symbols — YAML, TOML — is a real coverage gap for document retrieval and no gap
at all for "does this repository define `Foo`". Weakening every claim whenever
anything failed would be safe-looking, useless, and quickly ignored.

## 7. Incremental behaviour

| Transition | Behaviour |
|---|---|
| valid → failed | Semantic evidence removed transactionally; failure recorded; rest of index usable (§36) |
| failed → valid | Repaired content is `modified`, so it is re-parsed; failure row cleared by wholesale replace; evidence restored with no manual rebuild (§37) |
| unrelated edit while failure persists | Indexes normally; the standing failure carries forward from the snapshot (§35) |
| unchanged failed file | Carried forward from the snapshot without re-parsing — safe because an incremental plan is only compatible when the parser registry, version and config fingerprint are unchanged |

Full and incremental histories produce the same successful evidence, the same
failed-file set and the same coverage metadata (§38), asserted directly in
`indexProject.test.ts`.

## 8. Consumer behaviour

| Surface | Behaviour on a degraded index |
|---|---|
| `vtrace index` | Exits 0. `status: indexed with N failures`, `coverage: degraded — N file(s) could not be indexed`, failures named under a bound (§44) |
| `index_repo` (MCP) | `ok: true`; `indexReadiness.coverageComplete=false`, `failedFiles=N`; failed files carried in the existing bounded M141 `outcomes` view (§20) |
| `index_status` | Same readiness summary, so degradation is visible without reading logs (§43) |
| `get_code_context` / capsule / `run_pipeline` | Serve normally. Retrieval confidence and repository completeness stay separate axes (§42) |
| Workspace routing | Degraded is **usable**, not unavailable (§25) |
| Exact-symbol absence | Weakened to `bounded_absence` where failed files could be relevant (§21, §22) |
| Stage 5 live injection | Indexing succeeds, so context generation proceeds. `VALID_DELIVERY_EMPTY` (django-11740) is unchanged — it was never an availability failure (§26, §27) |

## 9. Schema and derivation

- `file_index_failures` added to `src/db/schema.ts`; `FILE_SNAPSHOT_SCHEMA_VERSION`
  4 → 5 (`indexOutcome` gained `failed`).
- Both move the derivation fingerprint, so indexes built under all-or-nothing
  semantics report `schema_incompatible` and rebuild.
- **This incompatibility is not suppressed** (§47). An index written before M156
  cannot express which files were refused, and reading one as though it could
  would report a degraded repository as complete — the exact lie M156 exists to
  prevent.
- No V1/V2 parallel schemas; the authoritative schema evolved in place (§46).
