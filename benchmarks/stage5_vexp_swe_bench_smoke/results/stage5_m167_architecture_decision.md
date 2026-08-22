# M167 — architecture decision

## The invariant §84 proposed, and why it is adopted in a narrowed form

The brief offered, conditional on the audit supporting it:

> One semantic result should have one authoritative model-facing representation;
> protocol compatibility fallbacks must not silently duplicate the full semantic
> payload.

The audit supports the first clause and **refutes the second as a rule**. Adopted:

> **One semantic result has one authoritative value and any number of derivations of
> it. A derivation that no consumer reads costs the model nothing; a derivation the
> model reads costs it everything. Which is which must be measured, never inferred
> from the protocol.**

The second clause fails because the duplication is what keeps VTRACE conformant. The
"compatibility fallback" here is `content[]`, the only channel the advertised revision
defines — and it carries the full payload precisely so that a conformant client gets a
complete answer. Forbidding that duplication would forbid conformance. The cost of the
duplication is paid in wire bytes and server CPU, which is the right place to pay it.

## What the audit found about the structure §13 asked for

Already in place. `content[0].text` and `structuredContent` are two expressions over
the same `toolResponse` binding in a single return statement (`src/mcp/startServer.ts`),
so they cannot drift. There is one authority and two derivations, not two independent
constructions. No correctness risk to flag.

## Standing note for whoever changes the protocol revision

If VTRACE ever advertises `2025-06-18` or later and declares an `outputSchema`, the
contract bar in `stage5_m167_intervention_decision.md` lifts — `structuredContent`
becomes a defined channel and `content[]` becomes a documented backwards-compatibility
courtesy. **The materiality bar does not lift.** Removing the text channel would still
save the model zero tokens, because the model never receives it. Do not read a protocol
upgrade as unlocking a saving that was never there.

The reverse move is the one to watch: a client that stops reading `structuredContent`
and falls back to `content[]` would change the delivered representation, and every
model-visible figure in M166 and M167 is conditional on that not happening. The binding
is stated explicitly in `stage5_m167_byte_attribution.json` rather than assumed.

## Where the model-visible cost actually is

Not across the channels. Inside the delivered one:

| category | median tokens | share |
| --- | ---: | ---: |
| DUPLICATE | 3,647 | 34.6% |
| TRANSPORT_STRUCTURE | 2,689 | 25.5% |
| REPOSITORY_EVIDENCE | 1,966 | 18.7% |
| MACHINE_DIAGNOSTIC | 887 | 8.4% |
| AGENT_USEFUL_CONTROL | 681 | 6.5% |
| PROVENANCE | 344 | 3.3% |

93.4% of repository facts are rendered on more than one surface of the same response.
That is the next question, and M167 does not answer it, propose an answer, or authorize
one. It requires the authority-preservation audit §22 names, and it inherits M166's
warning that an envelope-bound response converts removals into evidence rather than
savings — so any projection made without modelling the ceiling will overstate itself.

## Separately: the session schema tax

`tools/list` costs a median 8,141 characters, ~2,584 tokens, once per session. It is
reported apart from per-call cost and never added to it (§47). No tool declares an
`outputSchema`, so nothing in that figure is structured-output overhead.
