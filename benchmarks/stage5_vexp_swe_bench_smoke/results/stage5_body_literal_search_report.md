# Stage 5R — Body/literal search outcome

Change: add a general, framework-agnostic **body-literal search** so a distinctive
literal cited in a bug report — a diagnostic/error code (`models.E015`, `TS2345`,
`ERR_INVALID_ARG_TYPE`) or a quoted message ("Cannot resolve keyword") — recovers
the symbol that EMITS it from its source body. Symbol bodies were previously
invisible to retrieval (the index covers only name/fqName/signature/docstring/path),
so the strongest available signal for these tasks was unreachable.

## What was built

- **Indexing**: `src/indexer/extractBodyLiterals.ts` extracts distinctive literals
  (codes by shape — letter+digit / SCREAMING_SNAKE / qualified `pkg.Ennn`; messages
  as multi-word quoted strings) from each symbol body. A new FTS5 table
  `symbol_body_literals_fts` (`src/db/schema.ts`) stores them; `persistParseResult`
  + `indexProject` populate it at index time. Removal-safe (pruned with the file).
- **Retrieval**: a `bodyLiteralCandidates` generator in `hybridRetrieval.ts`
  extracts the task's literals, searches bodies (qualified codes matched precisely —
  `"models" AND "e015"` — to avoid conflating `models.E015` with `admin.E015`), and
  adds the emitting symbol with a new first-class `bodyLiteral` score component
  (fixed weight `BODY_LITERAL_WEIGHT`, counted as strong/local evidence).
- **Role assignment**: a body-literal override in `debugRoles.ts` promotes a
  function/method literal-emitter to PIVOT (the containing class is demoted to
  context) — analogous to the file-line-anchor override.
- **Scoring policy**: codes are strong, messages medium; generic words (`error`,
  `multiple`, `failed`) never drive a body search (only codes/messages are
  extracted, and message matches AND all distinctive words).
- **Diagnostics**: `body_literal_search_used` + `body_literal_matches` in Capsule v2
  JSON and Stage 5R rows/markdown.
- **Fingerprint**: the new table (schema) and extractor (under `src/indexer`) feed
  the index fingerprint, so the index auto-reinvalidates when this logic changes.

## Metrics (expanded fixture, 20 Django instances)

| metric | before | after | target | met |
| --- | --- | --- | --- | --- |
| top-1 file accuracy | 65.0% | **75.0%** | ≥70% | ✅ |
| top-3 file recall | 80.0% | **90.0%** | ≥85% | ✅ |
| expected file missing | 10.0% | **0.0%** | ≤10% | ✅ |
| expected file as pivot | 70.0% | 80.0% | — | — |

**Zero regressions.** Two instances improved, both `missing → hit_top1_pivot`:

- `django__django-11820` and `django__django-12858`: the bug reports cite
  `models.E015`, a literal that appears only in the body of `Model._check_ordering`
  (`django/db/models/base.py`). Body search recovers it; the qualified-code match
  avoids the `admin.E015` false positive; the role override makes the method the
  pivot (the `Model` class that also carries the literal is demoted to context).
  Row diagnostic: `body_literal_matches: models.E015 -> _check_ordering`.

This closes the recall gap the post-P1 audit identified as the root cause of the
remaining `_check_ordering` misses — not via Django-specific `_check_*` routing, but
via the general "diagnostic-literal → emitting symbol" rule the system-check routing
review recommended (gated on body indexing, now delivered).

## Verification

`bun run typecheck` clean; `bun test` 1418 pass / 0 fail; all 20 workspaces
re-indexed; expanded Stage 5R eval re-run with the metrics above.
