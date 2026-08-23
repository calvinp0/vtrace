# M174 — Post-Orientation Work Displacement and Implementation-Cost Attribution

```text
M174 overall:  MIXED

A: PASS    empty-delivery fallback repaired, 3/3 identity controls, 18 new tests
B: PASS    12/12 pairs reconstructed, 0 problems, full untruncated evidence
C: PASS    displacement measured, 4/4 classifier controls, WORK_DISPLACEMENT 0/12
D: PASS    tail selected mechanically, both cases fully reconstructed
E: PASS    premium reconciled to $0.0003 residual on $2.2011
F: PASS    verdicts reached

economic mechanism verdict:   STOCHASTIC_TAIL_DOMINANT
orientation economics verdict: COMPACT_ORIENTATION_ECONOMICALLY_NEUTRAL
product verdict:              KEEP_COMPACT_ORIENTATION_UNCHANGED
live follow-up verdict:       LIVE_WORK_NOT_LICENSED

product changed:   YES — empty-fallback correctness only
retrieval changed: NO
live spend:        $0.00
```

M173 asked whether the compact orientation was worth its price and answered
"it costs almost exactly what it displaces, and the solve set does not move".
M174 asked where the residual whole-run premium goes. It goes to two runs, for
two different reasons, and neither reason is the orientation.

---

## 1. The premium, reconciled

Eleven uncensored pairs. `pylint-4551` is `COST_CENSORED` in M173's ledger and is
excluded from every economic figure, exactly as M173 excluded it.

| Metric | Baseline | Compact VTRACE | Paired delta |
|---|---:|---:|---:|
| orientation call | $0.0000 | $1.0268 | +$1.0268 |
| pre-edit investigation | $2.4791 | $1.4213 | −$1.0578 |
| **pre-edit *including* the orientation call** | **$2.4791** | **$2.4481** | **−$0.0309** |
| implementation | $1.3091 | $2.0544 | +$0.7455 |
| verification / test / debug | $1.7995 | $3.2862 | +$1.4868 |
| **total** | **$5.5876** | **$7.7888** | **+$2.2011** |
| requests to first meaningful edit (median) | 2 | 3 | +1 |
| rework edits (same file, beyond the first) | 6 | 3 | −3 |

```text
Δ pre-edit incl. orientation   -0.0309
Δ implementation               +0.7455
Δ verification                 +1.4868
                               --------
sum                            +2.2014
provider whole-run delta       +2.2011
residual                       +0.0003
```

The reconciliation closes. That matters more than it looks: the phase model
prices the input side exactly and apportions whole-run output by authored
characters, and it lands within three hundredths of a cent of the provider's own
totals across eleven pairs. There is no unattributed remainder to hide a
mechanism in.

**The first line is the correction M174 contributes to M173's arithmetic.**
Measured against `PHASE_1` alone, the treatment's pre-edit investigation is
$1.06 cheaper and looks like a large saving. But the treatment's orientation call
is its *own first request*, and in the baseline that request is pre-edit
investigation. Counting it where it belongs, pre-edit is **flat: −$0.0309 across
eleven pairs.** The orientation costs what it saves. That is M173's break-even,
now visible at phase level rather than inferred from an attributable-cost ratio.

Everything else — the entire +$2.20 — is after the first edit.

## 2. The post-edit premium is two runs

```text
post-edit premium, all 11 pairs      +$2.2323
post-edit premium, the two tail runs +$2.1365   95.7%
post-edit premium, the other nine    +$0.0958   $0.0106 per pair
```

Tail selected mechanically (§39) as the top two positive whole-run deltas, before
any trace was read: `xarray-6599` (+$0.7301) and `astropy-14369` (+$0.7146).

```text
share of total positive premium   top 1  31.8%   top 2  62.8%   top 3  84.3%
without the tail                  median +$0.0292   mean +$0.0840   n=9
```

Nine of eleven pairs carry a post-edit premium of **$0.0106 each** — the same
order as the orientation packet itself, and below the noise floor of single live
runs. The economics are not systemic. They are a tail.

## 3. Did the work move, or vanish?

This was M174's central question, and it has a clean answer.

```text
strong information units that crossed the edit boundary

  pairs with ZERO displacement          8 / 12
  pairs classified WORK_DISPLACEMENT    0 / 12
```

Displacement is defined against each arm's **own** first meaningful edit (§25):
the baseline knew it before editing, the treatment did not, and the treatment
went and got it afterwards. On eight of twelve pairs not one unit qualifies.
The three pairs with any displacement at all have 2, 4 and 40 units, and the
40-unit case is the censored pair.

So the skipped pre-edit reading does not come back. **The treatment does not
re-acquire after its edit what the baseline acquired before.** H2 is rejected.

Nor does the treatment do materially more repository work of its own. Once
`TREATMENT_ONLY` is split — and it had to be, because §67's uniform-label check
caught it tracking packet size rather than behaviour — genuine extra
agent-acquired information is **zero on seven of twelve pairs**, and 44 of the
remaining units belong to a single pair.

### The premature-edit hypothesis is rejected on three independent measures

§37 asked whether compact orientation makes agents edit sooner and pay for it
later. It does not, and it does not even make them edit sooner:

```text
first meaningful edit, B − A     median +1     earlier 2     later 8     same 1
first-edit survival    A  4 final / 6 partial / 2 superseded
                       B  4 final / 7 partial / 1 superseded
rework edits           A  6        B  3
```

The treatment edits *later* by a request, its first edit survives at the same
rate, and it revises **less**. Whatever the premium is, it is not bought by
premature editing.

## 4. The two tail cases

Both were reconstructed request by request. They do not share a mechanism, which
is itself the finding — a single systematic cause would not produce two.

### xarray-6599 (+$0.7301, implementation +$1.0069) — STOCHASTIC

Both arms wrote semantically the same `to_floatable` repair; the arms' first
edits share 82% of their lines. The treatment edited at request 6 rather than 12
and then spent requests 7–16 unable to run it:

```text
r7   python3 -c "import xarray"      -> ModuleNotFoundError
r10  pip install numpy pandas        -> pip: command not found
r11  uv run --with numpy ...         -> creating virtual environment
r12  uv run --with "numpy<2" ...     -> creating virtual environment
r13  rm -rf .venv && uv run ...      -> creating virtual environment
r14  rm -rf .venv && uv run ...      -> creating virtual environment
r16  rm -rf .venv && uv run ...      -> creating virtual environment
r24  rm -rf /tmp/claude-* /tmp/uv-*  -> reclaiming disk
```

Fourteen requests of interpreter, virtualenv and disk friction; nine environment
rebuilds. The baseline's `pip install -e .` happened to work. This is the same
tmpfs that killed four M173 baseline arms with `ENOSPC`, and requests 24–26 are
the agent clearing `/tmp` to keep going. Nothing about the orientation is
implicated: the packet was ignored on this task, and the repair was correct in
both arms. Both resolved.

### astropy-14369 (+$0.7146, verification +$1.3101) — IMPLEMENTATION DIVERGENCE

The packet's focus was `astropy/units/format/cds.py`, a gold-patch file, and the
treatment edited it at request 3. But the two arms chose **different repairs** —
their first edits share only 38% of their lines:

```text
A   extends the existing rule:  division_of_units DIVISION product_of_units
B   restructures the grammar:   adds a new p_unit_product production
```

A grammar restructure needs more proving than a rule extension, and the
treatment spent requests 15–28 writing `/tmp` reproduction harnesses and reading
`test_format.py` to prove it. Its implementation phase was actually **$0.16
cheaper** than the baseline's; the entire premium is validating a more ambitious
change.

Both arms failed this task, and for the same reason neither cost explains: the
gold patch also edits `cds_parsetab.py`. The baseline edited it and still failed;
the treatment never touched it.

## 5. Was anything omitted from the packet that the agent later needed?

§43's five-condition test ran on every pair. Three produced candidates. None
survives.

| pair | candidate omitted file | why it fails |
|---|---|---|
| astropy-14369 | `astropy/io/ascii/cds.py` | 2 units against a $1.31 verification premium driven by grammar validation and 12 friction requests. Condition 5 fails: including it prevents nothing. |
| requests-1724 | `requests/models.py`, `requests/utils.py` | **The packet's focus, `requests/sessions.py`, is the gold file.** The baseline edited `models.py` — the wrong file — and failed. Adding `models.py` to the packet would have endorsed the wrong direction. |
| pylint-4551 | `tests/data/clientmodule_test.py` | the censored pair; and the treatment was $1.57 *cheaper*. |

`COMPACT_ORIENTATION_OMISSION_CAUSAL` is **not established anywhere in this
corpus.** The packet named a patched file on 10 of 12 pairs and the agent edited
that focus on 10 of 12.

## 6. Per-task evidence

`pkt used` = the first meaningful edit landed on the packet's focus file.
`elim`/`displ`/`B-only` are strong information units.

| task | pkt used | first edit A/B | A pre-edit | pkt units | elim | displ | B-only | survived | rework | A/B | mechanism |
|---|---|---|---|---|---|---|---|---|---|---|---|
| astropy-14369 | yes | 6/3 | 80 | 36 | 78 | 2 | 4 | partial | 0 | N/N | divergence |
| django-13658 | yes | 2/3 | 40 | 29 | 33 | 0 | 0 | final | 0 | Y/Y | stochastic |
| matplotlib-22719 | yes | 1/2 | 40 | 23 | 0 | 0 | 0 | partial | 0 | Y/Y | stochastic |
| seaborn-3187 | yes | 8/12 | 8 | 26 | 5 | 0 | 9 | partial | 0 | N/N | elimination |
| flask-5014 | yes | 2/3 | 40 | 31 | 29 | 0 | 0 | partial | 0 | Y/Y | elimination |
| requests-1724 | yes | 4/4 | 4 | 37 | 0 | 4 | 44 | final | 1 | N/N | divergence |
| xarray-6599 | no | 12/6 | 5 | 26 | 3 | 0 | 0 | partial | 1 | Y/Y | stochastic |
| pylint-4551 | no | 17/14 | 242 | 24 | 76 | 80 | 0 | final | 1 | N/N | not measurable |
| pytest-7432 | yes | 1/2 | 40 | 23 | 0 | 0 | 0 | superseded | 0 | Y/Y | stochastic |
| sklearn-10844 | yes | 2/3 | 0 | 29 | 0 | 0 | 1 | final | 0 | Y/Y | stochastic |
| sphinx-7462 | yes | 1/2 | 2 | 26 | 0 | 0 | 0 | partial | 1 | N/N | stochastic |
| sympy-13480 | yes | 1/2 | 2 | 31 | 0 | 0 | 2 | partial | 0 | Y/Y | stochastic |

```text
mechanism tally   STOCHASTIC 7   DIVERGENCE 2   ELIMINATION 2   NOT_MEASURABLE 1
§67 uniform-label check                          4 distinct labels — PASS
```

## 7. M174-A — the empty-delivery repair

M173 reported the fallback as an *empty delivery*. It is not. Traced against the
live product, the declining guard is `productContext.resolved !== true`, and the
authoritative record reads:

```text
resolved                false
retrievalFound          true
deliveryFailed          true
resultState             delivery_failure
selectedItemsBeforeBudget  10
deliveredItems             0
droppedForBudget          10
```

Retrieval **succeeded** — ten items and a correct lead pivot — and the response
envelope then evicted all ten. The cause is measurable and self-inflicted:

```text
request.query + request.task    21,412 chars   81.6% of the response
                                (the agent's own 10,611-char question, twice)

estimated_metadata_tokens        6,435
evidence needed                  3,731
                                ------
                                10,166  >  9,200  total_response_token_ceiling
```

The envelope preserved the echo and dropped the evidence, then told the agent to
"increase max_tokens". The old fallback shipped all **26,227 characters / 8,229
model-visible tokens** to deliver one 186-character sentence.

The repair adds `src/runPipeline/orientationDecline.ts`: a decline projector that
compacts only states it can positively identify, distinguishes the four states
§9 requires, quotes the product's own remedy verbatim, and carries a boundary
line on every decline so an absent focus is never read as absent code. Unknown
shapes keep the full authoritative envelope — compaction is earned by
identification, never assumed.

```text
NON_EMPTY_COMPACT_UNCHANGED              PASS   sha ba04af89faf3d3e4 == ba04af89faf3d3e4
EMPTY_DELIVERY_IS_COMPACT_AND_TRUTHFUL   PASS   8,229 -> 143 tokens   57.5x
DEBUG_STILL_AUTHORITATIVE                PASS   36,734 chars, productContext intact
repo_not_ready negative control          PASS   ok:false, isError:true, never reaches the decline
```

The "before" side is a capture taken from the shipped product *before* the
repair, so this is an A/B against the old binary's own bytes.

**Permanent invariant, now enforced:** a valid empty compact orientation must
remain compact and truthful; it must never expose the full authoritative internal
payload merely because no focus was selected.

### What M174-A deliberately did NOT fix

The eviction itself — an envelope that spends 6,435 tokens echoing the request
and then reports that the evidence would not fit — is the *cause* of the empty
delivery, and fixing it would change what evidence agents receive. That is beyond
the one licensed product change (§70) and it is recorded here as the finding it
is, not acted on.

## 8. The answers

**Did compact orientation save repository-understanding work, or move it?**
Neither, mostly. It does not move it: zero strong units cross the edit boundary
on 8 of 12 pairs, and no pair classifies as displacement. It does not save much
either: pre-edit cost including the orientation call is flat at −$0.0309 across
eleven pairs. The orientation substitutes for the work it replaces at
approximately its own price — which is M173's finding, now shown at the level of
what was actually learned rather than what was billed.

**Is there a repeatable defect in the compact orientation contract that causes
downstream cost?** No. The packet named a patched file on 10/12, was edited on
10/12, produced zero displacement, zero surviving omission candidates, no
premature editing, less rework than the baseline, and a post-edit premium of
$0.0106 per pair once two runs are set aside. The one real defect found was in
the *decline* path, not the orientation, and it is fixed.

**Is automatic first orientation still a viable direct-VEXP-competitor
architecture?** On this evidence, yes on cost and unproven on benefit. The
payload objection M169 raised is gone — $0.01 a task, consumed, correct, and
break-even against the investigation it displaces. What has not been shown is a
*benefit*: the same seven tasks resolve either way, and M174 finds no mechanism
by which the packet either helps or hurts downstream. The architecture is no
longer disqualified by its price. It is now waiting on evidence that being
oriented changes an outcome, and three consecutive milestones have not produced
one.

## 9. Next step

Not another orientation redesign, and not retrieval — M173 found wrong pivots
non-causal and M174 finds correct pivots non-causal too. The honest reading is
that **twelve pairs cannot resolve a $0.0106-per-pair effect**, and the two runs
that dominate the totals were decided by a virtualenv and a grammar preference.

If the economic question is worth closing, it needs replication at a sample size
where a tail cannot carry 95.7% of the signal, on infrastructure where an agent
does not spend fourteen requests looking for `pip`. That is a harness problem
before it is a product problem, and the environment friction measured here
(9 rebuilds in one run) is the first thing to fix.

`LIVE_WORK_NOT_LICENSED` — report and wait.

---

```text
provenance
  M174 head at start   e0252fac1fc9d590ba1b807ae3a536e35286384b
  M173 functional      edd52104850ed77d760d4a730c2d037f8486d2f7
  M173 ledger          e0252fac1fc9d590ba1b807ae3a536e35286384b
  corpus               24 runs / 12 pairs / 11 uncensored
  accounting           m169Economics, imported unchanged, dedup on message.id
  evidence             raw agent streams, NOT the 8192-truncated tool-call file
  live spend           $0.00

verification
  bun run typecheck              pass
  bun run typecheck:benchmarks   pass
  bun test                       5482 pass / 49 skip / 0 fail
  git diff --check               clean
```
