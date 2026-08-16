# M154 — the vtrace search contract

What each agent-facing surface claims, and what it may not. This is a product
contract: the wording here is enforced by `src/mcp/searchContract.test.ts`, not
merely described.

## The one sentence that matters

> `get_code_context` returns **bounded task-relevant evidence**. It is selective,
> not exhaustive enumeration. A symbol or file it does not return is **unsearched,
> not absent.**

Everything below is a consequence of that sentence.

## `get_code_context` (and its aliases)

`run_pipeline` is the same implementation; `get_context_capsule` is the
lower-level projection. All three carry this contract.

| Question | Answer |
| --- | --- |
| What comes back | A ranked, budget-bounded selection of definitions relevant to the task |
| What is omitted | Anything ranking placed below the cut, or the token budget dropped |
| What an omission proves | Nothing |
| What `resolved: false` means | Retrieval delivered nothing. **Not** that no implementation exists |
| What `resultState: no_result` means | Retrieval missed. **Not** absence |
| What `resultState: delivery_failure` means | Relevant evidence was found and did not fit |
| Source state | One indexed worktree at its current state. Never another branch or revision |

The response carries this structurally, in `productContext.coverage`:

```
coverage: { mode: "selective_task_retrieval",
            absenceClaim: "not_observed",
            enumerationComplete: false }
```

Three constants, deliberately. They are not a measurement — they are the contract,
serialized where the consumer sees it, because the failure being prevented is a
reader inferring the *opposite* from a response that never stated either way.

## `get_impact_graph`

Unchanged by M154 and deliberately separate. Its job is:

> a **known** symbol → its callers, references, dependents, blast radius.

It answers exactly, over the indexed graph, for one FQN. It is not a discovery
tool and `get_code_context` does not absorb it. The two compose: locate with one,
inspect blast radius with the other.

## Absence: three different claims, one scale

vtrace reuses one vocabulary across the whole product rather than inventing a
second one per lane (`src/workspace/evidenceClaims.ts`):

| Strength | Meaning | Who may state it |
| --- | --- | --- |
| `not_observed` | Says nothing about the world | Ranked retrieval — **always** |
| `bounded_absence` | Everything in a narrower-than-eligible scope answered | Bounded exact scans |
| `authoritative_absence` | Every eligible member answered from an exact source | Exact symbol / path membership |

`CAPABILITY_SETTLES_MEMBER_ABSENCE` encodes which capability may climb:
`RankedRetrieval: false`, `SymbolExactLookup: true`, `PathMembership: true`.

So: **an exact identifier lookup over a complete indexed scope may truthfully
report absence.** M154 does not weaken that. A task-aware top-k miss may not, and
M154 stops it from reading as though it could.

## Three coverage axes that must not collapse

They share the word "coverage" and answer different questions:

| Axis | Question | Field |
| --- | --- | --- |
| Workspace coverage | Which repositories were accounted for? | `workspace.coverage.coverageComplete` |
| Retrieval coverage | What task evidence came back? | `productContext.coverage` |
| Exact absence scope | What has exact lookup ruled out? | `NegativeClaimStrength` |

`coverageComplete: true` on a workspace scan means *every member answered*. It
does not mean the returned code evidence is complete. M149's field keeps its own
meaning; M154 did not repurpose it.

Relatedly, `omittedByBound` counts member **detail records** not serialized — a
display bound, never an evidence gap. `coverageComplete: true` alongside
`omittedByBound: 996` is normal.

## Confidence

`inspectFirst.confidence` is `high | medium | low` and means exactly one thing:

> **how specific the lead signal is** — did the winning candidate carry an
> edit-site phrase, behaviour vocabulary, or only a rank?

It is not confidence that the task was understood, that the evidence is
sufficient, or that the search was complete. Confidence that a lead is useful is
not confidence that the search was exhaustive, and M154 added no second number to
say so — the coverage state carries it structurally instead.

## Guidance about searching further

vtrace may not tell a caller to stop searching unless it has grounds. Before
M154 it did so unconditionally: every `inspectFirst` block ended with a constant
`Avoid first: Broad repository grep/find …`, and the installed guidance block
said `Use get_code_context before manual grep`. Neither was earned.

The rule now:

- **Never** advise against further search on coverage grounds. vtrace never
  enumerates a repository and cannot know what a search would find.
- An avoid-hint may only name a target the **evidence** marks — currently one
  case: a lead that re-raises is where the failure surfaces, not where it is fixed.
- Guidance names the reuse-before-write moment explicitly, because that is where a
  selective miss stops being a slower search and becomes duplicated code.

Fallback composition, stated once in the tool descriptions rather than repeated
per response:

```
locate task-relevant code / structural evidence   → get_code_context
blast radius of a known symbol                    → get_impact_graph
exact identifier enumeration                      → ordinary text search
cross-revision truth                              → Git
```

Text search enumerates **textual matches**, not semantic behaviour. Pointing at it
is not a claim that it is complete either.

## Cross-revision boundary

The index represents one repository, one worktree, one source state. It cannot
answer "does `origin/main` have this?" or "what differs from the PR base?" for a
revision it never indexed, and it must not answer such a question from the state
it does have. That is a Git question. M154 does not add cross-revision indexing.

The response binds its own source identity — repo root, repository id, worktree
id, HEAD commit, branch, index run — so a caller can always tell which state an
answer describes. There is no stale cross-worktree fallback.

## What M154 did not change

Mechanism scores, lexical weights, domain weights, candidate ranking,
operation-role and answer-role scoring: untouched. Behavioural repository routing
remains **default-off**. The one retrieval-affecting change is project-name
suppression reaching the searchable text, measured and attributed in
`stage5_m154_changed_case_ledger.json`.
