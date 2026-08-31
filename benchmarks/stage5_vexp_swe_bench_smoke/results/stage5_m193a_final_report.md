# M193A — acquisition-integrity closure

**Verdict: M193A — PASS. Readiness: M194_ACQUISITION_INTEGRITY_READY. Live model spend: $0.**

M193 reached a complete, frozen acquisition design and failed on its own rule
because one accidental live model call was made during the milestone. That
verdict stands and is not revisited here. What M193 also left behind were two
integrity hazards it had discovered but not closed, and closing them is all this
milestone does.

Both are closed. Neither closure changes what M194 would measure; both change
what M194 is allowed to believe about a measurement.

---

## 1. Starting state

```
branch                main
starting SHA          dac2db26632337dbc5d08c5ae336fcc822471fff
ahead / behind        157 ahead of origin/main, 0 behind
pre-existing dirt     2 tracked (stage5_outcome_ledger.{json,md}), 203 untracked
git diff --check      clean
```

M193's truncated `dac2db26…` recovers to the full SHA above. The two dirty
tracked files predate this work and are untouched.

---

## 2. The bytecode hazard, reproduced — and re-attributed

`run_stage5_m193a_bytecode_reproduction.py` drives the five committed dry-run
repositories through the real containers and the real execution seam.

| specimen | CPython | invalidation | natural | forced | classifier on the forced arm |
|---|---|---|---|---|---|
| `django/django-10880` | 3.6.13 | timestamp (12-byte header) | hazard | hazard | `CACHE_STALE_AND_ACCEPTED` |
| `pallets/flask-5014` | 3.11.10 | timestamp | hazard | hazard | `CACHE_STALE_AND_ACCEPTED` |
| `psf/requests-1142` | 3.9.20 | timestamp | hazard | hazard | `CACHE_STALE_AND_ACCEPTED` |
| `pytest-dev/pytest-10051` | 3.9.20 | timestamp | hazard | hazard | `CACHE_STALE_AND_ACCEPTED` |
| `sympy/sympy-12419` | 3.9.20 | timestamp | clean | hazard | `CACHE_STALE_AND_ACCEPTED` |

All five run in timestamp mode with `dont_write_bytecode` false, no
`pycache_prefix` and `optimize=0`. The scenario in every case is the same: source
`S0` is compiled and cached; the source becomes `S1` at the same length within
the same whole second; the path witness reports `/testbed/<pkg>/__init__.py`; the
execution witness fires; and the value read back is `S0`'s.

**M193's attribution was wrong, and this is the milestone's main correction.**
"3 of 5 dry-run repositories are hazardous" names a property of a repository
while measuring a property of an edit's timing. The affected set moved between
three runs of the same probe on the same five repositories:

```
M193                     requests, pytest, sympy
M193A first run          django, flask, requests
M193A committed run      django, flask, requests, pytest
```

In every case the hazard occurred exactly when the two writes shared a whole
second and never otherwise. With the race removed, **5 of 5 execute stale code**.
There is no safe repository in the fixture.

Two defects were found in M193A's own instrument, both by running it:

* The forced arm's priming write used the same length as the natural arm's, so on
  `pytest-dev/pytest` the priming read *itself* came from a stale cache and the
  control reported a false negative. The priming value now differs in length,
  which moves the size field and invalidates any cache regardless of the clock.
* The probe used `from __future__ import annotations`, which does not exist
  before Python 3.7, so it failed on `django/django` — the oldest interpreter in
  the fixture — and that specimen returned no verdict at all. The probe is now
  unannotated and records why in its own source.

---

## 3. The source-version authority

Full design: `stage5_m193a_integrity_design.md`.

Current source state is defined from the working tree's own diff against the base
commit, read from the checkout rather than from the harness's snapshot
bookkeeping.

> **M193B correction.** This paragraph originally named the command as
> `git diff --cached --name-only`. That was the middle line of a three-line
> shell: the committed implementation was `git add -A` → that command →
> `git reset -q`, which used staging as a *query*. M193B audited it and found
> two defects — the observation wrote (the mixed reset destroyed whatever the
> agent had staged) and a detected rename lost its vacated path — and replaced
> it with a non-mutating `git diff --no-renames --name-only HEAD` unioned with
> `git ls-files --others --exclude-standard`. See
> `stage5_m193b_final_report.md`; the frozen lifecycle re-runs to identical
> per-instance verdicts. Each changed file is judged by an out-of-band probe that
runs inside the container after the agent's command and never imports what it
judges.

```
would CPython have accepted the cache?     reconstructed from the same header
                                           fields CPython compares, with an
                                           explicit branch for the pre-3.7
                                           12-byte header
if yes, does the cache agree with the      the cached code object unmarshalled
current bytes?                             and compared to a fresh compile
```

The comparison is a recursive structural fingerprint of the code object, not raw
marshal bytes. That distinction is load-bearing: `marshal.dumps(compile(src))`
differed from a byte-identical file's cached body on **every** interpreter
measured, because of marshal's reference-sharing encoding. A byte comparison
would have reported staleness on every file in the corpus. Raw marshal equality
is still recorded, as a weaker witness expected to be false.

```
CURRENT_EDITED_STATE_CONFIRMED   every changed file recompiled, or backed by a
                                 cache provably equal to it
SOURCE_VERSION_AMBIGUOUS         freshness not established
STALE_EXECUTION_CONFIRMED        an accepted cache that is NOT the current source
NOT_APPLICABLE                   not a validation attempt, or no runner started
UNKNOWN                          the probe did not run
```

It fails closed exactly as `classifyValidationProvenance` does. A demonstrated
stale acceptance is reported even when the tree moved under the probe, because
ambiguity must not launder the strongest fact available. `NOT_APPLICABLE` and
`UNKNOWN` are distinct: the first says the question does not arise, the second
that it arose and went unanswered.

---

## 4. Falsification controls

Each was run on the real container and runtime path, not only against synthetic
records.

| control | expected | actual |
|---|---|---|
| forced stale cache, 5 specimens | never `CURRENT_EDITED_STATE_CONFIRMED` | `CACHE_STALE_AND_ACCEPTED` 5/5 |
| in-container stale control, 5 specimens | `CACHE_STALE_AND_ACCEPTED` | 5/5 |
| healthy current-source, 5 specimens | confirmed | `CACHE_MATCHES_CURRENT_SOURCE` 5/5 |
| in-container healthy control, 5 specimens | confirmed | 5/5 |
| natural first validation, 5 specimens | confirmed | `CURRENT_EDITED_STATE_CONFIRMED` 5/5 |
| poisoned copy, 5 specimens | path axis refuses | shadow package resolved outside the checkout 5/5 |

The poisoned-copy control is M192's, preserved deliberately. The current bytes
are copied into a shadowing site-packages install, so the *source-version*
witness is satisfied by the shadow and only the *path* witness can refuse it.
Fixture `F15` encodes the same shape: `CURRENT_EDITED_STATE_CONFIRMED` combined
with `INSTALLED_COPY_CONFIRMED` is I6-unusable. Neither axis may stand in for the
other.

A classifier that only ever abstains would pass the stale control and fail the
healthy one. It passes both.

---

## 5. The I6 usability rule

Frozen:

```
I6_USABLE_VALIDATION requires

    the run is RUN_VALID
AND the arm made a source edit
AND a post-edit validation was attempted
AND a test runner started
AND the semantic test result is not UNKNOWN
AND path provenance          == EDITED_CHECKOUT_CONFIRMED
AND source-version provenance == CURRENT_EDITED_STATE_CONFIRMED
```

`EDITED_CHECKOUT_CONFIRMED` with `SOURCE_VERSION_AMBIGUOUS` or
`STALE_EXECUTION_CONFIRMED` is I6-unusable even when the test result reads
normally. Freshness is never inferred from a validation having succeeded.

The two axes are two nested filters rather than one, so the ledger can say which
of the two an episode was lost to. A run losing every episode to the new axis is
still `RUN_VALID`, is reported as `I6_UNUSABLE_SOURCE_VERSION`, and is counted in
`validButI6UnusableSourceVersionArms` alongside `sourceVersionAmbiguousEvents`
and `staleExecutionEvents`.

### Synthetic fixtures

All twelve M193 fixtures classify **identically**. Four were added:

| fixture | shape | result |
|---|---|---|
| `F13_SOURCE_VERSION_AMBIGUOUS` | right file, normal result, cache could have carried the previous compilation | `RUN_VALID`, I6 false, `I6_UNUSABLE_SOURCE_VERSION` |
| `F14_SOURCE_VERSION_CONFIRMED` | fail → revise → pass with freshness established | `RUN_VALID`, I6 true |
| `F15_STALE_EXECUTION_WRONG_PATH` | poisoned copy carrying current bytes | `RUN_VALID`, I6 false, `NO_TRUSTWORTHY_VALIDATION_RESULT` |
| `F16_STALE_EXECUTION_CONFIRMED` | staleness proven, not merely suspected | `RUN_VALID`, I6 false, `I6_UNUSABLE_SOURCE_VERSION` |

16/16 agree with their frozen expectations. The corpus expectation moves from
10 valid / 4 I6-usable to 14 valid / 5 I6-usable purely by addition.

**The adequacy threshold is unchanged**: `ADEQUATE` at 12 I6-usable arms across 6
repositories with 30 valid runs, `PARTIAL` at 6/4/15. The new axis can only
reduce usable episodes, and the threshold was deliberately not lowered to absorb
that.

---

## 6. Treatment isolation

M193 left this as a per-arm precondition. M193A makes it a property of the object
the launcher builds, and in the course of doing so falsified one of M193's stated
guarantees.

| configuration | MCP servers resolved |
|---|---|
| inherited host configuration | **5** — Zoom, Slack, Google Drive, sequential-thinking, codex |
| private directory, credentials only (M193's precondition) | **3** |
| the same, plus `--mcp-config '{}'` and `--strict-mcp-config` | **3** |
| M193A's constructed arm | **0** |

M193's manifest states that an empty MCP config with `--strict-mcp-config`
"guarantees no MCP server, VTRACE's included, can reach the agent". That is true
of file-based registrations. The three survivors are claude.ai account
connectors, which arrive with the authenticated account and therefore follow
`.credentials.json` into *any* private directory. No file can be withheld to stop
them; `disableClaudeAiConnectors` reduces them to zero.

The host also carries a 978-byte user `CLAUDE.md`, an `enabledPlugins` set, an
`env` block, a `model` override, an `effortLevel`, a `statusLine`, a plugins
directory and a commands directory — all of which M193's audit would have had an
operator remember to avoid.

Construction, per arm:

```
a private directory that did not exist a moment earlier, 0700, unique per arm
exactly [".credentials.json"] copied in
{"disableClaudeAiConnectors": true} WRITTEN, never inherited
the process environment built from an allow-list, never from the parent
an audit of directory + environment + argv + measured MCP count
mayLaunchModel
```

Writing the settings file is isolation, not treatment: it adds no instruction, no
tool and no context, and removes a tool surface the untreated baseline never
described. The audit requires it to be exactly that object — an extra key, a
hook, or a copied host file is blocking.

`mayLaunchModel` is the only interface to anything that costs money. It is false
when the directory already existed, credentials are absent, the settings file is
wrong or missing, an unexpected file appears, a `VTRACE_`/`VEXP_`/`ANTHROPIC_`
key survives, `CLAUDE_CONFIG_DIR` does not point at the private directory,
`--strict-mcp-config` is absent, or the measured MCP count is not zero. Seventeen
tests in `m193aArmEnvironment.test.ts` build a thoroughly contaminated host —
user memory, hook-bearing settings, registered MCP servers, installed plugins,
`VTRACE_*` and `ANTHROPIC_*` variables, and an outer `CLAUDE_CONFIG_DIR` already
pointing at all of it — and assert that none of it crosses.

CLI version confirmed as `2.1.251` from `--version`, matching the pin. No
provider call was made to establish anything (§28).

Repository-native instruction files are preserved untouched.

---

## 7. Fake-agent dry run

Re-run end to end on the same five repositories, with source-version provenance
added at every validation and the falsification controls executed against the
same running container.

| repository | edit | val 1 | src-ver 1 | edit 2 | val 2 | src-ver 2 | patch | evaluator |
|---|---|---|---|---|---|---|---|---|
| `django/django` | ok | FAILED | CONFIRMED | ok | PASSED | CONFIRMED | `IDENTICAL_STRICT` | resolved |
| `pallets/flask` | ok | FAILED | CONFIRMED | ok | PASSED | AMBIGUOUS | `IDENTICAL_STRICT` | resolved |
| `psf/requests` | ok | FAILED | CONFIRMED | ok | PASSED | AMBIGUOUS | `IDENTICAL_STRICT` | resolved |
| `pytest-dev/pytest` | ok | FAILED | CONFIRMED | ok | PASSED | AMBIGUOUS | `IDENTICAL_STRICT` | resolved |
| `sympy/sympy` | ok | FAILED | CONFIRMED | ok | PASSED | CONFIRMED | `IDENTICAL_STRICT` | resolved |

5/5 lifecycles complete, evaluator returned 0 in 45s, 5/5 resolved.

The three `AMBIGUOUS` second validations are the new authority doing its job and
are worth stating precisely. They are caused by **pytest's assertion-rewrite
cache on the fake agent's own test file**, which pytest compiles itself and
validates against the same `(mtime, size)` pair. Its rewritten body cannot be
compared against a plain compilation, so the probe abstains rather than guessing.
The two repositories that report `CONFIRMED` are the two where the fake agent
fell back to a plain assertion instead of pytest.

This is more visible in the dry run than it will be live: the fake agent *creates*
its test file, so the file is in its diff. A real arm edits source and runs the
repository's pre-existing tests, which are not in its diff. The shape is reported
rather than tuned away.

---

## 8. Patch identity

Unchanged, and re-proved rather than assumed. For all five instances the
interactive final diff, the extracted prediction and the `patch.diff` the
official evaluator copied into its own container are byte-identical under the
frozen normalisation: `IDENTICAL_STRICT`, 5/5. All five resolve.

The M193A infrastructure touches the container adapter, so this was the check
most likely to catch an accidental change to patch materialisation. It did not.

---

## 9. The re-frozen experiment

```
task fixture hash     e79843d3b93d4c77551911a92eed9b316c57b5045ff7e7ef75018efb2e9aaca4
                      40 instances, 12 repositories                        UNCHANGED
old M193 manifest     7a85d25df322940e20b5f8075e696547fa0362022ad4ae0c5867187b478c2c98
new M193A manifest    b356e2114eb6b79698b9999e7c94eb734142760d6203ec8fc4bff933c30b4796
model                 claude-opus-4-5-20251101                             UNCHANGED
agent                 Claude Code CLI 2.1.251, headless                    UNCHANGED
max turns             250                                                  UNCHANGED
per-run cap           $3.50        total cap  $90.00                       UNCHANGED
min / max arms        20 / 40      concurrency  3                          UNCHANGED
stopping rule         spend cap OR max arms OR (>=20 arms AND >=12
                      I6-usable across >=6 repositories)                   UNCHANGED
adequacy              ADEQUATE 12/6/30, PARTIAL 6/4/15                     UNCHANGED
```

The M193A manifest is **derived** from the committed M193 manifest rather than
regenerated beside it, and the generator verifies M193's own hash before copying
it. "Nothing outside the integrity closure moved" is therefore a mechanical fact:
the generator diffs every leaf of both canonical forms and reports
**41 added, 4 changed, 0 removed, 0 outside the integrity scope**, with 15/15
declared invariants holding.

The four changed leaves are `schemaVersion`, `milestone`, `frozenSources` and
`i6UsableDefinition.requires`. Added: `derivedFrom`, `sourceVersionAuthority`,
`armLaunchRecord`, and the new keys under `i6UsableDefinition` and
`treatmentIsolation`.

---

## 10. Gates

15/15 pass — `stage5_m193a_readiness.json` evaluates each against a committed
artifact rather than against a statement.

```
G1  frozen design unchanged           0 leaves outside integrity scope, 15/15 invariants
G2  hazard reproduced                 5/5 forced, CPython 3.6/3.9/3.11; natural 4/5 (a race)
G3  stale never reads as current      5/5 forced + 5/5 in-container classified stale
G4  healthy positively confirmed      5/5 + 5/5 in-container + 5/5 natural first validations
G5  poisoned copy still rejected      5/5 shadow installs + F15
G6  I6 requires source version        16/16 fixtures; F13 and F16 I6_UNUSABLE_SOURCE_VERSION
G7  ambiguity stays visible           ambiguous=1 stale=1 validButI6Unusable=2 of 14 valid
G8  private config constructed        fresh 0700 dir, [".credentials.json"] + written settings
G9  contaminated parent cannot leak   5 → 3 → 3 → 0 MCP servers
G10 isolation failure blocks launch   mayLaunchModel tracks the audit; 7 failure shapes tested
G11 dry run still succeeds            5/5 lifecycles, evaluator rc=0, 5/5 resolved
G12 patch identity strict             5/5 IDENTICAL_STRICT
G13 M193 fixtures unchanged           12/12
G14 adequacy unchanged                12/6/30 and 6/4/15
G15 zero live model calls             0 across every artifact
```

---

## 11. Verification

```
bun run typecheck                PASS
bun run typecheck:benchmarks     PASS
bun test                         5787 pass, 49 skip, 0 fail (363 files, 199s)
git diff --check                 clean

real-container reproduction      5 specimens, natural + forced + healthy arms
real-container controls          stale / healthy / poisoned copy, 5 specimens each
fake-agent dry run               5 repositories, container to official evaluator
synthetic fixtures               16/16 agree with frozen expectations
manifest regeneration            M193 hash verified, 0 leaves outside integrity scope

live-agent runs                  0
live model spend                 $0
```

M193's accidental `$0.1204` remains recorded against M193 and is not reclassified.

---

## 12. Authorisation

```
M194_ACQUISITION_INTEGRITY_READY

NO_VTRACE_I6_PRODUCT_IMPLEMENTATION_AUTHORIZED
NO_RUNTIME_REPAIR_INTERVENTION_AUTHORIZED
I5_REMAINS_CLOSED
```

Readiness is not permission. M194 requires an explicit spend authorisation.

---

## 13. What is honestly still uncertain

**The connector closure is measured through `claude mcp list`, not through a
session.** That command resolves configuration and exits without a provider
request, which is why it could be used at all. Whether a session launched with
`--strict-mcp-config` would have loaded those three connectors as tools could
only be settled by a provider call. They are closed rather than argued about, and
the uncertainty is recorded in the manifest.

**The source-version authority abstains on pytest-rewritten files.** Where
pytest's assertion rewriter owns a changed file's compiled form, freshness cannot
be established by comparison against a plain compilation, and the event is
ambiguous. The dry run shows this costs three of ten validations there; live it
should be rarer, because a real arm edits source and runs pre-existing tests. It
is not known how much rarer, and the sizing margin was already thin.

**The margin is now thinner than M193 estimated.** M193 projected roughly 15
I6-usable episodes against a target of 12 at M191's attempt rate. Every
source-version abstention subtracts from that, and the threshold was deliberately
not lowered. `PARTIAL` is a more likely outcome than it was, and that outcome
would itself be worth knowing.

**Still zero agents have ever run on a repaired path.** M192 said it, M193
repeated it, and it remains true. M193A makes the instrument honest about a
failure mode it would otherwise have recorded as a clean result. It buys nothing
else.
