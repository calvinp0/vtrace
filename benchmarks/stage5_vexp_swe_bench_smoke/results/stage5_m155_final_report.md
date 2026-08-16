# Stage 5 M155 — Broad SWE-bench Regression and Agent-Utility Qualification

**Status: A PASS · B PASS · C PASS · D DEFERRED · E NOT RUN → M155 INCOMPLETE (at decision point).**

M155 is an evaluation milestone. This report covers the completed deterministic
layers. The live paired agent benchmark (D) and its causal analysis (E) were
deferred by explicit decision after A's findings, per §65/§95, so **no VTRACE
product-utility verdict is issued here** — that verdict requires D and would be
unfounded without it. What *is* issued is a broad retrieval-trend verdict.

## Provenance

| Field | Value |
| --- | --- |
| Candidate (M154 final functional) | `051a7c559efcc90848390922b8a42293fb66dba5` |
| M154 predecessor | `e3761ab989a14aea4e233844070491084f33b2ce` |
| Branch / push state | `main`, 17 local-only commits before this milestone, nothing pushed |
| Product code changed | **NO** — `git status --porcelain src/` empty |
| Behavioural routing default | **OFF** (asserted, `src/mcp/searchContract.test.ts:129-137`) |
| `provenanceValid` (all 4 comparisons) | **true** |
| `isolatedIndexes` / `sameFixtureHash` | **true** on every comparison |
| srcDirty (all five sides) | **false** — every side is a clean detached worktree |
| Task manifest hash | fixture `5ef1371ccaa1d941…`, order `3a1a09d196b80a05…`, gold `927308c91e811517…` |
| Verification | `bun run typecheck` ✅ · `typecheck:benchmarks` ✅ · `bun test` **4724 pass / 0 fail** ✅ · `git diff --check` ✅ |

Worktrees: 14 pre-existing (preserved untouched); 5 created by M155 under
`/home/calvin/bench/vtrace-m155/impl/` (removed at close — see Cleanup).

## Corpus

Reused the exact historical task IDs (§11); no new selection, no VEXP list (§14).
The frozen M103/M105–M108 pool reconstructs to **100 instances across 12
repositories**, and clean workspaces exist for 100/100 — a 1:1 match.

Legacy suites Frozen50 (50), django.expanded (20), cross_repo_30 (30) and
django (5) are all **strict subsets** of this corpus, so §101 is answered by
projection under the identical protocol rather than by a separately provenanced
second measurement.

## M155-A — what the audit found

Three findings, each a measurement rather than an inference. Full detail in
`stage5_m155_protocol_audit.md`.

### A1. The historical VTRACE arm has no agent-callable tools

`--vtrace-method mcp` parses but is never dispatched anywhere; the external
harness spawns Claude Code with `--strict-mcp-config` and an explicitly empty
`{ mcpServers: {} }`. VTRACE reaches the agent as injected text
(`_vtrace_instructions.md`).

Consequently §38/39/40/41/74/76/77 — tool discovery, usage rate, `VTRACE → read →
grep` ordering, per-tool utility — are recorded **UNAVAILABLE, never zero**. The
paired question of §27 (baseline vs same agent + VTRACE) survives intact and is
natively supported by `--protocol all`.

Both arms receive the identical tool list
(`DEFAULT_ALLOWED_TOOLS = Edit, Write, Bash, Read, Glob, Grep, TodoWrite`), so
§36 (baseline not crippled) and §37 (VTRACE arm free to grep) already hold.

### A2. The canonical deterministic suites scored current code against a 2026-06-08 index

The committed `expanded` and `cross_repo_30` baselines — labelled
`artifactState: "authoritative"` — read `.vtrace/index.sqlite` from workspaces
whose `index_runs` table holds exactly one row, created 2026-06-08 at commit
`7035429`, **491 commits back**. The runner contains no index build and no
staleness assertion.

Known-positive control, same instance and source, stale index vs freshly indexed
at M154:

| | stale (`7035429`) | fresh (M154) |
| --- | ---: | ---: |
| `document_chunks` | **0** | 6 |
| `symbol_mechanism_facts` | **0** | 79 |
| symbols of kind `module` | **0** | 69 |

M129's document lane, M150's mechanism facts and M140-A's module import-owner all
contributed **nothing** in the corpus those suites measured. The tables are
present but empty because opening a stale index migrates its schema without
populating it. This is why M155-B/C rebuilt every index per side.

### A3. The committed baselines are stale relative to the candidate

205 `src/` files changed since the baselines' `generated_at_commit` (`7b29882e`),
so the byte-diff-against-baseline path documented in CLAUDE.md is invalid for
M155. §101 was therefore run as a paired comparison, not a diff.

## Method (B/C)

Five architecture-era anchors, each a clean detached worktree with its own
dependencies, each indexing **its own isolated copy** of the same immutable source
corpus with **its own `bin/vtrace`**:

| Anchor | Commit | Era |
| --- | --- | --- |
| M129 | `1678871643c3…` | document-aware retrieval |
| M140 | `249f61feabf2…` | structural module / orchestration correctness |
| M150 | `6117f5f2dfa4…` | behavioural decision / mechanism retrieval |
| M152 | `bcdd962e42cf…` | repository-evidence / session-state split |
| M154 | `051a7c559efc…` | current candidate |

500 repository indexes were built (5 × 100), ~100 min wall per side in parallel.
Every side's `index.meta.json` records exactly its own anchor commit — verified,
no contamination. Quarantined-file sets are **byte-identical across all five
sides** (16 files, all genuinely unparseable — deliberate syntax-error fixtures in
pylint/pytest test data plus one unicode-escape bug in vendored urllib3), and
**zero quarantined files are gold**. All five eras therefore see an identical corpus.

Query shaping is the committed structured derivation from `problem_statement`;
gold labels are evaluation-only and never enter retrieval; no per-task rewriting.

## M155-B/C — results

### Broad trend across eras (100 cases)

| Checkpoint | File Top-1 | File Top-3 | Gold **delivered** | Gold anywhere | Gold discarded | Symbol anywhere | Missing gold | Misleading lead | Empty | Tokens (median) | Latency median | p90 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| M129 | 56% | 73% | **79%** | 85% | 6% | 64% | 15% | 42% | 2% | 1185 | 593 ms | 1356 ms |
| M140 | 55% | 72% | **80%** | 84% | 4% | 64% | 16% | 43% | 2% | 1165 | 562 ms | 1249 ms |
| M150 | 57% | 73% | **78%** | 89% | 11% | 64% | 11% | 41% | 2% | 1165 | 717 ms | 1607 ms |
| M152 | 57% | 73% | **78%** | 89% | 11% | 64% | 11% | 41% | 2% | 1165 | 711 ms | 1620 ms |
| M154 | 57% | 73% | **78%** | 89% | 11% | 64% | 11% | 41% | 2% | 1165 | 708 ms | 1613 ms |

`Gold delivered` = gold reached the model as pivot or support. `Gold anywhere`
additionally counts `discarded` — surfaced as a candidate and then **withheld**.
Only the former describes evidence an agent could act on.

### Adjacent transitions

| Transition | Semantic changes | Outcome changes | Improvement | Regression | Neutral |
| --- | ---: | ---: | ---: | ---: | ---: |
| M129→M140 | 57/100 | 47 | 0 | **3** | 44 |
| M140→M150 | 76/100 | 95 | 8 | 0 | 87 |
| M150→M152 | **0/100** | 0 | 0 | 0 | 0 |
| M152→M154 | 2/100 | 6 | 0 | 0 | 6 |

### The three headline results

**1. Five architecture eras produced no net gain in delivered gold.**
Across M129 → M154, gold actually delivered to the model went **79% → 78%**, with
M140 the peak at 80%. Gold symbol anywhere is **64.0% at every single
checkpoint** — flat to the decimal across all five eras. File Top-3 is 73% → 73%.
File Top-1 moved +1 point. Median tokens moved −20.

**2. The reported +4-point "gold anywhere" gain is a metric artifact.**
`gold anywhere` rose 85% → 89% at M140→M150 and stuck. But `discarded` rose 6% →
11% over the same step, and delivered gold *fell* 80% → 78%. Five of the eight
"improvements" are cases moving `missing → discarded` — gold became a candidate
and was still withheld from the model. The metric improved; the agent's evidence
did not.

**3. M150's mechanism lane cost ~26% median latency for no delivered gain.**
Median 562 ms (M140) → 717 ms (M150), p90 1249 ms → 1607 ms, and it persists
unchanged through M154. Over the same step delivered gold went 80% → 78%.

### Two clean confirmations

- **M152's store split is byte-identical for retrieval**: 0/100 semantic changes.
  The M152 claim holds on the broad corpus, not just the small suites.
- **M154 is contained**: 2/100 semantic changes, 6 outcome-neutral cases, every
  one a pure `discarded_count` increase (+1 to +3) with pivots, support and
  model-visible tokens unchanged (one case ±5 tokens). No regressions.

### The regressions (§26 attribution, not fixed — §66)

Three, all at M129→M140, all classified `path authority` (the lead moved and gold
moved with it):

| Case | Lead M129 → M140 | Gold role |
| --- | --- | --- |
| `django__django-14608` | `forms/formsets.py` → `forms/boundfield.py` | pivot → pivot |
| `sympy__sympy-12419` | `physics/quantum/identitysearch.py` → `matrices/matrices.py` | pivot → support |
| `sympy__sympy-16792` | `solvers/ode.py` → `utilities/autowrap.py` | discarded → missing |

`sympy__sympy-12419` is an independently known regression, now dated to the M140
structural era on a broad corpus.

### The legacy suites are substantially easier than the broad corpus

| Suite | M154 File Top-1 | M154 gold delivered |
| --- | ---: | ---: |
| Frozen50 | 76% | 90% |
| django.expanded (20) | 80% | 95% |
| cross_repo_30 | 73% | 87% |
| **Broad 100** | **57%** | **78%** |

Frozen50's delivered-gold is **90% at all five checkpoints** — perfectly flat.
This is the mechanical reason milestone after milestone could report "0/50
changed": the regression suite the project steers by is ~19 points easier on
Top-1 and 12 points easier on delivery than the broad corpus, and it has not
moved in five eras.

### Where M154 still misses (§67 ledger)

11 missing-gold and 11 discarded-gold cases; 2 cases deliver nothing at all
(`django__django-11740`, `sphinx-doc__sphinx-9320` — both frozen `no_context`
cases, consistent with the M110 manifest). Per-repository delivered gold:
`pylint 0/2`, `sphinx 3/7`, `matplotlib 4/7`, `sympy 12/17`, `django 37/44`,
with `xarray 6/6`, `astropy 5/5`, `requests 4/4` clean.

## Verdicts

**M155-A: PASS.** Protocol recovered from repository evidence, task set frozen
with hashes before candidate inspection, CLIs documented, rerun policy frozen,
provenance binding trustworthy, detectors given known-positive *and* known-negative
controls. The audit's job was to decide whether the instrument could be trusted;
it found three defects and two of them would have invalidated the measurement.

**M155-B: PASS** (evaluation validity, not product quality — §88). Complete 100/100
coverage on all five sides, provenance valid, gold/token/latency metrics computed,
case-level changes attributed, no contamination.

**M155-C: PASS** (§89). All four adjacent transitions are protocol-compatible and
provenance-safe; all five anchors executed faithfully under the modern evaluator
with no old product code modified. Bounded-scope limitation recorded: M129 and
M140 have no `symbol_mechanism_facts` table at all, so era-specific capabilities
are reported as capability differences rather than as zeros.

**M155-D: DEFERRED**, **M155-E: NOT RUN** — by decision, pending this report.

### Broad retrieval-trend verdict: **NEUTRAL / MIXED**

Not a product-utility verdict. On the broadest, freshest, fairest instrument the
project has: delivered gold 79% → 78%, symbol recall exactly flat, Top-3 flat,
Top-1 +1 point, tokens −20 median, latency +19% median (M129 → M154). Three
regressions, zero unique outcome improvements that reach the model. The one
apparent gain does not survive being asked whether the agent could see it.

M129–M154's local wins did **not** accumulate into broad improvement on
unfamiliar tasks. They also did not broadly regress: correctness and containment
milestones (M152, M154) are clean, and the safety work is real.

## Limitations

1. Gold = patch-modified files. §19's caution applies: a non-gold lead is not
   necessarily wrong, so `misleading lead` (41%) is an upper bound on harm, not a
   measurement of it.
2. `discarded` is treated as not-delivered based on the scorer's documented
   product framing.
3. Latency was measured by a separate read-only probe (3 repetitions, per-case
   median) because the eval records no timing; it is not folded into any semantic
   hash, per the M122 convention.
4. No live agent evidence. Nothing here says whether an agent benefits.
5. Change attribution is deliberately conservative and defaults to `unknown`
   (§52); 2 of 148 outcome-changed cases are `unknown`.

## Recommended next step

The evidence points away from more retrieval features and toward two things:

1. **Run D at reduced scope on the honest protocol.** A paired baseline-vs-VTRACE
   run answers the only question B/C cannot: whether injected context helps an
   agent even when gold ranking is unchanged. B/C give it interpretive context —
   for 11 missing-gold and 11 discarded-gold cases a loss is a retrieval
   deficiency; for the 78% delivered, a loss is an interaction problem.
2. **Re-baseline the regression suite before any further retrieval work.**
   Frozen50 cannot observe the index-side changes it is being used to police
   (A2) and is markedly easier than the broad corpus. Steering by it is how five
   eras of local wins produced a flat broad result.

`search_symbols` and richer result/effect semantics are **not** justified by this
evidence and were not built (§78/§79). No product code changed (§114).

## Artifacts

`stage5_m155_protocol.json` · `stage5_m155_protocol_audit.md` ·
`stage5_m155_cli_inventory.md` · `stage5_m155_task_manifest.json` ·
`stage5_m155_detector_validation.json` · `stage5_m155_retrieval_m154.json` ·
`stage5_m155_retrieval_summary.md` · `stage5_m155_retrieval_case_ledger.json` ·
`stage5_m155_historical_checkpoints.json` ·
`stage5_m155_historical_comparison.json` ·
`stage5_m155_historical_changed_cases.json` · `stage5_m155_latency_trend.json` ·
`stage5_m155_legacy_suite_projection.json` ·
fixture `retrieval_eval.m155_broad_100.json` · runners
`run_stage5_m155_latency_probe.ts`, `run_stage5_m155_analysis.ts` (+ tests).

Large raw artifacts (500 indexes, per-side corpora, paired row dumps) remain
outside the repository under `/home/calvin/bench/vtrace-m155/`.
