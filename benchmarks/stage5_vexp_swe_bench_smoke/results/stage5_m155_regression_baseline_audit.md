# Stage 5 M155-B2 — regression baseline audit

What the routine regression suite was actually measuring, and why it could not
observe the architecture it was being used to police.

## The defect

`run_stage5_retrieval_eval.ts` resolved each fixture's workspace and called
`openIndexerDatabase` on `.vtrace/index.sqlite`. It contained no index build, no
freshness assertion, and no derivation check. Whatever index was on disk became
the evidence.

VTRACE already owns an authority for exactly this question —
`resolveDerivationRebuildReason` in `src/indexer/indexMeta.ts`, plus
`SUPPORTED_INDEX_FORMAT_VERSIONS` and `evaluateIndexReadiness`. The benchmark
never asked it.

## What the committed Frozen50 baseline was standing on

Asking that authority now, for the 50 cases of the committed fast suite
(`django.expanded` 20 + `cross_repo_30` 30) against the executing implementation:

| Verdict | Cases |
| --- | ---: |
| derivation-valid | **5** |
| `schema_unsupported` | 41 |
| `meta_missing` | 4 |

**5 of 50.** Three different evidence regimes in one suite labelled
`artifactState: "authoritative"`:

- **41 cases** carry `index_format_version: 1` against a supported set of `{5}`,
  built 2026-06-08 at commit `7035429` — 491 commits before the code they were
  scoring. `index_runs` holds exactly one row.
- **4 cases** (in `django.expanded`) have **no `index.meta.json` at all**. They
  cannot state what produced them. `resolveDerivationRebuildReason` returns
  `undefined` for this — correct for a product deciding whether to discard
  content, wrong for a benchmark deciding whether evidence is trustworthy. This is
  the one place the benchmark gate deliberately diverges from the product
  authority, and these 4 cases are why the divergence is load-bearing.
- **5 cases** were silently re-indexed on 2026-08-16 at `588d55d8` (during
  M153-C2) and are genuinely valid.

A "0/50 changed" result across that set is not one measurement. It mixes fresh
evidence with format-v1 evidence and with evidence of unknown origin.

## Why "unchanged" was uninformative rather than reassuring

Opening a stale index with current code *migrates its schema*: the newer feature
tables are created, and left **empty**. Known-positive control on
`psf__requests-1142`, identical source, stale index vs freshly derived at M154:

| | stale (`7035429`, format 1) | fresh (M154, format 5) |
| --- | ---: | ---: |
| `document_chunks` | **0** | 6 |
| `symbol_mechanism_facts` | **0** | 79 |
| symbols of kind `module` | **0** | 69 |

So in the corpus that suite measured:

- M129's document lane had no documents,
- M150's mechanism facts did not exist,
- M140-A's module-scope import owner was absent.

Any milestone whose change lived in the index rather than the ranking code could
not have moved that suite. Reporting "unchanged" was accurate about the
measurement and silent about its scope.

## Retrospective qualification (M155 §10/§25)

Historical milestone reports are **not** rewritten. They remain accurate records of
what their declared harness measured. The qualification added here, once:

> Regression-neutrality evidence produced against the committed
> `results/workspaces` indexes has a narrower scope than previously believed. It
> demonstrates that *ranking and delivery code* did not change behaviour on that
> corpus. It does **not** demonstrate index-side behavioural invariance for any
> capability introduced after 2026-06-08 — the document lane, mechanism facts and
> module-scope import ownership were absent from that corpus entirely.

This applies to preservation claims of the form "0/50 changed" taken on that
corpus. It does not affect M155-B/C, which built fresh indexes per checkpoint, nor
the M134/M140 paired comparisons, which already prepared independent indexes.

## Re-baseline: before vs after

Same 50 cases, same fixture identity, same scorer, same candidate implementation.
Only the evidence differs.

| | before (committed workspaces) | after (freshly derived at M154) |
| --- | ---: | ---: |
| derivation-valid cases | 5/50 | **50/50** |
| gate usable | **false** | **true** |
| cases actually evaluated | 5 | 50 |
| workspace errors | 45 | 0 |
| gold file Top-1 | 0.60 *(of 5)* | **0.76** |
| gold file Top-3 | 0.60 *(of 5)* | **0.86** |
| gold delivered | 0.80 *(of 5)* | **0.90** |
| gold discarded | 0.20 *(of 5)* | 0.06 |
| gold missing | 0 *(of 5)* | 0.04 |
| mean capsule tokens | 2579 *(of 5)* | 1779 |

The "before" column is not a rival measurement of quality — it is the measurement
collapsing. 45 of 50 cases are refused, and the 5 that survive are the ones that
happened to be re-indexed during M153-C2. Its rates are printed only to show that
the previously reported numbers rested on a subset nobody had declared.

The "after" numbers independently reproduce the Frozen50 projection computed from
the broad 100-case run (`Top-1 0.76`, `delivered 0.90`) — two different drivers,
same prepared corpus, same answer.

## Standing consequence

Frozen50 keeps its place as a **fast stability gate**. It loses its place as the
broad quality authority: it is ~19 points easier on Top-1 than the broad corpus
and its delivered-gold is 90% at all five architecture checkpoints. See
`stage5_m155_regression_baseline_decision.md`.
