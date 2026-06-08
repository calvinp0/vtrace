# Stage 5R — System-check routing: general rule or Django-specific limitation?

Decision review for the two shared expanded-eval misses `django__django-11820` and
`django__django-12858`. **Analysis only — no retrieval logic was changed.** The
question: is there a GENERAL "validation / system-check error → check-method
candidates" rule worth implementing, or should this stay a documented
Django-specific limitation?

## Decision (recommendation)

**Do not implement a Django-specific system-check router now.** Reject the
name/dispatcher-keyed routings (`_check_*`, `Model.check`, `Options` meta) as
overfitting. There IS one genuinely general rule in this data — **"a cited
diagnostic/error-code literal routes to the symbol that emits it"** — and it is the
right shape, but it should be **deferred behind two prerequisites**, not built as a
bespoke check-router:

1. **Index symbol bodies / string-literals** (a general capability). The reason
   `_check_ordering` is unreachable today is purely mechanical: the only token tying
   the task to it — the error code `models.E015` — lives in the method BODY, and the
   search index covers only `local_name`, `fq_name`, `signature`, `docstring`,
   `file_path` (see `symbol_search_fts` in `src/db/schema.ts:331`). Bodies are read
   from disk on demand (`loadSymbolSource`) and are never searchable. No routing rule
   can rank a candidate whose only matching token is invisible to retrieval.
2. **Expand the eval with diverse error-code instances** before tuning. The current
   fixture cites a structured error code in exactly **2 of 20** tasks — and both cite
   the **same** code (`models.E015`) routing to the **same** symbol. A rule validated
   on two instances of one code is indistinguishable from an E015 overfit; generality
   cannot be measured from this sample.

Until both hold, document this as a known limitation with the precise root cause
(below). The interim cost is 2 misses; the avoided cost is a check-router tuned to
one Django error code.

## Evidence

### The two misses
| instance | task cites | gold file | gold symbol |
| --- | --- | --- | --- |
| django__django-11820 | "models.E015 … Meta.ordering … pk of a related field" | `db/models/base.py` | `_check_ordering` |
| django__django-12858 | "models.E015 … ordering uses lookups that are not transforms … SystemCheckError" | `db/models/base.py` | `_check_ordering` |

Both are auto-derived `gold_patch` bug reports; intent `debug`, budget 8000.

### Why the target is unreachable (mechanical root cause)
- `Model._check_ordering` (`db/models/base.py:1660`) is one of ~25 `_check_*`
  methods dispatched by the `Model.check()` classmethod (`base.py:1249`).
- It raises the cited code: `id='models.E015'` appears at `base.py:1721` and `:1748`.
- That literal is **the only token shared between the task and the gold symbol** — the
  method name `_check_ordering` is NOT in the prose, and the prose's lexical mass
  ("ordering", "lookups", "transforms") diffuses to `fields/*` and `lookups.py`.
- `models.E015` appears in **exactly one file and one symbol repo-wide** (verified
  with a repo-wide scan): `_check_ordering`. So the code→emitter signal is 100%
  precise here.
- But `models.E015` lives in the body, and the FTS index has no body column, so the
  signal is invisible. Post-P1 lexical down-weighting cannot help (nothing to
  re-rank); the candidate is simply absent from the 25-symbol pool (`symbol=0`,
  `lexical` diffused elsewhere — consistent with the post-P1 audit's "recall gap").

## Are the proposed routings general?

| proposed routing | general? | verdict |
| --- | --- | --- |
| **Error/diagnostic code → emitting symbol** (find the symbol whose source contains the cited code literal) | **Yes** — error codes are a cross-ecosystem concept (lint rule IDs, HTTP status, compiler diagnostics, framework check IDs). The mechanism ("the bug names a code; find where it is raised") names no framework. | The only defensible general rule. Right shape, blocked on body indexing. |
| `_check_*` method-name routing | No — `_check_` is a Django naming convention. Other stacks use `validate_*`, `clean_*`, `verify_*`, rule classes. | Reject: per-convention patch. |
| `Model.check` / `Options` meta routing | No — these are Django symbols. | Reject: hardcodes framework identity. |
| "system check" / "validation" phrase routing | Nominally general but **low precision**: would boost every `validate_*`/`check_*`/`clean_*` method on any task mentioning "validation", a large false-positive surface that risks regressing unrelated instances. | Reject: vague, high false-positive risk. |

Only the first is both general and precise. Crucially, its precision comes entirely
from the **code literal**, not from anything Django-specific — which is exactly why
it generalizes, and exactly why it needs body/literal indexing to work.

## Feasibility of the general rule

- **Signal quality:** excellent. A structured code (`models.E015`, or generally a
  token like `[A-Za-z_]+\.E\d+` / `E\d{3}` / `W\d{3}`) detected in the task, matched
  against a body/literal index, yields the emitter directly. Here: 1 candidate, exact.
- **Blocker:** no body-level search exists. Two implementation paths, both real work:
  - *Index-time (preferred, general):* add a searchable body/string-literal field (or
    a dedicated `error_code → symbol` extraction) to the index. Reusable beyond this
    task; cost is parser/extraction + index size + re-index.
  - *Query-time body scan:* detect a code, then scan source for the literal. The
    existing `source_body_call_fallback` only scans the EXISTING pool's bodies, and
    `base.py` is not in the pool — so this path cannot reach the target without a
    repo-wide content scan, which is O(repo) per query unless backed by an index.
- **Validation gap:** with 2 same-code instances, a "general code router" and an
  "E015 special-case" produce identical eval deltas. We cannot tell them apart, so we
  cannot claim generality — the requirement's central concern.

## What to do instead (interim)

1. Record this as a **known limitation**: "Tasks whose only precise signal is an
   error/diagnostic code emitted in a method BODY are under-retrieved, because symbol
   bodies are not indexed." (Root cause, not a Django quirk.)
2. When body/literal indexing is added for other reasons, revisit the **general**
   error-code→emitter rule and validate it against an **expanded, diverse** code set
   (other Django `E0xx`, and ideally non-Django: lint IDs, HTTP codes) before landing.
3. Do **not** add `_check_*` / `Model.check` / "validation"-phrase routing under any
   priority — they are framework-shaped and (for the phrase rule) regression-prone.

## Net

There is a real general rule here, but it is "diagnostic-code → emitter," not
"system-check routing." It is blocked on a general capability (body/literal search)
the index lacks, and unverifiable as general from two same-code instances. The
correct call is to **defer**, document the precise mechanical limitation, and gate
any future implementation on body indexing plus a broader error-code eval — not to
ship a Django-specific check-router for two rows.
