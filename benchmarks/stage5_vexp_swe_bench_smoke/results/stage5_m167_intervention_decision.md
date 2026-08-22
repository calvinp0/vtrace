# M167-D — intervention decision: NOT RUN

**Decision: do not change the transport representation.** Two independent bars are
failed, and either alone is sufficient.

## Bar 1 — materiality. The best available candidate saves 0.5%.

The gate was 20% median model-visible reduction (§34). Measured across the twelve
reference tasks, at M166's calibrated 3.15 chars/token:

| candidate | wire chars | wire delta | model tokens | model delta |
| --- | ---: | ---: | ---: | ---: |
| CURRENT | 68,459 | — | 10,526 | — |
| STRUCTURED_ONLY | 33,247 | −51.4% | 10,526 | **0%** |
| TEXT_ONLY | 35,371 | −48.3% | 10,476 | **−0.5%** |
| STRUCTURED_PLUS_SUMMARY | 33,439 | −51.2% | 10,526 | **0%** |

The reason the wire column and the model column disagree so violently is the whole
finding. The agent client delivers `structuredContent` and discards `content[0].text`
— re-derived here, not cited: 12/12 M164 model-visible payloads begin with the envelope
wrapper `{"schema":{"name":"vtrace.mcp_server"`, a prefix the text channel cannot
produce because it serializes the output alone. **A channel the client never reads
costs the model nothing, so removing it saves the model nothing.**

Removing `structuredContent` instead — the only candidate that touches what the model
actually receives — recovers the 157-character envelope wrapper. That is 50 tokens
against a 10,526-token response: 0.5%, missing the gate by a factor of forty, in
exchange for removing the only channel the one proven client is observed to read.

## Bar 2 — contract. The text channel cannot be removed, whatever it costs.

VTRACE advertises protocol revision `2024-11-05` (`src/mcp/startServer.ts:29`, asserted
by test) and declares no `outputSchema` on any tool (`formatListedToolDescriptor` emits
`name`, `description`, `inputSchema`; the test asserts exactly those three keys).
`structuredContent` is therefore an extension served under a revision that does not
define it, unannounced by any schema. A client that reads it does so by leniency; a
client that ignores it is conformant.

That inverts the naive reading of the evidence. The channel the proven client reads is
the *unsupported* one; the channel it discards is the *only* one VTRACE may assume any
consumer reads. And the repository claims more consumers than it can observe: the
README advertises the server for Codex, `src/runtime/codexConfig.ts` installs its MCP
config, and no Codex result-handling code or transcript exists here. Codex is UNKNOWN,
and UNKNOWN is a constraint, not a licence.

Consequences per candidate, measured rather than asserted — semantic preservation was
scored separately for a structured-preferring client and a text-only client:

- **STRUCTURED_ONLY** — a text-only client recovers **0/12**. It receives an empty
  result: no evidence, no readiness, no absence semantics, no error either. Silent.
- **STRUCTURED_PLUS_SUMMARY** — a text-only client recovers **0/12**, and this is the
  worse failure of the two because it is not silent, it is *plausible*: 53 tokens of
  counts where evidence was expected. "1 primary target, 2 support items, 0 impact
  edges" reads like a result.
- **TEXT_ONLY** — preserves both read rules 12/12, and is the only candidate that does.
  It also removes the channel the proven client reads, to save 0.5%.

## What was NOT done, deliberately

The model-visible restatement is real, but it is not this seam. Inside the delivered
channel, **114 of 122 repository facts (93.4%) are rendered on more than one surface** —
the prose context, the structured item list, the capsule digest, the legacy context
section — and DUPLICATE is 3,647 of 10,526 tokens (34.6%), the largest single category.

That is not M167's licence to spend. Compressing it would mean deduplicating semantic
items across surfaces, which §22 places behind an independent authority-preservation
audit, and M166 established exactly why: `productContext.items[]` is not decoration but
the one surface with addressable identity, carrying roles, line spans and content modes
that the prose does not restate. M166 also proved that removing restatements from an
envelope-bound response converts them into evidence rather than into savings. Both
findings say the same thing — this is a separate milestone with its own gate, not a
widening of this one.

## Verdict

`D NOT RUN — CORRECT STOP`. No product code was changed. The audit answered its
question; it did not need to produce a feature to have been worth running.
