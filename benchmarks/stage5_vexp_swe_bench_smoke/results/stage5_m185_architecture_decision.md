# M185 — architecture decision

## The question M185 was asked

> When VTRACE had already localized the correct implementation area but the coding
> agent still failed, was the decisive failure caused by a missing or misunderstood
> repository fact that VTRACE could actually derive?

## The answer

For four of the six correct-focus failures a concrete missing repository fact
exists and can be named with a witness at the base commit. For two of them
current VTRACE authority can derive it. For **none** of them does a successful
run demonstrate recovering and using the equivalent evidence — and that is the
gate that decides the architecture question, because a fact that no winner used
is not what separates winners from losers.

The corpus is unambiguous on that point. The thirteen correct-focus **successes**
read a median of **one** file. Eleven of thirteen read exactly one. One of
thirteen opened a test file. Their median tool-call count is 7 against 15.5 for
unresolved arms. Successful runs did not recover richer repository evidence after
localization; they recovered **less**, because the tasks they solved were the
ones whose correct repair is determined locally by the focus function alone.

## What this means for the product

VTRACE is a repository-intelligence system. Its lever is supplying facts. M183
measured that lever at the orientation stage and got zero. M185 looked for a
second place to pull it and found that the place where failures actually happen —
repair synthesis, and choosing between two locally-plausible edits — is not
fact-shaped.

Three of the six failures make this concrete in a way no aggregate can:

- **psf__requests-5414.** The winning arm considered the losing arm's exact patch
  — "the simplest fix is to ALWAYS try IDNA encoding in `_get_idna_encoded_host`,
  not just for non-ASCII hosts" — and rejected it because "that might have
  performance implications." Neither arm ever opened the test file that encodes
  the invariant both were guessing at. The outcome turned on a performance
  intuition.

- **django__django-13195.** The decisive fact — `set_cookie` declares
  `samesite=None` — was twenty lines above the edit, in the file the run had open.
  Both arms read it and both wrote `samesite='Lax'` anyway, producing byte-identical
  patches and byte-identical grader results.

- **sympy__sympy-13974.** The treatment arm had `tensor_product_simp_Mul`'s own
  TODO on screen three times; the baseline never saw it. The arm with the extra
  evidence wrote the **worse** patch, adding an `is_Integer` guard that excludes
  the symbolic exponent the test requires.

## The one real gap, and why it does not license work

Two cases — `mwaskom__seaborn-3187` and `sphinx-doc__sphinx-7462` — share a
mechanism worth naming: **MISSING_PARALLEL_IMPLEMENTATION_SITE**. The same
behaviour is implemented twice, the run patched one site, and the second site had
its own failing test. Both sites are in VTRACE's index. For seaborn the missed
symbol, `seaborn/utils.py::locator_to_legend_entries`, is in the **same file as
the delivered focus**, carries an incoming call edge and a test caller, and is
returned as a *pivot* by three separate queries derivable from the issue text.
The delivered default packet spent its same-file slot on `seaborn/utils.py::__all__`
instead, annotated "no indexed relationship to it".

That is a genuine, measured, currently-derivable authority-versus-projection gap
(§73). It does not license work, for four independent reasons:

1. **It is not repeated.** Two tasks across two repositories, against a threshold
   of three tasks across two (§43). Two is an observation.
2. **It has no success witness.** No run in the corpus, in either arm, found a
   parallel implementation site and used it. The seaborn baseline scoped its
   searches exactly as the treatment did.
3. **It is a localization mechanism, not a downstream one.** What was missing was
   a second *edit site* — the same hypothesis M183 already tested at first-file
   granularity and measured at zero. §55 does not license retrieval or ranking
   work because some tasks failed.
4. **Selectivity is unmeasured and the one case where it can be checked is bad.**
   For `psf__requests-5414` the decisive test is reverse-reachable from the focus
   at hop 4, by which point the frontier is 92 symbols. An intervention that emits
   everything four hops out is the "send all callers, all tests, all paths"
   failure mode §51 rules out in advance.

## Decision

    NO_FURTHER_AGENT_UTILITY_PRODUCT_WORK_LICENSED

No downstream evidence projection. No targeted tool-efficacy experiment. No new
semantic analyzer. No retrieval, ranking, orientation, or packet-size change. The
parallel-implementation-site observation is recorded so a future milestone with
an independent reason to look at it starts from evidence rather than from scratch;
it is not a standing recommendation.

## What is NOT concluded

That repository intelligence is useless. M183 tested one coding agent, one task
distribution, and one ~580-token automatic first orientation. The finding is
about **this** coding-agent utility thesis on **this** evidence, and it is a
finding about a lever that measured zero twice, not a proof that no lever exists.

## A measurement caveat that limits every validation claim here

Only **5 of 60** arms ever executed the repository's own test suite; 14 tried and
9 of those were refused by the environment — no `pytest`, no `pip`, an
uninstalled package. Validation behaviour in M183 is therefore a property of the
harness, not a choice the agents made, and no conclusion about validation-stage
interventions can be drawn from this benchmark. That is a constraint on any
future experiment, and it should be fixed before one is designed.
