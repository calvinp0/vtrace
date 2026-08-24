# M181-C — the primary selection-reason contract

Derived before any product code changed, from the source and from the frozen
corpus. §67.

## §83 — what are `selectionReasons`?

**A role claim followed by its provenance, in that order, by construction.**

Not a bag of interchangeable justifications. The assembly layer builds the array
as

```ts
selectionReasons: unique([item.roleReason, ...item.evidence].filter(Boolean))
```

`assembleProductContext.ts:408`, and the two halves are declared separately at
their definition:

```ts
/** The decisive reason this item landed in its role. */
roleReason: string;
/** Ordered evidence: why this item was selected. */
evidence: string[];
```

`productAdapter.ts:48-57`. So the array separates the two kinds **by position**:
position 0 answers *what part does this symbol play in the task*, positions 1..n
answer *how did VTRACE find it*.

Measured over the frozen corpus, the families sort exactly along that seam:

| Class | Families | Actionable |
| --- | --- | --- |
| `SEMANTIC_ROLE` | role-decisive, impact relation, co-edit hint, behavioural match | yes |
| `RELEVANCE_EXPLANATION` | direct-evidence anchor | partly |
| `SCORING_EXPLANATION` | graph dependency | weakly |
| `PROVENANCE_ONLY` | lexical signal, file locality, memory signal, project rule | no |
| `DEBUG_ONLY` | scoring diagnostic | no |

The last row is the sharp one. `preferred contrast side matched: management,
command, py (+0.18)` is a list of matched tokens and a float. It is not a claim
about the repository at all.

## §28 / §84 — is there one canonical primary reason?

**YES — an explicit priority contract exists, and position 0 is it.**

Four independent places in the source agree, none of them written for this
milestone:

1. `productAdapter.ts:48` — `roleReason` is *"The decisive reason this item
   landed in its role"*. Decisive is the word the codebase chose.
2. `assembleProductContext.ts:408` — the decisive reason is placed at position 0.
3. `assembleProductContext.ts:621` — merging duplicate drafts **appends**, so a
   merge can never displace position 0; drafts are pre-sorted by `roleOrder`, so
   the merge is deterministic rather than incidental.
4. `orientationProjection.ts:327` — *"The item's own first selection reason IS
   the relationship claim the authoritative state makes about it. Reused
   verbatim; never generalized."*

Position 0 is therefore **not** insertion order that happens to be stable. It is
a declared contract that the insertion order implements.

`compactReasons` is the one surface that overrides it, and it is also the only
surface with **no** declared contract: no priority enum, no ordering table, no
test, no comment stating an intent. Its preference is a substring match —

```ts
const preferred = reasons.find((reason) =>
  /preferred contrast|symbol-name match|direct evidence|exact/iu.test(reason));
```

— and those four substrings are copied from `answerBearing` twelve lines above,
where they decide **which item to keep**. A keep-priority vocabulary was reused
to rank the quality of an *explanation*. That is the whole mechanism.

## §84 — does `compactReasons` implement a semantic priority?

**No. It implements a representation heuristic, and the permutation control
proves it.**

The same reason set `{A, B, C}` fed in all six orders:

| | distinct values across the six orders |
| --- | ---: |
| declared decisive reason (position 0) | **3** |
| `compactReasons`' choice | **1** |

`compactReasons` returns the *same* reason for orders whose declared decisive
reason differs. It is not a competing contract that happens to disagree; it is
blind to the only contract there is.

## §29 — is the whole reason set agent-relevant?

**No. The set is internal authority; one compact explanation is the disclosure.**

This is the standing invariant *internal authority is richer than default
model-facing disclosure*. The orientation shows one reason per item and should
keep doing so — §30 forbids stabilising semantics by rendering everything. The
full set stays in `productContext.items[].selectionReasons` and at
`detail=debug`.

So the contract is not "show more". It is **choose once, and choose the declared
one**.

## §61 — the agent-relevance test, per observed substitution

| Substitution | n | Equivalent? | Would an agent act differently? |
| --- | ---: | --- | --- |
| scoring diagnostic → role decisive | 214 | no | **yes** — one names the edit site, the other names matched tokens and a float |
| direct-evidence anchor → role decisive | 61 | no | yes, less sharply — *why look* displacing *what it is* |
| role decisive → role decisive | 10 | **yes** | no — the 160-character ellipsis cutting one sentence |
| scoring diagnostic → direct-evidence anchor | 2 | no | yes |
| lexical signal → role decisive | 2 | see note | no — truncated prefixes of one role sentence |

*Note.* Where the family label and the string relation disagree, the string
relation governs: comparing the claims is evidence, labelling a 159-character
prefix is a heuristic. Under that precedence the corpus splits **277
reselections / 12 representation-only**.

## The verdict this licenses

```text
PRIMARY_SELECTION_REASON_CANONICAL
```

and therefore, per §36, one authoritative reason decision must be made **once**,
before compact and uncompacted rendering diverge — not two selectors with
separate semantics.

The repair this points at is *not* "make `compactReasons` match position 0 so the
106 go away". It is "`compactReasons` must reduce the array **without
reselecting**, because reselection is not its job and it has no contract
authorising it". That the residual count falls out of this is a consequence, and
§34 requires it to be a consequence rather than the goal.
