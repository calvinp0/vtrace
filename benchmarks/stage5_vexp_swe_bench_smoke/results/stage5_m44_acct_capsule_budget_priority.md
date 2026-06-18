# M44-ACCT — Capsule render budget / truncation priority audit

Offline, read-only audit (no live agents, no Docker, no SWE-bench evaluation, no
diagnostic verifier). It maps the VTRACE capsule rendering → truncation → injection
path, classifies rendered sections by priority, and reconstructs the M42 sphinx-7462
truncation behaviour from CAPTURED artifacts. A new PURE telemetry helper
(`src/capsuleV2/sectionBudgetAccounting.ts`) recomputes per-section truncation
verdicts; an offline script
(`run_stage5_m44_acct_capsule_budget_priority.ts`) emits the JSON/CSV companions.

## 1. Executive verdict

- **Is context truncation currently section-blind? YES.** The Stage 5 injector
  truncates the whole rendered capsule against a single global char budget
  (`truncateContext`, `text.slice(0, maxChars)` + a `[truncated to N chars]` marker).
  It is head-preserving and knows nothing about section boundaries or priority.
- **Can optional actionability text evict essential pivot/source evidence? YES.**
  Optional advisory sections are rendered ahead of the essential pivot-neighborhood
  block (which sits at the TAIL). When they push the render over budget, the
  head-preserving cut clips the tail — i.e. the essential evidence — while the
  optional text survives.
- **Did that happen in M42 treatment? YES — in all 3 reps.** The M39 Semantic Edit
  Hypothesis (+457 chars, top) and the M41 Final Edit-Sufficiency Check (+733 chars,
  near end) pushed the render from 11,562 → 12,752 chars. The 12,000-char cut clipped
  **752 of the 1,218 chars (62%) of the essential `Pivot neighborhood` block**, while
  all three optional sections (Multi-Pivot Action Plan, Semantic Edit Hypothesis,
  Final Edit-Sufficiency Check) were retained in full. The M42 *control* (11,562
  chars, no truncation) retained the entire neighborhood. **The M40 treatment
  (Semantic Edit Hypothesis alone, 12,019 chars) already tripped the same eviction**
  — it was only 19 chars over budget, and the neighborhood was still the casualty.
- **What should be fixed first?** Make truncation section-aware so optional advisory
  text can never evict essential evidence. This milestone ships the **measurement**
  (Option A); the behavioural fix is the recommended next milestone.

## 2. Renderer / truncation map

Path from capsule object → rendered text → injected prompt:

1. **`renderCapsuleV2Human(result, options)`** (`src/capsuleV2/renderHuman.ts`)
   assembles the human text in a fixed order (see §3). Optional sections are gated by
   flags: M35 Multi-Pivot Action Plan (default ON), M39 Semantic Edit Hypothesis
   (default OFF), M41 Edit-Sufficiency Checklist (default OFF). The engine wraps this
   with a leading `## VTRACE inspect-first` advisory and a trailing `## Pivot
   neighborhood` block to form the section's `rawContext`.
2. **`truncateContext(raw, maxChars, maxItems)`**
   (`benchmarks/.../run_stage5_vexp_swe_bench_smoke.ts:4867`) applies (a) an optional
   per-item line cap — SKIPPED for v2 because it is `preformatted`/budget-shaped — then
   (b) the global char cap: `if (text.length > maxChars) text = text.slice(0, maxChars)
   + "\n[truncated to ${maxChars} chars]"`. This is the section-blind step.
3. The truncated text is assembled into `_vtrace_instructions.md` (one `## vtrace
   context` block per instance) and injected into the agent prompt. `maxChars =
   DEFAULT_CONFIG.vtraceContextMaxChars = 12000` (`:866`), overridable via
   `--vtrace-context-max-chars`.

The renderer comments explicitly acknowledge the hazard and try to dodge it by
placing compact advisories near the TOP "so it survives char-budget truncation"
(`renderHuman.ts:142,185,199`). That heuristic protects the *advisory* — but it does
so by pushing the essential pivot bodies and the tail neighborhood block DOWN, which
is exactly what gets clipped. The protection is backwards for evidence.

## 3. Section inventory and priority classification

Render order and classification (sizes from the M42 sphinx-7462 treatment capsule):

| # | Section heading | Render origin | Priority | ~chars | Essential? | Optional? | Safe to truncate? |
|---|---|---|---|---|---|---|---|
| 1 | `## VTRACE inspect-first` + `intent/strategy/budget` | engine + renderHuman header | essential | 927 | yes | no | no (core framing) |
| 2 | `## Multi-Pivot Action Plan` (M35) | renderHuman, default ON | optional | 625 | no | yes | yes |
| 3 | `## Semantic Edit Hypothesis` (M39) | renderHuman, default OFF | optional | 457 | no | yes | yes |
| 4 | `## Multiple edit targets` | renderHuman (≥2 pivots) | important | 503 | no | no | last resort |
| 5 | `## Pivot inspection contract` | renderHuman | important | 935 | no | no | last resort |
| 6 | `## Actionability hints` | renderHuman | important | 797 | no | no | last resort |
| 7 | `● pivot` source bodies | renderItem (Full) | **essential** | 2,631 + 3,499 | yes | no | **no** |
| 8 | `## Edit risk / patch hint` | renderHuman (when present) | important | — | no | no | last resort |
| 9 | `○ support` source bodies | renderItem | essential | 94–133 each | yes | no | no |
| 10 | `## Final Edit-Sufficiency Check` (M41) | renderHuman, default OFF | optional | 733 | no | yes | yes |
| 11 | `## Pivot neighborhood (nearby symbols, compact)` | engine, TAIL | **essential** | 1,218 | yes | no | **no** |

Diagnostic class (accounting/provenance/debug headings) is not present in the
agent-facing capsule; it lives in the captured `_*.json` artifacts.

Key structural fact: **two essential sections (the pivot bodies #7 and the pivot
neighborhood #11) bracket the optional M41 checklist #10**, and the neighborhood is
LAST. Head-preserving truncation therefore reaches the essential neighborhood before
it reaches the optional checklist that precedes it.

## 4. M42 reconstruction (control vs treatment)

`maxChars = 12000`. Recomputed by `analyzeSectionTruncation` over each run's captured
`_capsule_v2_context.md`; consistent across r1/r2/r3 (deterministic render).

| label | arm | flags | preTruncChars | postTruncChars | truncated? | clipped section | essential evicted? | optional retained? | notes |
|---|---|---|---|---|---|---|---|---|---|
| eval-m42-control-sphinx-7462-r{1,2,3} | control | M39 off, M41 off | 11,562 | 11,562 | no | — | no | — | neighborhood intact (full 1,218 chars) |
| eval-m42-treatment-sphinx-7462-r{1,2,3} | treatment | M39 on, M41 on | 12,752 | 12,000 | **yes** | Pivot neighborhood | **yes (752/1,218 chars, 62%)** | Action Plan + Semantic Hypothesis + Edit-Sufficiency Check | optional text fully kept, essential tail clipped |
| eval-m40-treatment-sphinx-7462-r1 | treatment | M39 on, M41 off | 12,019 | 12,000 | **yes** | Pivot neighborhood | **yes (19 chars over → tail clipped)** | Action Plan + Semantic Hypothesis | M39 *alone* already tips over budget |

Answers to the specific reconstruction questions (M42 treatment):
- **Full rendered size:** 12,752 chars. **Final injected size:** 12,000 chars of
  capsule text + the `[truncated to 12000 chars]` marker (`vtraceContextChars = 12,027`).
- **Where did truncation occur?** Inside the `## Pivot neighborhood` block, which
  spans chars 11,534–12,752; the cut at 12,000 left only its first 466 chars.
- **Sections that survived:** framing, Multi-Pivot Action Plan, Semantic Edit
  Hypothesis, Multiple edit targets, Pivot inspection contract, Actionability hints,
  both pivot source bodies (ast.py AND python.py — both survived), all four support
  bodies, and the M41 Final Edit-Sufficiency Check.
- **Sections clipped:** only the `## Pivot neighborhood` block (essential), losing 752
  chars (callers + neighbor excerpts in `sphinx/domains/python.py`).
- **Pivot-neighborhood block evicted?** YES (62% clipped). **ast.py source survived?**
  YES. **python.py source survived?** YES. **Advisory text survived?** YES — all of it.

## 5. Accounting correctness

| metric | source | reflects | trustworthy for "what the agent saw"? |
|---|---|---|---|
| `vtraceContextChars` | `_run.meta.json` | **POST-truncation** injected size (12,027 = 12,000 + marker) | **yes — this is the true injected text size** |
| `vtraceContextTruncated` | `_run.meta.json` | global truncation flag — `true` when the cut bit | yes, but coarse: a single boolean, no section detail |
| `vtraceContextItems` | `_run.meta.json` | POST-truncation non-empty line count | yes (line count, not evidence completeness) |
| `vtraceCapsulePivotSourceChars` | `_run.meta.json` | PRE-truncation pivot-source chars in the capsule object (2,200, identical both arms) | **no — blind to truncation** |
| `pivotNeighborhoodPresent` | `_product_v2_probe.json` | PRE-truncation: neighborhood was BUILT (`true` in both arms) | **no — reports `true` even when the neighborhood was 62% clipped from the prompt** |
| `pivotNeighborhoodExcerptCount` (8), `estimatedOutputTokens` (7,915), savings % (80.19) | `_product_v2_probe.json` | PRE-truncation capsule-object accounting, **byte-identical control vs treatment** | **no — cannot distinguish the arms** |

**The true injected text size is `vtraceContextChars` (post-truncation).** Future
scorecards should report `vtraceContextChars` + `vtraceContextTruncated` AND the new
section-level eviction telemetry (`essentialSectionsEvicted`) — never rely on the
product-v2 probe's `pivotNeighborhoodPresent`/token estimates to claim the agent
received the neighborhood, because those are pre-truncation and identical across arms.

## 6. Risk analysis

- **Silent evidence eviction (CONFIRMED, not hypothetical).** Optional advisory text
  evicted 62% of the essential pivot-neighborhood in M42 treatment, and M40 treatment
  showed even a single optional section (19 chars over budget) does it.
- **Misleading live A/B interpretation (HIGH).** The product-v2 probe reports an
  IDENTICAL accounting (`pivotNeighborhoodPresent: true`, same token estimates) for
  control and treatment, so a scorecard reading the probe would conclude the arms
  delivered equivalent evidence — when the treatment actually delivered a 752-char-
  shorter, neighborhood-clipped prompt. Any treatment effect (good or bad) is
  confounded with silent evidence loss; M42's null/negative result cannot be cleanly
  attributed to the prompt text. This is exactly the M43 budget finding.
- **Token accounting under/over-count.** PRE-truncation metrics overstate what the
  agent saw by up to `truncatedChars` (752 here). `vtraceContextChars` is correct;
  the probe's `estimatedOutputTokens` is not the injected size.
- **Optional text harming context quality.** Beyond eviction, the optional sections
  also displace position: essential bodies are pushed deeper into the prompt.
- **Section-aware rendering complexity (the fix's cost).** A priority-truncation
  rewrite touches the injection path and must be proven to leave default-off output
  byte-identical and retrieval unchanged — hence this milestone ships measurement
  first and defers the behavioural change.

## 7. Implementation recommendation

**A. Implement section-level truncation accounting only** (this milestone) — plus a
companion offline audit. No behaviour change to the injected text; default-off output
is byte-identical; retrieval CSVs byte-identical. This gives trustworthy experiments
immediately (the missing signal that explains M42) at near-zero risk, and produces the
exact priority model that a follow-up section-priority truncation (M45) would consume.

The behavioural fix (section-priority truncation / essential-evidence reserve) is
real and warranted but changes the injection path; it belongs in its own milestone
with behaviour tests and a retrieval/no-change proof, not bundled into the audit.

## 8. Code changed

**What changed**
- `src/capsuleV2/sectionBudgetAccounting.ts` (NEW, pure): `inventorySections(text)`
  parses the rendered capsule into priority-classified sections (`## ` headings,
  `●/○` item blocks, leading framing); `classifyHeading(name)` maps headings to
  `essential | important | optional | diagnostic`; `analyzeSectionTruncation(text,
  maxChars)` mirrors the injector's head-preserving cut and reports
  `preTruncationChars`, `postTruncationChars`, `truncatedChars`, `truncationOccurred`,
  per-section `sections[]`, `truncatedSectionNames`, `fullyEvictedSectionNames`,
  `essentialSectionsEvicted`, and `optionalSectionsRetained`.
- `src/capsuleV2/sectionBudgetAccounting.test.ts` (NEW): 13 tests (inventory,
  contiguous spans, pre≥post, truncation flag, clipped-section detection, essential-
  eviction + optional-retention reproduction, classification, input-derived/no-leak,
  renderHuman additivity / default-off byte-identical / no pivot-support mutation).
- `benchmarks/.../run_stage5_m44_acct_capsule_budget_priority.ts` (NEW, offline):
  reads captured artifacts, recomputes per-run section truncation, cross-checks
  run.meta (post-truncation) vs product-v2 probe (pre-truncation), writes JSON + CSV.

**What behaviour changed:** none of the agent-facing path. The helper is analysis-only
and is NOT yet wired into the live injector, so injected context, retrieval, ranking,
pivots, scoring, and candidate generation are unchanged.

**What behaviour did NOT change:** rendering, truncation, injection, accounting probes,
all defaults (M39/M41 stay OFF, M35 stays ON), the legacy/enforcement/revision gates.

**Compatibility risks:** none observed — additive new files only; full suite (2,972
tests) green; both typechecks clean; retrieval CSVs byte-identical.

## 9. Next milestone

**A. M45 — implement section-priority truncation.** Render sections as priority-tagged
blocks and drop lowest-priority (optional → important) sections first so essential
pivot/source/neighborhood evidence is preserved under a tight budget; wire the M44
telemetry into `_run.meta.json` so live A/Bs report `essentialSectionsEvicted`. Gate
behind a flag, prove default output byte-identical, and re-run the M42 A/B (which is
not interpretable until this lands). Until then, the M42 treatment result must be
read as confounded by silent neighborhood eviction.

---

### Verification performed
- `bun run typecheck` — clean. `bun run typecheck:benchmarks` — clean.
- `bun test` — 2,972 pass / 0 fail (177 files), incl. the 13 new tests.
- Retrieval no-change proof — `stage5_retrieval_eval_expanded.csv` and
  `stage5_retrieval_eval_cross_repo_30.csv` byte-identical to the working copy.
- `git diff --check` — clean.
- No live agents, no Docker, no SWE-bench evaluation, no diagnostic verifier.
