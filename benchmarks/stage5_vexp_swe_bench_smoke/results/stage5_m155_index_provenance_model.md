# Stage 5 M155-B2 — index provenance model

## The model

An index is **derived evidence**, not a fixture. It is valid only relative to the
implementation that derived it:

```
checkpoint implementation (indexer + parser + config)
+ pinned benchmark source revision
+ benchmark fixture / query
        ↓
    fresh index          ← derived, disposable, provenance-stamped
        ↓
  retrieval result
```

A long-lived `.vtrace/index.sqlite` checked out beside a benchmark workspace is a
cache, and a cache whose key nobody validated is just old data.

## Identity that must match

Every regression index binds the following, all of which already exist in
`index.meta.json` and were already computed by the product:

| Field | Meaning | Derivation-relevant? |
| --- | --- | --- |
| `index_format_version` | table shape / readable schema | **yes** |
| `schema_version` | schema identity | **yes** |
| `indexer_fingerprint` | indexer semantics | **yes** |
| `parser_fingerprint` | parser semantics | **yes** |
| `config_hash` | configuration inputs | **yes** |
| `repo_head` | indexed source revision | source identity |
| `manifest.repository` / `manifest.worktree` | which repository/worktree | source identity |
| `vtrace_commit` | which commit built it | **no** — see below |

`vtrace_commit` is deliberately excluded from the reuse decision by the product's
own `NON_DERIVATION_FINGERPRINT_FIELDS`. That exclusion is what keeps a fast gate
fast: a commit that does not touch the indexer, parser or config leaves the
fingerprints alone, so the cached index stays valid and nothing is rebuilt.
Binding on the commit instead would force a full rebuild on every commit and the
gate would be abandoned within a week.

Measured confirmation: the M155 benchmark-only commits changed no derivation
input, so the corpus prepared at `051a7c55` is still derivation-valid under the
current working tree. The gate reports `derivation_agrees` — which is also an
independent check that M155's product freeze held.

## Authority

One authority, reused, not duplicated (§18):

- `computeIndexFingerprints()` — expected identity of the executing implementation
- `resolveDerivationRebuildReason(stored, expected)` — the reason a stored index
  must be discarded, in specificity order
- `SUPPORTED_INDEX_FORMAT_VERSIONS` — readable schema set
- `evaluateIndexReadiness()` — the fuller product-side view (source freshness,
  capability compatibility, repository/worktree identity)

`benchmarks/stage5_vexp_swe_bench_smoke/indexDerivationGate.ts` is a thin adapter
over these. It introduces no new fingerprint and no second opinion.

## One deliberate divergence: missing meta fails closed

`resolveDerivationRebuildReason(undefined, expected)` returns `undefined` — "nothing
stored, nothing to discard". That is right for a product deciding whether to throw
away content and wrong for a benchmark deciding whether to trust it.

The gate therefore treats a missing `index.meta.json` as **invalid**
(`meta_missing`). Four of the 20 committed `django.expanded` workspaces were in
exactly that state, so this is not a hypothetical.

## Failure behaviour (§19)

The gate never repairs and never proceeds:

| Condition | Verdict | Outcome |
| --- | --- | --- |
| no `index.sqlite` | `index_missing` | case not scored |
| no `index.meta.json` | `meta_missing` | case not scored |
| `index_format_version` outside supported set | `schema_unsupported` | case not scored |
| parser fingerprint differs | `parser_incompatible` | case not scored |
| config hash differs | `configuration_incompatible` | case not scored |
| indexer fingerprint differs | `derivation_incompatible` | case not scored |
| schema version differs | `schema_incompatible` | case not scored |
| all derivation fields agree | `derivation_agrees` | case scored |

A refused case surfaces as a `workspace_error` row carrying the reason verbatim,
so it lands in the artifact rather than in a log nobody reads. Rebuilding is a
separate, explicit step (`run_stage5_m134_prepare_targets.ts`), which is what keeps
"the baseline is stale" a visible benchmark verdict instead of a silent repair.

**There is no bypass.** An earlier draft added an opt-out for tests that need
merely *an* indexed corpus (capsule purity, summary shape). The better fix was to
make the test helper record derivation metadata the way a real index does, so those
tests now exercise a genuinely valid index. The opt-out was removed rather than
left in place unused — an escape hatch that exists is an escape hatch that gets
used.

## Where the gate applies

- `evaluateEntryLive` — the default evaluator, so every consumer of the
  authoritative scorer inherits it.
- `run_stage5_m155_fast_gate.ts` — audits all cases up front and marks the whole
  suite `exploratory` unless **every** case passes. One invalid case makes a suite
  unusable as a stability signal; "mostly valid" is how three evidence regimes
  ended up averaged together.

Not applied to `createHistoricalEvaluator`: historical anchors are evaluated by
their own implementation against indexes built by that same implementation, and the
M134 preparer already stamps and verifies that binding per side. Applying the
executing runtime's expectations there would reject every historical checkpoint by
construction — which is precisely what the gate correctly does report when asked
(M129 `parser_incompatible`; M140/M150/M152 `derivation_incompatible`).

## Consequence for artifact comparability

Adding the gate changed `run_stage5_retrieval_eval.ts`, and therefore the runner
fingerprint recorded in `benchmarkProvenance`. Artifacts produced before B2 are not
runner-identical to artifacts produced after it. The recorded *results* are
unaffected — the gate only refuses evidence, and every M155-B/C corpus is
derivation-valid — but a future paired comparison spanning the change will
correctly flag the runner difference rather than hiding it.
