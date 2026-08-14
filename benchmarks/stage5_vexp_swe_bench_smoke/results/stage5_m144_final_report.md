# M144 — Failure-Evidence Attribution and Behavioural Localization

**Verdict: MIXED.**

The evidence class is real, it resolves, and it produced one measured generic
gain with zero regressions. It is also far narrower than the roadmap assumed: of
50 frozen cases, 13 carry localizing failure evidence, 10 of those are already
solved by ordinary retrieval, and the capability's whole reach is 6 traceback
cases. `django-11740` — the case that motivated the milestone — contains **no
supplied failure evidence at all** and is therefore outside M144's scope.

| Workstream | Verdict |
|---|---|
| A — inventory + typed extraction | **PASS** |
| B — repository attribution | **PASS** |
| C — localization integration | **MIXED** — one narrow rule shipped; three measured mechanisms deliberately not shipped |
| D — paired measurement + preservation | **PASS** |

| | |
|---|---|
| M143 functional predecessor | `93a34d194b2360094d61b27f2ecc12f6dccacdb3` |
| M144 functional commit | `e7c45bdc397338c59fc0b8933dce46d6a5a9221d` |
| Branch / ahead / pushed | `main` / see closure commit / **nothing pushed** |

---

## 1. The determination that had to come first (§30, §81)

**Does `django-11740`'s original task contain usable failure evidence? No.**

```
fix changing a UUIDField to a ForeignKey not creating a cross-app migration
dependency in the autodetector
```

`label_source: manual_verified`, 106 characters, and every evidence lane reads
zero: no failing test, no traceback frame, no exception location, no reproduction
command, no explicit path.

The task *does* name the autodetector in prose. That is **task-entity** evidence,
not **observed-failure** evidence — nothing in it says where a failure was
observed or exercised — and §12 forbids collapsing the two. Under the
supplied-evidence-only scope the case is `not_addressable`, and it becomes the
negative control instead: no evidence, no effect. Measured: unchanged,
byte-identical, still `top1=false`, still the M142 regression M143 root-caused.

Recorded in full in `stage5_m144_django11740_failure_evidence.json`.

## 2. Prevalence (§16, §17)

| Evidence form | django 20 | cross-repo 30 | **frozen 50** | django 5 | cross-repo 16 | ARC 7 |
|---|---:|---:|---:|---:|---:|---:|
| traceback frame | 1 | 5 | **6** | 0 | 0 | 0 |
| exception name | 6 | 12 | **18** | 0 | 5 | 0 |
| failing test name | 2 | 4 | **6** | 0 | 0 | 0 |
| pytest node id | 0 | 0 | **0** | 0 | 0 | 0 |
| explicit source path | 1 | 0 | **1** | 0 | 0 | 0 |
| line anchor | 0 | 1 | **1** | 0 | 0 | 0 |
| reproduction command | 1 | 0 | **1** | 0 | 0 | 0 |
| **any evidence** | 8 | 15 | **23** | 0 | 5 | 0 |
| **localizing evidence** | 4 | 9 | **13** | 0 | 0 | 0 |
| exception-name only | 4 | 6 | **10** | 0 | 5 | 0 |
| **none** | 12 | 15 | **27** | 5 | 11 | 7 |

Three facts govern everything that follows.

**Exception names dominate and localize nothing.** 18 of 50 cases carry one; 10
carry *nothing else*. Reporting "23 of 50 have failure evidence" would double the
capability's apparent reach with symptom vocabulary.

**Zero pytest node ids.** All 8 failing-test mentions are bare names — `test_app`,
`test_foo`, `test_f_true`, `test_requests`. Only 3 of 6 cases resolve any symbol
of that name, and `django-12273`'s `test_f_true` does not exist in the repository
at all. The test-anchored lane §27/§28 imagined has almost nothing to anchor to.

**The other suites carry no localizing evidence at all.** `django_5` and
`cross_repo_16` report `localizing = 0` (the 5 hits in `cross_repo_16` are
exception names in prose — symptom vocabulary, not a place), and the ARC
behavioural corpus reports zero of everything, because it is process questions.
Those are the no-effect controls, and they are a count rather than an assumption.

## 3. Ten of thirteen were already solved (§89)

Of the 13 localizing-evidence cases, **10 already reach gold top-1 on the
predecessor**. Claiming them would be pure overclaiming.

The real headroom was three: `django-12273`, `psf/requests-1724`,
`pylint-dev/pylint-8898`. One of those (`django-12273`) rests on a test name the
repository does not contain. So the honest ceiling before any work began was
**two cases out of fifty**.

## 4. Resolution (§24-§25, §93)

34 evidence items across 13 cases: **20 resolve** inside the active repository, 14
are external or unresolved, **0 ambiguous**.

The corpus contains five path shapes and no prefix rule separates them:

```
./sympy/core/evalf.py                                repo-relative
\path\to\site-packages\sphinx\domains\python.py      Windows, installed
/app/venv/…/site-packages/django/db/models/query.py  installed copy of OUR code
/usr/lib/python3.10/sre_parse.py                     standard library
/Users/hwkns/test_requests.py                        the reporter's laptop
```

`site-packages` appears in both an installed copy of the project's own source
(django-12774's entire traceback, and it is the correct localization) and in
genuinely foreign dependencies. Membership is therefore decided by a
segment-boundary match against the indexed file list — the M143 §54 path-identity
rule, now in one shared module rather than a second ad hoc copy.

**One measured false resolution.** `/Users/hwkns/test_requests.py` is a file on
the reporter's laptop that shares its full last segment with the repository's own
`test_requests.py`, and membership accepts it. The segment-boundary rule does not
prevent this; a basename fallback is not the culprit (basename-only resolutions:
**0**). It is safe here because M144 uses membership only to *reject* foreign
frames, and it is recorded rather than hidden.

## 5. Frame roles: the design the measurement refuted (§38, §41, §53)

The obvious rule — promote the deepest in-repository frame — looked strong:

| Role | Names the gold file |
|---|---:|
| deepest in-repository frame | 4 / 6 |
| shallowest in-repository frame | 3 / 6 |
| any in-repository frame | 5 / 6 |
| gold reachable ONLY by a direct relation from the deepest | 1 / 6 |

Neither depth dominates, and `pydata/xarray-3677` is the counter-example in the
corpus: its deepest in-repository frame is `common.py::AttrAccessMixin.__getattr__`
— a symptom site — while gold is the *shallowest* project frame,
`dataset.py::merge`. A depth rule would have broken a case that already passes.

M142 had already found this and guarded it with the language-protocol dunder
rule. So M144 shipped **no depth rule**. It shipped a membership question placed
*ahead* of M142's existing selection, with every M142 guard still in front of it.

## 6. What shipped (§56, §57)

One change, in `e7c45bd`:

> Before choosing the single traceback frame M142 already admits, ask whether that
> frame's file belongs to the repository being searched, and choose the deepest
> frame that does.

`psf/requests-1724` is the case it is for. Its traceback ends in CPython's
`httplib._send_output` — a name this repository has never contained — and the
predecessor spends the request's strongest signal asserting it. The last frame
the project itself owns is `sessions.py, line 438, in send`, and
`requests/sessions.py` is the gold file.

Ordering is load-bearing, and two guards had to be handled explicitly:

- **Completeness is a property of the traceback, not of the selected frame.** It
  is still measured after the *deepest* frame in the text even when selection
  picks an earlier one. Without that, repository filtering would quietly
  re-enable truncated stacks — `pylint-8898` is cut mid-`sre_parse` and stays
  rejected.
- **The dunder guard runs after selection.** Filtering makes
  `common.py::__getattr__` the nearest in-repository frame in `xarray-3677`, and
  the guard must still refuse it. It does.

Without a resolver the selection is byte-identical to the predecessor, so the
capability is structurally inert wherever the caller cannot say what the
repository contains.

## 7. What was measured and deliberately not shipped (§87, §92, §97)

| Mechanism | Status | Why |
|---|---|---|
| failing test → direct production call (§48) | measured, not shipped | 0 node ids; all 8 test mentions bare; `test_f_true` names nothing |
| frame → direct relations → owner (§29, §45) | **measured, not shipped** | see below |
| reproduction-command attribution (§39) | not justified | 1 genuine command, naming a management command not a test target |
| broad-import / helper-hop negatives (§49, §50) | not applicable | no test-to-production lane exists to control |
| explicit source path (§54) | already organic | psf-5414 is top-1 via M103 anchor preservation |

The frame→relation lane deserves its own note, because it is **real**.
`pylint-8898` is the one frozen-50 case where no frame is itself gold, and its
gold *is* reachable: `_config_initialization` has direct `calls` edges to
`pylint/utils/utils.py::_unquote` and `::_splitstrip`, both gold. Direct-relation
precision across all six traceback cases is **15/24 = 0.625**.

It was not shipped for two measured reasons. Its traceback is truncated, so using
it requires relaxing the M142 completeness guard M142 measured as harmful; and
the case already has gold *anywhere*, so only the lead is wrong — the lane would
have to carry ranking authority, which is precisely the §43 architecture M143
condemned in the title lane. §78 prefers a conservative high-precision capability
to an activated one. This is a recorded ceiling, not an omission.

## 8. Final paired benchmark (§100-§102)

`93a34d1 → e7c45bd`, clean detached worktrees, independently prepared corpora with
separate index roots. `provenanceValid = true`; both suites report
`sameFixtureHash`, `sameTargetCorpusHash`, `isolatedIndexes`, `authoritative`.

| Metric | M143 | M144 | Δ |
|---|---:|---:|---:|
| Top-1 gold file | 38 | **39** | **+1** |
| Top-3 gold file | 44 | 44 | 0 |
| Gold file anywhere | 48 | 48 | 0 |
| Gold symbol anywhere | 31 | 31 | 0 |
| Missing gold | 2 | 2 | 0 |
| Mean pivots | 2.10 | 2.10 | 0 |
| Mean support | 3.88 | 3.88 | 0 |
| Mean tokens | 1835.20 | 1850.14 | +14.94 |

Suites: django 20 (**0** changed), cross_repo 30 (**1** changed).

### 8.1 Every changed case (§90, §132)

**One.** `psf/requests-1724`, `requests/api.py` → `requests/sessions.py`,
`top1 false → true`. Classification: `traceback_attribution`.

Causal chain: 7-frame traceback ending in stdlib `httplib._send_output` → the
predecessor selects that deepest frame → M144 finds the three `httplib` frames do
not resolve in the index → the deepest frame the project owns is
`sessions.py::send` → `send` replaces `_send_output` as the explicit identifier →
the gold file takes the lead.

Incremental-value check (§89): the predecessor is `top1=false` with the gold file
present only as support. The single input that changed is which frame contributes
an identifier. **New evidence caused it.**

### 8.2 No-evidence equivalence (§62, §63)

**Holds, and structurally rather than empirically.** 44 of the frozen 50 carry no
traceback frame; 0 of them changed. `isRepositoryPath` is consulted from exactly
one place and the path list is read lazily, so measured `indexedPathsRead = 0` on
all 44. A task with no traceback cannot reach the new code.

## 9. Generic controls (§87, §94)

**19 / 19 pass** — 11 frame controls and 8 prose false-positive controls, all
against synthetic path lists so each states a rule rather than a corpus fact.
**4 of the 11 discriminate** the predecessor from the candidate (§88).

Notable: framework-frame rejection; installed-copy-of-own-code acceptance;
foreign-dependency rejection at the same `site-packages` prefix; symptom-site
abstention; truncated-traceback abstention; duplicate frames not multiplying
authority; conflicting anchors resolved by membership rather than depth; and the
§64 word-alone controls — `tests show this is slow`, `this error is conceptual`,
`traceback support was added recently`, `pytest versions: 5.4.x` — none of which
manufacture evidence.

## 10. Performance and response size (§73, §74, §128)

| | |
|---|---|
| Additional DB queries | **0** — the path list was already read once per task by the localization detector and is now shared |
| Additional graph queries | 0 |
| Source reads before hydration | 0 |
| `failureEvidenceParseMs` | mean 0.085 ms, max 0.429 ms |
| `failureEvidenceResolveMs` (frame selection incl. regex scan) | mean 1.121 ms / max 2.577 ms over the 6 cases with frames; mean 0.366 ms over the 44 without — the residual is the frame regex, which runs either way; only the index read is conditional |
| `indexedPathsRead` | 1 on the 6 traceback cases, **0** on the other 44 |
| Response bytes | 49/50 cases byte-identical; +747 estimated tokens on the single changed case (+0.81 % corpus-wide) |

The token growth is entirely the changed case packing the gold file it now leads
with, inside its own unchanged 8000-token budget. No envelope growth was accepted
for the other 49.

## 11. Preservation (§104-§121)

**0 regressions attributable to M144.** 13 gates pass; 2 are blameless
precondition-unmet reproductions of what M143 recorded (M136 budget row, M138
harness `TypeError` at the identical line); 1 is the M132 stale assertion with the
identical 19/21 verdict and identical two red rows.

Verified case by case: the five M143 title cases byte-identical (§104, §106);
`django-11740` unchanged (§105); `django-11815` (§110), `sphinx-7462` (§111) and
`sphinx-7910` (§112) unchanged; `get_dihedral` still leads (§114); ARC behavioural
corpus **7 cases, 0 semantic differences** including the Gaussian case (§84 — no
synonym lexicon added); TCKDB `leadChanged=false` on every probe (§120).

M143-A truthfulness is untouched (§104): M144 writes nothing into
`lexical`/`fts`/`tfidf`/`bm25`/`symbol`, and all five title-injection cases carry
no traceback frame, so the shipped rule is unreachable on every one of them.

## 12. Verification

```
bun run typecheck              clean
bun run typecheck:benchmarks   clean
bun test                       4244 pass / 49 skip / 0 fail (260 files)
git diff --check               clean
```

No live agent, Docker, VEXP, paid API, or network was used at any point.

## 13. Remaining capability boundaries

1. **Task-supplied failure evidence is sparse and mostly redundant.** 13/50 carry
   localizing evidence; 10 of those already work. The capability's true frontier
   on this corpus is 6 traceback cases.
2. **Bare failing-test names are close to useless without node ids.** The corpus
   has zero node ids, and one bare name resolves to nothing at all.
3. **Frame depth does not identify the edit site.** Deepest 4/6, shallowest 3/6.
   Only membership was safe to act on.
4. **The frame→owner relation lane is real and blocked by an unrelated guard.**
   `pylint-8898`'s gold is one `calls` edge from its deepest in-repository frame,
   but its traceback is truncated and the case needs ranking authority, not
   candidate admission.
5. **`django-11740` remains outside every scope so far.** M143 proved no static
   subject→owner relation exists; M144 proves no supplied failure evidence exists
   either. It is not addressable by either evidence class.

## 14. Recommended M145 scope

Unchanged: **Workspace and Repository Identity Foundation** — workspace identity,
explicit repository membership, repo/worktree provenance, per-repository
readiness, explicit routing, candidate/result repository provenance, same-name
collision safety, index-operation ownership and locking. No cross-repository
ranking yet.

M144 sharpens one input to it. `repositoryPathMembership.ts` is now the single
place that answers "does this path belong to this repository", and it answers it
against a flat indexed path list with no workspace identity behind it. The
measured `test_requests.py` collision — a foreign path accepted because it shares
a full segment with a repository file — is exactly the class of ambiguity M145
exists to make explicit. M145 should take ownership of that predicate rather than
leave membership decided by string suffixes.
