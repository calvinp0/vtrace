# M177-F — architecture decision

## The decision

Replace the throw at `impactResponseEnvelope.ts:338` with a bounded terminal record
built from the draft the ladder already exhausted, returned unconditionally.

```diff
-  if (budget exceeds a bound) {
-    throw new Error("impact_response_envelope_unreachable");
-  }
+  if (budget exceeds a bound) {
+    return buildBoundedImpactDecline(draft, { … });
+  }
```

Everything else in the file is untouched.

## What was rejected, and why

**Extract a shared envelope abstraction across `run_pipeline` and
`get_impact_graph`.** The defect shape matches; the contracts do not.
`run_pipeline` may return a smaller, differently-shaped record; `get_impact_graph`
declares eleven required output fields and its terminal must stay a valid
`ImpactGraphOutput`. A common abstraction would have to erase the one difference
that decides each design. §11/§12 asked for the smallest auditable change, and a
duplicated 40-line terminal is both smaller and easier to read than a generic
envelope that two tools must then be understood through.

**Add a `resultState` value, or a public `envelope_decline` state.**
`bounded_truncated` beside `retainedEdges: 0` and `omittedEdges: 55` already says
*55 edges exist and you received none*, and it is what the tool already returned
one rung above. Nothing a coding model can infer or do differs between the two
cases: evidence existed, none arrived, raise the budget or narrow the request.
Minting agent-facing vocabulary for a distinction only a maintainer can use would
add a second surface to keep truthful forever. This is M176's decision, applied
unchanged.

**Widen `withinEnvelope` from `true` to `boolean`.** Considered because §52
forbids falsifying budget accounting. Rejected because it is not needed: the
terminal's size is a constant by construction and the smallest ceiling it must fit
(`max_tokens=1` → 801) exceeds the largest measured terminal (674) with margin,
including a unit test that drives all four identity strings to 2,800 characters.
No product code branches on the field, so widening it would have bought a
hypothetical honesty at the cost of a real public type change.

**Fix the `fits()`/terminal-check disagreement.** Real, measured, recorded in
`stage5_m177_outstanding_defects.md`. Tightening `:338` to also enforce
`modelVisibleEstimatedTokens <= requestedMaxTokens` would start declining
responses the product returns today — a behaviour change well outside a totality
repair.

**Project first and bound the projection.** M176's standing finding notes the
envelope measures a payload larger than what the model receives. Same is true
here. Out of scope: it changes the construction order M172/M173 froze.

## The three properties the terminal rests on

1. **It is returned, not re-gated.** There is no path from the decline back to an
   unreachable state, because nothing tests it and can reject it. §26's failure
   mode is structurally absent rather than argued away.

2. **Its size is a constant, not a function of the input.** Every field is a
   frozen constant, a boolean, a non-negative integer, an enum, or one of four
   identity strings bounded at 200 characters — omitted past the bound, never
   truncated, because `fqName` is the argument a caller feeds back to this same
   tool and half a symbol name is an identity that does not resolve.

3. **Discovered populations survive; only delivered counts go to zero.**
   `summary.consumers`, `richSummary`'s counts and
   `callerCoverage.exactCallerCount`/`potentialCallerCount` pass through untouched,
   beside a zeroed `deliveredExactCallerCount` and a `status` clamped away from
   `complete`. That is the M139 discovered/delivered split doing exactly the job it
   was built for.

## The invariant to carry forward

> For all currently repaired model-facing envelope paths, a valid authoritative
> result must terminate in either a valid response or truthful bounded
> degradation; budget exhaustion is not an exceptional or unreachable state.

> Bounded non-delivery is not evidence absence.

And one more, earned here rather than inherited:

> **A degradation ladder must be gated on the same condition that decides whether
> its output can be returned.** When they differ, the ladder spends itself
> answering one question and dies on another, and the residue it leaves is
> optimised against the wrong constraint. `get_impact_graph` shed evidence to
> exhaustion while 61% of its floor was metadata no rung could touch.
