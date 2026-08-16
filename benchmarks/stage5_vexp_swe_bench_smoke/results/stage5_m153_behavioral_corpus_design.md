# M153-A — behavioural cross-repository corpus: design

Frozen **before** any M153 routing implementation, per §30 and §131.

Source of truth: `benchmarks/stage5_vexp_swe_bench_smoke/behavioralCrossRepoCorpus.ts`.
Serialised to `stage5_m153_behavioral_corpus.json` / `stage5_m153_corpus_split.json`
by `run_stage5_m153_corpus_export.ts`.

## What this corpus is for

M153 exists because of a concern that cannot be answered by inspecting the code:
that VTRACE may be becoming ARC-shaped. Reading the diff for ARC-specific `if`
statements does not settle it, because overfitting of the kind at issue shows up
as *choices* — which discriminators were built, which weights were kept — not as
identifiers. The only thing that settles it is behaviour on repositories that
supplied none of the development pressure.

So the corpus is not a test of "does retrieval work". It is a test of **whether
the capabilities developed while looking at ARC transfer to code nobody was
looking at when they were built.**

## Composition

| Property | Value |
| --- | --- |
| Cases | 35 |
| Repositories | 7 (4 calibration, 3 holdout) |
| Calibration cases | 21 |
| Holdout cases | 12 |
| Ambiguous cases | 2 (counted in neither aggregate) |
| False-premise cases | 9 |
| Explicit-identifier absence controls | 3 |
| Multi-part ground truth | 14 |
| Recorded distractors | 35 |
| Behavioural categories | 12 |

Exceeds the §131 floor of 25 cases and 4 unrelated repositories.

## Repositories and why each was chosen

| Repo | Domain | Split | Behaviour it contributes |
| --- | --- | --- | --- |
| `requests` | HTTP client library | calibration | prefix-ordered adapter selection; setting precedence; encoding fallback |
| `flask` | web framework | calibration | nested error-handler precedence; response type dispatch; env config |
| `pytest` | CLI test runner / plugin host | calibration | fixture applicability, override precedence, scope ordering |
| `sphinx` | documentation compiler / parser host | calibration | suffix→filetype→parser selection; xref fallback cascade |
| `xarray` | scientific array IO | **holdout** | first-success backend selection over an explicitly ordered registry |
| `astropy` | scientific library with unified IO registry | **holdout** | format identification; genuine numeric priority table; MRO-nearest registration |
| `pylint` | CLI static analyser | **holdout** | reporter lookup-then-import fallback; checker activation filter |

All seven are pinned SWE-bench checkouts under
`results/workspaces/cross_repo/<instance>`, recorded with their `base_commit`.
None has driven VTRACE architecture. ARC and TCKDB are deliberately absent
(§74, §75) and are external holdouts only.

Architectural diversity per §12 is covered: web framework, HTTP client, CLI
tooling ×2, parser/compiler host, scientific ×2.

## The split is by repository, not by query (§73)

Holding out random queries from repositories already being tuned against is weak
evidence: the held-out query still benefits from that repository's vocabulary and
structure having been examined. Holding out **whole repositories** means the
holdout measurements come from code that was never opened during calibration.

Frozen split, before implementation:

- **Calibration** — `requests`, `flask`, `pytest`, `sphinx`
- **Non-ARC holdout** — `xarray`, `astropy`, `pylint`
- **External holdouts** — ARC, then TCKDB, run only after the functional
  candidate is frozen

## Ground-truth discipline

Every expected item carries a `sourceSpan` that was read out of the checkout, and
a one-line `why` quoting what the code does. Nothing was inferred from VTRACE
output (§17).

The assertions are mechanically checked: all **81** referenced symbols resolve in
the pinned trees by AST lookup, and every asserted span matches the symbol's
actual `lineno`–`end_lineno`. Nine spans were wrong on first writing and were
corrected against source before freezing — recorded here because a corpus whose
own line numbers were never verified is not ground truth.

`GROUND_TRUTH_FILE_DIGESTS` pins the content of all 14 ground-truth files. A
commit SHA tells you the tree moved; a digest tells you *this mechanism* moved,
which is the drift that actually invalidates a case (§122).

## Multi-part ground truth (§18, §19)

14 of 35 cases are only correctly answered by more than one definition, because
that is what the source does. Forcing them into a single gold symbol would make
the benchmark measure something the code does not contain.

Examples:

- `rq_adapter_selection` — `Session.get_adapter` (first prefix match) **and**
  `Session.mount` (maintains descending prefix-length order). Without `mount`,
  nothing explains why "first" means "longest".
- `fl_error_handler_dispatch` — the precedence loop in `app.py` **and** the key
  normalisation in `scaffold.py`. The mechanism genuinely spans two files.
- `sp_parser_selection` — suffix→filetype in `sphinx/util/__init__.py` **and**
  filetype→parser in `sphinx/registry.py`.

Roles reuse VTRACE's existing vocabulary where it exists (`PRIMARY_IMPLEMENTER` /
`CONSUMER` align with `OperationRole`); the additional producer kinds
(`ORDERING_PREREQUISITE`, `REGISTRATION_SOURCE`, `CONFIG_SOURCE`) name
distinctions M150 already reasons about. No new ontology was invented for the
benchmark (§20).

## False premise and the phrasing pair (§15, §16, §86)

Nine cases presuppose an abstraction that does not exist. The measurement is
whether VTRACE reconstructs the real mechanism or invents a plausible symbol.

Three of those are **paired controls**, which is the sharper test:

| Prose (mechanism expected) | Identifier (absence expected) |
| --- | --- |
| "Where is the function that ranks the connection adapters?" | "Where is `rank_adapters` defined?" |
| "Where is the function that ranks fixtures by priority?" | "Where is `rank_fixtures` defined?" |
| "Where are the backends scored so the best match can be chosen?" | "Where is `score_backends` defined?" |

Same missing abstraction, two phrasings, two different correct answers. Prose
should reconstruct; identifier syntax must remain a bounded absence (§87).

`xr_score_backends_identifier` is the hardest of the three: `sort_backends` is a
real symbol, one token away from the requested identifier, and topically correct.
Absence must still win.

## Project-name reuse (5 cases)

Natural reuse phrasing — *"Does `<project>` already have a helper for X?"* — is a
legitimate request shape, and the project token is legitimate **routing**
evidence. It must not become **symbol** relevance.

This is the generic form of the ARC defect where a query mentioning ARC promotes
`class ARC`. Three of the five cases are in repositories where the project name
is literally a class:

| Case | Project token | Symbol that must not be promoted |
| --- | --- | --- |
| `fl_project_name_reuse` | Flask | `src/flask/app.py::Flask` |
| `sp_project_name_reuse` | Sphinx | `sphinx/application.py::Sphinx` — also the most central class |
| `pl_project_name_reuse` | pylint | `pylint/lint/pylinter.py::PyLinter` — also the most central class |
| `rq_redirect_auth_reuse` | requests | `Session`, `Request` |
| `ap_project_name_reuse` | astropy | *(no project-name symbol; controls the phrasing alone)* |

Two of the five sit in **holdout** repositories, so the discrimination is
measured on code that supplied no development pressure.

## Ambiguity is representable (§81)

Two cases have `expectedRepository: null` because several corpus repositories
genuinely implement the behaviour (plugin loading: pytest, sphinx, pylint;
config-file-vs-CLI precedence: pytest, pylint). Bounded ambiguity or abstention
is correct and a confident lead is a **forced route** — an error the corpus can
therefore detect rather than reward.

## Deliberately hard cases (§123)

The corpus would be worthless if it only contained cases a lexical matcher
solves:

- **Consumer is the better lexical match.** `sp_xref_resolution` asks how a cross
  reference is resolved; the answer is `find_obj` while its caller is literally
  named `resolve_xref`.
- **Singular/plural trap.** `pl_reporter_selection`: the answer is
  `_load_reporter_by_name`, the distractor is `_load_reporters`.
- **Operation inverted, subject held constant.** `xr_backend_selection` and
  `xr_backend_order` share two symbols and swap which one leads. Subject
  alignment alone cannot separate them; only the operation can (§49).
- **Mechanism below symbol granularity.** `pt_fixture_scope_ordering`'s rule is a
  nested `sort_by_scope` inside the closure builder.
- **No lexical hook at all.** `pt_fixture_override`'s precedence is carried
  entirely by a negative list index; nothing is named "override" or "precedence".
- **A real priority table.** `ap_format_priority_tiebreak` is the control against
  concluding that behavioural questions never have scores — sometimes they do.

## What this corpus deliberately does not do

- No LLM grading (§148). Scoring is deterministic against source-backed labels.
- No live agents, Docker, VEXP or paid API (§149).
- No ARC vocabulary, and no chemistry analogies with renamed nouns (§13). The
  behavioural structures differ; there are not 25 versions of "which family
  wins?".

## Amendment policy (§31)

Once frozen, query text and expected evidence are not rewritten because a case
turns out to be hard. If a genuine ground-truth error is found, the original
expectation, why it was wrong, and the corrected expectation are recorded, and
affected baselines are rerun. No silent fixture correction.
