# M154 — Agent Workflow Safety and Search-Contract Hardening

```
M154 — CLOSED MIXED

A PASS      agent-facing surface and search-contract audit
B PASS      generated-state PR leakage
C MIXED     project-reference poisoning
D PASS      selective-vs-complete retrieval semantics
E PASS      reuse-before-write safety and preservation
```

C is MIXED, so M154 is MIXED (§108/§109). The invariant C exists to enforce was
violated generically and is fixed; the outcome-level harm ARC reported did not
reproduce on the frozen non-ARC corpus, and the fix trades one improvement for one
regression there. That is not a PASS and is not presented as one.

## Commits

| | |
| --- | --- |
| Predecessor functional | `e3761ab989a14aea4e233844070491084f33b2ce` |
| Predecessor evidence | `318f2c7b02437dd1efd0abeef83dca996990c2f8` |
| M154 functional | `4975d5b2` keep vtrace state out of commits · `1f13b4f2` separate project scope from symbol relevance · `051a7c55` stop bounded retrieval speaking as if it had searched everything |
| M154 final functional | `051a7c55` |

Branch `main`, local only, nothing pushed, no co-author trailers, pre-existing dirt
preserved. Worktrees: 14 pre-existing untouched; 1 created for the paired
predecessor arm and removed at close.

## What was wrong, and what it is now

### The response told every caller to stop searching

`buildInspectFirst` closed **every** response, at every confidence, with a
constant:

```
Avoid first:
- Broad repository grep/find before inspecting the targets above — start from these symbols first.
```

Capsule v2 selects bounded task-relevant evidence and never enumerates a
repository, so nothing in the evidence supported it. It is most harmful exactly
where it is least supported: on a low-confidence lead for a "does this already
exist?" question, where not looking further is how an agent concludes something is
missing and writes a second copy of it.

Measured on the frozen reuse-before-write corpus: **17 of 19 → 0.**

The installed guidance block said the same thing in the repository's own
`AGENTS.md`: *"Use `get_code_context` before manual grep or opening many files."*
Both producers were vtrace's, so both were M154's to fix.

What survives is the one avoid-hint the evidence can carry: a lead that re-raises
is where the failure surfaces, not where it is fixed.

### Nothing said what a miss proves

`get_code_context` is the tool agents call, and it was the one tool that said
nothing about what its result settled. `resolved: false` is a delivery fact; with
completeness unstated it was free to read as absence.

The response now carries, structurally:

```
coverage: { mode: "selective_task_retrieval",
            absenceClaim: "not_observed",
            enumerationComplete: false }
```

`absenceClaim` reuses the existing workspace vocabulary
(`not_observed | bounded_absence | authoritative_absence`) rather than inventing a
parallel scale — ranked retrieval already sat at the bottom of it, since
`CAPABILITY_SETTLES_MEMBER_ABSENCE[RankedRetrieval]` is `false`. Exact symbol and
path lanes keep the stronger reading M147/M149 proved for them, and workspace
`coverageComplete` was not repurposed.

### vtrace state could be committed into the user's PR

`.vtrace/index.sqlite` and `.vtrace/session.sqlite` were untracked and not ignored
— the one state where `git add -A` sweeps them into a commit. Reproduced in a
plain checkout and in a linked worktree.

Where the rule goes was **measured**: in a linked worktree, `$GIT_DIR/info/exclude`
is never read and `$GIT_COMMON_DIR/info/exclude` is. An implementation using the
more obvious `--git-dir` would pass every single-checkout test and do nothing in
precisely the case that motivated the milestone.

### The project's own name was symbol evidence

`deriveQueryIntent` correctly classified `Requests` in *"Does Requests already have
a helper for redirect resolution?"* as a project reference and refused it as an
identifier — then passed it to lexical scoring as an ordinary content word, in the
repository where it also names the package directory. The suppression now reaches
the searchable text.

## Results

### Reuse-before-write safety — 19 cases, 4 repositories

| Metric | predecessor | candidate | target |
| --- | --- | --- | --- |
| Unsupported anti-search advice | **17** | **0** | 0 ✔ |
| False absence implication | 0 | **0** | 0 ✔ |
| False authority | 0 | 0 | reduced/absent ✔ |
| Selective misses | 3 | 3 | *(none serialized as absence)* |
| Coverage state stated | none | every response | — |
| Mean response bytes | 50,867 | 51,213 (+0.68%) | bounded ✔ |

The three selective misses are the central case: an implementation exists,
bounded retrieval did not deliver it, and the response says
`absenceClaim: not_observed`, `enumerationComplete: false`. That is correct
selective behaviour, now visibly correct.

### Project-name poisoning — 12 cases, 4 repositories

| Metric | predecessor | candidate |
| --- | --- | --- |
| Paired regressions | 0 | 0 |
| Explicit same-name identifier controls preserved | 4/4 | 4/4 |
| Named lead is expected evidence | 7/12 | 8/12 |
| Named expected evidence delivered | 11/12 | 10/12 |

Two leads moved, both attributed to the change: `pytest-make-numbered-dir`
improves (the lead becomes the definition the question asks for);
`requests-resolve-redirects` regresses (the expected symbol leaves the delivered
set; neither lead was correct on either side).

### Deterministic suites

| Suite | Cases | Changed |
| --- | --- | --- |
| django | 20 | **0** |
| cross_repo_30 | 30 | **0** |
| **Frozen total** | **50** | **0** |

`provenanceValid: true`, `srcDirty: false`, both suites authoritative,
`sessionIsolationValid: true`. These fixtures are rooted at SWE-bench instance
directories, so the project-name precondition cannot fire — zero movement is
evidence the change stayed inside its own precondition, which is what makes it
meaningful rather than merely structural.

### Verification

```
bun run typecheck              clean
bun run typecheck:benchmarks   clean
bun test                       4698 pass · 49 skip · 0 fail
git diff --check               clean
```

Three tests asserted the old contract verbatim and were updated to assert the new
one **plus** a regression guard against the advice returning. A fourth new test
pins behavioural routing default-**OFF**, since rewriting descriptions and guidance
is exactly the change that can flip a default by accident.

## Honest limitations

- **The ARC observation is not explained.** The mechanism found and fixed is real
  and generic, but it does not reproduce ARC's outcome-level harm on non-ARC
  repositories. Something else may have contributed there, or the effect may be
  specific to that corpus. ARC was not run as diagnostic preservation.
- **C's corpus effect is one win, one loss.** No net measured retrieval gain.
- **The reuse corpus is 19 cases over 4 repositories.** Enough to establish the
  hard targets and to catch the constant-advice defect; not enough to estimate
  false-authority rates in general.
- **False authority was 0 on both sides**, so the metric is proven computable and
  its reduction is unproven — nothing in the corpus produced a wrong actionable
  lead where stronger evidence existed.
- **`coverage` is verified by contract and schema, not by the corpus runner.** The
  evaluator measures the capsule layer, where the field does not live; its presence
  on the product response is pinned by the typed contract, the MCP `required`
  schema, and `searchContract.test.ts`.
- **Model prose is out of scope** (§52). If a model overstates a truthful vtrace
  response, that belongs to M155.

## Recommended M155 scope

Proceed to **Broad SWE-bench Regression and Agent-Utility Qualification**, not from
inside M154. Freeze current retrieval/product behaviour first.

M155 should answer whether vtrace helps on unfamiliar tasks *and* whether it causes
unique agent failures through false authority — the second question is now
measurable, because the product states what its answers settle. Carry the
false-authority and false-absence metrics forward against live transcripts, where
the interesting question moves from "does vtrace claim too much?" to "does the
model infer too much from a truthful claim?"

`search_symbols` remains deliberately unbuilt (§16, §115). M154's job was to make
`get_code_context` honestly selective so that a separate deterministic enumeration
tool has a coherent contract to sit beside.
