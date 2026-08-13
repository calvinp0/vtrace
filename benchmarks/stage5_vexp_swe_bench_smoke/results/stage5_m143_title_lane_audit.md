# M143 Workstream A — title-lane audit

**Predecessor** `41fb0a9ba22b0f69e3349aca77b4ae2b15908504` (M142 final functional)
**Candidate** `93a34d1` (M143-A)
**Verdict** **MIXED** — one real defect removed; the `django-11740` promotion
defect is carried as a *measured* ceiling with eight rejected mechanisms.

---

## 1. The lane has TWO producers of ranking authority, not one

M142 root-caused the synthesized score and stopped there. Tracing every stage
(§10) shows the authority is produced twice, independently:

| # | Producer | Where | Effect |
|---|---|---|---|
| P1 | `TITLE_SYMBOL_FINAL = 2.5` | `titleSymbolAnchoring.ts:38` | fixed final, above every ordinary candidate |
| P2 | `evidenceTier = 2` | `buildCapsuleV2.ts` pivot ordering | sorts **before** `orderingFinal` is ever compared |

P2 is why M142's second experiment failed. "Restore the organic scorecard"
addressed P1 only; the pivot comparator sorts on `evidenceTier` *before* score,
so a tier-2 candidate outranks a tier-1 candidate **at any score**. The report
recorded that attempt as "restored recall but not the correct lead" without
identifying why. This is why.

`titleSymbolIds` also feeds four more precedence paths — decoy-suppression
immunity, graph-neighbour seeding, `namedAnchorIds` (cap exemption, dispatcher
demotion immunity), and support-displacement protection. Any future fix has to
treat the id set as six consumers, not one.

## 2. The injected scorecard was fabricated, not merely optimistic

The injected candidate declared:

```
lexical: 1   fts: 1   tfidf: 1   bm25: 1   symbol: 1   final: 2.5
```

Four of those are **measured retrieval quantities**, and the premise of the
injection is that retrieval never produced this candidate — so they were never
measured. The role gate and the decoy classifier read them. On `django-11740`
the capsule told the model, in prose it can read:

```
actionable class — symbol-name match; strong lexical match
```

There was no strong lexical match. There was no lexical measurement at all.

**Fixed in `93a34d1`.** Unmeasured components now report `0`; `symbol: 1` stays
because exact name identity from the title *is* true. Frozen 50: five quality
metrics unchanged, `selectedFiles`/`lead`/`roles`/`contentModes` diffs all
**zero**, mean tokens 1835.72 → 1835.20.

## 3. `django-11740` — what actually happens

`ForeignKey` is **not** "never retrieved". It is retrieved and it scores:

| | value | provenance |
|---|---|---|
| lane asserted | `final 2.5`, rank 1 | synthesized constant |
| actually earns | `final 1.343`, rank 14 | `hybridRetrieve` at pool 400 |
| gold competitor | `final 1.760`, rank **1** | `autodetector.py::_get_dependencies_for_foreign_key` |

`identifyingEvidence = 0` (symbol 0, path 0, bodyLiteral 0); `inDegree = 188`;
M142-B already caps its centrality at 56%. **Ordinary retrieval already leads
with the gold file.** The title injection is what displaces it — an 1.86×
promotion over the score the same scorer gives the same symbol.

## 4. Eight mechanisms measured; none separates the cases

The lane fires on **17 of the 50** frozen cases (21 matches: 16 incumbents that
keep their organic scorecard, 5 fresh injections). Of the five injections:

| case | titled symbol | organic top-1 | promotion |
|---|---|---|---|
| `django-11740` | `ForeignKey` | `autodetector.py::_get_dependencies_for_foreign_key` @1.760 — **already gold** | **wrong** |
| `django-13112` | `ForeignKey` | `admin/utils.py::FieldIsAForeignKeyColumnName` @1.720 — not gold | correct |
| `sympy-16766` | `PythonCodePrinter` | `lambdify.py::lambdify` @2.428 — not gold | correct |
| `django-11133` | `HttpResponse` | `http/response.py::write` @1.842 — already gold | correct (redundant) |
| `django-12276` | `FileInput` | `widgets.py::use_required_attribute` @1.950 — already gold **symbol** | correct (displaces gold symbol) |

**4 correct, 1 wrong.** Any mechanism that demotes injected title candidates
as a class is net-negative — which is what M142's Attempt 1 measured (37 → 35).

| # | mechanism | result |
|---|---|---|
| 1 | skip reinjection for ranked-out symbols (M142) | Top-1 37 → 35 — rejected |
| 2 | restore organic scorecard (M142) | recall yes, lead no — P2 unaddressed |
| 3 | organic score as discriminator | `11740` 1.343 vs `16766` 1.291 — **indistinguishable** |
| 4 | additive at the existing symbol weight | fixes 0, costs `13112` (loses by 0.004) |
| 5 | route title term through the `symbol` channel | `11740` rises to 2.585 — reproduces the defect |
| 6 | "task names a competing location" | every case names some file stem — no signal |
| 7 | hub in-degree / centrality | separates (188 vs 2/8) **only** via a threshold fitted between 9 and 188 — §9 forbids |
| 8 | behaviour-ownership promotion gate | see below |

### Mechanism 8 in detail — the ownership gate

Rule: withhold promotion iff the title candidate has **no** ownership evidence
**and** a rival has **positive** ownership evidence; abstain on ambiguity.
Measured on all 17 lane-active cases (`stage5_m143_title_ownership_gate.json`):

| variant | agrees with desired | wrong **suppress** | wrong abstain |
|---|---|---|---|
| as-measured (circular) | 15/17 | 0 | 2 |
| de-circularised | 8/17 | **8** | 1 |

The naive measure is **circular**: the title term is itself a request token, so
it becomes an objective and the title symbol's own name covers it. The gate then
never fires — it looks safe because it does nothing, and `django-11740` is one
of its two misses.

Removing the circularity makes it fire, and it fires *backwards*: it abstains on
`django-11740` (the case to fix) and suppresses `sympy-16766` (the lane's
flagship case). Across the suite it suppresses 9 times and **8 of those destroy
a correct lead**. The gate is worse than doing nothing.

The two error classes are not symmetric. A wrong abstain leaves a known defect
in place; a wrong suppress destroys a lead that was right. A mechanism with
eight of the latter is not a candidate for shipping.

## 5. What this means

The defect is real, reproduced generically (`titleLaneSemantics.test.ts` §17),
and root-caused to two producers. What is *not* available is a discriminator:
`django-11740` and `sympy-16766` are, on every candidate-local signal measured,
the same shape — a title-named class with no identifying evidence, competing
against a stronger differently-named candidate. In one the titled class is a
bystander; in the other it is the edit site. Nothing in the static evidence
distinguishes a bystander from a target.

Separating them appears to need the thing Workstream B exists to build —
behaviour ownership — and the gate measurement above shows the *current*
ownership signal is not yet strong enough to carry it. That is a genuine
dependency, not a deferral: A's remaining defect is blocked on B's capability.

Recorded per §66: `django-11740` is **not** relabelled neutral. Top-1 stays 38.
