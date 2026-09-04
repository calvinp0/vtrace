# M213 — preregistration: VTRACE_VEXP_CAUSAL_100

Generated from `m213Preregistration.ts` together with the JSON document. The
JSON is authoritative; this file is a rendering of it and is never edited by hand.

```text
preregistration hash   5d90eddb9cc4759acf6a6fbc033d54ee0d5aea589a92c169daa7dca8d9c568c8
manifest hash          0001072171e0e3aa4242a6865a7bf144cb3ffba145c89aeee27de99b18cbe9d9
intended runs          300
live model spend       $0
launch authorised      false
```

## 1. The question

Does VTRACE causally improve task resolution relative to baseline? H1: P(resolve|VTRACE) != P(resolve|baseline), two-sided.

Under identical agent, model, repository, native tools, budget and evaluator,
what changes because VTRACE or VEXP is present? Three arms, one hundred tasks,
three hundred runs, every task run under all three arms.

## 2. Task population

The exact VEXP subset, taken as the vendor's own committed artifact rather than
reconstructed: `/home/calvin/code/vexp-swe-bench/data/swe-bench-100.jsonl`, sha256 `7bd07d5e50e26f3c51e8813f93be6be840a62f9fac333586f139ac7853971d7d`.
100 instances across 12 repositories,
median complexity 22, maximum 247.

**The vendor's own selection script does not reproduce their own subset** — 22 of
100 instances overlap. The artifact is authoritative; the script is not.

## 3. Arms

| arm | MCP servers | treatment tools | native tools |
|---|---|---|---|
| A — baseline | none | 0 | 7 |
| B — VTRACE | vtrace | 14 (product default) | 7 |
| C — VEXP | vexp | 3 (product default) | 7 |

The catalogue asymmetry is deliberate and preserved: each arm is what that
product actually gives an agent.

## 4. Launch gates

| gate | requirement | status |
|---|---|---|
| G1 | preregistration committed | **PASS** |
| G2 | preregistration hash recorded | **PASS** |
| G3 | task population frozen | **PASS** |
| G4 | run manifest frozen | **PASS** |
| G5 | VTRACE treatment executable | **PASS** |
| G6 | VEXP treatment executable | **FAIL** |
| G7 | baseline contamination guard passes | **PASS** |
| G8 | treatment contamination guards pass | **PASS** |
| G9 | identical agent verified | **PASS** |
| G10 | identical model verified | **PASS** |
| G11 | identical budgets verified | **PASS** |
| G12 | identical native tools verified | **PASS** |
| G13 | repository-state equivalence verified | **PASS** |
| G14 | evaluator validated | **PASS** |
| G15 | exclusion rules frozen | **PASS** |
| G16 | statistical plan frozen | **PASS** |
| G17 | stopping rule frozen | **PASS** |
| G18 | randomisation frozen | **PASS** |
| G19 | all falsification controls pass | **PASS** |
| G20 | no benchmark-task outcome-bearing live run has occurred | **PASS** |
| G21 | treatment-generated state cannot enter a captured patch | **BLOCKED** |
| G22 | index warmth is symmetric across treatment arms | **BLOCKED** |

## 5. Falsification suite

| control | what it breaks | expectation | result |
|---|---|---|---|
| F0_CLEAN_BASELINE | a fully compliant baseline run raises no issue | GUARD_SILENT | satisfied |
| F0_CLEAN_VTRACE | a fully compliant vtrace run raises no issue | GUARD_SILENT | satisfied |
| F0_CLEAN_VEXP | a fully compliant vexp run raises no issue | GUARD_SILENT | satisfied |
| F1 | a VTRACE tool is injected into the baseline arm | GUARD_FIRES | satisfied |
| F2 | VEXP is exposed inside the VTRACE arm | GUARD_FIRES | satisfied |
| F3 | VTRACE is exposed inside the VEXP arm | GUARD_FIRES | satisfied |
| F4 | the VTRACE commit changes after the manifest is generated | GUARD_FIRES | satisfied |
| F5 | one arm runs a different model id | GUARD_FIRES | satisfied |
| F6 | a treatment-specific instruction is appended to one arm's prompt | GUARD_FIRES | satisfied |
| F7 | one arm is given a larger turn and cost budget | GUARD_FIRES | satisfied |
| F8 | source is modified before one arm starts | GUARD_FIRES | satisfied |
| F9 | a task is removed from the manifest after preregistration | GUARD_FIRES | satisfied |
| F10 | the arm-order seed is changed after preregistration | GUARD_FIRES | satisfied |
| F11 | an ordinary unresolved run is marked invalid with no infrastructure reason | GUARD_FIRES | satisfied |
| F12 | a treatment arm exposes its tool and the agent never invokes it: the run stays valid under ITT | GUARD_SILENT | satisfied |
| F13_CLASSIFIED | treatment initialisation failure is a preregistered exclusion category | GUARD_SILENT | satisfied |
| F13_NO_SILENT_BASELINE | a VTRACE arm whose treatment failed to initialise is silently run as baseline | GUARD_FIRES | satisfied |
| F14 | the preregistration document is edited after its hash is recorded | GUARD_FIRES | satisfied |
| F15 | the cohort is finalised after 180 of 300 planned runs | GUARD_FIRES | satisfied |
| F16 | tasks are dropped from the analysis because a treatment lost them | GUARD_FIRES | satisfied |
| F17 | Grep is removed from one arm | GUARD_FIRES | satisfied |
| F18 | the gold patch is reachable from the agent's context | GUARD_FIRES | satisfied |
| F19 | a later arm reuses the previous arm's conversation and patch | GUARD_FIRES | satisfied |
| F20 | the VEXP arm cannot pin a version | GUARD_FIRES | satisfied |
| F21_HARNESS | the harness's own patch-capture exclusion list is asymmetric across treatments | GUARD_FIRES | satisfied |
| F21_PATCH | a captured patch contains the treatment's generated index state | GUARD_FIRES | satisfied |
| F21_CLEAN | a captured patch containing only source changes raises no issue | GUARD_SILENT | satisfied |
| F22 | the harness preserves one treatment's index between tasks and wipes the other's | GUARD_FIRES | satisfied |
| F22_CLEAN | a symmetric clean policy raises no issue | GUARD_SILENT | satisfied |

## 6. Spend

```text
benchmark-task live-agent runs   0
live model spend                 $0
VTRACE product changes           0
VEXP product changes             0
frozen A1-A15 scorer changes     0
```

No paid run is authorised by this document. The launch gates decide that.
