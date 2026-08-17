# M156-A — The three frozen availability failures

Reproduced against the M155 predecessor `d39871de` on the exact pinned M155
workspaces (`stage5_m155_paired30_manifest.json`, manifest sha256
`d143f807…c244ba6`). Machine-readable form:
`stage5_m156_live_availability_baseline.json`.

Command, per case:

```bash
vtrace index <workspace copy> --mode full --quiet --json
```

---

## psf__requests-1142 — baseline **PASS**

```
failing file    requests/packages/urllib3/contrib/ntlmpool.py
language        python
parser          vtrace-python
class           ENCODING_ERROR
message         SyntaxError: (unicode error) 'unicodeescape' codec can't decode
                bytes in position 130-131: truncated \uXXXX escape (line 34)
files failed    1
files indexed   0     ← the whole repository
exit code       1
index.sqlite    present, schema initialised, 0 files / 0 symbols / 0 edges
index.meta.json ABSENT
```

The most expensive of the three: VTRACE was unavailable on a task the baseline
agent solved, so the product cost a win outright.

## pytest-dev__pytest-5262 — baseline **PASS**

```
failing file    doc/en/example/py2py3/test_py2.py
language        python
parser          vtrace-python
class           SYNTAX_ERROR
message         SyntaxError: multiple exception types must be parenthesized (line 4)
files failed    1
files indexed   0
exit code       1
```

A **documentation example** deliberately written in Python 2 syntax to
demonstrate a py2/py3 difference. It is doing its job by being unparseable
under Python 3.

## pylint-dev__pylint-4551 — baseline **FAIL**

```
failing files   13
first           tests/functional/s/star/star_needs_assignment_target_py35.py
class           SYNTAX_ERROR
message         SyntaxError: cannot use starred expression here (line 15)
files failed    13
files indexed   0
exit code       1
```

The full set — every one an intentionally malformed fixture in a **linter's own
test corpus**:

```
tests/functional/s/star/star_needs_assignment_target_py35.py
tests/functional/s/syntax_error.py
tests/functional/s/syntax_error_jython.py
tests/functional/t/tokenize_error.py
tests/functional/t/tokenize_error_jython.py
tests/functional/u/unknown_encoding_jython.py
tests/input/func_w0122_py_30.py
tests/input/func_w0332_py_30.py
tests/regrtest_data/bad_package/__init__.py
tests/regrtest_data/descriptor_crash.py
tests/regrtest_data/py3k_error_flag.py
tests/regrtest_data/py3k_errors_and_warnings.py
tests/regrtest_data/syntax_error.py
```

---

## Two corrections to the prompt's framing

**Two of the three were baseline PASSES, not one.** `stage5_m155_paired30_outcomes.json`
records `baselinePassWithTreatmentUnavailable` with **two** entries —
`psf__requests-1142` and `pytest-dev__pytest-5262`. The M155 final report names
only the first in prose. The product harm is twice what the summary implies.

**`pylint-dev__pylint-4551` fails on 13 files, not one.** The M155 summary
describes each case as "one problematic file each". That is true for two of
them; pylint aborts on thirteen. This matters for the fix: a per-file
containment mechanism that only handled a single failure per repository would
still leave pylint unavailable.

## Why this cannot be a syntax fix

These are not obscure corners of Python that a better parser would swallow. They
are files that are *supposed* to be unparseable:

- a py2/py3 documentation example demonstrating a syntax difference,
- a linter's regression corpus of deliberately broken input,
- a vendored library with a corrupt escape sequence.

`tests/functional/s/syntax_error.py` cannot be made to parse without ceasing to
be what it is. Any repository that tests a parser, a linter, a formatter or a
migration tool will contain files like these. Teaching the parser three new
dialects would fix these three repositories and leave the class of failure
untouched — which is why §5 states the invariant as containment rather than
coverage.

## Scope beyond the frozen 30

The M155 preparation reports (preserved in
`stage5_m156_m155_corpora_provenance.json` before the corpora were deleted) show
the deterministic benchmark quarantining **4 targets / 16 files across the broad
100**, at every one of the five architecture eras:

| instance | files quarantined |
|---|---|
| `psf__requests-1142` | 1 |
| `pytest-dev__pytest-5262` | 1 |
| `pytest-dev__pytest-6197` | 1 |
| `pylint-dev__pylint-4551` | 13 |

`pytest-dev__pytest-6197` is in the broad corpus but outside the frozen 30, so
M155's paired experiment never saw it. The availability defect is a **4%**
property of the corpus, and the deterministic benchmark has been silently
working around it — by `rename`-ing the offending files out of the tree and
restoring them afterwards — since M134.

That workaround is why the failure stayed invisible for so long: the benchmark's
index was complete *for a repository that does not exist*, and nothing in it
recorded the 16 missing files. §6 asks whether the benchmark skips more than
product truthfulness permits. It does, and M156 does not port it.
