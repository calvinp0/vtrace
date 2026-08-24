# M179 — outstanding defects

Measured, reproducible, and deliberately not repaired here.

## 1. Item metadata is evidence, and the last-resort collapse does not know it

`compactMandatoryProductMetadata` reduces `productContext.items` to a single entry
as a **metadata** saving. But `projectRunPipelineOrientation` derives the focus AND
the entire related list from that array, so the collapse deletes delivered
evidence.

Two measured consequences:

- **Related entries disappear as the budget grows.** 35 pairs on Broad100-A, 27 on
  Broad100-B, after the M179 repair. Example: `django__django-11133`, 3,200 → 6,400
  tokens, items 3 → 1, related 2 → 0, while model-visible tokens rise 1,574 → 5,548.
- **The focus symbol can change.** The packer's rung 8 keeps
  `sort(compareKeepPriority)[0]`; the envelope keeps `items[0]`, first in
  authoritative order. When they disagree, a larger budget points the agent at a
  different site. 21 pairs on Broad100-B. Example: `pytest-dev__pytest-7324`,
  400 → 1,000 tokens, focus `source.py::compile_` → `expression.py::Expression.compile`.

Mostly invisible before M179 because those budgets declined instead of delivering.
The repair did not cause them; it made them reachable. **This is the licensed next
work.**

## 2. The orientation ceiling is not derived from `max_tokens`

`ORIENTATION_POLICY.ceilingTokens` is a flat 2,000 tokens measured with M166's
provider rate, while the caller's budget is measured in `chars/4`. A larger
`max_tokens` admits more items, which compete for a packet whose size does not
grow — so pivot-neighbourhood entries are displaced by item entries at the same
total count. Sound (it is a prefix of an authoritative order) but budget-blind.

## 3. The renderer's closing sentence is served as source code

`parseRenderedBodies` assigns everything after an item's metadata lines to that
item's body, and `render` appends one closing sentence after the **last** section:

```text
Impact entries above are bounded static structural evidence; they are not dynamic execution flow.
```

The final item's `focus.code` therefore ends with a sentence that is not source.
**268 of 582** orientation packets on Broad100-A and **218 of 464** on Broad100-B
are affected. Which item is last depends on how many survived the budget, so the
contamination moves with the budget and reads as a representation change.

Normalized out of every M179 measurement and reported rather than silently
subtracted. Repairing it is a rendering change, not a packing one — either
`render` should not append the note, or `parseRenderedBodies` should not consume
it.

## 4. `modelVisibleEstimatedTokens` still misnames what it measures

Inherited from M178 unchanged. The field measures five evidence keys; M166/M167
established the whole response is model-visible and billed. Not renamed: it is
agent-visible output and a rename would break byte-identity for no gain.

## 5. `typecheck:benchmarks` fails at HEAD, and did before M179

`run_stage5_m178_identity.ts:37` statically imports
`/home/calvin/bench/vtrace-m178/pre-split/src/impact/impactResponseEnvelope`, a
temporary worktree that no longer exists. Pre-existing at `a4eee924`; not caused
by and not fixed in M179. M179's own cross-checkout script imports through a
template literal precisely so it cannot repeat this.
