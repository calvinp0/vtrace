# M193A — source-version authority and treatment isolation by construction

Design document for the two acquisition-integrity closures. Neither changes what
M194 would measure; both change what M194 is allowed to believe about a
measurement.

---

## Part 1 — source version

### 1.1 The gap M192 and M193 left open

M192 established that two questions about a validation event are independent and
both necessary:

```
which FILE did the interpreter resolve?     path provenance
did the interpreter actually run?           execution provenance
```

M193 found a third, which neither answers:

```
which BYTES of that file did it run?        source-version provenance
```

CPython validates a timestamp-based `.pyc` against the source's
`(mtime_seconds, size)` and nothing else. An edit that preserves the size within
one whole second leaves both fields untouched, so the interpreter accepts a cache
compiled from the *previous* bytes while `__file__` continues to name — truthfully
— the edited checkout. Every witness M192 built says the right thing, and the
program that ran is the old one.

M193 measured this and recorded it as a property of three of five repositories.

### 1.2 What the reproduction actually found

`run_stage5_m193a_bytecode_reproduction.py` drives the real containers through
the real execution seam. It reports the natural arm, which writes two
same-length values back to back and lets the clock decide, and a forced arm,
which sets the second write's mtime back to the first's and lets nothing decide.

The natural arm's affected set is **not stable**:

| run | hazardous specimens |
|---|---|
| M193 | requests, pytest, sympy |
| M193A, first run | django, flask, requests |
| M193A, committed run | django, flask, requests, pytest |

The repositories did not change between those runs. What changed is whether the
two writes happened to land in the same whole second. In every case where
`s0.mtime == s1.mtime` the stale read occurred, and in every case where the
second boundary was crossed it did not.

So M193's standing finding — "3 of 5 dry-run repositories are hazardous" —
attributes to a repository what belongs to an edit's timing. Under the forced
arm, **5 of 5 execute stale code**, across CPython 3.6.13, 3.9.20 and 3.11.10,
all three in timestamp invalidation mode with `dont_write_bytecode` false and no
`pycache_prefix`. There is no safe repository in the fixture; there are only
edits that happen to miss.

Two smaller findings from the same run, both paid for by being bitten:

* **The control's own setup hit the hazard it was constructing.** The first
  forced arm wrote its priming value at the same length as the natural arm's,
  so on `pytest-dev/pytest` the priming read itself came from a stale cache and
  the arm reported a false negative. The priming write now uses a different
  length, which moves the size field and invalidates any cache regardless of the
  clock.
* **The probe could not run on the oldest image in the fixture.** It was written
  with `from __future__ import annotations`, which does not exist before Python
  3.7, so it failed silently on `django/django` (3.6.13) and that specimen came
  back with no classifier verdict at all. The probe is now unannotated, and says
  why in its own source.

### 1.3 How freshness is established

The probe (`m193a_source_version_probe.py`) runs inside the container, after the
agent's command, as a separate process. It never imports the file it is judging —
importing one would write or refresh the very cache whose staleness is the
evidence.

For each changed file it asks two questions in order.

**Would the cache have been used at all?** Reconstructed from the same header
fields CPython compares. The header format is version-dependent and the branch is
explicit: before 3.7 it is 12 bytes with no flags word, and reading an mtime out
of a flags field would be a silent, plausible error. If the magic differs, or the
`(mtime, size)` pair differs, or a checked hash-based cache's recorded hash
differs, the interpreter had to recompile and what it ran is the current bytes by
definition.

**If it would have been used, does it agree with the current bytes?** The cached
code object is unmarshalled and compared against a fresh compile of the file as
it stands now.

The comparison is on a **recursive structural fingerprint** of the code object,
not on raw marshal bytes. This is load-bearing: on every interpreter measured,
`marshal.dumps(compile(src))` differs from a byte-identical file's cached body
because of marshal's reference-sharing encoding. A byte comparison would report
staleness on every file in the corpus. Raw marshal equality is still recorded, as
a weaker second witness that is expected to be false.

### 1.4 The states

```
CURRENT_EDITED_STATE_CONFIRMED    every changed file in scope either recompiled
                                  or is backed by a cache provably equal to it
SOURCE_VERSION_AMBIGUOUS          freshness not established
STALE_EXECUTION_CONFIRMED         a cache that is NOT the current source would
                                  have been accepted
NOT_APPLICABLE                    not a validation attempt, or no runner started
UNKNOWN                           the probe did not run
```

Per changed file:

```
COMPILED_FROM_CURRENT_SOURCE   no cache, or a cache the interpreter must reject
CACHE_MATCHES_CURRENT_SOURCE   an accepted cache that equals a fresh compile
CACHE_STALE_AND_ACCEPTED       an accepted cache that does not
NON_CACHED_ASSET               a template, fixture or config read from disk at
                               run time; fresh by construction
COMPILED_ARTIFACT_REQUIRED     a C extension or similar; never claimed fresh
INDETERMINATE                  could not be established
```

`NOT_APPLICABLE` and `UNKNOWN` are kept apart deliberately (§15). The first says
the question does not arise; the second says it arose and went unanswered. Only
the first is ever benign.

### 1.5 The scope rule

The changed-source set is every path in the working tree's current diff against
the base commit, excluding the environment's own pre-agent untracked output. It
is read from `git diff --cached --name-only` in the checkout, not from the
harness's own snapshot bookkeeping, so the two cannot drift apart.

A whole-repository freshness proof is neither necessary nor affordable. What a
validation event is evidence *about* is the edited program, and the edited
program is exactly this set.

Because the only rejection is a demonstrated stale acceptance — a cache that
exists, would be accepted, and provably differs — the conservatism costs almost
nothing. A changed file that was never imported cannot be convicted unless its
cache was genuinely poisoned.

### 1.6 Third-party import caches

pytest's assertion rewriter compiles test modules itself, writes the result
beside the standard cache under its own tag, and validates it against the same
`(mtime, size)` pair — inheriting the same collision. Its body is a rewritten
code object, deliberately not a plain compilation, so the fingerprint comparison
that settles the standard cache cannot settle this one.

Rather than ignore the file or pretend a comparison we cannot make came out
fine, the probe reports one of two things:

* the cache was written at or after the moment the validation started, so the run
  being judged is the run that produced it, and it compiled the source it read;
* otherwise, `INDETERMINATE`, and the event is `SOURCE_VERSION_AMBIGUOUS`.

This is visible in the committed dry run: `validation2` is
`SOURCE_VERSION_AMBIGUOUS` on the three repositories where the fake agent used
pytest, and `CURRENT_EDITED_STATE_CONFIRMED` on the two where it fell back to a
plain assertion. The ambiguity is entirely about the fake agent's *own* test
file, which it creates and which is therefore in the changed set. A real
acquisition arm edits source and runs the repository's pre-existing tests, which
are not in its diff — so this shape is rarer live than the dry run makes it look.
It is reported rather than tuned away.

### 1.7 The stability guard

The probe necessarily runs after the command. It describes what the command saw
only if nothing rewrote the tree in between, so the `BEFORE_VALIDATION` and
`AFTER_VALIDATION` diff hashes must agree. When they do not, the honest answer is
that freshness was not established — not that it was fine.

One exception, and it is deliberate: a *demonstrated* stale acceptance is
reported even when the tree moved. Ambiguity must not be allowed to launder the
strongest fact available.

### 1.8 What was deliberately not done

Deleting `__pycache__`, exporting `PYTHONDONTWRITEBYTECODE`, invoking `python -B`,
touching source files before every validation, sleeping past the timestamp
granularity, or changing the test runner would each make the hazard impossible —
and would each mean the acquisition measured a condition no agent will ever meet.
The hazard is observed truthfully. It is not treated.

---

## Part 2 — treatment isolation

### 2.1 The gap M193 left open

M193 audited ten contamination routes and closed nine by construction. The tenth
was left as a precondition:

> launch with a private `CLAUDE_CONFIG_DIR` containing credentials only

A precondition is an instruction to an operator. This programme has now twice
recorded what happens when correctness depends on someone remembering something.

### 2.2 What the inherited configuration actually exposes

M193's audit reported one blocking finding: a 978-byte `~/.claude/CLAUDE.md`.
Measured against a running CLI — `claude mcp list`, which resolves configuration
and exits without a provider request — the inherited configuration on this host
also delivers **five MCP servers**, three of them remote network services, plus
an `enabledPlugins` set, an `env` block, a `statusLine`, a `model` override and
an `effortLevel`.

### 2.3 The precondition was not sufficient

M193's manifest states that an empty `--mcp-config` with `--strict-mcp-config`
"guarantees no MCP server, VTRACE's included, can reach the agent". Measured:

| configuration | MCP servers resolved |
|---|---|
| inherited host configuration | 5 |
| private directory, credentials only — M193's stated precondition | **3** |
| the same, with `--mcp-config '{}'` and `--strict-mcp-config` | **3** |
| M193A's constructed arm | **0** |

`--strict-mcp-config` closes *file-based* registrations. The three survivors are
claude.ai account connectors — Zoom, Slack, Google Drive — which arrive with the
authenticated account and therefore follow `.credentials.json` into any private
directory. No file can be withheld to stop them. `disableClaudeAiConnectors`
reduces them to zero.

The uncertainty is recorded rather than argued away: `claude mcp list` is the
CLI's own resolution, and whether a strict *session* would have loaded those
connectors as tools could only be settled by a provider call, which §6 forbids.
They are closed instead of debated (§28).

### 2.4 The construction

```
constructArmEnvironment()
  → a private directory that did not exist a moment earlier, mode 0700,
    unique per arm
  → exactly the allow-listed files copied in: [".credentials.json"]
  → the isolation settings WRITTEN, not inherited:
        { "disableClaudeAiConnectors": true }
  → the process environment built from an allow-list, never from the parent
  → an audit of the directory, the environment and the argv
  → mayLaunchModel
```

Writing `settings.json` is isolation, not treatment. It adds no instruction, no
tool and no context; it removes a tool surface the untreated baseline condition
never described. It is written rather than copied so it cannot inherit anything,
and the audit requires it to be exactly that object — an extra key, a hook, or a
copied host file is a blocking finding.

The environment is an allow-list because `{...process.env}` with a few keys
deleted is a denylist, and a denylist is only as complete as the last person to
think about it. `ANTHROPIC_` is forbidden alongside `VTRACE_` and `VEXP_`: an
inherited API key or base-URL override would silently change which service the
pinned model is bought from.

### 2.5 Failing closed

`mayLaunchModel` is the entire interface between this module and anything that
costs money. It is false when the directory already existed, when credentials are
absent, when the settings file is anything but the isolation object, when the
settings file is missing, when a file outside the allow-list appears, when a
`VTRACE_`/`VEXP_`/`ANTHROPIC_` key survives, when `CLAUDE_CONFIG_DIR` does not
point at the private directory, when `--strict-mcp-config` is absent, or when the
pre-launch MCP measurement is not zero.

An arm whose audit fails is recorded `TREATMENT_CONTAMINATION` under M193's
existing exclusion category and is `RUN_INVALID`. Launching and recording the
contamination alongside the result is not permitted.

### 2.6 What is preserved

Instruction files belonging to a benchmark repository at its base commit are
untouched. They are the benchmark's normal condition, they are recorded in a
separate telemetry field from experimental injection, and removing them would
be an intervention of its own.

---

## Part 3 — what this does not do

The corpus adequacy threshold, the task fixture, the model, the CLI version, the
turn budget, the caps, the concurrency and the stopping rule are all unchanged.
The new axis can only reduce the number of I6-usable episodes, and the threshold
was deliberately not lowered to absorb that: the reduction is what truthful
measurement is supposed to reveal.

No VTRACE product behaviour was added, altered or read. I5 remains closed. I6
remains unimplemented.
