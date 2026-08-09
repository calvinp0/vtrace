# VTRACE M137 — Exact-Answer Retrieval and Query-Signal Hygiene

## Verdict

**PASS.** Functional commit: `68514687df2056d1c3551ea3285503dc6449023f`. Starting evidence HEAD: `3c786e27a76f159c3dfd62e9d58fa5bdba31406e`; functional predecessor: `f48f8c11f0cf76805943e98baa4fc3f566400d39`. Work remained on `main`; nothing was pushed.

## Root causes and implementation

Exact definitions and related helpers previously shared lexical, domain, graph, and contrast components. Indexed signatures/docstrings influenced lexical recall, but there was no bounded component saying that a function definition itself satisfied an existence/capability request. The exact ARC definition could lead, but its lead was not attributed to direct satisfaction and remained close to related candidates.

Residual symbol contamination came from a second, broad extractor in `shapeSweQuery`: `function <next word>` treated prose such as “function in ARC” as symbol `in`, while all-caps project tokens could remain symbol-like. M135 suppressed their worst scoring effect and M132 suppressed project-name anchoring later, but the bad hypotheses still existed upstream.

M137 extends the one request-local `DerivedQueryIntent` with `kind`, `intentReason`, typed `IdentifierSignal.source`, `eligibleAsSymbol`, `symbolHypotheses`, and `projectReferences`. `likelySymbols` is now derived from eligible structured hypotheses plus failing-test symbols; there is no parallel prose symbol extractor. Ordinary semantic terms remain available to lexical/document lanes.

High-confidence `capability_lookup` rules cover deterministic forms such as “is there a function,” “does a helper exist,” “do we already have,” “find the function that,” “which/what function,” “where is the method,” and the bounded nominal form “a function that returns/parses/computes/…”. Comparison, caller, explicit-symbol, and broad behavioral controls remain `general`.

`directAnswerScore` uses only indexed definition-local name, function/method kind, signature, docstring, normalized term/phrase coverage, and conservative numbered parameter shape. It is capped at `0.95`, repetition-normalized, requires at least two matched capability terms, and caps candidates without a name-concept match at `0.28`. Bodies are not read per candidate. It is added once to the existing ranker; explicit symbol/path/graph components and M135 contrast remain independent.

## ARC exact answer

Exact query: “a function that returns a dihedral angle given three vectors, rather than given coordinates and four atom indices”. The authoritative M136 replay already had `get_dihedral` as organic rank 1 on the promoted checkout; M137 keeps it rank 1/P1 and increases the answer-bearing margin with a truthful 0.95 definition match. This differs from the earlier real-use rank-4 observation in the milestone prompt; the replay reports the actual declared `f48f8c11` baseline rather than reproducing an unsupported historical presentation state.

| candidate | M136 rank | M137 rank | M137 role | lexical | literal symbol | positive | contrast penalty | direct answer | base | final |
|---|---:|---:|---|---:|---:|---:|---:|---:|---:|---:|
| `get_dihedral` | 1 | 1 | lead pivot | 1.0000 | 0 | 0.24 | 0 | 0.9500 | 1.6013 | 2.7913 |
| `calculate_dihedral_angle` | 2 | 2 | pivot | 0.8507 | 0 | 0.24 | 0.28 | 0.6960 | 1.7659 | 2.4219 |
| `interp_dihedral_deg` | 18 | 14 | discarded | 0.4897 | 0 | 0.18 | 0 | 0.5720 | 0.7956 | 1.5476 |
| `get_normal` | 22 | outside organic 25 | support via bounded direct evidence | — | — | — | — | — | — | — |
| `interpolate_addition` | outside 25 | outside 25 | absent | — | — | — | — | — | — | — |

The lead explanation is: “direct definition matches requested capability: returns, dihedral, angle, three, vectors; parameter shape aligns.” It does not claim an exact symbol match. `calculate_dihedral_angle` retains the `coordinates/indices` contrast penalty. Controls confirm explicit `find calculate_dihedral_angle`, comparison, broad behavioral handling, and `who calls get_dihedral` receive no capability promotion.

## Symbol hypotheses

Reconstructed query: “Is there a function in ARC that returns a dihedral angle given three vectors, rather than given coordinates and four atom indices?”

| token | M136 | M137 | reason |
|---|---|---|---|
| `in` | eligible `likelySymbols` entry | ineligible ordinary-prose signal; absent from `likelySymbols` | grammatical preposition has no identifier context |
| `ARC` | eligible `likelySymbols` entry | project reference metadata; absent from `likelySymbols` | repository basename without explicit class/symbol context |
| `get_dihedral` | strong only when explicitly named | strong only when explicitly named | explicit snake-case lookup/call context is preserved |

The cleaned hypothesis set for the reconstructed query is empty; `projectReferences` is `["ARC"]`. No candidate reason mentions symbol `in` or project symbol `ARC`. Adding “in this file” does not change likely symbols. Generic “handled in ARC” is equivalent to the project-free query, while “the ARC class” yields an explicit `ARC` hypothesis. All explicit `In` controls (`element In`, `class In`, `symbol In`, `Element.In`, FQN, backtick) remain strong. Author-marked dotted identifiers such as `` `caplog.get_records()` `` preserve their compatibility clues; unmarked `app.Model.origin` still does not seed generic `origin`.

## M136 → M137 paired quality

Both sides used the M134 runner fingerprint `738392…`, protocol v1, identical fixture hashes/target corpora, clean commits, and isolated index paths. Provenance is authoritative and valid.

| suite | Top-1 before/after | Top-3 before/after | pivot before/after | missing before/after | lead changes | selected-set changes |
|---|---:|---:|---:|---:|---:|---:|
| Django expanded (20) | .9000 / .9000 | 1 / 1 | 1 / 1 | 0 / 0 | 0 | 0 |
| cross_repo_30 | .7000 / .7000 | .8333 / .8333 | .7667 / .7667 | .1000 / .1000 | 0 | 0 |
| Frozen 50 | .7800 / .7800 | .9000 / .9000 | .8600 / .8600 | .0600 / .0600 | 0 | 0 |

One case changes only rendered context: `django__django-13012`. M136 emitted ordinary prose `that` from “a function that expects”; M137 removes it. Lead, selected set, roles, content modes, token accounting, gold visibility, and every quality metric are unchanged. Cause: `symbol_hypothesis_cleanup`; effect: neutral. There are zero unexpected cases. `psf__requests-1724`, `sphinx-doc__sphinx-7462`, and all six M135 watch cases are byte-semantically unchanged.

## Preservation and performance

- Budget ladder 200/500/3000/9000 is truthful and within the whole-response envelope. At 200 the result is an explicit `delivery_failure`; from 500 onward `get_dihedral` is visible and never disappears. The required 3000 row is resolved, retrievalFound, non-empty, answer-visible, and within envelope.
- Flow is one exact `calls` edge from `reorder_p_label_map` to `map_two_species`, at edge-site line 1724, with no traversal-limit hit.
- Impact resolves `get_dihedral`, retains 3/10 bounded edges, includes callers `TestVectors.test_get_dihedral` and `calculate_dihedral_angle`, and remains within envelope.
- Nested-worktree exclusion and requested-worktree routing pass in the full suite and focused M132 tests; no routing/index code changed.
- TCKDB read-only checkout is `main` at `6d460d53307ab26eb4b0f2fb3fc74e9103c25cc9`; the secondary capability smoke leads in `clients/python/src/tckdb_client/builders/uploads.py`. This is repository-backed evidence, not a new gold claim.
- Query derivation including symbol cleanup measures 0.0523 ms/request; direct definition scoring 0.0093 ms/candidate; the sampled ARC retrieval is 152.0489 ms total. Added definition scoring is low single-digit milliseconds across the bounded pool and performs zero candidate source reads.
- The 120-similar-definition fixture leads with `normalize_vector` under 250 ms; the repeated weak-word fixture yields no likely symbols and a bounded structured signal set.
- New diagnostics are compact/debug-oriented. M136 progressive delivery and response-envelope tests pass.

## Verification, limitations, and roadmap

`bun run typecheck`, `bun run typecheck:benchmarks`, and the full `bun test` suite pass: 3,913 passed, 49 skipped, 0 failed across 241 files. Focused intent/direct-answer/hygiene/scale tests, M131 flow, M132 worktree/project name, M133 impact, M135 contrast/short identifiers, M136 delivery/envelope, paired provenance, TCKDB, and `git diff --check` also pass. No agents, paid APIs, Docker, VEXP, network operations, pushes, workspace aggregation, stale-memory changes, embeddings, or new MCP tools were used.

Known limitations: capability detection is intentionally phrase-bounded; deterministic lexical morphology is shallow; definition-local scoring cannot infer semantics absent from indexed name/signature/docstring; the ARC baseline discrepancy is recorded rather than rewritten. Observation freshness remains unchanged and belongs to **M138 — Observation/Memory Provenance and Freshness**. Workspace aggregation remains after M138.
