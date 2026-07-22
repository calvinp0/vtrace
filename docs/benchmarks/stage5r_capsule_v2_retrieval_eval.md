# Stage 5R — Capsule v2 Retrieval Eval

A frozen milestone for Capsule v2's **product intelligence**: can the capsule
recover the correct edit target from the index alone, on a small set of real
Django issues?

## What this eval is

- **Deterministic retrieval only.** It runs `buildCapsuleV2` over an indexed
  fixture and inspects the pivots/support it produces. There is **no Claude, no
  Docker, and no API** in the loop — nothing here calls a model or applies a
  patch. The result is reproducible from the index + task text alone.
- **5 Django fixtures.** A handful of real SWE-bench Django issues, each indexed
  and queried with its issue prose under `--intent debug`.
- **Expected labels are eval-only.** Each fixture carries an expected edit file
  and symbol used _purely to score the eval_. They are never passed into
  production retrieval — the capsule recovers the target from the index, and the
  labels only grade what it recovered.

## Results

- **100% top-1 file accuracy** — the lead pivot's file is the expected edit file
  in every fixture.
- **100% expected-file-as-pivot rate** — the expected symbol is surfaced as a
  pivot (not merely as support) in every fixture.
- **11490 fixed** by two index-driven recovery passes working together:
  - **SQL-rendering recovery** — a composed-query SQL-output bug whose lexical
    pool is dominated by the public query-builder API (`values`/`values_list`),
    so the renderer (`SQLCompiler.get_combinator_sql`) is recovered from general
    structural signals (a `*/compiler.py` path, a `get_*_sql` method).
  - **File-line anchor recovery** — the issue text's explicit source anchor
    (`compiler.py#L428-L433`) is parsed, resolved against the index, and mapped
    to its enclosing symbol (`get_combinator_sql`), promoting the exact edit site
    the issue points at over a lexically-similar neighbour.

## Why it is frozen

This eval pins the point at which Capsule v2's retrieval reliably names the right
edit target on these issues, decoupled from any agent or execution harness. It is
the product-intelligence baseline the live Stage 5 runs (which add the agent,
Docker, and patch evaluation) build on top of — so a regression in retrieval can
be caught here, deterministically, without a live run.
