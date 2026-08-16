# M154-C — tracing the project token through the product path

## The question

Naming the repository you are already inside should change nothing about which
symbols are relevant. §29 states the invariant:

```
project/repository name token
    ├── may establish repository scope       YES
    └── may independently boost a code symbol NO
```

ARC reported that natural phrasing — `Does <PROJECT> already have …?` — produced
substantially worse retrieval than omitting the name. ARC is not calibration here;
the question is whether the invariant is violated generically.

## What already protected it (the §31 control)

`src/capsuleV2/projectNameSignals.ts` predates M154 and is well-shaped: it derives
aliases from the **repository root basename**, hardcodes no project vocabulary, and
yields entirely whenever the task shows explicit symbol evidence. It is consumed
in two places — literal anchoring (ALL-CAPS anchors) and `deriveQueryIntent`.

M151's `queryRouteHints` independently refuses bare prose tokens as routing
evidence: "a repository must never be chosen because a query mentions its name".

Both controls hold. Repository routing was never the leak.

## Where the token still entered symbol evidence

`deriveQueryIntent` in `src/retrieval/querySemantics.ts` computed
`projectReferences` and used them to suppress the token from the **identifier**
lanes — `explicitIdentifiers`, `symbolHypotheses`, `identifierSignals`, and
exact-name eligibility. It did not remove it from the **text**.

Measured directly on the pure function, repository root `/tmp/requests`:

| Phrasing | `projectReferences` | `positiveTerms` |
| --- | --- | --- |
| `Does Requests already have a helper for redirect resolution?` | `["Requests"]` | `["requests", "already", "have", "helper", "redirect", "resolution"]` |
| `Is there already a helper for redirect resolution?` | `[]` | `["there", "already", "helper", "redirect", "resolution"]` |

So the module correctly identified the token as a project reference, refused it as
an identifier, and then passed it on as an ordinary content word.

`positiveSearchText` / `positiveTerms` flow into:

| Consumer | Site |
| --- | --- |
| Path relevance context | `buildCapsuleV2.ts:217` |
| Concept-owner retrieval | `conceptOwnerRetrieval.ts:372` |
| Upstream rescue BM25 | `upstreamRescue.ts:406,492` |
| Lexical scoring / matched terms | `querySemantics.ts:876,985` |
| SWE query assembly | `sweQueryShaping.ts:230` |

In a repository whose name is also its package directory — `requests/`, `flask/`,
`sphinx/` — that token matches the path of every file in the package.

**The invariant was violated, generically, and the seam is one place.**

## The fix

The suppression now reaches the searchable text: project-reference spans are
removed from `positiveSearchText` alongside contrast-clause removals, so
`positiveTerms` never sees the token. Nothing new decides this — the lexical bag
simply honours the classification the module had already made.

Two guards keep it from over-reaching:

- **Explicit symbol evidence** (pre-existing): `class Flask`, `the Sphinx class`,
  a backticked identifier, a call, a member access, a `path::Symbol` — any hit and
  no suppression happens at all.
- **Path segments** (added, after the first version regressed it): an occurrence
  touching `/` or `\` is part of a filename. Stripping `requests` from
  `requests/sessions.py` left `/sessions.py`, which resolves to nothing.

No project vocabulary is hardcoded. Protection is not duplicated across layers —
the seam is the one place where the classification and the text meet.

## Measurement

Frozen non-ARC corpus: 12 cases, 8 paired + 4 explicit-identifier/path controls,
across four unrelated repositories (requests, flask, pytest, sphinx), each
materialized with its **project name as the root basename** so the alias resolver
can fire at all — the SWE-bench checkouts are named after their instance, which is
why the protection had never been exercised in any existing suite.

| Metric | predecessor `e3761ab9` | candidate |
| --- | --- | --- |
| Paired regressions (named loses what plain found) | 0 | 0 |
| Paired lead divergences | 0 | 0 |
| Explicit same-name identifier controls preserved | 4 / 4 | 4 / 4 |
| Named lead is a known distractor | 1 | 1 |
| Named lead is expected evidence | 7 / 12 | 8 / 12 |
| Named expected evidence delivered | 11 / 12 | 10 / 12 |

Two leads moved, both attributed to this change:

| Case | Before | After | Quality |
| --- | --- | --- | --- |
| `pytest-make-numbered-dir` | `pathlib.py::cleanup_numbered_dir` | `pathlib.py::make_numbered_dir` | **improvement** — the lead becomes the definition the question asks for |
| `requests-resolve-redirects` | `auth.py::handle_401` (expected delivered as support) | `connectionpool.py::urlopen` (expected not delivered) | **regression** — neither lead is correct; the expected symbol leaves the delivered set |

Deterministic suites (django 20, cross_repo_30 30): **0/50 changed**, provenance
valid, `srcDirty: false`. Those fixtures are rooted at instance directories, so the
alias never matches a task token and the change cannot fire — zero movement is the
evidence that it stayed inside its own precondition.

## Verdict

The **invariant violation reproduced generically** and is fixed structurally at the
seam, with repository scope, explicit same-name identifiers, and path references
all preserved, and no hardcoded project vocabulary.

The **outcome-level harm ARC reported did not reproduce** on this corpus: zero
paired regressions on *both* sides, and the candidate trades one improvement for
one regression. So the fix enforces a stated architectural rule; it does not
demonstrate a measured retrieval gain, and the ARC observation remains
unexplained by this mechanism alone.

**M154-C: MIXED** — root cause proven and fixed, harm not reproduced, no net
measured improvement.
