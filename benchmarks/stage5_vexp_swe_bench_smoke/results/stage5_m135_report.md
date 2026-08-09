# VTRACE M135 — Query Semantics and Literal-Signal Quality

## Verdict

**PASS.** M135 fixes both reproduced retrieval failures without changing aggregate
Frozen-50 quality, lead selection, exact symbol resolution, flow, impact,
worktree routing, response envelopes, or the TCKDB acceptance result.

- Starting HEAD: `6d9a1b7854ab5768c9f059c73f63909e69199888`
- M134 functional predecessor: `7b29882ec23477ed7bcc738a4073af1d270ece7e`
- M135 functional commit: `cec130c2b1f62a1fd95b459e56aa7d6c3d223731`
- Branch: `main`
- Pushes: none

## Root cause and implementation

M134's shaped task had no polarity. The full prose—including the right-hand side
of “rather than”—fed lexical admission, BM25/FTS, path clues, objectives, direct
evidence, and selection as positive evidence. Consequently, “coordinates” and
“four atom indices” strengthened the implementation the task excluded.

The short-symbol failure had the same missing-confidence shape at a different
layer. Case-folded lexical matching let an ordinary grammatical token such as
`in` contribute exact local-name strength to `In`. There was no contextual
distinction between prose and `element In`, `Element.In`, a backtick, or an
FQN. Case and length alone were insufficient.

M135 derives one request-local `DerivedQueryIntent` during query shaping. It
carries positive text/terms, bounded contrast clauses and phrases, explicit and
comparison identifiers, identifier-confidence signals, and weak literal tokens.
The same value is reused by candidate generation, ranking, synthetic backfill,
path-objective affinity, and bounded diagnostics.

The deterministic contrast grammar recognizes high-confidence forms including
`rather than`, `instead of`, `not B but A`, `without`, `excluding`,
`except`, and `not the X version`. The right span stops at punctuation,
adversative/result boundaries, or 12 tokens. The preferred left clause is also
bounded. Positive affinity is capped at 0.24 and contrast penalty at 0.75, so
repetition cannot create an unbounded penalty. Explicit positive/comparison
anchors remain protected.

The grammar deliberately refuses naive negation and observed-behavior traps:
`not only A but also B`, `whether or not X`, `does not crash`,
`no longer calls X`, `not X itself, but its caller`, and narrow bug-report
forms such as “raises/uses X instead of Y,” “except sometimes,” and passive
“is formatted without.” The paired audit found and drove the last three rules.

Identifier confidence is `explicit_identifier`, `strong_literal`,
`weak_short_literal`, or `ordinary_prose`. A small inspectable task-language
set controls only high-signal symbol confidence; tokens remain available to FTS
and documents. Backticks, symbol-kind words, comparisons, causal questions,
qualified access, and FQNs activate explicit short symbols. Generic dotted
values such as `app.Model.origin` are not reduced to a broad `origin` seed.

## ARC dihedral acceptance

Task: “a function that returns a dihedral angle given three vectors, rather than
given coordinates and four atom indices”.

| Candidate | M134 rank | M135 rank | M135 positive | M135 literal | Contrast penalty | M135 final | Selected |
|---|---:|---:|---:|---:|---:|---:|---|
| `get_dihedral` | 5 | 1 | 0.24 | 0 | 0 | 1.9413 | lead pivot |
| `calculate_dihedral_angle` | 2 | 3 | 0.24 | 0 | 0.28 | 1.8132 | pivot |
| `get_normal` | 1 | 2 | 0.12 | 1 | 0 | 1.9000 | support |
| `interpolate_addition` | outside cap | outside cap | 0 | 0 | 0 | — | no |

M134 selected `calculate_dihedral_angle` but not `get_dihedral`; M135 makes
`get_dihedral` the lead. The coordinate/index implementation is measurably
demoted rather than blacklisted. The historical incident described
`interpolate_addition` approximately; on the recorded ARC checkout it is
outside both deterministic candidate caps.

Controls pass:

- `find calculate_dihedral_angle`: `calculate_dihedral_angle` rank 1/lead.
- `compare get_dihedral with calculate_dihedral_angle`: both pivots, ranks 2/1.
- `why doesn't get_dihedral call calculate_dihedral_angle?`: both pivots,
  ranks 2/1, no exclusion.

## ARC short-identifier acceptance

The reconstructed incident query is recorded verbatim as:
`How does lookup work in element.py?`

| Candidate | M134 literal signal | M135 confidence | M134 rank | M135 rank | Result |
|---|---|---|---:|---:|---|
| `arc/molecule/element.py::In` | ordinary `in` contributed lexical strength | `ordinary_prose` | 3 | outside cap | support removed upstream |

M134 gave `In` lexical 0.8736/final 2.5736 and selected it as support. M135
creates no high-confidence literal candidate from that `in`; `In` does not
consume a selected or pivot slot. The positive control
`where is element In defined?` gives `In` rank 1,
`explicit_identifier`, symbol score 1, and keeps it as support. Exact FQN
resolution remains unchanged.

Generic `In/As/At/No/Be/Go/DB/IO` fixtures, qualified/backtick controls,
ordinary-prose and explicit metamorphic tests, and
`DB rather than IO` all pass. Symbol-specific confidence is not applied to the
YAML/TOML document lane.

## M134 → M135 paired benchmark

Both sides used the same M134 paired runner and protocol, the same fixture
identity, the same target commits, clean detached VTRACE implementations, and
independently prepared indexes. Provenance validation reports authoritative and
valid for both suites.

| Suite | M134 Top-1 | M135 Top-1 | M134 Top-3 | M135 Top-3 | M134 pivot | M135 pivot | Missing |
|---|---:|---:|---:|---:|---:|---:|---:|
| Django expanded (20) | 0.9000 | 0.9000 | 1.0000 | 1.0000 | 1.0000 | 1.0000 | 0.0000 |
| cross_repo_30 (30) | 0.7000 | 0.7000 | 0.8333 | 0.8333 | 0.7667 | 0.7667 | 0.1000 |
| Frozen 50 | 0.7800 | 0.7800 | 0.9000 | 0.9000 | 0.8600 | 0.8600 | 0.0600 |

There are six semantic changes, zero lead changes, and zero quality-metric
changes. Every case is attributed:

| Case | Cause | Selection consequence | Gold effect |
|---|---|---|---|
| `django__django-11749` | short `id`/ordinary-token confidence | final support order swapped | neutral |
| `django__django-11820` | explicit short `pk` vs ordinary short prose | one support file changed | neutral |
| `django__django-12774` | `UniqueConstraint instead of unique=True` contrast | marginal manager support removed | neutral |
| `astropy__astropy-14365` | ordinary `in/is/be` | role/content mode only; same file | neutral |
| `astropy__astropy-14598` | ordinary `In/in/I` | context/accounting only; same set | neutral |
| `sympy__sympy-16766` | pronoun `I` and preposition `to` | support order only; same set | neutral |

No `unexpected` cause remains. `psf__requests-1724` is unchanged with
`requests/api.py` lead and gold visible, so its historical M123 attribution is
preserved. `sphinx-doc__sphinx-7462` is byte-semantically unchanged with
`sphinx/domains/python.py` lead and the same support composition.

The M135 semantic hashes and complete M134 provenance are promoted in
`stage5_m135_quality_summary.json`; filename alone is not treated as baseline
authority.

## Preservation and performance

- Project name: the generic ARC geometry task does not select
  `arc/main.py::ARC`; the explicit ARC-class query still leads with it.
- Flow: `reorder_p_label_map → map_two_species` is one exact `calls` edge,
  edge-site line 1724, with frontier traversal not limited.
- Impact: `get_dihedral`, `max_edges=10`, `max_tokens=1200` retains known
  caller evidence and returns `withinEnvelope:true`.
- Worktrees: nested exclusion and explicit requested-worktree routing pass.
- Response envelope: focused and scale suites pass; no successful bounded
  response reported `within_envelope:false`.
- TCKDB: same read-only checkout/head and index produce identical M134/M135 lead
  and six-file selection covering client tests, implementation, workflow,
  full-suite/dependency configuration, and notebook evidence.

Median of eight warmed runs of the exact ARC query on one read-only index:

| Timing | M134 ms | M135 ms | Delta ms |
|---|---:|---:|---:|
| Task derivation | 14.6575 | 15.2880 | +0.6305 |
| Candidate scoring | 12.7745 | 15.6947 | +2.9202 |
| Hybrid retrieval | 261.7878 | 186.5428 | -75.2450 |
| Total capsule | 324.4307 | 235.6986 | -88.7321 |

The parser alone averaged 0.2851 ms for a deterministic 1,182-character,
multi-clause query over 10,000 iterations. Phrase normalization is request-local;
there is no candidate×phrase reparse.

## Verification and safety

- `bun run typecheck`: PASS
- `bun run typecheck:benchmarks`: PASS
- `bun test`: 3,880 pass, 49 skip, 0 fail across 241 files
- `git diff --check`: PASS
- Focused preservation matrix: 78 pass, 0 fail
- No live agents, Docker, VEXP, paid APIs, external NLP, embeddings, or LLM
  rewriting were used.
- ARC and TCKDB sources were read-only; isolated/copy indexes were used where
  product behavior was exercised.

## Limitations and recommendation

This remains a deliberately small English task grammar, not a full semantic
parser. It under-applies ambiguous contrast, caps phrase scope, and recognizes
only inspectable explicit-identifier contexts. Medium-confidence parses are not
penalized. The stopword set is intentionally small and affects only literal
symbol confidence.

The six-case ledger exposes no remaining recurring failure pattern or quality
loss. The evidence therefore supports reassessing and then proceeding to
**M136 — Workspace and Repository Identity Foundation**. M136 should not begin
automatically, and workspace aggregation remains out of scope for M135.
