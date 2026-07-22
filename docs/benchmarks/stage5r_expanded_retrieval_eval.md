# Stage 5R — Expanded Retrieval Eval (body/literal search)

A milestone for Capsule v2's **product intelligence** on the expanded 20-instance
Django fixture: can the capsule recover the correct edit target from the index
alone — including targets named only by a diagnostic literal in the bug report?

## What this eval is

- **Deterministic retrieval only.** It runs `buildCapsuleV2` over indexed
  workspaces and inspects the pivots/support it produces. There is **no Claude, no
  Docker, and no API** in the loop — nothing here calls a model or applies a patch.
  The result is reproducible from the index + task text alone.
- **20 Django fixtures.** Real SWE-bench Django issues, each indexed and queried
  with its issue prose under `--intent debug`.
- **Expected labels are eval-only.** Each fixture carries an expected edit file and
  symbol used _purely to score the eval_; they are never passed into production
  retrieval.
- **No token or cost claim.** This eval measures retrieval quality, not agent
  execution — it makes no statement about tokens, cost, or patch correctness.

## Results

Before body/literal search:

```
top-1:   65%
top-3:   80%
missing: 10%
```

After body/literal search:

```
top-1:   75%
top-3:   90%
missing:  0%
```

No instance regressed.

## Key fix

**Body/literal search recovers diagnostic-code emitters.** Retrieval previously
indexed only symbol names, signatures, docstrings, and paths — never source
bodies — so a symbol named only by the diagnostic it emits was unreachable. Body
search extracts distinctive literals (diagnostic/error codes, quoted messages) from
symbol bodies at index time and, when a bug report cites one, recovers the emitting
symbol.

For example, `models.E015` in the issue text resolves to the one symbol whose body
raises it:

```
models.E015  →  django/db/models/base.py::_check_ordering
```

This recovered `django__django-11820` and `django__django-12858` (both
`missing → top-1 pivot`). The rule is general — keyed on the _shape_ of a literal,
not on any framework — and qualified codes are matched precisely (`models.E015`
does not collide with `admin.E015`).

## Non-claims

- Deterministic retrieval only.
- No Claude.
- No Docker.
- No token/cost claim.
