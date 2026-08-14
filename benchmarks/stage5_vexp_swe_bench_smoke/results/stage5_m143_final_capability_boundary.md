# M143 — the static-evidence capability boundary

**Predecessor** `41fb0a9ba22b0f69e3349aca77b4ae2b15908504` (M142 final functional)
**Candidate** `93a34d194b2360094d61b27f2ecc12f6dccacdb3` (M143 final functional)

This is the milestone's central scientific output. M143 did not fail to find a
static relation between the task subject and the behaviour owner. **M143
established that, for the hard case, the relation does not exist.**

---

## 1. What static evidence CAN establish

| evidence | what it proves | status |
|---|---|---|
| **title identity** | the task *talks about* symbol `X`; `X` exists under that exact name | reliable, and now truthfully scored |
| **organic retrieval** | which code matches the task's language, across lexical / FTS / TF-IDF / BM25 / symbol channels | reliable; frequently already leads with the behaviour owner |
| **`calls` / `references` / `imports` / `contains`** | exact, directed, source-observed relations | reliable where the relation exists |
| **interface / override role** | a class that redefines a base's member has taken responsibility for that member | reliable — reconstructible from a class-to-class `references` edge intersected with `contains` members |
| **absence of a relation** | that two symbols are genuinely unconnected in source | reliable, and *informative* — see §3 |

## 2. What static evidence CANNOT establish

| question | why not |
|---|---|
| **is a title-named symbol the EDIT SITE or merely the SUBJECT?** | measured on the frozen 50: no candidate-local or relational signal separates the one wrong promotion from the four correct ones |
| **which same-domain class owns a requested ACTION?** | the override role answers this only when the request's vocabulary reaches the interface member's name; real requests routinely do not |
| **what implements behaviour involving entity `X`, when the implementation never names `X`?** | there is no fact in the source to read |

Eleven mechanisms were measured across M142, M143-A and M143-B and every one was
rejected on evidence, not on taste. Two of them looked positive until measured
properly: the ownership gate (circular, then backwards — 9 suppressions, 8
destroying a correct lead) and title-family support (a pool-floor artifact).

## 3. The decisive measurement

For `django-11740` the behaviour owner is
`django/db/migrations/autodetector.py` and the task subject is
`ForeignKey` in `django/db/models/fields/related.py`. Across **all 45 × 138
symbol pairs** between those two files the index holds:

```
calls        0
references   0
imports      0
contains     0
```

in **both** directions. `ForeignKey` has **inDegree 193** — its top referrers
are `tests/invalid_models_tests/test_relative_fields.py` (44),
`tests/schema/tests.py` (28), `tests/migrations/test_state.py` (20). Not the
autodetector.

### Why the relation is absent

The migration autodetector operates on **field instances drawn from model
state**. It never names a concrete field class. Stated generally:

> An implementation is general enough to own the behaviour precisely because it
> does not name the specific entity the bug report mentions.

Generality is *anti-correlated* with nameability. So a "the owner will reference
the subject" heuristic is weakest exactly where ownership matters most.

This absence is:

- **not** missing from the index
- **not** missing from the parser
- **not** lost at persistence

It is absent from the source-level static relationship itself. **No schema change
can create it truthfully.**

## 4. A real representational loss (separate finding)

`edges.edge_type` admits only `contains | imports | calls | references`. The
Python parser tags reference kinds — `inheritance`, `decorator`, `annotation` —
and `emitReferenceEdges` uses the kind only for shadowing before discarding it.
So "`X` inherits `Y`" and "`X` annotates with `Y`" are the same row.

This is a genuine loss and worth recording. It is **not** the cause of §3:
restoring inheritance as a first-class edge would sharpen the interface/override
role and would leave `django-11740` exactly where it is, because there is no
`autodetector → ForeignKey` fact of any kind to promote. **Do not turn this into
a schema-expansion milestone.**

## 5. What new input class would be required

The missing signal is **not** more of what M143 already has:

```
not more title weighting
not more centrality
not more body lexical text
not more static graph traversal
```

It is an **observed failure / localization evidence class** — evidence about what
actually executed and failed, rather than what the repository statically
contains:

```
failing test name
failing test file / path
traceback frame
stack trace
exception location
explicit reproduction command
assertion location
task-provided file references
```

For `django-11740` this is decisive in principle: the failing test exercises the
autodetector, which names the owner directly without any inference from
`ForeignKey`. The evidence hierarchy would become:

```
TITLE / TASK ENTITY     what the report talks about
STATIC RETRIEVAL        what repository code matches the task's language
FAILURE EVIDENCE        what code path actually failed / was exercised
BEHAVIOUR LOCALIZATION  combine the above without fabricating a relation
```

**This remains a hypothesis.** M143 establishes that static evidence cannot
separate this case; it does **not** establish that failure evidence will. That
has to be measured, which is what makes it a milestone rather than a patch.

## 6. Invariants this milestone leaves behind

```
TITLE IDENTITY CAN PROVE THE TASK TALKS ABOUT X
IT CANNOT PROVE X IS THE EDIT SITE

STATIC GRAPH ABSENCE CAN BE REAL
IT IS NOT AUTOMATICALLY AN INDEX BUG

GENERIC IMPLEMENTATION CODE MAY OWN BEHAVIOUR INVOLVING A
CONCRETE ENTITY WITHOUT EVER NAMING THAT ENTITY

ORGANIC RETRIEVAL MAY ALREADY FIND THE BEHAVIOUR OWNER
WHILE TITLE INJECTION PROMOTES THE TASK SUBJECT OVER IT

BEHAVIOUR OWNERSHIP CANNOT BE FABRICATED FROM
CENTRALITY, IDF, OR A FITTED THRESHOLD

INTERFACE/OVERRIDE EVIDENCE IS A REAL STRUCTURAL OWNERSHIP SIGNAL
BUT ONLY WHERE QUERY ACTION AND INTERFACE ROLE ALIGN

WHEN STATIC EVIDENCE IS AMBIGUOUS: ABSTAIN
```

Abstention is not a safety failure. It is the designed response to insufficient
evidence, and the generic ambiguous controls confirm vtrace takes it rather than
fabricating certainty. M143-B's NOT PASS is a statement about **capability**, not
about safety.
