# M180 — candidate decision

Three candidates, simulated on both frozen corpora with the pre-M180 checkout as
the paired arm, both arms called on the same in-memory object. Scored with
`comparePreservation`, whose semantics were fixed before any candidate existed
(see `m180Ownership.ts`) and which fails a candidate in both directions: a claim
decaying to the roles fallback and a focus abandoning the declared lead pivot are
violations, exactly as their reverses are benign.

| | C_CURRENT | C_PRESERVE_MINIMAL_INDEX | C_AUTHORITATIVE_SUPPLY_CHANNEL |
| --- | ---: | ---: | ---: |
| projector's supply cut by metadata (of 1,380) | 722 | **0** | **0** |
| preservation violations (both corpora) | 54 | 26 | 113 |
| — orientation → decline | **0** | **26** | **0** |
| — related item lost | 54 | 0 | **8** |
| — semantic role changed | 0 | 0 | 106 |
| totality failures | 0 | 0 | 0 |
| truthfulness failures | 0 | 0 | 0 |
| serialized response identical at the default budget | 169/169 | 68/169 | **169/169** |
| metadata tokens, median | 1,243 / 1,232 | 1,240 / 1,239 | **1,243 / 1,232** |
| packet tokens, median (pooled) | 462 / 583 | 732 / 827 | 1,208 / 1,291 |

## Why C_PRESERVE_MINIMAL_INDEX was rejected

It is the obvious repair: stop the two rungs deleting rows, and have them reduce
each row to the fields the projector reads. It works — the supply cut goes to
zero and related-item loss goes to zero with it — and it is the only candidate
that also makes the SERIALIZED response stop misdescribing its own contents.

It costs too much. A delivered item row measures 393 characters at a full budget
and 338 under compaction; the projector-relevant subset is 178. Keeping fourteen
of those is roughly 630 tokens against a flat metadata allowance of 1,000, so
responses that used to fit stop fitting, fall to M179's evidence-budget retry,
and some of them cannot be delivered at all. Measured: **26 ordered budget pairs
where a larger budget declined and a smaller one did not** — the exact class M179
drove from 1,088 to 0, and §55 admits no regression in it. Its blast radius is
also large: 101 of 169 default-budget responses change.

## Why C_AUTHORITATIVE_SUPPLY_CHANNEL was selected

`applyProgressiveContextBudget` owns the evidence budget — `max_tokens` bounds
the model-visible context and that is its contract — so it publishes what it
delivered, keyed on the productContext record it wrote into, and the projector
reads that instead of the array the envelope is about to compact.

It costs nothing. The supply is not part of the response, so it cannot push
anything over a ceiling: **the serialized response is byte-identical at the
default budget on all 169 cases**, metadata medians are unchanged to the token,
and `orientation → decline` stays at 0. Metadata compaction is untouched and
still ejects the same 722 budgets' worth of item rows — which is correct, because
that array is model-facing metadata and shrinking it is what this module is for.
What changed is that shrinking it no longer decides what the agent is told.

Selected on §37's order: ownership correctness and truthfulness are equal between
the two, totality and the M179 regression gate separate them, and the tie-break
never reached economics.

## What it does not fix, and does not pretend to

Violations rise from 54 to 113 and that number is not the repair regressing. It
is the same pattern M179 recorded when its own repair made a second defect
reachable: with the full supply restored, two pre-existing mechanisms become
measurable.

- **106 SEMANTIC_ROLE_CHANGED.** `compactReasons` in `budgetDelivery.ts` selects a
  *preferred* reason from the item's own list, while the uncompacted path leaves
  `selectionReasons[0]` first — so which authoritative claim the projector
  reuses depends on whether the evidence layer compacted. Verified, not assumed:
  of **10,203** related claims delivered by the repaired arm, **10,185** are
  verbatim authoritative and **18** are an authoritative reason under
  `compactReasons`' 160-character ellipsis. **Zero** unsupported, **zero** about a
  symbol not in the supply. No claim is invented and no symbol is lost; the
  *choice* among the symbol's own claims is budget-dependent.
- **8 RELATED_ITEM_LOST.** `ORIENTATION_POLICY.ceilingTokens` is a flat 2,000 and
  the packet now reaches it. A larger budget supplies more candidates and richer
  claims, so an authoritative-order prefix under a fixed ceiling admits fewer
  entries. `sympy__sympy-13974`: supply 22 → 23, related 17 → 17, packet 1,977 →
  1,962 tokens against a 2,000 ceiling. This is M179's outstanding defect §2,
  now reachable rather than new.

Neither is an ownership defect and neither is repaired here. §53 forbids forcing
the count to zero by widening scope.

## Economics, honestly

The packet median rises from 462/583 to 1,208/1,291 tokens, and at the default
budget of 8,000 from 769 to 1,560. That is not refill: the projector's rule has
always been *the authoritative supply running out ends the packet, not a budget
being reached*, and the supply was being cut before it got there. 1,326 of the
restored entries are ones the product already delivered at some other budget;
8,671 are ones it delivered at none, because the collapse fired at every budget on
those cases. Both are entries the orientation contract already specified.

It remains bounded: `ORIENTATION_POLICY.ceilingTokens` caps the packet at 2,000
tokens and the measured maximum on Broad100-A is now exactly 2,000. Against the
6,766–6,884 median M171 measured for the full response, the packet is still four
to five times cheaper. Packets at budgets 100 through 600 are unchanged to the
token; growth begins at 1,600, which is where the collapse used to begin.

The honest reading is that M172's measured 600-token median was taken on a
projector whose input was being cut, and part of that compactness was a defect.
