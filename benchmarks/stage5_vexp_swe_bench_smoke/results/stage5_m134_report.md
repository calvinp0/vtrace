# M134 — Retrieval Benchmark Provenance and Historical Attribution

## Verdict

**PASS.** M134 makes stored deterministic baselines provenance-safe, adds the
authoritative paired predecessor/candidate workflow, reconstructs the stale
cross-repository movement to an exact adjacent transition, regenerates the
current frozen 50 from the clean M134 implementation, and preserves M133 product
behavior. No retrieval tuning was performed.

| identity | value |
|---|---|
| starting branch / HEAD | `main` / `5340305` |
| M133 implementation | `a004529` (`5a05916e` tree) |
| M134 functional commit | `7b29882` (`0f7b6de1` tree) |
| starting ahead / behind | 4 / 0 |
| pushed | no |

The evidence/ledger commit containing this report is intentionally identified by
Git after the commit; a commit cannot truthfully contain its own hash.

## Last trustworthy baseline and historical answer

The last trustworthy historical baseline is M103: implementation `199769f`,
fixture/baseline promotion `f14aab8`. Its structured-task promotion changed 15
cross-repository and 8 Django task strings, but changed no ordering or gold
labels. Both fixture files then remained byte-stable through M133. The benchmark
runner/scorer also did not change from M103 through M133.

The cumulative cross-repository Top-1 movement is exact:

| Transition | cases | Top-1 | any-gold | lead | cause |
|---|---:|---:|---:|---:|---|
| M122 `1a80527` → M123 `c678624` | 2 | -1/30 | 0 | 1 | shared Capsule-v2 ranking / compound-rescue convergence |

`psf__requests-1724` moved from `requests/sessions.py` (gold pivot, rank 1)
to `requests/api.py` (gold sessions file retained as support, rank 2). This is
the sole `0.7333 → 0.7000` Top-1 case. `sphinx-doc__sphinx-7462` retained
`sphinx/domains/python.py` as its gold lead but changed support composition.
M123's own report disclosed the aggregate product-v2 tradeoff; M134 supplies the
missing commit, target, index, and case attribution.

Isolated replay hashes are unchanged at M103, M119, M120, M121 and M122 for the
two implicated cases, then change at M123. Full frozen-50 hashes match from M123
through M124, M125, M126, M128, M129 and M133. Report-only commits were skipped;
M127 and M130–M133 were conservatively deduplicated using product diffs plus
matching endpoint hashes. M132's own same-checkout A/B evidence remains separate
and confirms it did not cause the stale-golden movement.

## Provenance schema and authority

Every authoritative JSON result now carries `benchmarkProvenance` with:

- authority state: `authoritative`, `exploratory`, `superseded`, or
  `historical_unverified`;
- VTRACE commit, Git tree, effective source fingerprint, dirty flag and paths;
- fixture byte hash, task/order hash, gold-label hash, and case count;
- runner fingerprint and `stage5.retrieval.protocol.v1`;
- ordered target instance/repository/base-commit identity and per-index source
  fingerprints;
- index/manifest/snapshot/retrieval/product-context versions where exposed;
- `stage5.retrieval.semantic.v1`, raw semantic-result hash, metric-summary hash,
  completeness, and collection overhead.

The semantic contract includes selected files, lead, roles, content modes,
rendered model-visible context, per-item and aggregate token accounting, and
quality fields. It excludes timings, timestamps, request IDs, absolute temporary
paths, and diagnostic counters.

An authoritative baseline must be clean, committed, complete, and match the
declared predecessor commit/tree, fixture, runner, protocol, target corpus, and
semantic version. Structured refusal reasons are:
`baseline_vtrace_commit_mismatch`, `baseline_tree_mismatch`,
`fixture_hash_mismatch`, `runner_fingerprint_mismatch`, `protocol_mismatch`,
`target_corpus_mismatch`, `semantic_hash_version_mismatch`,
`dirty_baseline_not_authoritative`, and `missing_provenance`.

Dirty executions are automatically exploratory. The explicit mismatch override
never yields an authoritative PASS. Empty SQLite files are unresolved target
state, not complete indexes.

## Paired predecessor architecture

The preferred milestone proof now prepares the target corpus once, creates an
isolated source/index/manifest/cache state for each implementation, executes the
declared predecessor and candidate with the same fixed scorer and protocol,
validates provenance, then compares semantic fields case by case. Static goldens
remain supplementary evidence.

Three legacy target checkouts contain intentionally invalid or obsolete Python
syntax that makes the current full index transaction fail. M134 records each
path and content hash, temporarily quarantines the same files independently on
both sides, builds a non-empty full index, and restores the exact source bytes
before retrieval. The affected cases are pytest-5262, requests-1142, and
pylint-8898. The complete lists and hashes live in the preparation evidence;
both sides used identical exclusions. This bounded fallback replaces the invalid
alternative of treating an empty database as a successful index.

## M133 → M134 authoritative equivalence

Both sides were clean and committed. Both suites used identical fixture and
target-corpus hashes, separate indexes, and runner fingerprint
`738392b3…e7285`.

| suite | cases | selected | lead | roles | modes | context | tokens | metrics |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| Django expanded | 20 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| cross_repo_30 | 30 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |

The comparison is authoritative and passed. This proves M134 did not tune or
otherwise change product retrieval.

## Current authoritative baselines

The canonical JSON/CSV/Markdown suites were regenerated from clean `7b29882`
using its own fresh isolated indexes. Provenance was generated at execution time;
old JSON was not decorated.

| suite | evaluated | Top-1 | Top-3 | pivot | missing | semantic hash |
|---|---:|---:|---:|---:|---:|---|
| Django expanded | 20/20 | 0.9000 | 1.0000 | 1.0000 | 0 | `ef66680a…f15aa` |
| cross_repo_30 | 30/30 | 0.7000 | 0.8333 | 0.7667 | 0.1000 | `05f42793…912cf` |

Metric definitions are unchanged: a fixed raw M133 result scores byte-identically
under the pre-M134 and M134 aggregate functions. The cross-repository CSV differs
from the old committed file in token-accounting rows because M134 normalizes to
fresh independently generated indexes; its headline quality metrics are
unchanged, and the paired fresh M133/M134 token-accounting difference is zero.

## Product preservation

- Real ARC copied-index impact smoke, `get_dihedral`, `max_edges=10`,
  `max_tokens=1200`: 3 edges, 4 nodes, 41 omitted edges, 6,596 characters,
  1,649 estimated complete tokens under a 2,000 ceiling, `withinEnvelope:true`.
  Caller evidence remains vectors.py:253 and vectors_test.py:84/88/92/98/101.
- Context-envelope tests retain successful bounded `within_envelope:true`.
- M132 nested-worktree exclusion, explicit worktree routing, sibling isolation,
  and wrong-worktree fail-closed behavior: 53/53 focused product tests passed.
- TCKDB source was read-only on `main` at `6d460d5` (pre-existing untracked
  `paper/`, behind origin by one). Separate clean local clones and separate
  M133/M134 indexes produced identical files, lead, roles, modes, rendered
  context, accounting, and semantic hash `840539f7…01525`.

ARC's pre-M132 615-file/15,188-symbol/18,862-edge evidence remains classified
`worktree_contaminated_index`; the clean 324-file/8,635-symbol/19,404-edge state
must not be described as a graph regression.

## Historical claim correction

M123's aggregate claim is `SUPERSEDED_BY_RECONSTRUCTION` with exact case-level
attribution. M124–M131 static-golden preservation claims are
`UNSUPPORTED_OLD_PROOF_BUT_NOW_CONFIRMED`. M132 and M133 are
`CONFIRMED_BY_RECONSTRUCTION` because their direct same-checkout evidence was
already valid. Broad M104–M120 assertions not needed for the implicated cases
remain bounded by their original evidence; M134 does not invent a full replay it
did not perform. No old report was deceptively rewritten.

The structural lesson is distinct from prior incidents:

- M130: missing whole-response dimension;
- M131: missing graph-size dimension;
- M134: missing baseline-provenance dimension.

The old workflow could compare a candidate with an unbound stored file and print
PASS. Identical bytes did not prove that the file represented the declared
predecessor. The permanent repository rule now forbids that claim and requires a
provenance-validated paired execution.

## Performance, safety, and verification

Warm provenance collection was 116 ms for Django and 133 ms for cross_repo_30;
the initial cold exploratory load was approximately 3.9 s. Fixture and runner
hashing are small; target identity hashes stable commits and indexed-file
metadata rather than SQLite bytes. Latency is explicitly non-authoritative and
cold/warm observations are not pooled.

All implementation is typed benchmark code; no `@ts-nocheck` was added and
product `tools.ts` was untouched. No live agents, paid APIs, Docker, VEXP, or
live SWE-bench arm ran. ARC/TCKDB source and in-place indexes were not modified.
Temporary historical worktrees, clones and generated indexes are untracked and
removed after acceptance.

Verification:

- `bun run typecheck`: PASS
- `bun run typecheck:benchmarks`: PASS
- `bun test`: 3,845 pass, 49 skip, 0 fail across 240 files (pre-final evidence
  rerun; final rerun recorded at commit time)
- provenance/retrieval focused tests: 94 pass, 0 fail
- M132/M133 product smokes: 53 pass, 0 fail
- `git diff --check`: PASS

## Artifacts

Tracked M134 evidence includes the protocol plan, milestone map, fixture/runner/
target provenance, historical reconstruction JSON/Markdown, case attribution,
historical claim audit, negative tests, paired comparison details and summary,
M133 equivalence, current authoritative baselines, ARC/no-agent smoke, TCKDB
acceptance, and this report. Large raw replays, target copies, indexes, caches,
logs, and historical worktrees are not tracked.

## Recommendation and limitations

Proceed to **M135 — Query Semantics and Literal-Signal Quality** for contrast/
negation and short stopword-like identifiers. M134 intentionally does not fix
those ranking failures and does not begin workspace/multi-repository aggregation.

Remaining limits are explicit: some early broad claims were not replayed over all
50 cases because bisection plus adjacent validation exactly resolved the headline
delta; three legacy checkouts require content-bound unsupported-file quarantine
for a successful modern full index; and historical live/latency artifacts remain
`provenance_partial` rather than being rerun.
