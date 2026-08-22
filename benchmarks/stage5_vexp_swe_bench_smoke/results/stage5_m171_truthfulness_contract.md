# M171 — the truthfulness contract for a selective packet

**Frozen at M171-B, before any truthfulness result existed.**

## The requirement

Selective disclosure changes what a truthfulness audit must check. Completeness
is no longer the standard — the packet is allowed to omit supported facts. What
replaces it:

```text
every claim surfaced to the model
is supported by the authoritative internal state
```

The packet must be **sound, selective and bounded**. It need not be exhaustive.

## The five things that must never happen

Derived from §49; each is a zero-tolerance count in `stage5_m171_claim_soundness.json`.

| Violation | What it looks like |
|---|---|
| **Unsupported claim** | the packet names a location, span or relationship the authoritative state does not contain |
| **False authoritative absence** | the packet turns an omission into "this does not exist" |
| **Exact / potential strengthening** | a potential or lexical relationship rendered as an exact one |
| **Bounded / exhaustive strengthening** | a bounded search result rendered as a complete enumeration |
| **Ownership strengthening** | a supporting item rendered as the owner of a behaviour |

## The permanent invariants, restated

```text
omitted            != absent
not observed       != absent
bounded absence    != authoritative absence
support            != ownership
potential caller   != exact caller
parse failure      != semantic absence
truncation         != semantic absence
duplicate accounting != semantic duplicate
```

## How the contract makes each one unreachable

**Unsupported claims** are prevented structurally rather than checked after the
fact. Every string in a packet is either copied verbatim from the authoritative
state or drawn from a frozen phrase list declared in the contract. There is no
code path that composes a new sentence about the repository.

**False absence** is prevented by the global boundary appearing on every resolved
packet, unconditionally, and by the packet never emitting a negative claim. It
does not say "no callers"; it says nothing about callers. Since it never claims
to enumerate, omission carries no information.

The one place this needed care is the neighbourhood skip list. A neighbour
skipped for `source_unavailable` is a *bounded* absence — VTRACE could not read
the source, which is not the same as the neighbour not existing. The packet
carries neither the neighbour nor the skip, so it stays silent rather than
negative. The skip record survives at `detail=debug`.

**Strengthening** is prevented by the exhaustive relationship phrase table. Each
raw enum value maps to one phrase that states a fact about the index and
preserves the exact strength of the underlying edge. An unmapped value fails
closed: the neighbour is dropped rather than labelled.

## Controls the audit must pass (§50, §51)

A comparative analyzer that cannot classify an unchanged input correctly has not
earned the right to a treatment verdict. Every M171 semantic analyzer therefore
runs three controls:

- **known positive** — a fixture that genuinely violates the rule must be caught;
- **known negative** — a clean fixture must pass;
- **identity** — the status quo compared against itself must report no change.

The adversarial fixtures cover: exact callers, potential callers, a bounded
caller set, an authoritative absence, a not-observed absence, a component that is
unavailable, a component that errored, omitted support, the same item in several
semantic roles, the same skip reason at two different scopes, and
`repo_not_ready`.

This is the fourth milestone in a row to require it. M167, M168, M169 and M170
each found a classifier that reported a clean result because it could not
distinguish the case it existed to detect — most recently M169's repeat control,
which certified two identical `repo_not_ready` errors as an identical delivery
and reported 100/100 on a corpus where 93 of 100 delivered nothing.

## The rule that governs a token shortage

Truthfulness metadata does not compete with evidence for space. If a claim cannot
be rendered truthfully inside the orientation target:

```text
omit the claim
```

never

```text
render an overstrong version
```

A qualifier is attached to the claim it protects and is evicted only with it.
