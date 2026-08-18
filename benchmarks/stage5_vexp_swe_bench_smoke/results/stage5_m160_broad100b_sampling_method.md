# Broad100-B — sampling method

Frozen before any retrieval ran. Manifest hash
`68854de565119a1497904b11edf1d4cb7268fc239fd8ec5bdaca8aefd6897cff`.

## 1. Why a new corpus was constructible at all

Broad100-A is **exactly** the 100 rows of the vexp harness's
`data/swe-bench-100.jsonl` — verified by reconstructing its membership from the
committed fixture rather than from any summary. So the "remaining eligible
population" that §10 asks Broad100-B to be drawn from does not exist in that file:
subtracting Broad100-A from it leaves zero.

It exists only because Broad100-A turns out to be a **strict subset of SWE-bench
Verified** (100 of 500), whose parquet is already in the local HuggingFace cache.
That keeps Broad100-B inside the same benchmark family as Broad100-A (§12) instead
of quietly changing benchmarks, and leaves 400 genuinely unconsumed instances.

`m160_extract_swe_bench_verified.py` materializes those 500 rows to JSONL sorted
by `instance_id`, so the extraction is byte-reproducible; the corpus file itself is
a large raw artifact and is never committed, only hashed.

## 2. Population, with every drop counted

| stage | count |
| --- | ---: |
| SWE-bench Verified | 500 |
| − already consumed as Broad100-A | −100 |
| − metadata-ineligible | −0 |
| **candidate pool** | **400** |
| − corpus-integrity failures | −0 |
| **eligible after the gate** | **400** |
| selected | **100** |

Metadata eligibility drops an instance with no local bench clone, no base commit,
no problem statement, no gold source file, no gold file inside the archived
subtree, or whose gold is *entirely* files the patch creates. None of the 400
tripped any of these — but the checks exist because two of them (subtree scope and
created-file gold) would otherwise manufacture phantom product failures. The one
instance in the pool whose patch creates a gold file alongside three it edits
(`astropy-13398`) is **kept**: the scorer takes the best rank over any gold file,
so three retrievable golds make it a valid retrieval instance.

## 3. The integrity gate ran before selection, over the whole pool

§22 asks for `Verified − Broad100-A − invalid` *before* sampling, and the gate is
cheap enough to honour that literally: a depth-1 fetch of the base commit plus
`git ls-tree` answers "does the gold file exist at this revision?" with no
checkout and no index. All 400 were gated, not a sampled cohort, so no instance
is ever swapped in afterwards to keep the count round (§17).

**The gate's first run was wrong, and the way it was wrong is worth recording.**
It returned 16 `CORPUS_INVALID` verdicts, every one `REVISION_UNAVAILABLE`, spread
across 8 unrelated repositories. Every one of them fetched successfully on a
manual retry seconds later. A transient network error was being written down as a
permanent statement about the benchmark. With bounded retries (4 attempts,
1s/3s/8s backoff) the gate returns **400 VALID, 0 CORPUS_INVALID**. One attempt is
not a measurement — and an unretried flake would have biased the pool the corpus
is drawn from, in a milestone whose entire purpose is an unbiased draw.

Gold paths are resolved with the evaluator's own `fileMatches`, not a second
comparator (§24), and gold-file existence is used only to decide eligibility — the
path is never handed to VTRACE, which receives the ordinary derived task text
(§25).

## 4. Selection is balanced, not proportional

Broad100-A is 44% django. A proportional draw from the remaining Verified
population would be 47% django. Either way, roughly half the corpus would be one
repository — and the question M160 exists to answer is whether a causal mechanism
is repository-*general* (§19), with §55 explicitly valuing "5 cases / 4 unrelated
repos" over "8 cases / 1 repo" and §56 refusing to build on a ceiling that is
mostly one repository. A corpus that concentrates half its evidence in one place
has little power to settle that.

So the quota fills every eligible repository **equally**, bounded by what each
repository actually has, redistributing the shortfall from small repositories:

| repository | pool | quota |
| --- | ---: | ---: |
| django/django | 187 | 11 |
| sympy/sympy | 58 | 10 |
| sphinx-doc/sphinx | 37 | 11 |
| scikit-learn/scikit-learn | 30 | 11 |
| matplotlib/matplotlib | 27 | 11 |
| astropy/astropy | 17 | 11 |
| pydata/xarray | 16 | 11 |
| pytest-dev/pytest | 15 | 11 |
| pylint-dev/pylint | 8 | 8 |
| psf/requests | 4 | 4 |
| mwaskom/seaborn | 1 | 1 |

Sympy lands at **10%**, below both its natural pool share (14.5%) and its
Broad100-A share (17%) — the balanced rule is not a disguised way of oversampling
the repository the old theory came from (§18).

Within a repository, the quota splits across the published `difficulty` strata in
proportion to that repository's own profile (largest remainder), so each
repository keeps its difficulty shape. Within a stratum, members are ordered by
`sha256("VTRACE-M160-Broad100-B-v1:" + instance_id)` and taken from the front.

That hash order is the seed §16 asks for, in a form with a useful property: it is
a **fixed permutation of the pool**, so the sample does not depend on iteration
order, on how many draws preceded it, or on any PRNG state. The same pool always
yields the same 100.

**Nothing in the rule consults VTRACE.** Repository, difficulty, patch and problem
statement are all published benchmark metadata; no retrieval ran until after the
manifest was written (§13, §27).

## 5. What Broad100-B inherits rather than improves

Workspace preparation reproduces Broad100-A's protocol exactly, including an
asymmetry it would be tempting to fix: **django is archived from its `django/`
package directory** (~830 .py files, no `tests/`, `docs/` or `scripts/`), while
every other repository is archived from its root. Changing that here would
confound a protocol change with the replication result (§119), so it is inherited
and stated instead.

Task text, intent, budget, label source and gold-label extraction all come from
`buildGoldRow` — the identical function that built Broad100-A's rows — so the only
thing that differs between the two corpora is which instances they contain (§34).

## 6. What is NOT claimed

This is not a VEXP comparison. It reproduces none of VEXP's task list, sampling,
model, budget or agent protocol (§15). It is VTRACE-internal generalization
evidence.

Aggregate rates are **not** directly comparable to Broad100-A's, because the
repository mix differs by design. M160-E therefore reports the comparison twice —
raw, and with Broad100-B's per-repository rates reweighted to Broad100-A's mix —
and treats neither alone as the answer (§64, §66).
