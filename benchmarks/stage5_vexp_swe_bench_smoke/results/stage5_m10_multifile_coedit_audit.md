# Stage 5 M10 — Multi-file co-edit actionability audit

Offline audit of the new generic **multi-file co-edit** actionability detector
(`src/capsuleV2/multiFileCoeditHints.ts`). The detector was run over the captured
Capsule v2 selections (pivots/support from `_capsule_v2_manifest.json`) for the three
M9 multi-file value-gap cases plus three controls. **Diagnostic only** — no live
agents, no Docker, no 30/100-case runs, no retrieval/scoring/ranking/candidate-gen
changes. The detector is a post-selection advisory: it reads the final selection's
roles/paths/symbols and emits a compact co-edit obligation; it never touches
retrieval (proven below: retrieval evals byte-identical).

## What the detector does

It answers one question from the selection shape alone: *does this capsule likely
require coordinated edits across multiple surfaced files?* Two generic signals, no
instance ids / repo names / hardcoded filenames:

- **Path A — cross-module pivots.** ≥2 edit-capable pivot **files** selected in
  **different directories**. The fix crosses module boundaries; the agent tends to
  edit the traceback-named module and skip the other. Confidence **high**.
- **Path B — sibling pivots + coupled callers.** A single file selected with ≥2 pivot
  **symbols** (a multi-symbol edit) **plus** edit-capable support files that share a
  domain **noun** with the pivot symbols/file (callers/handlers the change propagates
  to). Domain nouns exclude generic CRUD/dispatch verbs (`set`/`get`/`update`/…) so
  coupling keys off real domain terms (`cookie`, `response`), not ubiquitous verbs.
  Confidence **medium**.

Gating is conservative: emits only when ≥2 edit-capable files and a coupling signal
exist. Docs/examples/tests and generated tables are never co-edit targets. A file
already covered by a more-specific **generated_artifact** hint is suppressed (the two
never duplicate or override). The emitted hint carries a `consider_coedit_files_in_final_diff`
obligation and a compact inspect / rule-out / final-diff checklist, rendered **before**
the bulky pivot bodies so it survives Stage 5's 12 000-char injected-context cutoff.

## Per-case result

| case | old actionability hints | new actionability hints | multi_file_coedit? | related files | confidence | evidence | expected effect | risk |
|---|---|---|---|---|---|---|---|---|
| **sphinx-7462** | none (generic "Multiple edit targets" only) | **multi_file_coedit** | **yes (Path A)** | `sphinx/pycode/ast.py` | high | 2 pivots across separate modules (`sphinx/domains`, `sphinx/pycode`) — a fix that crosses file boundaries | Surfaces the hidden `ast.py::unparse` pivot the agent ignored in all 3 runs as an explicit co-edit obligation, not passive context | low — both files are already selected pivots (high-confidence) |
| **seaborn-3187** | none (generic only) | **multi_file_coedit** | **yes (Path A)** | `seaborn/relational.py` | high | 2 pivots across separate modules (`seaborn/_core`, `seaborn`) — crosses file boundaries | Makes the cross-module fix shape explicit; agent must inspect both pivot files before finalizing instead of editing one | low — names selected pivots only |
| **django-13195** | none (generic only) | **multi_file_coedit** | **yes (Path B)** | `django/contrib/sessions/middleware.py`, `django/contrib/messages/storage/cookie.py` | medium | lead file exposes 2 sibling edit targets (`delete_cookie`, `set_cookie`) — a multi-symbol fix; coupled support shares domain terms (`cookie`, `response`) | Promotes the two **gold** co-edit files (`cookie.py`, `middleware.py`) from passive support into an explicit obligation — exactly the M9 gap | medium — support coupling is inferred; both surfaced files are in fact the gold co-edits, and noisy support (`csrf.py`, `i18n.py`) was correctly excluded |
| **astropy-14369** (control: generated-artifact) | generated_artifact ×2 (`cds_parsetab.py`, `cds_lextab.py`) | generated_artifact ×2 (unchanged) | **no** | — | — | 2 pivots share a directory (`astropy/units/format`); `cds.py` is generated-artifact-covered → suppressed | Generated-artifact obligation preserved verbatim; no spurious co-edit added | none |
| **sympy-16766** (control: single-file) | none | none | **no** | — | — | 2 pivots share a directory (`sympy/printing`); no file has ≥2 pivot symbols | No co-edit noise on a single-file fix | none |
| **requests-5414** (control: single-file) | none | none | **no** | — | — | 2 pivots but in different files, 1 symbol each → Path B sibling gate not met; same top-level dir → Path A not met | No co-edit noise; the `prepare_url`/`InvalidURL` noun overlap (`url`) does **not** fire because there is no multi-symbol edit shape | none |

## Success criteria

| # | criterion | result |
|---|---|---|
| 1 | sphinx-7462 gets a multi_file_coedit obligation | ✅ |
| 2 | seaborn-3187 gets a multi_file_coedit obligation | ✅ |
| 3 | django-13195 gets a multi_file_coedit obligation | ✅ (surfaces both gold co-edit files) |
| 4 | astropy-14369 still gets the generated-artifact hint | ✅ (unchanged; co-edit suppressed) |
| 5 | sympy-16766 does NOT get multi_file_coedit | ✅ |
| 6 | requests-5414 does NOT get multi_file_coedit | ✅ |
| 7 | hints render early enough to survive Stage 5 truncation | ✅ (rendered before pivot bodies; unit test inflates a pivot >12k and asserts the hint stays < the cutoff) |
| 8 | no retrieval eval changes | ✅ (byte-identical — see below) |

## Why the controls do not fire (the discriminator)

All three controls *also* have two distinct pivots, so a naive "≥2 pivots" rule would
wrongly fire. The discriminator is structural and generic:

- **sympy / requests / astropy**: the two pivots sit in the **same directory** (a
  base/dispatch method or public-API entrypoint alongside the real edit site, or two
  symbols of one parser module). Path A requires **different** directories → no fire.
- **requests / sympy** additionally have only **one pivot symbol per file**, so Path B's
  sibling-pivot gate (≥2 symbols in one file) is not met → coupled-caller surfacing
  never triggers. This is what stops `requests` from coupling `exceptions.py::InvalidURL`
  to `models.py::prepare_url` on the shared noun `url`.
- **astropy** is doubly safe: same-directory pivots *and* `cds.py` is suppressed as a
  generated-artifact-covered file.

## Verification

- `bun run typecheck` — clean.
- `bun run typecheck:benchmarks` — clean.
- `bun test` — 2610 pass, 0 fail (includes the new `multiFileCoeditHints.test.ts`:
  16 detector/render/product/schema tests, plus a generated-artifact-not-replaced
  test in `actionabilityHints.test.ts`).
- `git diff --check` — clean.
- **Retrieval evals (no retrieval/ranking change):** both
  `stage5_retrieval_eval_expanded` and `stage5_retrieval_eval_cross_repo_30` produced
  output **byte-identical** (modulo the output-directory path field) to the baseline
  generated by HEAD code **before** this change. The detector is a post-selection
  advisory and provably does not alter retrieval, scoring, ranking, or candidate
  generation.

## Recommendation

Ship the detector as an advisory hint (default-on, like the generated-artifact hint).
The next measurement step (out of scope here — needs live agents) is a bounded re-run
of the three multi-file cases (sphinx-7462, seaborn-3187, django-13195) with
astropy-14369 as the generated-artifact positive control, to test whether the explicit
co-edit obligation lifts resolution on the cases that previously failed by editing only
the lead pivot. Do not scale to 30/100 until that bounded signal is in.
