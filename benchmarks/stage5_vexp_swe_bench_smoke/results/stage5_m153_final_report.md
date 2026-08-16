# M153 — Cross-Repository Behavioural Nomination and Generalisation Proof

**Verdict: INCOMPLETE (A PASS · B PASS · C NOT PASS · D not run · E not run).**

M153 does not close PASS. What it does deliver is the thing the milestone was
actually created for: a measurement, on repositories that supplied none of
VTRACE's development pressure, of how much of the behavioural capability is real
and how much was ARC-shaped. That answer is unambiguous and it is not flattering.

Predecessor: `72ce221c7006dc9e477dcbfa2d7e7372c136fa8c` (M152 final functional).

## Commits

| SHA | What |
| --- | --- |
| `5900528b` | Non-ARC behavioural generalisation corpus (before any algorithm work) |
| `8b10e944` | Repository evidence audit + behavioural routing contract |
| `f700d5b6` | M152 oracle and workspace baselines |
| `84dba95d` | Bounded behavioural repository nomination, default-off |

Branch `main`, committed locally, **not pushed**, no co-author trailers. The
brief stated 40 commits ahead of `origin/main` and unpushed; in fact `origin/main`
was already at `bcdd962e`, so the tree started at 0 ahead and fully pushed. The
four commits above are the only unpushed work.

Worktrees: 14 pre-existing, untouched. None created, none removed.

## A — corpus and baselines: PASS

35 cases across 7 pinned SWE-bench checkouts, split **by repository** so no
holdout case shares a repository with a calibration case.

| | |
| --- | --- |
| Calibration | requests, flask, pytest, sphinx (21 cases) |
| Non-ARC holdout | xarray, astropy, pylint (12 cases) |
| Ambiguous | 2 cases, no correct repository by construction |
| False-premise | 9 · explicit-absence controls 3 · project-name reuse 5 |
| Multi-part ground truth | 14 · recorded distractors 35 · categories 12 |

Ground truth was read from source and then checked mechanically: all **81**
referenced symbols resolve by AST lookup in the pinned trees, and every asserted
span matches the symbol's real line range. Nine spans were wrong on first writing
and were corrected before freezing. All 14 ground-truth files are
content-digested.

The corpus was committed **before** the routing implementation existed, which is
what makes it a test rather than a description.

### The finding

| Metric | Oracle | Workspace |
| --- | ---: | ---: |
| correct repository Top-1 | 100% *(forced)* | 18.2% |
| correct implementation Top-1 | **3.3%** | 3.3% |
| correct implementation Top-3 | 3.3% | 3.3% |
| required support present | 56.7% | 56.7% |
| clean answer rate | 0% | 0% |
| cases with misleading evidence | 13.3% | 6.7% |
| explicit absence held | 100% | 100% |
| false-premise reconstructed | 0% | 0% |

The workspace 18.2% is arithmetic, not capability: the configured default is
`requests`, `requests` owns 6 of 33 repository-bound cases, and **all 35 requests
were answered by `configured_default` with `decidingTier: null`**.

The oracle number is the important one. Handed the correct repository for free,
the product puts the right implementation first in 1 of 30 cases and delivers an
expected definition anywhere in 2 of 30.

**Root cause: only 15 of 35 queries derive a behavioural operation at all.** The
other 20 return `suppressedBy: "no behavioural operation cue"`, after which
mechanism facts, subject alignment and answer-role delivery never run and the
request falls through to lexical matching — "format" matching a file about time
formats, "parser" matching the command-line argument parser, "reporter" losing to
"command line".

The near-minimal pair settles the diagnosis. M150's own fixture asks which
backend **wins** and derives `selection`; the corpus asks which backend **opens a
given file** and derives nothing. Same operation, same subject, ordinary
paraphrase. **The machinery generalises where it fires; its activation cue does
not.**

## B — audit and contract: PASS

Lane precedence, documented and implemented:

```
0 explicit repo/member authority   never overridden
1 absolute path containment
2 unique indexed path
3 unique exact symbol
4 behavioural mechanism            <- M153
5 configured default / sole member  fallback, not evidence
6 abstain
```

Two audit findings changed what had to be built:

1. **The absence controls already worked.** 32 of 35 queries produce no routing
   hints; the 3 that do are exactly the explicit-identifier cases, which reach
   the exact-symbol lane and earn a proven absence. An invariant to protect, not
   a gap to close.
2. **Repository-name poisoning was already blocked in the router** — not by a
   rule but by the hint extractor's shape, since `Flask`, `Sphinx` and `pylint`
   have neither an underscore nor a camel transition. The residual risk lives in
   retrieval scoring, not routing.

Cost model measured before designing: indexing ranges from 0.4 s (requests) to
142 s (astropy), so full retrieval per member is unaffordable at 11 members and
absurd at 1000 — which is why the lane is a bounded probe.

## C — implementation: NOT PASS

The lane is built as contracted and is correct by construction:

- sits below every exact lane and above the configured default;
- compares repositories by strongest **evidence class**, never by score, keeping
  only each repository's best item, so volume buys nothing;
- no runner-up margin and no threshold;
- abstains on a tie; word overlap never decides;
- declines to `no_decision` without making any absence claim;
- reuses M150's candidate generator (bounded, zero source reads) instead of
  reimplementing alignment;
- opens the probe database **read-only**, so index writes are 0 by construction;
- routing metadata stayed flat at 749 bytes with the lane on and off.

13 focused unit tests cover the ladder semantics, including that a small aligned
repository beats a large unaligned one, that ties are never broken by candidate
count, and that a no-decision is not phrased as an absence.

**It does not pass, on its own criteria.** §133 requires wrong-subject repositories
to be rejected. Enabled, the lane fired on 6 of 35 cases and routed wrongly on 3:

| Case | Routed | Correct |
| --- | --- | --- |
| `rq_adapter_selection` | flask | requests |
| `sp_parser_registry_false_premise` | astropy | sphinx |
| `ap_project_name_reuse` | pytest | astropy |
| `rq_redirect_auth_reuse` | requests | requests ✓ |
| `pl_reporter_ranking_false_premise` | pylint | pylint ✓ |
| `amb_plugin_loading` | pytest | *(ambiguous — should abstain)* |

The adapter case is diagnostic. For that query `requests` admits **zero**
candidates — its own first-prefix-match loop is not indexed as a selection
mechanism fact — while `flask` admits one, because the operand
`url_build_error_handlers` happens to contain the subject token `url`. The lane
faithfully routed to the only evidence in the workspace, and the only evidence
was coincidental.

So the lane's reach is capped twice over: by the 15/35 activation rate, and by
mechanism-fact sparsity in repositories nobody tuned against. Its precision is
capped by operand-token alignment.

**Shipped default-off** (`enableBehavioralRouting`, or
`VTRACE_ENABLE_BEHAVIORAL_ROUTING=1`), following the M78/M82/M85 precedent for
guards that measure MIXED. With the lane off the corpus result is unchanged; with
it on, oracle results are untouched — routing did not disturb retrieval, which is
the one property §78 and §100 demand.

Fixing this means widening operation-cue derivation and hardening subject
alignment. Both are **retrieval**, both are frozen M150 surface, and §68 forbids
letting M153 expand into them. The corpus has now independently proven the
generic defect §4 requires, so the work is justified — as the next milestone.

## D and E — not run

D (holdout evaluation of a frozen passing candidate) and E (ARC and TCKDB
holdouts, Frozen50 / Django / cross_repo_30 paired suites, 11/100/1000 scale
table, M138–M152 preservation runners) were **not performed**.

D is not meaningful for a candidate that is default-off and did not pass C. E is
simply outstanding work. Holdout *repositories* were measured as part of the
paired comparison above, but that is not the same as consuming the holdout
against a frozen passing candidate, and it is not claimed as such.

**ARC was not run, and was not consulted at any point.** No tuning decision in
this milestone looked at it.

## Two methodological findings worth keeping

1. **`initRepo` is not idempotent.** A second call over an existing index fails
   with `UNIQUE constraint failed: edges.id`. The harness now removes `.vtrace`
   before indexing.
2. **Session state accumulates across benchmark runs and feeds back into
   retrieval.** Re-running with `--skip-prepare` changed delivered item counts,
   and with the lane enabled, routing to a different repository caused *that*
   repository to accumulate observations that perturbed later oracle calls in the
   same pass. Not a violation — §97 permits the final delivery to write — but
   paired arms must each start from clean state, which they now do.

Also recorded: pylint cannot be indexed at all without excluding its
deliberately-invalid analyser fixture data (`doc/data/messages/`,
`tests/functional/`, `tests/input/`, `tests/regrtest_data/`). A `.vtraceignore`
in that checkout records the exclusion; the M153 ground truth is unaffected.

## Verification

```
bun run typecheck              clean
bun run typecheck:benchmarks   clean
bun test                       4646 pass, 49 skip, 0 fail (290 files)
git diff --check               clean
```

Pre-existing dirty files (`stage5_outcome_ledger.*`) were left untouched.

## Recommended next milestone

**M154 — behavioural activation and subject alignment.** The corpus has proven,
without ARC, that the behavioural chain fails to activate on ordinary paraphrases
and that alignment matches coincidental operand tokens. That is now the dominant
limitation, it gates the routing lane this milestone built, and for the first
time there is a frozen non-ARC corpus to calibrate it against and an untouched
holdout to check it on.

The behavioural routing lane should be re-measured and considered for default-on
once activation and alignment can carry it.
