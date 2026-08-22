# Stage 5 — M168-E live results: the three-arm VTRACE policy ablation

```text
runs            36/36 complete, 36/36 graded
spend           $24.8734 against a $60 authorised cap
parity          36/36 — the discipline block absent from every arm
guard           5 guarded · 7 unexercised · 0 degraded · 0 fault
product change  NONE — VTRACE frozen at de7bfe48 for the whole window
```

## Headline

```text
A  BASELINE        7/12 resolved
C  VTRACE_CLEAN    8/12 resolved      mandate only
B  VTRACE_STRICT   6/12 resolved      mandate + prohibition + Grep|Glob hook
```

**The coercive policy is strictly dominated.** Against the clean arm it won zero
tasks, lost two, and cost slightly more. Against the no-VTRACE baseline it is
also net negative. The mandate alone is the only arm that beats baseline, and
only by one task.

## Pairwise outcomes, 12 paired tasks each

| comparison | both | left only | right only | neither |
|---|---:|---:|---:|---:|
| B strict vs C clean | 6 | **0** | **2** | 4 |
| C clean vs A baseline | 5 | 3 | 2 | 2 |
| B strict vs A baseline | 5 | 1 | 2 | 4 |

## The decomposition that carries the finding

The hook is conditional: it denies only when the engine's index exists, and it
is only ever *invoked* when the agent reaches for `Grep` or `Glob`. Splitting
the twelve tasks by whether it actually denied anything separates a policy that
bound from a policy that merely sat there.

**Tasks where the guard denied a real search attempt (n=5):**

| task | denials | A | C | B |
|---|---:|:-:|:-:|:-:|
| astropy-14369 | 2 | ✅ | ❌ | ❌ |
| seaborn-3187 | 3 | ❌ | ✅ | ❌ |
| requests-1724 | 1 | ❌ | ✅ | ❌ |
| xarray-6599 | 2 | ✅ | ❌ | ❌ |
| pylint-4551 | 1 | ❌ | ❌ | ❌ |
| **resolved** | | **2/5** | **2/5** | **0/5** |

**Tasks where the agent never attempted a search (n=7):**

```text
A 5/7    C 6/7    B 6/7
```

**Where the coercion bound, it went 0 for 5. Where it never bound, it matched
the clean arm exactly.** Every one of B's deficit tasks is a task where the hook
fired. The policy is inert when unnecessary and harmful when it operates.

## What the blocked agent did instead

Both tasks C won and B lost show the same shape: denial did not remove the
investigation, it displaced it into the channels the hook does not cover.

```text
seaborn-3187    C: 5 searches,  6 bash, 12 reads, 66 turns, $1.235  RESOLVED
                B: 3 searches, 15 bash, 15 reads, 87 turns, $1.488  failed
                   (3 denials)

requests-1724   C: 3 searches,  0 bash,  4 reads, 27 turns, $0.450  RESOLVED
                B: 1 search,    0 bash,  5 reads, 23 turns, $0.466  failed
                   (1 denial)
```

On seaborn the blocked agent did **2.5× the Bash work, 25% more reads and 32%
more turns than the arm that was allowed to search — and still failed.** This is
the stated-versus-enforced gap M168-A recorded, now measured: the published
policy forbids grep, glob, Bash, Read and cat in prose, and enforces only Grep
and Glob. The agent obeyed the wall it could feel and walked around it.

## Economics

Paired medians over 12 tasks (left − right):

| metric | B − C | C − A | B − A |
|---|---:|---:|---:|
| billed cost | −$0.014 (6–6) | **+$0.134** (10/12 higher) | **+$0.095** (10/12 higher) |
| total traffic | −86k (7–5) | +225k (10/12) | +84k (9/12) |
| cache creation | +6.8k (4–8) | +20.8k (11/12) | +24.4k (11/12) |
| turns | −2 (7–4–1) | +3 (8/12) | +1 (7/12) |
| search attempts | **0** (5 lower, 0 higher, 7 tied) | **−1** (7 lower, 2 higher) | **−1** (8 lower, 0 higher) |
| pipeline calls | 0 (10 tied) | +1 (**12/12**) | +1 (**12/12**) |

Per-arm totals: baseline $7.9143, clean $8.6639, strict $8.2951.

Three things fall out:

1. **The mandate does the search reduction; the hook does not.** B is never
   higher than C on searches, but 7 of 12 pairs are ties — mostly both at zero,
   because the clean arm already stopped searching without being forbidden.
   Against baseline, both VTRACE arms cut searching (B lower on 8/12 and higher
   on none).

2. **Reduced searching did not reduce cost.** Both VTRACE arms cost *more* than
   baseline on 10 of 12 tasks. The delivered context is more expensive than the
   searching it displaces — a ~$0.13 median premium for the clean arm.

3. **Mandate compliance was total.** `run_pipeline` was the first action on
   12/12 runs in both treatment arms. Nothing here is an adoption failure.

## Censoring, disclosed

Exactly one run hit the $3 per-task cost limit: **baseline / pylint-4551 at
$3.0384**, killed mid-work. No run hit the 250-turn limit. That single censored
value inflates the baseline's mean ($0.6595) relative to its median ($0.3034),
which is why every comparison above is a paired median. On that task both VTRACE
arms finished inside budget ($1.399 and $1.254) and all three failed the grader.

## Controls

```text
prompt parity            36/36 — no arm carried the harness's anti-search block
                         signals: runner flag, adapter injection log (known
                         positive: it fired on the discarded pre-fix run),
                         policy-file bytes vs frozen arm text, baseline
                         transcript free of mcp__vtrace__ calls
guard telemetry          every hook invocation logged; 0 degraded, 0 fault
first-action compliance  12/12 both treatment arms
grading                  official SWE-bench Docker, identical for all arms,
                         evaluationRan=true 36/36
reruns                   1, infrastructure only (driver process killed by the
                         task wrapper, no artifact produced, nothing recounted)
```

`sphinx-7462` failed on all three arms, as a standing Stage 5 finding predicts:
its gold spans a file a python.py-only patch cannot reach. A useful sanity check
that the grader is discriminating rather than rubber-stamping.

## Verdicts

```text
B vs C   VTRACE_STRICT_NEGATIVE
         0 unique wins, 2 unique losses, cost neutral, search reduction
         identical. Strictly dominated.

C vs A   VTRACE_CLEAN_INCONCLUSIVE
         8 vs 7 resolved, 3 unique wins against 2 unique losses, at a
         significant cost premium. +1 task on n=12 is noise.

B vs A   VTRACE_STRICT_NEGATIVE
         6 vs 7 resolved, more expensive.

causal attribution   AGENT_POLICY_GAP — confirmed as a behavioural mechanism,
                     REFUTED as an economic or outcome benefit
```

The policy VEXP publishes does change agent behaviour, reliably and in the
direction it intends. It does not convert that change into cheaper runs or more
resolutions. On this sample it converts it into losses, concentrated entirely in
the tasks where it actually bound.
