# M153-B — behavioural repository nomination: contract

The semantics the M153-C implementation must satisfy. Written before the code, so
the code can be checked against it rather than described by it.

## The question the lane answers

> **Which repository contains the strongest evidence for implementing the
> behaviour described by this request?**

Explicitly **not** "which repository has the most overlapping words" (§34).

## Lane precedence

```
  0.  explicit repo/member authority      never overridden          (§55)
  1.  absolute path containment
  2.  unique indexed path
  3.  unique exact symbol                                            (§56)
  4.  BEHAVIOURAL REPOSITORY NOMINATION   <-- M153 adds this
  5.  configured default / sole member    fallback, not evidence     (§54)
  6.  abstain                                                        (§41)
```

The behavioural lane sits **below** every exact lane, because a request carrying
authoritative path or symbol evidence must never be re-routed by fuzzy
behavioural scoring, and **above** the configured default, because a default is a
fallback rather than competing evidence.

## The decision rule: a structural evidence ladder

Repositories are compared by the **strongest class of subject-aligned behavioural
evidence each one contains** — never by summed or averaged score mass.

```
  For each candidate repository:
      classify its single strongest subject-aligned behavioural evidence
      retain ONLY that class, plus provenance of the best supporting item

  Compare repositories by evidence CLASS:

      exactly one repo at the strongest admissible class  -> route to it
      two or more tied at the strongest admissible class  -> ambiguous, abstain
      best class is lexical/document-only                 -> lane does not decide
```

### The ladder

Derived from existing generic evidence authority and `OperationRole` semantics —
not from ARC, and not from observed score gaps in the M153 corpus.

| Class | Meaning | May decide? |
| --- | --- | --- |
| `direct_aligned` | a candidate directly implements the requested operation on an aligned subject | **yes** |
| `direct_unaligned` | directly implements the operation, subject does not align | yes, only if no repo has `direct_aligned` |
| `partial` | mechanism fact present but neither direct nor aligned | yes, only if nothing stronger exists anywhere |
| `lexical_only` | name/document overlap alone | **never** |

### Why no margin and no threshold

A runner-up count margin would make a repository benefit from having *many*
weaker matches, which is the §44 size-distractor failure wearing a structural
disguise. A numeric threshold would need calibrating on four repositories and
would not be shown to hold on the other three. Neither is used.

**A repository gains nothing from volume.** Only its single best item is retained.
A large repository with forty partial facts still ranks below a small one with a
single aligned direct implementer.

## Fallback semantics: additive, never confidence-inflating

When the lane does not decide, control returns **unchanged** to the pre-existing
M151 policy — configured default, sole usable member, otherwise abstain. The lane
is strictly additive: every request that routes correctly today continues to.

Three constraints on what that fallback may claim:

1. Metadata must distinguish **behavioural `no_match`** from **selected by
   configured default**. They are different facts and must not share a field.
2. Weak behavioural evidence must not strengthen the fallback repository's
   confidence or claim scope. A default chosen after a failed behavioural probe
   is exactly as authoritative as one chosen without probing.
3. A failed behavioural probe is **not an absence proof** (§58). It cannot
   support a claim that the behaviour is absent from the workspace, and it may
   not contribute to any exact-lane uniqueness proof. `not_observed`,
   `bounded_absence` and `authoritative_absence` keep their M151 meanings (§42,
   §114).

## Subject and operation must BOTH matter

| Situation | Required outcome | Clause |
| --- | --- | --- |
| repo A orders parsers, repo B orders backends; query asks backend precedence | only B gains strong evidence | §47 |
| two repos implement SELECTION on different subjects | subject discriminates | §48 |
| two repos mention the same subject, one implements the operation | operation discriminates | §49 |
| repo A has rich docs, repo B has the implementation | B leads | §50 |
| repo A has tests naming it, repo B implements it | B leads | §51 |
| repo A only consumes the decision, repo B implements it | B leads | §45 |
| correct repo has generic symbol names and no query words | still reachable | §46, §61 |

The last row is the capability most at risk from a cheap lexical shortlist, and
the reason the shortlist may not be the only route to deep probing.

## Boundedness

| Property | Requirement | Clause |
| --- | --- | --- |
| full retrievals after routing | **1**, at any workspace size | §39, §99 |
| behavioural deep probes | bounded, measured at 11/100/1000 | §59, §106 |
| source reads during nomination | **0** | §37 |
| `index.sqlite` writes during nomination | **0** | §96 |
| `session.sqlite` writes during nomination | **0** | §97, §98 |
| routing metadata size | flat in member count | §65, §110 |

A repository merely *considered* as a route must gain no session observations or
manifests — being a candidate is inspection, not delivery.

## Determinism

Identical workspace, indexes and query must produce an identical route, with no
dependence on filesystem iteration order (§103). Ties resolve by the rule above —
abstain — never by whichever SQLite row arrived first (§104). Concurrent
identical queries must agree on lead and supporter set (§105).

## Truthfulness invariants carried forward

- Supporting evidence is never ownership (§82, M149).
- Explicit identifier syntax keeps exact-lookup semantics; the behavioural lane
  must not reinterpret it as prose (§87).
- A repository name may express project intent for **routing**. It may never
  become **symbol** relevance (§33, §53).

## What M153 deliberately does not build

- No cross-repository dependency edges (§67).
- No redesign of supporter composition (§69) or product-state ownership (§112).
- No new persistent route cache unless one is unavoidable (§101).
