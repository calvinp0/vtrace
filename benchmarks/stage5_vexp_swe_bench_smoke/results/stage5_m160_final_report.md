# M160 — Independent Broad Retrieval Generalization

```
M160 overall verdict: PASS

A  PASS   Broad100-B constructed, integrity-gated and frozen
B  PASS   frozen product qualified across it
C  PASS   27/27 residuals localized, 0 unexplained
D  PASS   populations subtyped; bridge intervention simulated on both corpora
E  PASS   cross-corpus comparison complete; decision derived from evidence

replication verdict:            PARTIAL REPLICATION
subject→owner / result-effect:  NOT REPLICATED — do not build
functional decision:            NO_SINGLE_DOMINANT_CEILING — RECONSIDER STRATEGY

product code changed: NO
```

A clean falsification is a PASS (§96). M160 set out to discover whether M159's
causal picture was a property of VTRACE or of a hundred tasks that five milestones
had read. It is partly the first and substantially the second, and that is the
result — not a disappointment to be worked around.

---

## 1. Repository state

| | |
| --- | --- |
| M159 predecessor (evidence) | `f15b274d8f86dceed9154c4528c719da9e1b3f1e` |
| M159 commits | `2d90280a753b19c60827ba8038398781332ab8d7`, `ed6c6d8bb439499b9d31931e4516af13878d1698`, `5cd15b81f005d1a448d80f3757569d61f3db2828`, `f15b274d8f86dceed9154c4528c719da9e1b3f1e` |
| M158 final functional | `b7ba0381850174ccf55844edc96f3dc8d7c1de0c` |
| M160 corpus commit | `227b6fbebf` — *Freeze an independent broad retrieval corpus* |
| M160 evidence commit | `3c3c14d3` — *Test the residual retrieval theory on an unfamiliar corpus* |
| branch / ahead / behind | `main` / 52 / 0 |
| pushed | NO |
| co-author trailers | NONE |
| product code changed | **NO** — `git status --porcelain src/` empty throughout |
| worktrees | 14 pre-existing, 0 created, 0 removed |
| unrelated dirt preserved | yes — `stage5_outcome_ledger.{json,md}` untouched |

---

## 2. Corpus construction

Broad100-A's identity was recovered mechanically from its committed fixture, not
from any summary, and the recovery produced the fact the whole milestone turned
on: **Broad100-A is exactly the 100 rows of the vexp harness's
`swe-bench-100.jsonl`.** Subtracting it from that file leaves nothing. A disjoint
corpus exists only because Broad100-A is a strict subset of SWE-bench Verified.

| | |
| --- | --- |
| Broad100-A | 100 cases, manifest hash `7c6324757d02…` |
| eligible remaining population | 400 (Verified 500 − Broad100-A 100 − 0 metadata-ineligible) |
| integrity failures | **0** |
| Broad100-B frozen size | **100** |
| overlap with Broad100-A | **0**, asserted mechanically |
| repositories | 11 |
| strata | repository × published `difficulty` |
| selection seed | salt `VTRACE-M160-Broad100-B-v1`, hash-order permutation |
| manifest hash | `68854de565119a1497904b11edf1d4cb7268fc239fd8ec5bdaca8aefd6897cff` |

Selection is balanced rather than proportional — max 11 cases from any repository
against Broad100-A's 44 from django — because the question is whether a mechanism
is repository-*general* and half a corpus in one repository cannot answer it.
Sympy lands at 10%, below both its pool share (14.5%) and its Broad100-A share
(17%).

### The integrity gate was wrong the first time, and that is the finding

Its first full run returned 16 `CORPUS_INVALID` verdicts, every one
`REVISION_UNAVAILABLE`, across 8 unrelated repositories. Every single one fetched
successfully on a manual retry seconds later. A transient network error was being
written down as a permanent statement about the benchmark. With bounded retries:
**400 gated, 400 valid, 0 invalid.**

Left unfixed it would have deleted 16 instances from the draw and reported the
deletion as a property of SWE-bench — the same error M159 found running the other
way, when a broken fixture was reported as a VTRACE failure.

---

## 3. Preparation reproduced Broad100-A's contamination, live

Broad100-A carries two instances — `django-13590` and `django-15572` — whose
extraction stopped part-way through the tree. Confirmed independently here in
A's own pinned corpus: 442 and 477 `.py` files against a peer median of 824, gold
file genuinely absent from disk.

The first Broad100-B preparation run reproduced it. **`django-12741`: 1902 of 3381
paths extracted, `tar` exit 0, gold files in the missing 44%.** Thirteen more
workspaces died with `tar: Unexpected EOF`.

The cause is concurrency against a shared bench clone: one worker's `git fetch`
repacks the object store while another streams `git archive` out of it. An index
over a half-tree builds perfectly well, and nothing downstream of preparation can
tell. That is almost certainly how the two Django instances entered Broad100-A,
where they then counted as VTRACE retrieval failures for two milestones.

Three layers now stand between that and a measurement: work is serial within a
repository, fetches disable auto-gc, and **every workspace is verified path-by-path
against `git ls-tree` at its own base commit before it is indexed**, with a
missing in-scope gold file retried and then refused. Final preparation:

```
100/100 usable — 89 VALID, 11 DEGRADED_VALID, 0 refused
14 workspaces needed a retry; the serial repair pass converged the last 2
```

`INDEX_FILE_MISSING` is 2/1 on Broad100-A and **0/0 on Broad100-B**. Both A cases
were the corpus defects; B's gate stopped their equivalents from ever entering.

---

## 4. Broad100-B quality

Valid denominator **100/100** (every frozen case scored; none refused).

| metric | Broad100-A | Broad100-B | B reweighted to A's repo mix |
| --- | ---: | ---: | ---: |
| gold file Top-1 | 0.58 | **0.41** | 0.44 |
| gold file Top-3 | 0.74 | **0.64** | 0.66 |
| gold file anywhere | 0.89 | **0.87** | 0.92 |
| gold symbol anywhere | 0.64 | **0.63** | 0.60 |
| gold delivered | 0.79 | **0.71** | 0.70 |
| gold symbol delivered | — | 0.43 | — |
| empty contexts | 0.01 | 0.01 | 0.01 |
| misleading lead | — | 0.58 | — |
| tokens mean / median / p90 | 1659 / 1181 / 3750 | **2145 / 1497 / 4539** | 1610 / 1181 / 2880 |

Latency (capsule build): mean 711 ms, median 588 ms, p90 1552 ms.
Index build: 71 804 files, 1 325 858 symbols, median 38 s per workspace, 8.9 GB.

**Reweighting explains almost none of the Top-1 gap.** Correcting Broad100-B's
per-repository rates to Broad100-A's mix moves Top-1 from 41% to 44%, against A's
58%. Broad100-B is genuinely harder, not merely differently composed.

The shape of the difference matters more than its size: `gold anywhere` is 87%
against 89%, but `gold delivered` is 71% against 79% and Top-1 is 41% against 58%.
**Retrieval finds gold on unfamiliar tasks at nearly the same rate and leads with
it far less often.**

Availability (§32, §81): 89 usable, 11 usable-and-degraded, **0 unavailable**, with
81 contained per-file Python parse failures. M156's containment invariant holds —
no single unparseable file made a repository unavailable. No benchmark quarantine
was used or reintroduced (§31).

### Gold fate

| fate | Broad100-A | Broad100-B |
| --- | ---: | ---: |
| delivered as pivot | 68 | 58 |
| delivered as support | 11 | 13 |
| support packed out | 9 | 14 |
| never retrieved | 11 | 13 |
| no-pivot withheld | 1 | 1 |
| role denied | 0 | 1 |
| corpus invalid | — | 0 (excluded before scoring) |

---

## 5. First divergence — 27 of 27 localized, 0 unexplained

| first divergence | Broad100-A cases/repos/rate | Broad100-B cases/repos/rate |
| --- | --- | --- |
| LANE_GENERATION_FAILURE | 8 / 4 / 8.2% | 8 / 5 / 8.0% |
| CANDIDATE_GENERATION_POOL_BOUND | 6 / 5 / 6.1% | 8 / 6 / 8.0% |
| CANDIDATE_BOUND_EVICTION | 3 / 3 / 3.1% | 6 / 5 / 6.0% |
| SUPPORT_PACKING | 0 / 0 / 0% | 4 / 3 / 4.0% |
| INDEX_SYMBOL_MISSING | 1 / 1 / 1.0% | 1 / 1 / 1.0% |
| INDEX_FILE_MISSING | 2 / 1 / 2.0% | 0 / 0 / 0% |
| GROUND_TRUTH_*, QUERY_INTERPRETATION, LANE_NOT_ELIGIBLE, LANE_NOT_ACTIVATED, CANDIDATE_NOT_ADMITTED, INDEX_RELATION_MISSING, INDEX_SEMANTIC_FACT_MISSING, RELEVANCE_RANKING, ROLE_AUTHORITY, NO_PIVOT_GATE, SERIALIZATION_CONSUMER, OTHER | 0 | 0 |

Denominators differ in kind, not size: Broad100-A is 100 historical / **98
integrity-qualified**, Broad100-B is 100 valid. Rates above use each corpus's own
valid denominator (§66, §67). The historical 79/100 is not rewritten.

`RELEVANCE_RANKING` and `QUERY_INTERPRETATION` remain **zero on both corpora** —
two independent corpora now say the residual losses are not ranking problems and
not query-understanding problems.

---

## 6. Lane-generation subtypes — where the theory dies

| subtype | Broad100-A | Broad100-B |
| --- | --- | --- |
| SUBJECT_OWNER + RESULT_EFFECT | 3 (sympy 67%) | 1 (matplotlib) |
| RESULT_EFFECT | 2 (sympy 100%) | 1 (scikit-learn) |
| SUBJECT_OWNER | 1 (pylint) | 1 (matplotlib) |
| SUBJECT_UNREPRESENTED | 2 / 2 repos | **5 / 4 repos** |
| **sympy share of the theory subtypes** | **5 of 6** | **0 of 3** |

The class replicates; the mechanism inside it inverts. Broad100-A's largest
residual population is subject-owner/result-effect and is sympy-borne.
Broad100-B's is *the query naming no identifier the index represents at all* —
there is nothing to bridge **from** — across four unrelated repositories, and sympy
contributes no lane-generation failure whatsoever.

### The intervention simulation settles it

The most favourable concrete form of the bridge — admit the members of every class
the query names, including inherited members, and credit recovery if gold is
produced *at all* at any rank:

| | targets | recovered | repos | median candidates admitted |
| --- | ---: | ---: | ---: | ---: |
| Broad100-A | 6 | **0** | 0 | 0 |
| Broad100-B | 3 | 1 | 1 | 45 |

Five of Broad100-A's six targets — including all four sympy cases — have **no
starting point**: the query names no class the index represents. The single
Broad100-B recovery (`scikit-learn-13142`: task names `GaussianMixture`, gold is
the inherited `BaseMixture.fit_predict`) costs 45 injected candidates against a
product pool of 25; `matplotlib-20859` would inject 132 and still miss.

Bound-family interventions, simulated identically on both corpora:

| intervention | A recovered/targets | B recovered/targets | verdict |
| --- | ---: | ---: | --- |
| POOL_CAP_25_TO_50 | 0/3 | 1/6 | NEW_ON_B_ONLY |
| POOL_CAP_25_TO_100 | 0/3 | 1/6 | NEW_ON_B_ONLY |
| GENERATION_POOL_WIDENING | 0/6 | 2/8 | NEW_ON_B_ONLY |
| INDEX_NESTED_FUNCTIONS | 1/1 | 1/1 | RECOVERS_BOTH_CORPORA |
| CORPUS_REPAIR | 2/2 | 0/0 | REJECTED_CORPUS_SPECIFIC |
| SUBJECT_OWNER_BRIDGE | 0/6 | 1/3 | INSUFFICIENT_BREADTH |

The delivery ceiling is **rank 30 on both corpora** (547 delivered items on B, 570
on A). M159's refutation of bound-widening survives replication: nothing beyond
rank 30 is ever delivered, so candidates available only deeper cannot be reached
however large the pool. `INDEX_NESTED_FUNCTIONS` recovers 1 case on each corpus —
real, but a two-case population is not a milestone.

### Query language of the residual cases (evaluator analysis only)

Broad100-A lane-generation: 5 identifier-driven, 2 behaviour-driven, 1
result/effect-driven. Broad100-B: 5 identifier-driven, 3 behaviour-driven. No
query heuristic was added to the product.

---

## 7. Detector controls — 14/14, plus one correction that changed a conclusion

| detector | result |
| --- | --- |
| gold path matching | 7/7, including the cases naive equality gets wrong |
| gold-file integrity | 2/2, including the django-13590 truncation shape |
| delivery cross-check (scorer vs reconstruction) | 100 cases, **0 disagreements** |
| lane generation | 8/8 internally consistent |
| candidate bound | 6/6 internally consistent |
| index symbol presence | 1/1 |
| pre-cap replication downgrade | 4/27 unvalidated, **all 4 marked low confidence** |
| **generation reach** | **60/71 — 11 known-positive misses** |

Two honest limitations, both recorded rather than smoothed:

**The reach detector's blind spot is larger on B.** 11 of 71 delivered cases are
invisible to `evaluatedById` (A: 1 of 43), and lane-injected deliveries are 44
against A's 22 — post-hybrid lanes simply carry more delivery on Broad100-B.
M159's safety argument was that `taskNamesGoldSymbol` was false in all its
unreachable residuals; on Broad100-B it is true in 2 of 8, of which one
(`matplotlib-20859`) is the meaningless `__init__` and one
(`scikit-learn-13142`) is substantive. So for one case, `UNREACHABLE_BY_GENERATION`
may understate what a post-hybrid lane could reach.

**A detector defect was found and corrected mid-analysis (§44).** The first
subtype classifier short-circuited any task that mentioned a gold symbol, on the
reasoning that naming the symbol removes the need for a bridge.
`scikit-learn-13142` falsified it: the task does say `fit_predict`, but the index
defines `fit_predict` **nine times** and the class the task names inherits it
rather than defining it. Naming an ambiguous method conveys no owner information.
A name now counts only when the index says it is nearly unique, and dunder names
never count. **Audit detector only; no product behaviour touched.** No M159
conclusion is affected — M159 did not use this classifier.

---

## 8. Preservation

| invariant | result |
| --- | --- |
| §83 `sphinx-9320` pivot refill | **byte-identical** capsule shape |
| §84 `django-11740` no-pivot diagnostic | **byte-identical** |
| §115 `xarray-6599` support composition | **byte-identical** |
| §85 duplicate support | 0 slots on A (matches M158 candidate), 0 on B |
| §85 negative control (distinct same-name support still delivered) | 6 on A, 7 on B |
| §86 `<module>` deliveries | 0 on A, 0 on B |
| §87 behavioural routing | OFF (env-gated, never enabled) |
| §88 session isolation | preserved; M160 wrote to no evidence index |
| §89 index writes during retrieval | 0 on A, 0 on B |
| §90 `.vtrace` staged / tracked | 0 / 0 |
| §90 tracked ignore changes | 0 |
| §90 global git config mutations | 0 |
| §91 runner overwrite safety | every M160 runner writes an explicit `stage5_m160_*` path |

---

## 9. Verification

```
bun run typecheck              PASS
bun run typecheck:benchmarks   PASS
bun test                       4895 pass · 49 skip · 0 fail (317 files, 149s)
git diff --check               clean
```

Tests were run on an idle machine (load 1.2) with no indexer in flight; no
load-induced rerun was needed.

---

## 10. The answers, without hedging

> **Did the dominant residual retrieval ceiling discovered in Broad100-A
> generalize to Broad100-B?**

**No.** The first-divergence *class* did — `LANE_GENERATION_FAILURE` is 8 cases on
both corpora, at 8.2% and 8.0%, and on Broad100-B it spans one more repository. But
the *mechanism* M159 proposed inside that class did not. Its share of the class
falls from 6/8 to 3/8, its sympy weighting falls from 5-of-6 to zero, and the
dominant Broad100-B subtype is a different failure entirely — the query naming
nothing the index represents.

> **Is another deterministic retrieval feature milestone justified?**

**No.** Broad100-B's 27 residuals spread over 5 first-divergence classes and 11
repositories; the largest single mechanism is 5 cases. Every bound intervention was
simulated on both corpora and none recovers more than 2 cases. The subject→owner
bridge, given every advantage, recovers **0 of 6** on the corpus that produced the
theory.

> **If no, should VTRACE return to end-to-end live agent utility qualification
> instead of further deterministic retrieval tuning?**

**Yes.** Five milestones of internal gold metrics have converged on heterogeneous,
small, mutually unrelated residual populations. M155 found broad retrieval flat
across M129→M154 and deferred the live paired qualification; M156–M159 fixed four
real defects without moving the broad metric; M160 now shows the remaining defects
do not share a cause worth building against. The measurement that has never been
cleanly completed for this product generation is whether any of it changes what a
coding agent does.

**That run spends money and requires explicit authorization. It was not started.**

---

## 10a. Corpus lifecycle — Broad100-B is reproducible, not resident

The derived Broad100-B state was **deleted after closure** (§93). Removed:

```
benchmarks/stage5_vexp_swe_bench_smoke/results/workspaces/m160_broad_b
100 workspaces · 8.9 GB reclaimed
```

Nothing tracked lived under it — the path is gitignored and carried zero tracked
files. Broad100-A's pinned corpus is at a separate path and is untouched.

What remains committed is everything the corpus IS, as opposed to everything it
produced: the frozen manifest with all **100 base commits** (40-char, verified
complete), the integrity audit, the exclusion ledger, the corpus and manifest
hashes, the preparation protocol and its runner, the fixture, and every result —
metrics, gold fate, case traces, first divergence, subtypes, simulations. The raw
Verified corpus file (7.8 MB) is kept as well, since re-extracting it needs
`pyarrow`.

Rebuild:

```bash
R=benchmarks/stage5_vexp_swe_bench_smoke
# only if results/_m160_corpus/swe_bench_verified.jsonl is missing:
uv run --with pyarrow python $R/m160_extract_swe_bench_verified.py \
  --out $R/results/_m160_corpus/swe_bench_verified.jsonl
bun $R/run_stage5_m160_prepare_workspaces.ts --concurrency 6   # ~25 min, network
```

The manifest is the input, so membership cannot drift on a rebuild. **Verified
after deletion** rather than assumed: rebuilding `psf__requests-1766` and
`django__django-11603` from the committed manifest alone reproduced their
committed records exactly — 76 files / 1022 symbols and 828 files / 14538 symbols
respectively, with identical availability and expected-path counts.

---

## 11. Standing findings

- **A causal distribution can replicate while its mechanism does not.** All three
  of Broad100-A's largest first-divergence classes reappear on unfamiliar tasks at
  comparable rates — and the story M159 told about the largest of them survives
  none of it. Class-level replication is cheap; mechanism-level replication is what
  a feature needs, and only subtyping both corpora tells them apart.

- **The corpus that produced a theory is the worst place to test its cure.** The
  subject→owner bridge recovers 0 of 6 on Broad100-A, because 5 of those 6 queries
  name no class at all. The theory was built from cases it structurally cannot
  address. Nothing but simulating the actual intervention over the actual
  population would have exposed that — M158's lesson, one level up.

- **Benchmark preparation is a measurement instrument and fails like one.** Two
  Broad100-A instances were half-extracted, and M160 reproduced the failure live
  (`django-12741`, 1902 of 3381 paths, tar exit 0) plus 13 more. The mechanism is
  a fetch repacking a clone while an archive streams from it. A per-path
  completeness check against `git ls-tree` costs milliseconds and is the only
  thing standing between that and a silent retrieval "failure".

- **One attempt is not a measurement.** The integrity gate's first run declared 16
  instances invalid across 8 repositories; all 16 fetched on retry. Both times a
  transient error nearly became a permanent claim about the benchmark — once
  against the corpus, once against the product.

- **Naming a symbol is not naming its owner.** `fit_predict` has nine definitions
  in scikit-learn, and the class the task names inherits it. Any detector — or
  product lane — that treats a mentioned identifier as an owner handle will be
  wrong exactly where inheritance does the work.

- **Retrieval's gap on unfamiliar tasks is in delivery, not discovery.** `gold
  anywhere` barely moves between corpora (89% → 87%) while Top-1 falls 58% → 41%
  and delivery 79% → 71%, and repo-mix reweighting explains ~3 of those 17 points.
  The product finds the right file and leads with the wrong one — which is not a
  first divergence any of the six classes names.
