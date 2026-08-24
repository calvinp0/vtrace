# M180 — outstanding defects

Measured, reproduced, and deliberately not repaired here.

## 1. `compactReasons` reselects which authoritative claim is delivered

`budgetDelivery.ts` compacts an item's `selectionReasons` to ONE entry, and it
picks a *preferred* one — the first matching `/preferred contrast|symbol-name
match|direct evidence|exact/` — while the uncompacted path leaves the item's own
`selectionReasons[0]` first. The orientation projector reuses `reasons[0]`
verbatim as the related entry's `how`. So which of a symbol's authoritative
claims the agent is shown depends on whether the evidence layer compacted.

```text
astropy/io/ascii/qdp.py::QDP     authoritative reasons:
  [0] actionable class — in a likely edit file; strong lexical match
  [1] preferred contrast side matched: ascii, qdp, table, format (+0.24)
  [2] task names module path `ascii.qdp` (direct evidence, strong)

max_tokens 2,000  ->  how = [1]
max_tokens 8,000  ->  how = [0]
```

**106 ordered budget pairs**, both corpora. Nothing is invented and nothing is
lost: of 10,203 related claims the repaired arm delivers, **10,185 are verbatim
authoritative** and **18** are an authoritative reason under `compactReasons`'
160-character ellipsis — **0 unsupported**, **0** about a symbol outside the
supply. It is a claim-SELECTION instability, not a truthfulness failure.

Mostly invisible before M180 because the items carrying those claims were being
deleted before the projector could read them. The repair did not cause it; it
made it reachable. **This is the licensed next work.**

- measured: yes, both corpora
- reproduced: yes, deterministically, from frozen objects
- mechanism known: yes — `compactReasons`, `budgetDelivery.ts`
- repaired: no
- next work licensed: yes

## 2. The orientation ceiling is flat, and the packet now reaches it

`ORIENTATION_POLICY.ceilingTokens` is 2,000 tokens and does not move with
`max_tokens`. With the supply restored, the packet reaches it: the measured
maximum on Broad100-A is now exactly 2,000. A larger budget supplies more
candidates and richer claims, so an authoritative-order prefix under a fixed
ceiling can admit fewer entries than a smaller budget did.

```text
sympy__sympy-13974   3,200 -> 8,000
  supply           22 -> 23
  related          17 -> 17
  packet tokens 1,977 -> 1,962   (ceiling 2,000)
```

**8 ordered budget pairs.** This is M179's outstanding defect §2, unchanged in
mechanism and now reachable rather than theoretical.

- measured: yes | reproduced: yes | mechanism known: yes | repaired: no
- next work licensed: not yet — defect 1 is larger and comes first

## 3. The renderer's closing sentence is still served as source code

Inherited from M179 §3, unchanged. `parseRenderedBodies` assigns everything after
an item's metadata lines to that item's body, and `render` appends
`Impact entries above are bounded static structural evidence; they are not
dynamic execution flow.` after the last section — so the final item's
`focus.code` ends with a sentence that is not source. Normalized out of every
M180 measurement, as in M179, and reported rather than silently subtracted.

- measured: yes | reproduced: yes | mechanism known: yes | repaired: no

## 4. `responseBudget.compacted_fields` is a lossy self-report

`[...new Set(fields)].sort().slice(0, reportedFields)` — deduplicated,
**alphabetically sorted**, then truncated. `productContext.items` sorts after
`capsuleResult.*`, `context` and `deferred.items`, so it falls off the report on
exactly the responses where it fired. Found while trying to attribute the 83
violations; the M180 instrument reads the rendering instead and never trusts it.

A truncated report that looks complete is worse than no report. Not repaired: it
is model-facing output and changing it is a default-output change with no
measured consumer benefit.

- measured: yes | reproduced: yes | mechanism known: yes | repaired: no

## 5. `modelVisibleEstimatedTokens` still misnames what it measures

Inherited from M178/M179 unchanged. Not renamed: it is agent-visible output and a
rename would break byte-identity for no gain.

## 6. Related-selection instability under load

Still outstanding, and **still not unified with this milestone**. M180 established
that the deterministic mechanism was `productContext.items` being cut by
serialization, and that mechanism is gone: the projector no longer reads a mutable
surface at all. Whether a load-dependent instability remains has NOT been
re-measured here — §100 says to reassess only after the deterministic mechanism is
eliminated, which is now true, and §102 says to stop.

- measured: previously | reproduced under M180: not attempted
- mechanism known: no | repaired: no | next work licensed: not yet

## 7. `productContext.items` still misdescribes its own response

The serialized response continues to say `omittedItemCount: 20` while carrying 21
rendered sections. That is now correct in the sense that matters — `items` is
model-facing metadata and the count is a truthful record of metadata compaction —
but the response's own map of its contents remains lossy for a reader who has only
the response. The candidate that fixed this too (`C_PRESERVE_MINIMAL_INDEX`) cost
26 new `orientation -> decline` pairs and was rejected on §55.

- measured: yes | reproduced: yes | mechanism known: yes | repaired: no
- next work licensed: no — it costs a totality regression at today's allowance
