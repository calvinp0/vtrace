# M143 Workstream B — behaviour-ownership evidence audit

**Predecessor** `93a34d194b2360094d61b27f2ecc12f6dccacdb3` (M143-A functional)
**Candidate** M143-B — **evidence only, no functional change**
**Verdict** **NOT PASS — measured deterministic capability ceiling** (§95)

M143-A established that title identity can *nominate* a candidate but that no
title-local signal separates a titled **bystander** from a titled **edit site**
(eight mechanisms measured and rejected). B asked whether the **repository**
could supply the missing distinction:

> What deterministic repository relationship shows that a candidate
> participates in, controls, implements, or is edited by the requested
> behaviour?

The answer, measured rather than argued, is that for the population that matters
**the relationship does not exist in the source** — not that vtrace fails to
index it.

---

## 1. What the index can represent at all

This bounds everything B could have done, so it was established first.

| relation | representable? | how |
|---|---|---|
| `contains` | yes | edge type |
| `imports` | yes | edge type, owned by the `<module>` symbol (M140) |
| `calls` | yes | edge type |
| `references` | yes | edge type |
| **inheritance** | **partly** | persisted, but *only* as an undifferentiated `references` edge |
| **override / interface** | **derivable** | base `references` edge ∩ `contains` members |
| decorator / annotation reference | **no** | collapsed into `references` |
| factory / registration | no | not modelled |
| serialization / configuration-key | no | not modelled |

`edges.edge_type` admits exactly `contains | imports | calls | references`
(`src/db/schema.ts:343`). The Python parser *does* distinguish reference kinds —
`collect_references` tags `inheritance`, `decorator` and `annotation` — but
`emitReferenceEdges` uses the kind only for shadowing and then discards it
(`src/parsers/pythonParser.ts:1755`). So "`X` inherits `Y`" and "`X` mentions `Y`
in a type annotation" are the same row.

This matters for §27, which nominated interface/override evidence as *especially
interesting*: it is available, but only by reconstruction, and it inherits that
ambiguity. Locked by `src/capsuleV2/behaviorOwnershipEvidence.test.ts`.

## 2. The five title cases — measured, not assumed

`stage5_m143_title_ownership_matrix.json`. Probe pool 400, deep pool 1500,
0 source reads, 4 graph queries and ~300 relations inspected per case.

| case | title | title in gold file | organic lead | lead-file ↔ title relations | best in-family rank / score |
|---|---|---|---|---|---|
| `django-11740` | `ForeignKey` | **no** | `autodetector.py::_get_dependencies_for_foreign_key` (gold) | **0 / 0** | 862 / **0.504** |
| `django-13112` | `ForeignKey` | yes | `admin/utils.py::FieldIsAForeignKeyColumnName` | **0 / 0** | 135 / 0.694 |
| `sympy-16766` | `PythonCodePrinter` | yes | `lambdify.py::lambdify` | **0 / 0** | 416 / 0.638 |
| `django-11133` | `HttpResponse` | yes | `http/response.py::write` (gold) | 27 / 20 | 1 / 1.841 |
| `django-12276` | `FileInput` | yes | `widgets.py::use_required_attribute` (gold) | 9 / 7 | 14 / 1.169 |

### 2.1 The §15 hypothesis is refuted

M143 §15 predicted that `_get_dependencies_for_foreign_key --references-->
ForeignKey`, which would type `ForeignKey` as the task **subject**. It does not.
There is **no edge of any type, in either direction, between
`db/migrations/autodetector.py` and `db/models/fields/related.py`** — measured
across all 45 × 138 symbol pairs.

`ForeignKey` has **inDegree 193**. Its top referrers are
`tests/invalid_models_tests/test_relative_fields.py` (44),
`tests/schema/tests.py` (28), `tests/migrations/test_state.py` (20) — tests, not
the autodetector.

The reason is semantic and general: **the migration autodetector operates on
field *instances* drawn from model state, so it never names a field class.** The
more general an implementation is, the less likely it names the entity a task is
about — and generality is exactly what makes it the behaviour owner. Structural
subject↔owner evidence is systematically absent precisely where it is needed.

Reproduced generically as `ChangePlanner` / `LinkField` (test 3).

### 2.2 Relation-to-the-lead does not discriminate

The lead-file ↔ title-family column separates `{11133, 12276}` (rich relations)
from `{11740, 13112, 16766}` (none). But `13112` and `16766` are **correct**
promotions and `11740` is the wrong one. The signal groups the case to fix with
the two cases that must not be touched. **Rejected.**

### 2.3 Family retrieval support does not discriminate

"Does the requested behaviour live *inside* the titled class?" looked, at pool
400, like a categorical zero-vs-non-zero split — `11740` alone had no retrieved
family member. It is an artifact. `django-11740`'s pool floor is **0.660**, which
is *higher* than the best family score in `13112` (0.694 is barely above) and
higher than `16766`'s (0.638). Widening the pool to 1500 recovers
`ForeignKey.get_default @862 = 0.504`.

The real picture is a continuum — **0.504 / 0.638 / 0.694** — and separating
`11740` from `16766` needs a constant fitted between 0.504 and 0.638. §35 forbids
exactly this. **Rejected.**

### 2.4 "Task names a competing location" — the counterexample

M143-A rejected this for having no signal; B has the concrete reason.

- `django-11740` names **`autodetector`**, and `autodetector.py` **is** the gold.
- `sympy-16766` names **`lambdify`**, `lambdify.py` holds the organic lead, and
  it is **not** the gold (`pycode.py` is).

Two structurally identical cases — a task naming a location that holds the
organic lead — with opposite correct answers. **Rejected, permanently.**

## 3. The one discriminator that survived: interface-override ownership

A class that inherits a base and redefines one of that base's members has taken
responsibility for that member's behaviour. That is a repository fact, it is
asymmetric in the way §37 demands, and it needs no schema change.

Measured on ARC (`stage5_m143_gaussian_behavior_owner.json`):

| | base | override surface |
|---|---|---|
| `arc/job/adapters/gaussian.py::GaussianAdapter` | `JobAdapter` | `write_input_file`, `set_files`, `set_additional_file_paths`, `set_input_file_memory`, `execute_incore`, `execute_queue` |
| `arc/parser/adapters/gaussian.py::GaussianParser` | `ESSAdapter` | `parse_geometry`, `parse_frequencies`, `parse_normal_mode_displacement`, … |

The two same-domain classes are cleanly separated by *which* interface member
each owns. This is real, and it is the answer §26/§27 hoped for.

### 3.1 But it cannot activate on the real query

The exact recorded wording (§24, not paraphrased) is:

> How does ARC decide which Gaussian route keywords to **emit**?

Objectives: `arc, decide, gaussian, route, keyword, emit`. Overlap with the
adapter's override surface: **none**. Overlap with the parser's: **none**. The
mechanism **abstains**.

Bridging `emit` → `write_input_file` requires a hand-authored synonym lexicon.
§55 rules that out: *"If this cannot be achieved without weak heuristics, B is
not PASS."* §41 independently forbids a second untyped verb extractor.

The generic controls show the same boundary from both sides
(`stage5_m143_behavior_owner_generic_controls.json`):

| control | query | result |
|---|---|---|
| parser-vs-adapter | "How is backend **input written** before execution?" | elects `ToolAdapter` ✅ |
| action switch | "How is backend **output parsed**?" | elects `ToolParser` ✅ |
| vocabulary gap | "…which route keywords to **emit**?" | **abstains** — the Gaussian shape |
| title-is-owner | "`NameWidget` **validate**s mixed-case names incorrectly" | `confirmed_owner` ✅ |
| subject-vs-owner | link-field dependency task | abstains; **no relation exists** |
| caller-vs-helper | discount rate task | abstains — a call edge alone proves nothing |
| ambiguous | report summary task | abstains ✅ |

So the mechanism is correct where it fires, safe where it does not, and fires on
**none of the seven real candidates measured** — the five title candidates, plus
`GaussianAdapter` and `GaussianParser` on the real ARC query. Shipping it would
add a lane whose only demonstrated wins are fixtures written to demonstrate it.

## 4. Evidence classes inspected

| class | discriminates? | why |
|---|---|---|
| exact calls (both directions) | no | absent between subject and owner in 3/5 |
| exact references (both directions) | no | same; and the failing case has none at all |
| contains / enclosing | no | present in correct promotions too |
| inheritance / base | partly | recoverable only as `references`; kind erased |
| override / interface | **yes, but inert** | separates roles; no real query activates it |
| imports (module-level) | no | `0/0` in `11740`, `13112`, `16766` alike |
| constructor / use sites | no | subsumed by calls/references; same result |
| same-file neighbours | no | groups `11133`+`12276` only |
| path / module role | no | title file lacks organic mass in 3 cases, 2 correct |
| query-action overlap | no | `emit` ∉ implementation vocabulary |
| query-object overlap | no | circular — M143-A mechanism 8 |
| bounded graph proximity | no | nothing within one hop to be proximate to |
| factory / registration / serialization / config-key | **not representable** | not modelled by the index |
| global centrality | forbidden | §13; M142-B settled it |

## 5. Conclusion

Two distinct ownership classes exist, and only one is even partly tractable:

1. **Interface-implementation ownership** — real, deterministic, recoverable
   today. Inert on real queries because request vocabulary and implementation
   vocabulary do not meet.
2. **Subject-versus-implementation ownership** (`django-11740`, and the Gaussian
   problem's core) — **there is no relation to read.** Generic implementations
   do not name the entities they operate on.

The second is not an indexing gap that a schema change would close. Adding an
`inherits` edge type would sharpen class (1) and do nothing for class (2),
because the source contains no `autodetector → ForeignKey` fact of any kind.

`django-11740` therefore stays open and is **not** relabelled. Per §47 and §78's
Outcome 3, B ships no mechanism: a weak heuristic here would trade a known
one-case defect for the 4:1 correct-promotion population M143-A measured.
