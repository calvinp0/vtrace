# M159 — Retrieval loss localization and candidate-depth audit

**M159 is PASS**, as an audit milestone. The residual broad100 population is fully
localized with zero unexplained cases, and **no product code changed** — because
no causal population survived its own intervention simulation.

| workstream | verdict |
| --- | --- |
| A — residual reconstruction, ground truth, frozen manifest | **PASS** |
| B — end-to-end first-divergence localization | **PASS** |
| C — causal taxonomy, intervention simulation, decision | **PASS** |
| D — functional candidate | **NOT RUN — correct stop (§89)** |
| E — preservation and verification | **PASS** |

> **Strategic result: MULTIPLE_SMALL_POPULATIONS.**
> The 20 residual failures fragment across 5 causal classes. The largest (8 cases,
> 4 repositories) is a **measured ceiling with no constructible intervention**;
> every intervention that *could* be constructed recovers **zero**.

---

## 1. The question, and the answer

> For every remaining broad100 gold failure, what is the earliest product stage at
> which useful evidence becomes unavailable — and does a large enough
> cross-repository population share it to justify a generic change?

**Localization: complete. Generic intervention: not justified.**

| first divergence | cases | repos | instances |
| --- | ---: | ---: | --- |
| `LANE_GENERATION_FAILURE` | 8 | 4 | django-14792, pylint-4551, pylint-8898, sphinx-9230, sympy-15875, sympy-16597, sympy-20428, sympy-20801 |
| `CANDIDATE_GENERATION_POOL_BOUND` | 6 | 5 | django-17084, matplotlib-24970, matplotlib-25332, pytest-6197, sphinx-9698, sympy-16792 |
| `CANDIDATE_BOUND_EVICTION` | 3 | 3 | django-13810, matplotlib-26466, sphinx-7910 |
| `INDEX_FILE_MISSING` | 2 | 1 | django-13590, django-15572 |
| `INDEX_SYMBOL_MISSING` | 1 | 1 | django-15037 |

```
residual useful cases   20
localized               20 / 20
unexplained              0
```

Every other class in the §106 taxonomy — `QUERY_INTERPRETATION`,
`LANE_NOT_ELIGIBLE`, `RELEVANCE_RANKING`, `ROLE_AUTHORITY`, `NO_PIVOT_GATE`,
`SUPPORT_PACKING`, `SERIALIZATION_CONSUMER`, `OTHER` — is **empty** as a first
divergence. That is the headline correction M159 delivers.

---

## 2. The residual population is not what its bucket names said

M158 closed with two residual groups: 11 "never retrieved" and 9 "support-packed
out, i.e. ranking depth". §7 explicitly forbade assuming they shared a cause.
They do not — but neither is what its name implied.

**The nine were never a ranking population.** In all nine, the gold *symbol* is
absent from the candidate pool entirely. What sits at packed position 22 is a
**different symbol from the same file**. Recovering that slot would deliver a
sibling definition, not the patched one. `goldSymbolCandidates = 0` in **all 20**
residual cases — a number no prior milestone printed, and the one that dissolves
the deep-ranked/never-retrieved distinction the milestone was framed around.

**Six of the eleven "never retrieved" are reachable**, just past a generation
bound. And **two are not benchmark instances at all** (§7 below).

The two groups therefore cross-cut the causal classes rather than aligning with
them, which is exactly why §8's terminology hold was worth keeping.

---

## 3. The measurement that refutes the entire bound family

Every bound intervention assumes something testable: that a candidate admitted
deeper in the pool can still be delivered. So it was tested.

```
delivered items across 100 cases        570
deepest ordinary rank EVER delivered     30
p50 / p90 / p99                     4 / 14 / 25
lane-injected deliveries (no rank)       22
```

The nine bound-population targets become available at ranks:

```
40   51   74   87   110   162   343   369   1058
```

**Not one is inside a range delivery has ever reached, in 570 opportunities.**

| intervention | targets | repos | recovered | verdict |
| --- | ---: | ---: | ---: | --- |
| `NO_CHANGE` | — | — | — | baseline |
| pool cap 25 → 50 | 3 | 3 | **0** | rejected — all 3 past the ceiling |
| pool cap 25 → 100 | 3 | 3 | **0** | rejected — all 3 past the ceiling |
| widen the generation pool | 6 | 5 | **0** | rejected — all 6 past the ceiling |
| index nested functions | 1 | 1 | 1 | 1 case / 1 repo, below §47 |
| corpus repair (benchmark-side) | 2 | 1 | 2 | not a product defect |

Harm is reported honestly rather than comfortingly: a row that recovers nothing is
refuted on recovery before harm matters (§93), and the two unrejected rows report
harm as **NOT MEASURED**, because neither was selected for implementation and no
harm run was performed. Printing `0` there would have been an invention.

This is M158's finding one layer upstream. The bound genuinely does cut these
candidates off; the diagnosis is correct; raising it recovers nothing. §42 stops
being a policy and becomes a measurement.

---

## 4. Three structural hypotheses, each shown its control

§39 asks for repeated structural facts, not repeated words — and the control is
what separates the two.

| discriminator | residual | delivered (control) | verdict |
| --- | --- | --- | --- |
| task never names the gold symbol | 19/20 (95%) | 50/79 (63%) | ENRICHED_NOT_CAUSAL |
| gold symbol is private/dunder | 11/20 (55%) | 32/79 (41%) | ENRICHED_NOT_CAUSAL |
| derived task body is degenerate | 13/20 (65%) | 32/79 (41%) | ENRICHED_NOT_CAUSAL |

The degenerate-body hypothesis is the one worth recording as a **rejection**. On
inspection it looks like the obvious cause — thirteen residual tasks collapse to
`### Bug summary`, `**Describe the bug**`, `(last modified by Tim Graham)`. Then
the control finds the identical degeneracy in a third of the cases that
**succeeded**. A defect most of its victims survive is not the mechanism.

The lexical-handle result is the most informative and still not a rule.
19 of 20 residual cases give retrieval no lexical purchase on the definition that
must change — but so do 50 of the 79 that work. **Necessary, not sufficient.** A
rule built on it would fire on 50 healthy cases to reach 19 sick ones.

What it does establish is where the headroom lives: the behavioural link from a
bug *report* to its implementing definition — the M143-B subject→owner ceiling and
the M153 result/effect ceiling meeting on one corpus.

---

## 5. The nine former "deep-ranked" cases

| instance | repo | usefulness | gold-file rank | gold symbol available at | score | first divergence |
| --- | --- | --- | ---: | ---: | ---: | --- |
| `django-15037` | django | USEFUL_PRIMARY | 9 | never | — | `INDEX_SYMBOL_MISSING` |
| `django-17084` | django | USEFUL_PRIMARY | 26 | 110 | 0.781 | `CANDIDATE_GENERATION_POOL_BOUND` |
| `matplotlib-25332` | matplotlib | USEFUL_PRIMARY | 26 | 343 | 0.253 | `CANDIDATE_GENERATION_POOL_BOUND` |
| `matplotlib-26466` | matplotlib | AMBIGUOUS | 30 | 74 | 0.767 | `CANDIDATE_BOUND_EVICTION` |
| `pylint-8898` | pylint | USEFUL_PRIMARY | 13 | never | — | `LANE_GENERATION_FAILURE` |
| `sphinx-7910` | sphinx | USEFUL_PRIMARY | 28 | 40 | 1.207 | `CANDIDATE_BOUND_EVICTION` |
| `sphinx-9698` | sphinx | USEFUL_PRIMARY | — | 87 | 1.057 | `CANDIDATE_GENERATION_POOL_BOUND` |
| `sympy-16597` | sympy | PATCH_GOLD_NOT_USEFUL | 17 | never | — | `LANE_GENERATION_FAILURE` |
| `sympy-16792` | sympy | USEFUL_PRIMARY | — | 1058 | 0.372 | `CANDIDATE_GENERATION_POOL_BOUND` |

**Is the current ranking reasonable? Yes, in all nine** (§30). Every one of these
gold symbols is either absent from the pool or available only past a depth the
delivery layer has never reached. Withholding them is the ranking behaving
correctly, not a defect.

`django-15037` is the sharpest case: its gold `table2model` is a **nested function
inside the command handler** and is not represented as an indexed symbol at all.
Its gold-*file* candidate sits at rank 9 — comfortably inside every bound — which
is precisely how it wore a packing failure's clothes for two milestones.

---

## 6. The eleven former "never retrieved" cases

| instance | repo | usefulness | file indexed | symbol indexed | available at | first divergence |
| --- | --- | --- | --- | --- | ---: | --- |
| `django-13590` | django | GROUND_TRUTH_ERROR | **no** | no | — | `INDEX_FILE_MISSING` |
| `django-13810` | django | USEFUL_PRIMARY | yes | yes | 51 | `CANDIDATE_BOUND_EVICTION` |
| `django-14792` | django | USEFUL_PRIMARY | yes | yes | never | `LANE_GENERATION_FAILURE` |
| `django-15572` | django | GROUND_TRUTH_ERROR | **no** | no | — | `INDEX_FILE_MISSING` |
| `matplotlib-24970` | matplotlib | USEFUL_PRIMARY | yes | yes | 369 | `CANDIDATE_GENERATION_POOL_BOUND` |
| `pylint-4551` | pylint | AMBIGUOUS | yes | 6/9 | never | `LANE_GENERATION_FAILURE` |
| `pytest-6197` | pytest | AMBIGUOUS | yes | yes | 162 | `CANDIDATE_GENERATION_POOL_BOUND` |
| `sphinx-9230` | sphinx | USEFUL_PRIMARY | yes | yes | never | `LANE_GENERATION_FAILURE` |
| `sympy-15875` | sympy | USEFUL_PRIMARY | yes | yes | never | `LANE_GENERATION_FAILURE` |
| `sympy-20428` | sympy | USEFUL_SUPPORT | yes | 1/3 | never | `LANE_GENERATION_FAILURE` |
| `sympy-20801` | sympy | USEFUL_PRIMARY | yes | yes | never | `LANE_GENERATION_FAILURE` |

"Never retrieved" was never a parser story (§65). Nine of the eleven have their
gold file indexed, and eight have the gold symbol indexed too. The loss is
retrieval semantics, not representation coverage — with two exceptions that are
not retrieval at all.

---

## 7. Benchmark validity — two invalid instances (§102)

`django-13590` and `django-15572` were checked out **without the package subtree
containing their gold file**.

```
django-13590   442 indexed files;  no core/, db/, template/, utils/ trees
django-15572   477 indexed files;  no core/, db/, template/, utils/ trees
peer django cases                 827 – 869 indexed files
```

- **Invalid prior result:** both counted as `never_retrieved` retrieval failures in
  M157, in M158, and in M159's own first reconstruction.
- **Corrected result:** both are **invalid benchmark instances**. Retrieval cannot
  surface a file the corpus never materialised, so they carry no retrieval headroom.
- **Known-positive control:** the same on-disk probe over all 100 cases finds the
  gold file present in **98**. The defect is bounded, not systemic.

**Not repaired, deliberately.** The M156 corpus is the immutable target every
M156–M159 paired comparison rests on; re-materialising two workspaces mid-audit
would break comparability (§96). Nominated as its own milestone.

Per §96 the historical metric is reported unchanged, with the qualified reading
stated beside it and never substituted for it:

```
historical (unchanged, comparable)   gold delivered 79 / 100
retrieval-attributable (qualified)   gold delivered 79 /  98
```

---

## 8. Ground truth — patch gold is not the same thing as useful evidence (§95)

| label | cases |
| --- | ---: |
| `USEFUL_PRIMARY` | 13 |
| `USEFUL_SUPPORT` | 1 |
| `PATCH_GOLD_BUT_NOT_USEFUL_CONTEXT` | 1 |
| `AMBIGUOUS` | 3 |
| `GROUND_TRUTH_ERROR` | 2 |

`sympy-16597`'s patch spans six files, two of whose gold symbols
(`get_known_facts_cnf`, `get_known_facts_dict`) live in `ask_generated.py` — a
**machine-generated fact table**. Nobody orients by reading a generated CNF table;
retrieving it would spend a slot to deliver noise. The three `AMBIGUOUS` cases are
auto-derived symbol lists mixing the real fix site with unrelated hunks
(`pytest-6197` carries 14 symbols including bare `obj`, `collect`, `__init__`).

So **16 of 20 residual failures are genuine useful-context misses**; 2 are corpus
defects and 1 is a label that should not be optimised toward. Broad retrieval
quality is modestly better than raw gold fate implies — stated as a qualification,
never as a replacement for the metric (§96).

---

## 9. Benchmark-detector validity, including the control that failed

Three detectors carry positive controls. One of them **failed and was fixed rather
than buried**.

| control | result |
| --- | --- |
| path matcher (`fileMatches`) | 6/6 — package-root stripping positive, non-boundary-suffix negative |
| pre-cap replication vs the capsule's own pool | 18/20 exact; 2 at 23/25 and 24/25, uncovered entries identified as post-hybrid lane injections |
| generation-reach detector | **42/43** |
| gold file present on disk | 98/100 |

**The reach-detector miss is the most useful single finding about the method.**
`sympy-13480` delivers its gold symbol `cosh.eval`, yet the probe reports it
unscored at every rung up to 32× the product pool. The probe is right: no *hybrid*
generator scores it. The product reaches it through `computeClassMethodExpansion`,
a **post-hybrid lane** that synthesizes a method candidate from a class candidate
the task names — exactly the case `evaluatedById`'s own contract warns about.

So `UNREACHABLE_BY_GENERATION` means *unreachable by hybrid generation*, never
*unreachable by the product*. The foothold that lane needs was then measured on
every residual case:

```
sympy-13480 (control)      parentScored=true   taskNamesGoldSymbol=true
11 residual unreachable    taskNamesGoldSymbol=FALSE in all 11
```

The hole is real, measured, and touches **no residual verdict**.

---

## 10. Preservation (§112)

No product code changed, and that is provable rather than asserted: the `src` tree
hash is **identical** at M158's product commit, M158's evidence commit, and the
M159 working tree.

```
src tree @ 99d578ad / f51b9609 / b7ba0381 / working   60f9ee2b221d8be06a003d327c18a280f3a58463
git status --porcelain src                            (empty)
```

| gate | result |
| --- | --- |
| `sphinx-9320` M157 pivot refill | **identical** — lead `sphinx/cmd/quickstart.py::_has_custom_template`, 2 pivots / 4 support |
| `django-11740` no-pivot | **identical** — `no_context`, 0 pivots, 0 support |
| `xarray-6599` M157 neutral case | **identical** — 2 pivots / 4 support, `polyval` ×3 on distinct evidence |
| M158 duplicate support | **0 cases, 0 wasted slots**; manifest hash `326abc25…` **byte-identical to M158's candidate** |
| M158 negative controls | 6 cases still delivering distinct same-name support, preserved |
| gold delivered / support slots | 79 / 380 — unchanged |
| `<module>` deliveries | **0** |
| index writes during retrieval | **0** |
| behavioural routing | OFF |
| broad100 Top-1 / Top-3 / delivered | 0.58 / 0.74 / 0.79 — inherited valid on the identical `src` tree; not re-run (§58, §59: product unchanged) |
| frozen50, frozen30, clean27 | inherited valid on the identical `src` tree; frozen30 30/30 usable, 0 unavailable, 3 degraded |
| quarantine | 0 |

A note worth keeping: `pylint-4551` is **both** a residual case and one of the
three known-degraded frozen30 indexes. Its degradation is 13 parse failures in
pylint's own deliberately-invalid syntax-error test fixtures, and all four of its
gold files index cleanly — so the degraded index is **not** the explanation for its
residual status. Checked precisely because the coincidence would otherwise have
looked like one.

---

## 11. Verification (§114)

```
bun run typecheck              clean
bun run typecheck:benchmarks   clean
bun test                       4832 pass · 49 skip · 0 fail (4881 across 311 files)
git diff --check               clean
```

`.vtrace` staged: 0 · tracked ignore-file changes: 0 · global Git config
mutations: 0 · new runtime source reads: **0** · no live agents, no Docker, no
network, no indexing, no writes to any target workspace or index.

---

## 12. What is the dominant remaining reason VTRACE fails on broad100? (§115)

**No single dominant, actionable reason — and that is the finding.**

The largest population (8 cases, 4 repositories) shares one first divergence and
one structural explanation: the task gives retrieval no lexical handle on the
definition that must change, and the link is purely behavioural. That is not an
unfixed defect. It is the **same ceiling M143-B measured** (no subject→owner
relation exists in the source) and the **same ceiling M153 measured** (same
mechanism, same subject, different produced result).

The remaining twelve split four ways, none of which supports a generic change:
six blocked by a delivery ceiling no bound change reaches, three the same, two
corpus defects, one a nested-function representation gap in a single repository.

---

## 13. Next milestone (§116)

The residual distribution does **not** point at candidate bounds, ranking weights,
or query shaping. In priority order:

1. **Behaviour → implementing-definition semantics** (8 cases / 4 repos). The only
   population with real reach — and the one §68 forbids building on this evidence,
   because it is sympy-weighted exactly as M153's was sphinx-weighted. It needs a
   corpus **built to measure it**, not another pass over broad100. That corpus is
   the honest next milestone.
2. **Corpus repair** for `django-13590` and `django-15572`, as its own milestone
   with its own re-derived baseline, so comparability is broken deliberately and
   once rather than silently mid-audit.
3. **Nested-function representation** (`django-15037`). One case, one repository —
   defensible as an indexer-correctness fix on its own merits, never as a
   retrieval intervention, and not on benchmark evidence.

Explicitly **not** recommended: raising `CANDIDATE_POOL_SIZE`, widening the
generation pool, retuning rank weights, adding synonym expansion, or implementing
`search_symbols` — the first three are refuted by the delivery ceiling, and the
last two have no measured population behind them.

And the standing constraint (§118): none of this claims a coding-agent success
improvement. Deterministic recovery is not live utility, and M159 spent no live
tokens to pretend otherwise.
