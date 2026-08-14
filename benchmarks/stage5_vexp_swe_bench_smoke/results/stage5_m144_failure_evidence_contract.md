# M144 — Failure-evidence contract

What counts as task-supplied **observed failure evidence** in Stage 5, what each
form is allowed to assert, and what M144 actually consumes.

Companion artifacts: `stage5_m144_failure_evidence_forms.json` (the typed shapes
and their corpus counts), `stage5_m144_failure_evidence_inventory.{json,md}`
(prevalence), `stage5_m144_failure_path_resolution.json` and
`stage5_m144_traceback_attribution.json` (resolution and frame roles).

## 1. The evidence hierarchy this contract exists to keep separate

```
TITLE / TASK ENTITY     what the report talks about
STATIC RETRIEVAL        what the repository's text and structure suggest
FAILURE EVIDENCE        where the failure was observed or exercised
BEHAVIOUR LOCALIZATION  the combination of independent signals
```

These are four different claims. M143 established what happens when one is read
as another: the title lane asserted `lexical = fts = tfidf = bm25 = 1` for a
candidate retrieval had never produced, and the capsule told the model "strong
lexical match" with no lexical measurement behind it.

Failure evidence is therefore **not** a title boost and **not** a lexical score.
It answers a different question, and it must be represented as itself.

## 2. What each form may and may not assert

| Form | Localizes? | May assert | May **not** assert |
|---|---|---|---|
| traceback frame (complete, in-repository) | yes | the runtime executed this function in this file | that this is the edit site |
| traceback frame (external / stdlib / foreign) | no | that execution left the repository here | anything about repository symbols |
| traceback frame (raising, dunder) | no | that a language protocol hook ran | the behaviour the report is about |
| failing test name | weak | a test with this name was observed failing | the production code it exercises |
| pytest node id | yes | a specific test symbol failed | the production code it exercises |
| exception class name | **no** | a symptom class | any location whatsoever |
| explicit source path | yes | the author pointed at this file | that the fix belongs there |
| line anchor (`file.py#L401`) | yes | the author pointed at this line | that the fix belongs there |
| reproduction command | weak | an execution entry point | semantic ownership |

Two of these are worth stating twice, because both are easy to get wrong and the
corpus contains a live example of each:

- **An exception class name is not a location.** `ValueError` is the most common
  evidence form in the frozen 50 (18 of 50 cases) and it localizes nothing. Ten
  frozen-50 cases carry an exception name and *no other* evidence; counting them
  as "failure evidence present" would inflate the capability's apparent reach by
  a factor of two.
- **A failing test is an observation anchor, not the answer.** A test can fail
  because of code far from it, and `django-12273`'s `test_f_true` does not exist
  in the repository at all.

## 3. Membership: whose code is this?

A path that arrived as text is not a repository object until it resolves. The
corpus contains five shapes that all had to be handled:

```
./sympy/core/evalf.py                                   repo-relative
\path\to\site-packages\sphinx\domains\python.py         Windows, installed
/app/venv/…/site-packages/django/db/models/query.py     installed copy of OUR code
/usr/lib/python3.10/sre_parse.py                        standard library
/Users/hwkns/test_requests.py                           the reporter's laptop
```

**No prefix rule separates them.** `site-packages` holds both an installed copy
of the project's own source (django-12774's entire traceback, and it is the right
localization) and genuinely foreign dependencies. Membership is decided by a
segment-boundary match against the indexed file list — the same path-identity
rule M143 gave the gold-path comparison, in one shared module
(`src/retrieval/repositoryPathMembership.ts`).

Three outcomes, all of them explicit:

- `resolved` — the path names an indexed file
- `external` — it resolves nowhere, and stays external (§67); it never becomes a
  repository candidate
- `ambiguous` — several indexed files match; the capability abstains rather than
  guessing

### 3.1 What membership cannot do

A segment-boundary match is an existence test, not proof of intent.
`/Users/hwkns/test_requests.py` is a file on the reporter's machine that shares
its full last segment with the repository's own `test_requests.py`, and
membership returns true for it. That is acceptable for **rejecting** foreign
frames, which is all M144 uses it for; it would not be acceptable as a licence to
treat the match as the author's intent. One of the 34 resolved evidence items in
the frozen 50 is such a collision, and it is recorded rather than hidden.

## 4. What M144 consumes

M144 ships exactly one consumer, and it is a **narrowing** of an existing rule
rather than a new lane.

M142 admits one traceback frame as an explicit identifier: the deepest, provided
the traceback is complete and the name is not a language-protocol dunder. M144
adds one question ahead of the choice — *is this frame's file part of the
repository being searched?* — and selects the deepest frame that is.

Ordering is load-bearing. Completeness is still measured after the **deepest**
frame in the text, not after the selected one, because completeness is a property
of the traceback (was the excerpt cut off?) rather than of the frame we pick.
Without that, repository filtering would quietly re-enable truncated stacks.

Everything else measured in this milestone — failing-test-to-production
relations, reproduction-command attribution, direct-relation expansion from a
frame — was **measured and not shipped**, with the measurement recorded in
`stage5_m144_failure_localization_generic_controls.json` under
`unshippedMechanismControls`.

## 5. Provenance

Every extracted signal keeps its source. The shipped consumer emits
`source: "traceback_frame"` on the identifier signal it contributes, which is a
pre-existing typed channel — no failure evidence is written into `lexical`,
`fts`, `tfidf`, `bm25` or `symbol`, and the M143-A title truthfulness fix is
untouched (verified case by case in `stage5_m144_preservation_final.json`).

## 6. No evidence, no effect

`isRepositoryPath` is consulted from exactly one place, and the indexed path list
is read lazily. A task with no traceback frame never reaches the new code:
measured `indexedPathsRead = 0` on all 44 no-traceback cases of the frozen 50,
and 0 additional database queries overall, because the path list the membership
test needs was already being read once per task by the localization detector and
is now shared with it.
