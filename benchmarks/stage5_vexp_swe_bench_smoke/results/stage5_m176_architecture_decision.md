# M176-F — architecture decision

## The invariant

> **Every expected product-pressure state must have a bounded truthful terminal
> representation. Envelope exhaustion is a product condition, not an exceptional
> transport failure.**

and its corollary:

> **A response that cannot communicate repository evidence within its truthfulness
> constraints must decline to make that repository claim. It must not crash,
> fabricate absence, or expose the full authoritative internal payload.**

## Status of the invariant after M176

The three things below are deliberately separate, and the distinction is the
point. M176 does **not** establish that this invariant holds repository-wide.

**Established architecturally.** The invariant is now stated, has a worked
implementation, an executable control corpus, and a precedence matrix that says
where a bounded decline sits relative to readiness, empty retrieval and genuine
faults. Any future envelope can be held to it.

**Satisfied for the repaired instance — `run_pipeline`.** The exhausted-ladder
condition terminates in a bounded truthful decline in the existing public
vocabulary, measured over Broad100-A and Broad100-B at two budgets and through
the real MCP transport. `remeasureResponseBudget`, the `get_code_context`
re-measure path, is repaired by the same construction.

**One known outstanding violation — `get_impact_graph`.**
`src/impact/impactResponseEnvelope.ts:340` throws
`impact_response_envelope_unreachable` at the end of its own degradation ladder,
and the server's catch-all reports it as `handler_failed`. Reproduced
deterministically through the real transport on a real symbol
(`src/_pytest/debugging.py::_enter_pdb`): `max_tokens` of 1, 50, 200 and 400 all
fail; 1,200 succeeds. Recorded in `stage5_m176_sibling_defect.json`. **Not
repaired**: §34 bounds the product diff to the already-measured `run_pipeline`
envelope, and repairing an envelope M176 has otherwise not measured would mean
shipping a change with no control corpus behind it.

## The decision that shaped the repair

Ladder exhaustion did **not** get a new agent-facing state.

The tempting reading of §5 is that `DELIVERY_DECLINED` and `DELIVERY_FAILURE` are
different things and must be named differently. They are different *mechanisms*.
They are not different *epistemic states*: in both, relevant evidence exists, none
of it could be delivered inside the bound, and the remedy is identical. A coding
model cannot infer anything different from the two and cannot act differently on
them, so a second public state would be vocabulary that costs the agent tokens
and buys it nothing — and a second surface to keep truthful forever.

The distinction a maintainer needs is real, and it is kept: one internal boolean,
`productContext.diagnostics.envelopeDecline`, set only where the ladder was
exhausted and absent from the graceful degradation one rung above. §42's
"do not pool states" is satisfied in the *reporting*, which is where it matters,
without the public schema growing.

## The architectural finding M176 did not act on

The envelope is enforced on the **authoritative** result at `tools.ts:9252`. The
compact orientation the model actually receives is projected from it afterwards at
`tools.ts:9282`. The payload measured against the ceiling is therefore not the
payload delivered.

That inversion is why the crash was reachable at all: on the known positive the
model-facing answer is 445 characters, and the call died because the *authoritative*
payload behind it could not be squeezed under a 1,150-token ceiling. Projecting
first and bounding the projection would be the deeper repair.

M176 does not make it, and should not have. It would change the default packet's
construction order, which M172 and M173 froze and §34 forbids. It is recorded here
as a measured property of the architecture, not as a defect requiring action: the
current order has a bounded terminal state now, which is what the milestone was
for.

## Standing rules this establishes

1. **A fail-closed ladder needs a terminal representation, not just a terminal
   decision.** Deciding to refuse is correct. Refusing by throwing turns a product
   condition into an implementation fault at the transport boundary.
2. **The fallback is reachable only from a failed measurement, never from a
   `catch`.** This is what keeps genuine faults failing. Any future bounded
   fallback must be wired the same way.
3. **Bound by omission, not truncation, wherever the value carries a claim.** A
   truncated symbol name is an identity that does not resolve; a truncated
   freshness reason is a re-worded claim.
4. **`compacted_fields` is a bounded audit report, not a fact about the response.**
   It is sorted, deduplicated and capped at ten entries. Telemetry and tests must
   read the state itself.
5. **Model-facing means the projection.** Since M172 the default response is a
   projection of the authoritative result, so a boundedness claim measured on the
   authoritative record is measuring the wrong object. The 200-token target in
   §27 is scored on what the model receives; the internal record is reported
   beside it.
