# M150 path-evidence contract

## The invariant

> A path can tell VTRACE **where to look**. It cannot, by itself, prove **which
> symbol answers the question**.

Concretely: a path/file/directory-stem match may strengthen a candidate that
already has independent query relevance, but a path-stem-only coincidence may not
independently create maximum-strength answer relevance.

This is the same shape as M142's centrality rule — centrality may strengthen
relevance and may not create it — applied to a different evidence kind.

## The producer (§11), named exactly

`src/capsuleV2/directEvidenceAnchoring.ts`, branch (a) of `resolveFileStemWord`.

It is **not** FTS, not path-component scoring, not the domain lane, and not the
`pathClues` signal. The lane resolves a bare lowercase prose word against
`filesWithBasename(term + ".py")` and, on a hit, calls
`symbolsForResolvedFile(..., cap = 1)` to pick one definition out of that file.
`buildDirectEvidenceCandidate` then **synthesizes** a scorecard:

```
lexical: 1, fts: 1, tfidf: 1, bm25: 1, symbol: 1, localEvidence: 1
final:   DIRECT_EVIDENCE_WEAK_FINAL = 1.9
```

That is the observed `lexical = 1.0000 / final = 1.9000` exactly. Nothing
computed it from the candidate; it was assigned by tier.

### The path component responsible

Query: `What determines the precedence/order when multiple reaction families match?`
→ bare word `families` → basename `families.py` → `arc/job/adapters/ts/linear_utils/families.py`
→ `symbolsForResolvedFile` ordering is `mentioned → topLevel → actionable`; no
definition in that file is named in the task, so it fell through to the first
top-level def, `_dihedral_angle`, a geometry helper.

### Evidence-authority conflation (§12)

The weak tier gave a **file-level** observation the authority of a **symbol-level**
answer match. M142 had already found and fixed this on branch (b) — the bare-word
→ top-level-symbol resolution now requires exact-symbol eligibility, which is what
stopped `which` becoming `common.py::which`. Branch (a) was documented as
"deliberately left alone", because a file with that basename genuinely exists.
That reasoning is sound about the FILE and silently extends to a symbol it does
not cover.

## The rule

A weak, **file-derived** mention may synthesize an answer-grade candidate only for
a definition that has independent relevance:

```
lexical > 0  or  domain > 0  or  bodyLiteral > 0  or  testToImpl > 0
                 or  mechanismEvidence > 0
```

`path` and `symbol` are excluded on purpose. `symbol` is precisely what the
mention synthesizes, so consulting it would make the test circular (§13); `path`
is the coincidence under scrutiny.

`mechanismEvidence` counts (§14). Subject-aligned behavioural evidence is real
candidate relevance, so an operation-fact candidate keeps any path support it
earns.

The predicate is supplied by the **caller**, because independence must be judged
against a retrieval pool this lane cannot see. Omitted means "unknown", and
unknown changes nothing — without a predicate every stem resolution behaves
exactly as it did before.

## What is deliberately unchanged

- **Strong mentions** — dotted module paths and explicit file paths — name a file
  or symbol outright and are untouched (§16, §17, §23).
- **Stem resolutions whose symbol IS independently relevant** keep the full weak
  tier, which is what preserves the M96 recoveries.
- **Concept-owner file nomination** is a different layer and was not touched
  (§42, §43). File-owner discovery and symbol answer-ranking stay separate.
- **Path contribution magnitude** was not retuned. No constant was shaved, and no
  threshold was introduced (§27, §29, §55).

## Measured effect

ARC ordering query: `_dihedral_angle` **1.9000 / rank 1 → out of the lead**. The
lead is now `determine_family` on genuine lexical evidence.

Frozen50 (M149 → final): **16/50 cases changed composition, every quality metric
identical** — Top-1 38, Top-3 44, gold anywhere 48, gold symbol 31, missing 2 on
both sides; mean tokens 1832.40 → 1832.48. §66 anticipated exactly this: rankings
that depended on path-only accidental evidence moved, and nothing that measures
answer quality did. Cause `path_only_relevance_gate`, quality **NEUTRAL**.

M142 preservation intact: Gaussian owner-file Top-1 **true**, `which()` and
ARC-class controls unchanged, all four behavioural cases unchanged.
