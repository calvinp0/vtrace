# M45 — Section-priority truncation for VTRACE capsule context

Implements section-aware budget truncation so optional/advisory sections are dropped
before essential pivot/source evidence is ever clipped. Offline, read-only validation
(no live agents, no Docker, no SWE-bench evaluation, no diagnostic verifier). Builds on
the M44-ACCT section-accounting helpers.

## 1. Executive verdict

**Yes — M45 prevents optional advisory sections from evicting essential pivot/source
evidence.** Replaying the captured M42/M40 rendered contexts under the new algorithm:
in every treatment rep where the legacy section-blind slice clipped the essential
`## Pivot neighborhood` block, M45 instead drops lower-value optional advisory sections
(Multi-Pivot Action Plan, Edit-Sufficiency Checklist) and preserves the neighborhood in
full — with `essentialSectionsEvicted=false`. Control runs (under budget) are unchanged
(`mode=none`, byte-identical). No run evicts essential evidence under M45.

## 2. Previous failure mode (M44-ACCT)

The Stage 5 injector truncated the whole rendered capsule with one global,
head-preserving char slice (`text.slice(0, maxChars)` + marker) — section-blind. The
essential pivot-neighborhood is rendered LAST, so when optional advisory text pushed the
render over the 12,000-char budget, the head-preserving cut clipped the tail (essential
evidence) while every optional section survived in full. M42 sphinx-7462 treatment lost
752/1,218 chars (62%) of the neighborhood in all 3 reps; M40 treatment (M39 alone, 19
chars over) lost it too. This confounded the M40/M42 A/Bs.

## 3. Algorithm (`truncateContextByPriority`)

Deterministic, in `src/capsuleV2/sectionBudgetAccounting.ts`:

1. If `text.length <= maxChars` → return unchanged (`mode="none"`).
2. Inventory sections (`## ` headings, `●/○` item blocks, leading framing) and classify
   each `essential | important | optional | diagnostic` (M44 classifier; unknown
   headings default to `important`, never silently droppable).
3. Drop whole sections in priority order — **diagnostic → optional → important**,
   largest-first within a class — until the projected size fits. Each dropped section is
   replaced by a one-line omission marker: `[omitted <priority> section: <name> (<N>
   chars)]`. Essential sections (framing, pivot/support source, pivot-neighborhood) are
   never dropped here.
4. If the kept set now fits → `mode="section_priority"`, `essentialSectionsEvicted=false`.
5. If the **essential sections alone still exceed the budget**, fall back to the legacy
   head-preserving slice (same `[truncated to N chars]` marker) over the reduced text →
   `mode="legacy_slice_fallback"`, `essentialSectionsEvicted=true`, naming the clipped
   essential section(s).

Invariant (enforced + tested by a full-range budget sweep): an optional section is never
retained in full while an essential section is clipped. No summarizer, no semantic
rewriting of source excerpts — sections are kept whole or dropped whole (with a marker).

Integration: `buildVtraceContextMarkdown` routes **preformatted (Capsule v2) sections**
through `truncateContextByPriority`; legacy (non-preformatted) sections keep the old
per-item line cap + char slice unchanged.

## 4. Metadata

New additive telemetry, surfaced into `_run.meta.json` as `vtraceContextBudget` (via the
free-form `indexRunMetaFields` bag — no CSV/row schema change):

| field | meaning |
|---|---|
| `maxChars` | the injector budget in effect (12,000 default) |
| `preTruncationChars` | full rendered size before reduction |
| `postTruncationChars` | size of the ACTUAL injected text after reduction (incl. markers) |
| `truncatedChars` | `preTruncationChars - postTruncationChars` |
| `truncationOccurred` | whether any reduction happened |
| `truncationMode` | `none` \| `section_priority` \| `legacy_slice_fallback` |
| `droppedSectionNames` | sections dropped whole (render order) |
| `truncatedSectionNames` | sections clipped mid-block (fallback only) |
| `essentialSectionsEvicted` | true only when the fallback clipped an essential section |
| `optionalSectionsDropped` | whether any dropped section was optional |
| `optionalSectionsRetained` | optional sections kept in full (empty when essential evicted) |

**Future scorecards** should treat `essentialSectionsEvicted` as the trust gate for an
A/B arm: if true, the arm's context is degraded and the result is not cleanly
attributable. `truncationMode` distinguishes a clean section-priority reduction from the
fallback. The flat `vtraceContextChars` / `vtraceContextTruncated` are retained and now
reflect the actual injected text after section-priority reduction.

## 5. M42 replay / reconstruction

`maxChars=12,000`. Legacy = head-preserving slice; M45 = section-priority. Source:
captured `_capsule_v2_context.md`; consistent across r1/r2/r3.

| scenario | preChars | legacy postChars | legacy essentialEvicted | M45 postChars | M45 dropped optional | M45 essentialEvicted | neighborhood preserved (M45)? |
|---|---|---|---|---|---|---|---|
| M42 control r{1,2,3} | 11,562 | 11,562 | no | 11,562 (`none`) | — | no | yes (unchanged) |
| M42 treatment r{1,2,3} | 12,752 | 12,000 | **yes** | 11,527 (`section_priority`) | Multi-Pivot Action Plan, Final Edit-Sufficiency Check | **no** | **yes** |
| M40 control r1 | 11,562 | 11,562 | no | 11,562 (`none`) | — | no | yes (unchanged) |
| M40 treatment r1 | 12,019 | 12,000 | **yes** | 11,458 (`section_priority`) | Multi-Pivot Action Plan | **no** | **yes** |

Note: in the M42 treatment, M45 keeps the **Semantic Edit Hypothesis** (the M39 section
under A/B test) and the full pivot-neighborhood, shedding only the two lowest-value
optional advisories. The treatment arm now delivers the section-under-test AND the
essential evidence — so a re-run becomes interpretable.

## 6. Compatibility

- **Retrieval unchanged** — `stage5_retrieval_eval_expanded.csv` and
  `stage5_retrieval_eval_cross_repo_30.csv` byte-identical to the working copy.
- **Ranking / candidate generation unchanged** — the new code only reorders/drops
  rendered TEXT sections post-render; it reads no scores and mutates no capsule object.
- **Default feature flags unchanged** — M39/M41 stay OFF, M35 stays ON; section-priority
  applies to the preformatted v2 path only and is a pure function of the rendered text +
  budget. Under budget it returns the text unchanged (`mode=none`), so default-off
  behavior is byte-identical.
- **Pivot revision / enforcement unchanged** — untouched; defaults remain off.
- Legacy (non-preformatted) context keeps the exact old truncation path.

## 7. Accounting correctness

- **Actual injected text size:** `vtraceContextChars` (= `assembled.chars` =
  `postTruncationChars`) and `vtraceContextTruncated` (= `truncationOccurred`). Both now
  reflect the post-section-priority text.
- **Pre-truncation diagnostic:** `vtraceContextBudget.preTruncationChars`; the product-v2
  probe's `pivotNeighborhoodPresent` / token estimates remain pre-truncation and must NOT
  be used to claim the agent received a section.
- **Optional-section drops are reported** explicitly via
  `vtraceContextBudget.droppedSectionNames` / `optionalSectionsDropped`, with a visible
  `[omitted …]` marker in the injected text itself.

## 8. Risks

- **Optional text may be dropped in treatment arms.** When a treatment's own section is
  optional and large, a tight budget could drop it. Mitigated by largest-first-within-
  class ordering and by reporting `droppedSectionNames` so any A/B can detect it; in the
  M42 replay the M39 section-under-test was retained (only the action plan + checklist
  were shed). The principle stands: a dropped optional advisory is acceptable; a silently
  clipped essential source is not.
- **Agent may lose advisory behavior under very tight budgets** — but this is strictly
  better than losing code evidence, and it is now visible in telemetry rather than silent.
- **Classification errors** — a mislabeled optional could be dropped, or a mislabeled
  essential retained at the expense of true essentials. Mitigated by the conservative
  default (unknown → important) and the M44 classifier tests.
- **Legacy-fallback risk** — if essentials alone exceed budget, the head slice still
  clips essential evidence, now flagged `essentialSectionsEvicted=true`. This is a real
  last resort; the captured runs never hit it (essentials fit comfortably).

## 9. Next milestone recommendation

**A. M46 — rerun M42 after the budget fix.** The replay is clean (neighborhood preserved
in every treatment rep, no essential eviction), so the M42 A/B is now interpretable and
should be re-run to measure the M39/M41 prompt effect on a fair, full-evidence context.
(Broadening the budget replay across M32/M36/M40 artifacts — option B — is a reasonable
follow-on but secondary.)

---

### Verification performed
- `bun run typecheck` + `bun run typecheck:benchmarks` — clean.
- `bun test` — 2,985 pass / 0 fail (177 files), incl. the new M45 unit + runner tests.
- Retrieval no-change proof — both CSVs byte-identical to the working copy.
- `git diff --check` — clean.
- No live agents, no Docker, no SWE-bench evaluation, no diagnostic verifier.
