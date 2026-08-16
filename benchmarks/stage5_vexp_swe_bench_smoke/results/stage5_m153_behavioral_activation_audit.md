# M153-C2 — where the behavioural chain actually breaks

Built before any code was changed (§17), then re-run after each fix so the
taxonomy can be seen moving rather than asserted.

Artifacts: `stage5_m153_behavioral_failure_taxonomy.json` (pre-C2),
`..._c2a.json` (after activation), `..._c2b.json` (after representation).

Denominator: 33 repository-bound cases (35 minus the 2 ambiguous cases, which
have no oracle repository by construction).

## Method

Each case is walked through the chain and attributed to the **first** stage that
failed, because the stages gate each other — a representation failure hidden
behind an activation failure is invisible until activation is fixed. Later
stages are recorded as observations, not causes.

```
ACTIVATION      no behavioural operation derived from the query
REPRESENTATION  the ground-truth implementation carries no usable fact
CANDIDATE       facts exist, generator admitted nothing
SUBJECT         admitted, but the expected owner was rejected for subject
ROLE_DELIVERY   admitted as a candidate and still not delivered
GROUND_TRUTH    the expected symbol is not in the index at all
```

## Movement

| Stage | pre-C2 | after C2-A | after C2-B |
| --- | ---: | ---: | ---: |
| ACTIVATION | 16 | 11 | **11** |
| REPRESENTATION | 6 | 10 | **9** |
| CANDIDATE | 6 | 7 | **7** |
| SUBJECT | 2 | 2 | **2** |
| ROLE_DELIVERY | 0 | 0 | **0** |
| NONE (chain worked) | 3 | 3 | **4** |
| **activation rate** | **14/33** | **19/33** | **19/33** |

REPRESENTATION rising as ACTIVATION falls is the taxonomy working: those cases
were always broken at representation, and could not be seen until the query
reached that stage.

**GROUND_TRUTH failures: 0.** Every expected symbol resolves in its index, which
is independent confirmation that the frozen corpus is sound.

## C2-A — activation, two structural defects

### 1. Capability-lookup suppression was applied to prose

Two false-premise cases were suppressed with
`capability lookup (definition lookup phrase)`:

> "Where is the function that ranks the connection adapters?"
> "Where is the function that ranks fixtures by priority?"

The rule being enforced is about requests that **name** a definition. It was
being applied to requests that **describe** one — which is precisely the shape
M150 exists to answer, and §22 requires to reconstruct a mechanism.

Naming is still protected, and by a stronger check than the one removed:

- an explicit symbol lookup is refused earlier, by its own branch;
- `"Where is rank_adapters defined?"` derives no operation regardless, because
  `\b` does not match inside `rank_adapters`, so the cue never fires on the
  identifier's own words.

The discrimination that matters is **identifier vs prose**, which the intent had
already decided. Suppression now additionally requires that the request actually
carry an identifier.

### 2. Cue inflections disagreed with the module's own vocabulary

`OPERATION_VOCABULARY` — used to strip operation words from subject terms —
declares `decide, decides, decided, deciding`. The selection cue matched
`decides?`, i.e. only the first two. So:

| Query | Derived |
| --- | --- |
| "How does the system **decide** which backend wins?" | `selection` |
| "How is it **decided** which backend opens a given file?" | *nothing* |

Same verb, same question, ordinary English inflection. The same inconsistency
existed for `rank`/`ranks` against the ordering cue.

This is **not** a synonym list built from failed queries (§20). No new verb was
introduced; the inflections of verbs the module already declares were completed.

### Result

Activation 14/33 → 19/33. Newly activated:

| Case | Operation |
| --- | --- |
| `rq_adapter_ranking_false_premise` | ordering |
| `pt_fixture_applicability` | selection |
| `pt_fixture_ranking_false_premise` | ordering |
| `xr_backend_selection` | selection |
| `pl_checker_activation` | selection |

**All three explicit-identifier absence controls remain suppressed**, so the
§22/§86 pair now works in both directions for the first time: the prose twin
reconstructs a mechanism, the identifier twin stays an absence.

## C2-B — representation, two structural defects

### 3. Destructured loop targets were invisible

`Session.get_adapter` — a textbook first-success loop — carried **no mechanism
fact at all**, while sphinx's structurally identical `get_filetype` was
represented correctly. The difference was punctuation:

```python
for (prefix, adapter) in self.adapters.items():   # not matched
for suffix, filetype in source_suffix.items():    # matched
```

The loop-target pattern required the target to begin with a letter, so a
parenthesised Python tuple was skipped — and so was `for (const [k, v] of …)`,
the ordinary JS/TS form. That the same gap affects a language **not in the
corpus** is the evidence that it is generic rather than corpus-shaped (§27).

The subject and acceptance tests are unchanged, so the guards that keep logging
loops, accumulating loops and `return None` bail-outs from counting still apply.
Four negative controls were added (§28).

### 4. The loop subject was the accessor, not the collection

`normalizeOperand` keeps the last dotted segment, so `self.adapters.items()`
reduced to **`items()`**. Every mechanism fact taken from a Python dict loop
shared that same meaningless subject, which aligns with nothing any request could
name — defeating the subject discrimination M150 exists for.

Dropping a trailing **iteration accessor** (`items()`, `values()`, `keys()`,
`entries()`, and the `iter*` spellings) recovers the real collection. The set is
fixed and small; anything else is left alone, because `x.first()` is not an
iteration accessor and its subject genuinely is the call.

### Result

`Session.get_adapter` now carries `first_success_return` with subject `adapters`,
and is the **only** candidate admitted for its query. The case is delivered
correctly end to end.

## What remains, on calibration only

| Stage | Calibration | Example |
| --- | ---: | --- |
| REPRESENTATION | 7 | `pt_fixture_applicability`: `_matchfactories` filters and yields every match — an accumulating loop, correctly *not* a first-success. The vocabulary has no "filter" kind, and §27 forbids adding one on a single case. |
| ACTIVATION | 6 | `fl_response_coercion`, `sp_builder_selection` and the reuse-phrasing cases express operations through structures (`what happens when …`, `does X already have a helper that …`) rather than any operation verb. |
| CANDIDATE | 3 | `sp_parser_selection`: `get_filetype` has a direct fact and is still not admitted, while `Project.path2doc` is. |
| SUBJECT | 2 | admitted, expected owner rejected for subject. |

Holdout cases were counted by stage only. No holdout case was inspected to choose
any rule (§5, §42).

## Consequence for C

Oracle `correct implementation Top-1` is **unchanged at 3.3%** (1/30). Two real
generic defects were removed and the chain now reaches further, but the dominant
remaining failures moved to representation and candidate admission rather than
being eliminated.

§35 and §71 are explicit that workspace routing must not be tuned while oracle
retrieval is still mostly failing, and §45 is explicit that a safely-disabled
lane is containment rather than capability. **C therefore does not pass**, and
the behavioural routing lane stays default-off.
