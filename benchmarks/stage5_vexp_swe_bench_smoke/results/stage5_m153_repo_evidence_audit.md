# M153-B — audit: what repository-level routing evidence already exists

Read against `72ce221c` (M152 final functional), before any M153 implementation.

## The existing nomination ladder

`src/workspace/repositoryRelevance.ts::nominateRepositories` groups evidence into
tiers. The highest tier producing any evidence decides; **within** a tier, more
than one repository means `Ambiguous` rather than a winner. There is no blended
score anywhere, and that is deliberate — §32 of M146-B refuses to assume one
repository's raw retrieval score is comparable to another's.

| Tier | Kind | Index needed? | What it reads |
| --- | --- | --- | --- |
| 0 | `explicit_route` | no | caller-supplied repo/member selector |
| 1 | `path_containment` | no | an absolute path inside a registered root |
| 2 | `indexed_path` | **yes** | suffix membership via M145 identity |
| 3 | `exact_symbol` | **yes** | bounded exact-name lookup |
| — | *(nothing)* | — | `no_match` → configured default / sole member / abstain |

`EVIDENCE_REQUIRES_READY_INDEX` is a table, not a per-lane condition, and
`poolForEvidence` derives each lane's member pool from it. A new lane therefore
cannot forget the readiness gate — it must declare whether it reads
indexer-derived state, and the pool follows.

## The gap, stated by the code itself

`src/workspace/productRoute.ts` says it outright:

> There is no behavioural relevance lane in M146-M149 and this module does not
> invent one: a query that names no path and no identifier carries no routing
> evidence, and the honest outcome is the workspace's own configured authority or
> an abstention — never the member whose name the query happened to mention.

That was truthful in M151 and is exactly what M153 addresses.

## What the hint extractor actually emits

`extractQueryRouteHints` is deliberately strict. A token becomes a **symbol**
hint only if it is backtick-quoted, a call (`foo()`), qualified (`a.b`,
`A::b`), contains an underscore, or has a lowercase→uppercase transition. Bare
words never qualify, and a bare all-caps acronym never qualifies.

Running the corpus queries through it establishes what routing evidence today's
product can actually see:

| Corpus query shape | pathHints | symbolHints | Lane reached |
| --- | --- | --- | --- |
| behavioural prose (26 cases) | none | none | **no lane runs** → `no_match` |
| `Where is rank_adapters defined?` | none | `rank_adapters` | exact symbol → absent everywhere |
| `Where is score_backends defined?` | none | `score_backends` | exact symbol → absent everywhere |
| `Does Flask already have…` | none | none | **no lane runs** |
| `Does Sphinx already have…` | none | none | **no lane runs** |

Two findings worth recording:

1. **The absence controls already work.** `rank_adapters` / `rank_fixtures` /
   `score_backends` are underscore-bearing, so they reach the exact-symbol lane,
   find nothing in any member, and produce a proven absence. M153 must not
   disturb this (§58, §87).
2. **Repository-name poisoning is already blocked at the routing hint level.**
   `Flask`, `Sphinx` and `pylint` have no camel transition and no underscore, so
   they never become symbol hints. The residual risk is not in routing — it is in
   **retrieval scoring**, where the project token travels into the capsule task
   and could promote a same-named symbol. That is measured in oracle mode, and it
   is where the mid-milestone clarification's concern actually lives.

## Candidate evidence sources for a behavioural lane

| Source | Truthful for behavioural nomination? | Why |
| --- | --- | --- |
| exact symbols | already a stronger tier | must keep outranking (§56) |
| indexed paths | already a stronger tier | must keep outranking (§56) |
| repository names | **no, not for symbol relevance** | may express project intent for routing only (§33, §53) |
| raw lexical/FTS overlap | **no** | rewards repository size (§43, §44); the §50 docs-only distractor wins on it |
| document/path clues | shortlist only | must not exclude a correctly-but-dully-named repo (§60, §61) |
| **M150 mechanism facts** | **yes** | subject-aligned, operation-typed, already generic |
| **operation-role assignment** | **yes** | separates direct implementer from consumer (§45) |
| workspace membership / manifests | metadata only | not behavioural evidence |

The only sources that survive are the ones M150 already built: a mechanism fact
carries both the operation performed and the subject it acts on, which is exactly
the pair §47–§49 require. Nothing new needs inventing; the lane needs a **bounded
probe** over machinery that exists.

## Cost model, measured before designing

Indexing the seven corpus repositories (`initRepo`, cold):

| Repository | Python files | Index time |
| --- | --- | --- |
| requests | 35 | 0.4 s |
| flask | 80 | 4.9 s |
| pytest | 214 | 14.2 s |
| sphinx | 548 | 31.9 s |
| xarray | 165 | 22.2 s |
| astropy | 941 | 141.7 s |
| pylint | 2189 | *(see note)* |

Note: pylint ships deliberately-invalid Python as linter fixture data
(`doc/data/messages/*/bad.py` contain intentional `SyntaxError`s), which fails
indexing outright. A `.vtraceignore` excluding `doc/data/messages/` is committed
into that checkout and recorded here; it is analyser test data, not source, and
the M153 ground truth lives in `pylint/lint/pylinter.py`.

The relevant consequence is the **ratio**: a full retrieval against astropy is
three orders of magnitude more expensive than a bounded index probe. Any design
that runs full retrieval per member is unaffordable at 11 members and absurd at
1000 (§39, §108). This is why the lane must be a probe, and why the probe must
not hydrate source (§37).

## Where the lane belongs

Between tier 3 and the `no_match` fallback:

- **Below exact symbol** — a unique exact symbol must not be overridden by fuzzy
  behavioural scoring (§56), and explicit scope must not be overridden at all
  (§55).
- **Above configured default** — a default is a fallback, not competing
  evidence, so real evidence may override it (§54).

`RepositoryProbe` is the natural seam: it already abstracts "what may this lane
ask an index", is opened lazily per member, and is counted per member so
consulting one index twice is one probe.
