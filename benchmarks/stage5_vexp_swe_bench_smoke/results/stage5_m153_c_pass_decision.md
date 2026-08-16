# M153-C — pass decision

**Verdict: C NOT PASS.** The behavioural routing lane stays default-off.

Measured with per-case session isolation (§48–§51), so the two arms are genuinely
independent. Artifacts: `stage5_m153_m153_iso_off_*`, `stage5_m153_m153_iso_on2_*`,
`stage5_m153_session_isolation_validation_*.json`.

## What C2 changed

Five structural defects, all found from the frozen calibration corpus, none from
ARC, none from a holdout repository, and none a synonym list or numeric constant.

| # | Defect | Stage |
| --- | --- | --- |
| 1 | capability-lookup suppression applied to prose, not just to naming | activation |
| 2 | cue inflections disagreed with the module's own declared vocabulary | activation |
| 3 | destructured loop targets invisible to the extractor | representation |
| 4 | loop subject was the iteration accessor, not the collection | representation |
| 5 | test-file definitions could decide repository routing | routing evidence |

## Gate-by-gate

| §76 gate | Result |
| --- | --- |
| activation materially generalises on calibration | **yes** — 14/33 → 19/33 |
| correct operation derived for intended behavioural queries | yes for the 5 newly activated; no false activation observed |
| explicit identifier semantics preserved | **yes** — all 3 absence controls still suppressed |
| ground-truth mechanisms represented where architecture claims support | improved, not complete |
| expected implementations admitted at useful rate | **no** |
| wrong-subject routing = 0 on calibration controls | **yes — 0** (was 1) |
| lexical/docs-only evidence cannot decide | yes |
| ties abstain | yes |
| configured-default fallback preserved | yes |
| exact path/symbol authority preserved | yes |
| probes read-only / session-write-free | yes |
| default full retrieval count remains 1 | yes |
| route metadata bounded | yes — 749 bytes, unchanged |
| **safe enough to enable by default** | **no** |

## Why it does not pass

**Oracle retrieval is still failing.** `correct implementation Top-1` is
**1/30 (3.3%)**, unchanged from the M152 baseline. The chain now reaches further
— `Session.get_adapter` is represented and is the only candidate admitted for its
query — but the dominant failures moved to representation and candidate admission
rather than disappearing:

| Stage | Calibration, after C2 |
| --- | ---: |
| REPRESENTATION | 7 |
| ACTIVATION | 6 |
| CANDIDATE | 3 |
| SUBJECT | 2 |
| NONE (chain worked) | 3 |

§35 and §71 are explicit that routing must not be tuned while oracle retrieval is
mostly failing, and that is still the case.

**Routing is not safe to enable.** With the lane on, 4 behavioural routes fire:

| Case | Split | Routed | Correct |
| --- | --- | --- | --- |
| `rq_redirect_auth_reuse` | calibration | requests | yes |
| `ap_project_name_reuse` | holdout | pytest | no — astropy |
| `pl_checker_activation` | holdout | pytest | no — pylint |
| `amb_plugin_loading` | ambiguous | pytest | should abstain |

Calibration wrong routes are 0, which is the §44 minimum — but two holdout cases
are still wrong and one genuinely ambiguous case is forced. §45 is explicit that a
safely-disabled lane is containment rather than capability, and §138 lists forcing
an ambiguous route as a failure condition. Enabling this by default would trade a
truthful configured-default answer for a confident wrong one in three of four
fires.

The holdout failures were counted, not diagnosed: no holdout case was inspected to
choose any rule (§5, §42), so the holdout remains **unconsumed**.

## The ambiguity tension, recorded rather than resolved

`amb_plugin_loading` is semantically ambiguous — pytest, sphinx and pylint all
load plugins at startup — but **evidentially** unique: only pytest carries an
aligned mechanism fact for it. The ladder therefore routes, correctly by its own
rule, to the only repository with evidence.

This is a real gap between "several repositories implement this" and "several
repositories can be shown to implement this". Resolving it by making the lane
abstain whenever a query *could* match several repositories would require
comparing evidence VTRACE does not have. It is recorded as a limitation rather
than patched, because the honest fix is better mechanism coverage, not a routing
rule that guesses at ambiguity.

## Net effect on the workspace measurement

| | lane off | lane on |
| --- | ---: | ---: |
| correct repository Top-1 (overall) | 18.2% | 18.2% |
| calibration | 28.6% | 28.6% |
| holdout | 0% | 0% |

Before the test-evidence fix the lane scored 21.2% overall / 8.3% holdout, and
that number was worse than it looked: it included a route reached through another
repository's test fixtures. Removing test evidence removed both a wrong route and
a *correct* route that rested on the same illegitimate basis. Losing the latter is
the right outcome — routing is a claim about implementation ownership, and a test
naming a behaviour is not a repository implementing it.

## Consequence

C NOT PASS → **D is not run** (§77: do not consume the holdout to collect numbers
for a candidate that did not pass), and **E is not run**. The non-ARC holdout and
ARC both remain unconsumed and untuned.
