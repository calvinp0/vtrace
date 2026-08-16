# M153-A — M152 baselines on the non-ARC corpus

Measured against `72ce221c` (M152 final functional) before any M153
implementation. Artifacts: `stage5_m153_m152_oracle_baseline.json`,
`stage5_m153_m152_workspace_baseline.json`.

Denominators: 30 scored cases (35 minus 3 explicit-absence controls, which are
scored separately, and 2 ambiguous cases, which belong to no repository).
Repository accuracy uses the 33 repository-bound cases.

## The two baselines

| Metric | Oracle | Workspace |
| --- | ---: | ---: |
| correct repository Top-1 | 100% *(forced)* | **18.2%** |
| correct implementation Top-1 | **3.3%** | 3.3% |
| correct implementation Top-3 | 3.3% | 3.3% |
| required support present | 56.7% | 56.7% |
| clean answer rate | **0%** | 0% |
| cases with misleading evidence | 13.3% | 6.7% |
| empty context | 0% | 3.3% |
| explicit absence held | **100%** | 100% |
| false-premise mechanism reconstructed | **0%** | 0% |
| abstentions | 0 | 0 |

Per split, correct implementation Top-1: calibration 5.3%, holdout 0%.

## What the workspace number actually measures

18.2% is not a routing capability. The workspace's configured default is
`requests`, and `requests` owns 6 of the 33 repository-bound cases — 6/33 = 18.2%
exactly. **Every** workspace-mode request was answered by the configured default;
none was routed by evidence. That is the M151 behaviour working as designed and
documented, and it is the gap M153-C exists to close.

## The headline finding: the behavioural chain rarely activates off ARC

Running each corpus query through `deriveQueryIntent` →
`deriveBehavioralObjective`:

> **Only 15 of 35 queries derive a behavioural operation at all.** The remaining
> 20 return `operation: null, suppressedBy: "no behavioural operation cue"`.

When no operation is derived, mechanism facts, subject alignment,
operation-fact candidate generation and answer-role delivery never run. The
request falls through to ordinary lexical retrieval — which is exactly what the
failures look like:

| Case | Delivered lead | Why it was chosen |
| --- | --- | --- |
| `ap_format_identification` | `astropy/time/formats.py::to_value` | the word *format* matched a file about time formats |
| `sp_parser_selection` | `sphinx/cmd/build.py::get_parser` | the word *parser* matched the command-line argument parser |
| `pl_reporter_selection` | `pylint/config/arguments_manager.py::_parse_command_line_configuration` | the words *command line* matched, *reporter* did not |
| `xr_backend_selection` | `xarray/backends/api.py::open_dataset` | the consumer of the decision, not the decision |
| `fl_error_handler_dispatch` | `src/flask/scaffold.py::register_error_handler` | the registration site, not the dispatch |

The last two are informative in a different way: both delivered a genuinely
related definition and still got the *role* wrong — consumer instead of
implementer, registration instead of dispatch. Those are the discriminations M150
built. They did not fire because the operation was never derived.

### The cue vocabulary is the narrow part, not the machinery

The clearest illustration is a near-minimal pair. M150's own fixture query

> "How does the system decide which backend **wins**?"

derives `selection`. The corpus query

> "How is it decided which backend **opens a given file**?"

derives nothing — same operation, same subject, ordinary paraphrase.

This is precisely the shape of overfitting M153 was built to detect: the
machinery generalises where it fires, and its *activation cue* was developed
against ARC and the M150 fixtures, so it does not cover how the same question is
asked elsewhere. It is a **generic defect proven by a non-ARC corpus**, which is
the only kind of evidence the M153 development policy accepts.

## Consequence for M153-C, stated in advance

The behavioural routing lane draws its evidence from the same mechanism
machinery. Where no operation is derived, the lane will have nothing to compare
and must correctly decline to decide. **The reachable ceiling for behavioural
routing on this corpus is therefore bounded by the 15/35 activation rate**, not
by the routing rule.

This is recorded before implementing, so the resulting numbers are read against a
predicted ceiling rather than explained afterwards.

## What is NOT concluded here

Per §28, poor oracle performance is classified, not immediately repaired. The
operation-cue lexicon is *retrieval*, and M153's deliverable is *routing* (§68).
Widening it is a real, corpus-justified opportunity and is recorded as the
leading candidate for the next milestone rather than absorbed into this one.

Two results are genuinely good and must be preserved:

- **Explicit absence held at 100%.** All three identifier controls
  (`rank_adapters`, `rank_fixtures`, `score_backends`) correctly returned no
  fabricated match, including the hard `score_backends` case where the real
  `sort_backends` sits one token away.
- **No forced routes and no empty oracle contexts.** M152 never invented a
  repository it had no evidence for.

## Errors

Two oracle-mode cases returned `ok=false`; both are the ambiguous cases, which
have no oracle repository by construction and are excluded from every aggregate.
