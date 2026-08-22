# M170 — Transparent Agent Workflow Integration and Automatic Reduction Qualification

**Overall: MIXED. Offline audit; $0.00 live spend; `src/` byte-identical
throughout — no product change was made and none is licensed.**

```text
A   PASS        normal-agent investigation surface reconstructed and priced
B   PASS        one zero-cost seam found; no new capability required
C   PASS        counterfactual replayed; the frozen gate decided against the design
D   NOT RUN     C did not license it
E   PASS        200 fresh-index cases confirm C at scale, on both corpora

automatic integration verdict   TRANSPARENT_MEDIATION_NOT_ECONOMIC
product changed                 NO
selected mediation              NONE
live extension                  NOT AUTHORIZED, NOT REQUESTED
```

M170 asked whether VTRACE can sit *underneath* an agent's ordinary repository
investigation and make it cheaper without a separate model-visible call. The
answer has two halves and they point in opposite directions.

**The architecture works.** There is a supported seam that costs zero model
tokens whether it fires or not, requires no extra agent decision, adds no schema,
and fails open by the harness's own rule. That is the first thing in M162–M170
with no fixed tax at all.

**The opportunity does not.** Everything that seam could reach is worth about
5.9% of a run, the best future-reading selector recovers 4.8%, and the best
implementable one recovers 1.3% while removing the fix site from view on two of
every three files it touches.

---

## A — what a normal agent actually does

Twelve M168 baseline runs: no VTRACE tools, no VTRACE policy, no VTRACE context.
Traces reconstructed from the raw stream and paired by `tool_use_id`.

```text
operations                      145
investigation operations         99
investigation characters    219,566
investigation cost           $1.063   (median $0.052 / task)
```

Investigation is **12.5% of whole-run cost** across the eleven uncensored runs —
$0.611 of $4.876. That number is the ceiling on everything M170 could ever do,
and it was worth establishing before designing anything.

Inside it, the traffic is extraordinarily concentrated:

```text
intent               n   characters   share
WHOLE_FILE_READ     10      113,622   51.8%
REGION_READ         36       56,250   25.6%
PATTERN_ENUMERATE   25       32,092   14.6%
SYMBOL_LOCATE       11       11,891    5.4%
SHELL_INSPECT       12        5,261    2.4%
PATH_DISCOVER        5          450    0.2%
```

**Ten operations carry half the investigation.** The single largest is 12.2% of
it on its own; the top five are 37.5%. Everything else is small change: the
median `SYMBOL_LOCATE` returns about a thousand characters, and the first action
on five of the twelve tasks is a grep for a name the issue text already gave,
which returns one file for about fifty characters. There is nothing for VTRACE
to beat there.

Three facts about the corpus that had to be established before it could be used:

- **The captured tool-call artifact truncates at 8,192 characters.** Read from
  `_tool_calls_with_outputs.json`, django-13658's one Read is 8,192 characters;
  read from the stream it is 18,551. Every figure above comes from the stream.
- **The harness's own partial-view banner fired zero times.** Not one of the ten
  whole-file reads hit Read's token cap, so in every case the agent received the
  entire file and the harness never had cause to say the view was partial.
- **The agent already narrows its own searches.** Thirty of thirty-six baseline
  Greps (83%) were scoped by `path` or `glob`, and four carried an explicit
  `head_limit`. The search-mediation family would be re-narrowing an
  already-narrowed search.

## B — the seam, and the asymmetry that decides everything

Five integration classes were audited against the shipped Claude Code
executable's own strings rather than its documentation. All eight probes present.

```text
S1  PreToolUse updatedInput          0 tokens firing, 0 declining, fails open   ELIGIBLE
S2  PreToolUse deny                  coercion                                   FORBIDDEN §17
S3  PostToolUse additionalContext    adds by construction                       DISCLOSURE ONLY
S4  MCP tool                         5,521-token schema on every task           FORBIDDEN §12
S5  ripgrep substitution on PATH     impersonates a shared binary               REJECTED §16
```

S1 is the seam: the hook rewrites the parameters of the operation the agent
already chose, the native tool runs, and the model never learns anything
happened. The harness validates the rewritten input against the tool's own
schema and, on an absent or empty rewrite, *falls back to the agent's own input*
— fail-open is not something M170 would have had to build.

No new capability is required to drive it. Read narrowing needs exactly two
producers, both already pure functions over the index database: `hybridRetrieve`
to rank and `listSymbolsForFile` to resolve spans. One producer was mis-shelved
until measured — `searchSymbols` handed 2,597 characters of issue prose returns
**zero** results, because it is a name lookup and not a prose ranker.

Then the asymmetry, read out of the harness binary:

- **Grep declares its own bound.** Its result mapper appends
  `[Showing results with pagination = limit: N]` whenever a limit was applied.
- **Read does not.** Its `[Truncated: PARTIAL view — …]` banner is emitted only
  when `(offset ?? 1) <= 1 && limit === undefined` — a whole-file read over the
  token cap. Supplying a limit takes the read off that path entirely: no banner,
  and `truncatedByTokenCap` is never set.

So narrowing a Grep leaves the bound legible in the tool's own words, and
narrowing a Read removes the only sentence that would have told the agent its
view was partial. Read narrowing is `SEMANTICALLY_UNSAFE_REPLACEMENT` as it
stands, and is restorable to `SAFE_NARROWING` only by adding a disclosure back —
which every mediated result in M170-C therefore carries and pays for.

## C — the counterfactual, on operations that really happened

Ten whole-file reads replayed against the real trees at the real base commits
with real indexes. All ten reproduce the agent's own result from the workspace,
so the ground truth is the file the agent actually saw.

```text
policy                  fired  op-local reduction  whole-run  verdicts
P1_TOP_SYMBOL             3/10        78.1%          2.16%    1 safe 1 recoverable 1 UNSAFE
P4_TOP_SYMBOL_SCOPE       3/10        46.8%          1.31%    2 safe 1 recoverable 0 unsafe
P2_COVER_TOP_K            1/10        40.0%          0.33%    1 recoverable
P3_COVER_ALL_RANKED       0/10           —              —     never fires
PX_ORACLE (upper bound)   6/10        79.8%          4.81%    5 safe 1 recoverable
```

The `PX_ORACLE` row reads the future — it centres the window on what the agent
went on to use — and it exists to separate a bad selector from a bad seam.
**It bounds whole-run saving at 4.81%.** Nothing built on this seam can beat that
on this population, however good its ranking becomes.

The unsafe case is worth naming because it is not a retrieval failure.
django-13658's issue text quotes `ManagementUtility.__init__` verbatim; VTRACE
correctly ranks `__init__` first; the fix is in `execute`, 150 lines away in the
same class. Retrieval identified the symbol the *issue* names. The window policy
then converted "the symbol the issue names" into "the only lines the agent may
see", and that conversion is where a truthfulness cost became a correctness one.
`P4_TOP_SYMBOL_SCOPE` — widen to the declaring scope — is the smallest repair,
and it is why P4 rather than P1 is the candidate carried to the gate.

Five of the ten reads had **no ranked in-file candidate at all**, including
astropy-14369's gold file and every file pylint-4551 read. There the mediation
declines, which is correct and free, and delivers nothing.

## E — the same selection at scale, on fresh indexes

200 cases, Broad100-A (the exact public VEXP manifest, re-materialised by M169)
and Broad100-B (the disjoint holdout). Derivation gated fail-closed: **0 of 200
invalid**. The operation here is simulated and the ground truth is the gold
patch, so this is a different measure from C's and is never averaged with it.

```text
                        Broad100-A                     Broad100-B
policy              fire   reduce  gold-complete   fire   reduce  gold-complete
P1_TOP_SYMBOL        65%    93.5%      31.1%        69%    91.1%      33.8%
P4_TOP_SYMBOL_SCOPE  52%    79.1%      30.6%        61%    82.5%      33.3%
P2_COVER_TOP_K       46%    67.2%      59.4%        47%    66.0%      52.2%
P3_COVER_ALL_RANKED  22%    58.8%      73.3%        34%    56.2%      48.5%
```

The two columns move against each other on both corpora and the trade is
monotone. Fire more and cut deeper, and the window stops containing the fix;
widen until it contains the fix, and it fires on a fifth of files and delivers
most of each one. There is no rung where both are acceptable.

The mechanism is structural rather than a tuning failure. **Roughly half of
gold-edited files are edited in more than one place** — 35 of 72 in A, 49 of 103
in B — with a median spread of 139 and 94 lines and a p90 of 532 and 989. Read's
schema admits exactly one contiguous window. A fix that touches an import block
at line 4 and a method at line 528 cannot be served by one window that is also
smaller than the file. That is the shape of the seam, not a parameter.

Counting only what actually worked — fired *and* contained the complete fix site
— the best policy manages **27.5% of eligible files on A and 24.5% on B**.

## The gate

Frozen in `stage5_m170_plan.md` before any window was computed.

```text
G1  operation-local reduction >= 20%      PASS   46.8%
G2  evidence preservation     >= 95%      FAIL   66.7% observed, 30.6% A, 33.3% B
G3  unsafe mediations          == 0       PASS   0
G4  whole-run projection      reported    1.31%, against a 4.81% oracle ceiling
G5  fixed non-fire overhead    == 0 tok   PASS   0
```

G2 fails on all three corpora, by roughly a factor of two at best. D is not run.

## Standing findings

- **The seam is real, and it is the first architecture here with no fixed tax.**
  `PreToolUse.updatedInput` rewrites the parameters of an operation the agent
  already chose; the native tool runs and returns a native result; the model
  makes no extra decision, reads no extra schema, and cannot tell. Enabled and
  never firing, it costs exactly zero model tokens — against the $0.0985 per task
  the mandatory pipeline charged before improving anything. Whatever else M170
  concluded, this is where a future automatic optimization would attach.

- **The whole opportunity is 12.5% of a run, and the reachable part is 5.9%.**
  Investigation is $0.611 of $4.876 across eleven uncensored runs; whole-file
  reads are $0.290 of it. §28 was the right rule to have frozen in advance: the
  operation-local numbers here are large — 47% to 94% — and they are large
  fractions of something small. An oracle that reads the future saves 4.81% of a
  run. That is the honest ceiling and it was reached before any policy was tuned.

- **Read's schema is the binding constraint, not VTRACE's ranking.** One window,
  contiguous, per call. About half of real fixes touch a file in two or more
  places with a p90 spread of 532 to 989 lines. The reduction/containment trade
  is monotone across four policies and two independent corpora, and it has no
  acceptable rung: 94% reduction buys 31% containment, and 73% containment costs
  a 22% fire rate. Improving retrieval moves a case between rungs; it does not
  create one.

- **Narrowing a Read silently removes the harness's own honesty.** The
  `[Truncated: PARTIAL view — …]` banner is gated on the read being a whole-file
  read over the token cap; supplying `offset`/`limit` suppresses both the banner
  and `truncatedByTokenCap`. A mediation that bounds a Read therefore has to
  re-state, in the tool's own words, the thing the tool would have said for free.
  Grep's contract is the opposite — it declares its own pagination — which is why
  the safe family and the valuable family are not the same family.

- **The agent is not issuing the naive searches the product assumed.** 83% of
  baseline Greps were already scoped by `path` or `glob` and 11% carried an
  explicit `head_limit`. The narrowing a search mediation would apply is one the
  agent is already applying to itself. This is the same shape as M169's finding
  that a skipped search is not a saved search, arriving from the other direction.

- **A producer was mis-shelved until it was measured.** `searchSymbols` returns
  zero results for 2,597 characters of issue prose — it matches names, not prose.
  Any mediation built on it would have declined on every real task and reported
  itself as safely fail-open while doing nothing at all. The map in
  `stage5_m170_seams_and_producers.json` records what each producer answers, and
  every row was verified by importing the module rather than by reading a doc.

- **The two preservation measures are not the same measure and are not averaged.**
  The observed corpus scores ten real operations against what real agents went on
  to use; the simulated corpus scores 200 hypothetical operations against the gold
  patch. The first is right and small; the second is large and answers a different
  question. They agree in direction, which is the only claim made from having both.

- **Next-step recommendation: keep the seam, drop the mediation, and change the
  population before changing the design.** No further work on read narrowing is
  licensed: its ceiling is 4.81% and its safe rung does not exist. Two things
  would change the conclusion, and neither is a better window policy. The first is
  a population where localization is genuinely expensive — this one localizes for
  a median of $0.052 and half the tasks never issue a whole-file read at all. The
  second is a seam that admits more than one contiguous window, which is a change
  to the harness's tool contract and not to VTRACE. Absent either, the honest
  answer to "can VTRACE disappear underneath the normal workflow and make it
  cheaper" is: it can disappear, and there is not enough there to be worth it.
