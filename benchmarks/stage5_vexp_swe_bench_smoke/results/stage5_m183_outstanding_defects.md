# M183 — outstanding defects

Found during M183 and deliberately **not repaired** by it. §62/§120 freeze the
product once the protocol is frozen, and §155 permits a product commit only for a
pre-launch benchmark-integrity defect that must be repaired. Each item below is
either worked around on the benchmark side or recorded as debt.

## 1. A rebuild that does not rebuild, and reports success (PRODUCT)

**Severity: high. User-reachable. Silent.**

Deleting `.vtrace/` and re-running `vtrace index <repo>` does not force a
rebuild. The reusable-snapshot registry lives at

    <gitCommonDir>/vtrace/repositories/<repositoryId>/snapshots/<worktreeId>.json

that is, inside `.git`, which neither `rm -rf .vtrace` nor `git clean -fdx`
reaches. `selectReusableSnapshot` matches on `repositoryId`, parser version and
parser config fingerprint — not on whether the TARGET database has any content —
and `indexProject` then short-circuits on `plan.mode === "noop"` even though it
was passed `hasExistingGraph: false`.

The result is an index that exits 0, writes an `index.meta.json` whose every file
entry says `indexOutcome: "indexed"`, and contains **nothing**.

Measured on `pallets__flask-5014` at base commit `7ee9ceb7`:

| action | mode | parsed | symbols |
|---|---|---|---|
| `rm -rf .vtrace` then index | `noop` | 0 / 91 | **0** |
| `rm -rf .vtrace .git/vtrace` then index | `full_rebuild` | 91 / 91 | 1,165 |

Reproduced deterministically, twice, on a completely fresh `.vtrace`.

**Why it matters beyond M183.** The failure is invisible at every surface a
caller would check: exit code, meta file, freshness verdict. Only a query
notices, and it fails as `repo_not_ready` — which reads as "this repository was
never indexed", not "your rebuild silently did nothing". This is the same class
M146-A named (*rebuild-that-didn't-rebuild*); the mechanism here is a different
store.

**M183's response.** Benchmark-side only. `run_stage5_m183_prepare.ts` now clears
both stores, and gates each workspace on `mode === "full_rebuild"` **and**
`symbols > 0` read from the database rather than from the manifest. A workspace
failing either is `PREPARATION_FAILED` and its instance cannot enter the sweep.

**Recommended follow-up (not licensed here).** A reused snapshot should not be
able to produce a noop against an empty graph: `hasExistingGraph: false` already
carries the fact that would prevent it. Any fix touches the indexer and therefore
needs the deterministic retrieval no-change proof.

## 2. `index.meta.json` `vtrace_commit` tracks git HEAD, not product identity

**Severity: low. Cosmetic for M183, misleading in general.**

The field records the repository's HEAD at index time, so a **benchmark-only**
commit changes it even when nothing under `src/` moved. During M183's preparation
a commit landed mid-run and the prepared workspaces split across two values.

M183's response: all thirty indexes are rebuilt in a single pass at one HEAD, and
`stage5_m183_index_authority.json` additionally records that `src/` is unchanged
between the M182 closure commit and that HEAD — which is the property that
actually determines retrieval. `indexer_fingerprint`, `parser_fingerprint` and
`config_hash` are product-derived and were uniform throughout.

## 3. Inherited documentation debt (UNOWNED)

`VTRACE_TOOLING_AUDIT.md` remains untracked and stale. Known stale claims: the
M179-fixed django orientation→delivery_failure defect is still described as open,
and the M172-removed five-entry orientation cap is still described as current.

M183 does not edit or stage this file (§137). Documentation debt remains; it does
not affect live experiment validity.

## 4. `modelVisibleEstimatedTokens` is misleadingly named (INHERITED)

It does not represent all model-visible content. M183 does not rely on it and
does not rename it (§138). Token authority is the harness result row, per
`stage5_m183_token_accounting_contract.md`.
