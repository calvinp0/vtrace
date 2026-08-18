# M160 functional decision

## Decision

```
NO_SINGLE_DOMINANT_CEILING — RECONSIDER STRATEGY
```

No product code changed in M160, and none should change on the strength of this
evidence.

## The three questions, answered separately

**§68 — does the M159 first-divergence distribution replicate?**

```
PARTIAL REPLICATION
```

The *classes* replicate well. The three largest Broad100-A populations all
reappear on an unfamiliar, disjoint corpus at comparable or higher rates, and
across MORE repositories:

| first divergence | Broad100-A | Broad100-B |
| --- | --- | --- |
| LANE_GENERATION_FAILURE | 8 cases / 4 repos · 8.2% | 8 cases / 5 repos · 8.0% |
| CANDIDATE_GENERATION_POOL_BOUND | 6 / 5 · 6.1% | 8 / 6 · 8.0% |
| CANDIDATE_BOUND_EVICTION | 3 / 3 · 3.1% | 6 / 5 · 6.0% |
| SUPPORT_PACKING | 0 / 0 · 0% | 4 / 3 · 4.0% |
| INDEX_SYMBOL_MISSING | 1 / 1 · 1.0% | 1 / 1 · 1.0% |
| INDEX_FILE_MISSING | 2 / 1 · 2.0% | 0 / 0 · 0% |

It is partial rather than strong for three reasons. `SUPPORT_PACKING` is a
population Broad100-A did not have at all. `INDEX_FILE_MISSING` disappears — both
Broad100-A cases were the corpus defects M159 identified, and Broad100-B's
integrity gate prevented their equivalents from ever entering. And, most
importantly, the *mechanism* inside the largest class does not carry over.

**§69 — is the subject→owner / result-effect theory independently replicated?**

```
NOT REPLICATED — DO NOT BUILD
```

Three independent measurements say so.

*The subtype composition inverts.* Broad100-A's lane-generation population is 6 of
8 subject-owner/result-effect, and 5 of those 6 are sympy. Broad100-B's is 3 of 8,
across matplotlib and scikit-learn, with **zero** sympy — sympy contributes no
lane-generation failure on Broad100-B at all. The dominant Broad100-B subtype is
something else entirely: 5 of 8 cases across 4 repositories where the query names
no identifier the index represents, so there is no subject to bridge *from*.

*The sympy weighting M159 flagged was the whole signal.* §56 said a ceiling that is
still mostly one repository must not be built on. On unfamiliar tasks, that
repository's contribution to this mechanism is 0%.

*And the intervention recovers nothing where the theory came from.* The most
favourable concrete form of the bridge — admit the members of every class the
query names, including members inherited from base classes, and count recovery if
the lane produces gold *at all*, at any rank — gives:

| | targets | recovered | repos | median candidates admitted |
| --- | ---: | ---: | ---: | ---: |
| Broad100-A | 6 | **0** | 0 | 0 |
| Broad100-B | 3 | **1** | 1 | 45 |

Five of Broad100-A's six target cases, including all four sympy ones, have **no
starting point**: the query names no class the index represents, so a class-member
bridge cannot begin. The one Broad100-B recovery, `scikit-learn-13142`, is real
and is exactly the predicted shape — the task names `GaussianMixture`, the gold is
`BaseMixture.fit_predict`, and the class inherits rather than defines it — but it
costs 45 injected candidates against a product pool of 25, and
`matplotlib-20859` would inject 132 and still miss.

This is M158's lesson repeating one level up: a mechanism that *explains* a set of
failures is not thereby a mechanism whose repair *recovers* them.

**§105 — is another deterministic retrieval feature milestone justified?**

No. Broad100-B's 27 residuals spread across 5 first-divergence classes and 11
repositories; the largest class splits into 4 subtypes of which the biggest is 5
cases. Nothing on the independent corpus reaches the breadth §70 requires. Every
bound-widening intervention was simulated on both corpora and none recovers more
than 2 cases; the delivery ceiling is rank 30 on both, so candidates available only
deeper cannot be reached however large the pool.

## What this does not say

It does not say Broad100-A's analysis was wrong. M159 localized 20 of 20 residuals
with zero unexplained, and every one of those localizations still holds. It says
the *generalization* those localizations invited does not survive contact with
unfamiliar tasks — which is the only thing M160 was convened to find out.

It also does not say retrieval is finished. `gold anywhere` is 87% on Broad100-B
against 89% on Broad100-A, but `gold delivered` is 71% against 79% and Top-1 is 41%
against 58%. Retrieval FINDS gold at nearly the same rate on unfamiliar tasks and
LEADS with it far less often. That gap is not explained by any single first
divergence, which is precisely why no single feature addresses it.

## Recommended next milestone

Not a retrieval feature. §74 and §105 both point the same way, and M155's finding
that broad retrieval has been flat across the M129→M154 era points there too:

> **A fresh paired live agent-utility qualification on the post-M159 product.**

The case for it is that every deterministic signal is now saturated. Five
milestones of internal gold metrics have produced heterogeneous, small, mutually
unrelated residual populations, and the one measurement that has never been cleanly
completed for this product generation is whether any of it changes what a coding
agent actually does. M155 deferred that; M156–M159 fixed real defects without
moving the broad metric; M160 now shows the remaining defects do not share a cause.

**This requires explicit authorization — it spends money and runs live agents. It
is not started in M160.**

If a deterministic milestone is nonetheless wanted first, the honest candidate is
not the subject→owner bridge but the population this milestone actually found:
**5 cases / 4 repositories on Broad100-B where the query names no identifier the
index represents**. That is a query-representation question, not a ranking or bound
question, and it has no Broad100-A counterpart large enough to confirm it — so it
would need its own sealed corpus before implementation, exactly as this one did.
