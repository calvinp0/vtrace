# M135 Query Semantics and Literal-Signal Quality Plan

## Authority and scope

- Starting HEAD: `6d9a1b7854ab5768c9f059c73f63909e69199888` on `main`.
- Functional predecessor: `7b29882ec23477ed7bcc738a4073af1d270ece7e` (M134).
- Functional candidate: `cec130c2b1f62a1fd95b459e56aa7d6c3d223731` (M135).
- Intentional scope: deterministic task polarity and contextual confidence for
  short/ordinary-language identifier collisions.
- Explicit non-goals: workspace aggregation, embeddings, LLM rewriting, broad
  retrieval retuning, new parser languages, live agents, Docker, and VEXP.

## Root-cause trace

M134 passes the shaped task string unchanged to lexical admission, BM25, domain
relevance, path-objective affinity, symbol/path seeding, and downstream selection.
There is no polarity in `ShapedSweQuery`, so terms to the right of a phrase such
as “rather than” are positive evidence in every lexical scorer. Literal/symbol
lanes likewise have no shared contextual confidence: a short local name that is
also ordinary task language can inherit exact-name lexical strength even when the
task used that token only grammatically.

## Implementation plan

1. Derive one request-local `DerivedQueryIntent` during query shaping.
2. Recognize only bounded, high-confidence contrast forms; preserve comparison,
   causal, historical, and naive-negation traps.
3. Remove excluded spans from positive query/path/symbol derivation while keeping
   document retrieval independent.
4. Reuse the derived intent during candidate scoring for a capped contrast
   penalty and capped positive-side affinity.
5. Assign contextual confidence to exact local-name readings; sharply weaken a
   short ordinary-language collision without blacklisting valid short symbols.
6. Surface compact query interpretation and candidate attribution diagnostics.
7. Validate ARC controls, synthetic dimensions, M132/M133 preservation, TCKDB,
   and M134's provenance-safe paired Frozen-50 comparison.

## Contrast scope rule

The right-hand span ends at sentence punctuation, newline, an adversative clause
boundary (`but`, `while`, `although`, `because`, `so`) or a common result-clause
boundary (`running`, `causing`, `resulting`), or 12 non-whitespace
tokens, whichever comes first. Coordinating `and` remains inside the span so
phrases such as “coordinates and four atom indices” stay intact. The preferred
left side is bounded by the preceding punctuation and the same 12-token cap.

## Quality gate

PASS requires the targeted ARC failures and all safety controls to pass, valid
M134→M135 paired provenance, every changed Frozen-50 case attributed, no
unexplained quality regression, and preservation of flow, impact, worktree,
response-envelope, project-name, and TCKDB behavior.
