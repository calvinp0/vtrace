# M171 — the minimum-sufficient orientation contract

**Frozen at M171-B, before any dose, preservation or holdout number existed.**

## What the packet is for

One question, asked once, at the start of a task:

> Where in this repository should the agent look first, and what is there?

Not "what does VTRACE know about this repository". The distinction is the whole
milestone:

```text
INTERNAL EPISTEMIC AUTHORITY  !=  DEFAULT MODEL-FACING DISCLOSURE
```

VTRACE needs detailed internal state to avoid making false claims. That does not
imply the agent must read all of it before starting every task.

## What the evidence says the packet needs

Three measurements on the twelve development cases decided the shape.

**The current response is 21,318 characters and carries 895 characters of code.**
Actual repository source is about 4% of what the model pays for. The rest is
packaging, restatement, bookkeeping and provenance.

**The packet is right or wrong per case, not partly right.** On the twelve live
M168 runs, the response either supported the agent's first repository action, its
first edit, and every early-phase action (7 cases), or it supported none of them
(5 cases). Early-phase support is 0% or 100% with nothing in between. The value
is carried by whether the primary target is correct — not by how much support
travels alongside it.

**Three quarters of what is surfaced is never opened.** Median 3 surfaced files,
median 75% never touched by the agent in the whole run.

Taken together: a bigger packet does not rescue a wrong pivot, and a right pivot
does not need a bigger packet.

## The shape

```text
Focus
path::Symbol  lines 184-408  [skeleton]
why: <the authoritative selection reason, verbatim>

<bounded source excerpt>

Related
path::Symbol  lines 411-414 — direct caller of path::Symbol
path::Symbol  lines 78-83  — calls the focus symbol (indexed call edge)

Focused orientation: task-relevant evidence selected from the indexed worktree,
not an exhaustive repository listing. Items not shown are not thereby absent.
```

The structured representation carries exactly these fields and no others. Per
§22 the compact object IS `structuredContent`; there is no fuller copy beside it.

## Priority classes

| Class | Content | Included |
|---|---|---|
| P0 | state, focus identity and location, the global boundary | always |
| P1 | focus source excerpt, head-bounded, labelled with its form | when the authoritative state carries one |
| P2 | related locations with relationship labels, in authoritative order | up to the rung's cap |
| P3 | interpretation-critical notes | only when there is something to say |
| P4+ | additional support, impact detail, memory, flow, provenance, accounting | **never, at any rung** |

P4+ is empty on purpose. This is what §17's no-refill rule means in practice: the
projector has no notion of remaining space, so there is nothing for spare budget
to attract. A packet complete at 400 tokens under a 2,000-token ceiling stays at
400 tokens.

## Rules the projector obeys

**Authoritative order only.** Related entries are a PREFIX of the order the
pipeline itself produced — `productContext.items` as delivered, then
pivot-neighborhood excerpts. The projector does not re-rank, re-score, or
re-select. This is also what makes the rungs nested: anything named at R1000 is
named at R2500.

**Verbatim or frozen.** Every string in a packet is either copied unchanged from
the authoritative state or is one of a small set of frozen phrases declared in
the contract. Re-wording is how "potential caller" becomes "caller" and how "not
observed" becomes "absent", so the projector does not re-word.

**Fails closed on unknown vocabulary.** The pivot-neighborhood relationship enum
is rendered through an exhaustive phrase table. A reason absent from the table
carries no claim and the neighbour is dropped, so a newly added internal token
can never leak as an opaque label or be read as a stronger relationship than it
is. `fallback_symbol_window` — a same-file symbol reached by no edge at all —
renders as *"in the same file as the focus symbol; no indexed relationship to
it"*, which states the absence of a relationship rather than implying one.

**Code comes only from what is already disclosed.** The focus excerpt is cut from
`productContext.modelVisibleContext`, the only place a serialized response
carries source text at all. The packet therefore cannot show source the current
default does not already show, so a size comparison is never confounded by a
content change (§38).

**Failure is not compressed.** A non-resolved state produces a problem block
carrying the reason, the recommended action and the authoritative readiness
record in full. A compact success output does not license a vague failure output.

## One global boundary instead of repeated local ones

The boundary line appears on **every** resolved packet, unconditionally. That is
deliberate: a boundary that appeared only sometimes would make its absence
informative, and its absence would fall exactly on the packets that are most
selective.

Item-local qualification survives only where it changes the claim:

- `form` on the focus excerpt, because a skeleton shown without its label reads
  as the implementation;
- the relationship phrase on each related entry, because "indexed call edge" and
  "same file, no indexed relationship" are different claims;
- a freshness note when the index is not fresh, because that changes how every
  other claim in the packet should be read.

## What moved to `detail=debug`

Twenty-two of the forty rules in the disclosure matrix are `DEBUG_ONLY`, and
nothing was deleted. The largest movements, by median characters in the current
response: `capsuleResult` (2,106), `responseBudget` (1,276), `deferred` (1,189),
`diagnostics` (908), `context` (852), `memory` (759), `request` (598), `intent`
(579), `workspaceRouting` (493), `taskSummary` (480), `rules` (363), `runtime`
(362), `accounting` (307).

Each has a stated reason in `stage5_m171_disclosure_matrix.json`. Three are worth
naming here because the reason is a measurement rather than a judgement:

- **memory** — durable memory on this corpus is VTRACE's own prior tool calls
  ("Built context capsule for query with 2 pivots and 4 supports"). M164 measured
  zero voluntary reuse.
- **rules** — no active rule fired on any development case.
- **impact / flow** — impact is skipped by intent and flow resolves no endpoints
  across the development corpus. When either produces evidence it reaches the
  packet as a related entry; when it does not, omitting it asserts nothing,
  because the packet never claimed to enumerate either.
