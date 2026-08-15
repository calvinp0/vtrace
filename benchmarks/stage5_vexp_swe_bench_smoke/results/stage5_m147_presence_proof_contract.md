# M147 — Repository presence proof contract

The rule bounded workspace routing must satisfy before it may report a unique
repository, and the reasoning that fixes each clause.

## 1. The obligation

M146 closed on a measured ceiling:

```text
Finding one exact-symbol match is cheap.

Proving it is the ONLY match requires proving every OTHER eligible
repository does not match.

A truncated deep search cannot make that global negative claim.
```

So the question is not "which repository matched" but "what did the answers we
collected entitle us to conclude". Those are different questions, and M146
answered the first while reporting the second.

## 2. States

Every eligible repository contributes exactly one of:

| State | Meaning | Contributes |
| --- | --- | --- |
| `present` | The repository defines the exact name. Measured. | An owner |
| `definitely_absent` | The repository was asked and does not define it. | Negative proof |
| `unknown` | Nobody asked, or the answer cannot be trusted. | Nothing |

`possibly_present` is deliberately **absent from the implementation**. It belongs
to inexact mechanisms — a Bloom filter's positive answer is "maybe", and a
router consuming one must deep-probe before claiming an owner. The mechanism
M147 measured and shipped is exact, so a positive answer *is* presence and the
second stage that would resolve maybes has nothing to resolve. Adding the state
anyway would have shipped a stage no code path can reach. Section 9 records what
would have to change to reintroduce it.

### Why `unknown` is subdivided

Three conditions produce it, and they have different remedies, so collapsing
them into one flag would send someone looking for the wrong problem:

| Reason | Cause | Remedy |
| --- | --- | --- |
| `index_refused` | M146-A refused the member's derivation | Reindex that member |
| `beyond_scan_bound` | The scan bound was reached first | Raise `maxPresenceScans`, or narrow the query |
| `probe_unavailable` | Ready, but its index would not open | Investigate that member's index |

## 3. The proof rule

For an exact identifier `X` over the eligible members:

```text
present            = { R : R answered PRESENT }
definitely_absent  = { R : R answered ABSENT }
unknown            = { R : R could not answer }

|present| > 1                        -> AMBIGUOUS
|unknown| > 0                        -> UNPROVEN
|present| = 1 and |unknown| = 0      -> UNIQUE
|present| = 0 and |unknown| = 0      -> ABSENT
```

Read in that order. The ordering is the contract, not an implementation detail.

### The one asymmetry, and why it is not a hole

`|present| > 1` is decided **before** `unknown` is consulted. Every other verdict
is a claim about repositories that did not answer, so a missing answer withholds
it; but two owners cannot become fewer than two owners no matter what a third
member says. The conclusion is already earned. Reporting `unproven` there would
be over-abstention — refusing to state a fact that further evidence could not
overturn — and it would mask genuine duplicate-symbol ambiguity behind a
readiness complaint.

This is pinned by `repositoryPresence.test.ts::two owners settle the question
even while members remain unchecked`, and by an exhaustive control over every
combination of four member states asserting that no input shape yields an owner
that was not observed present.

## 4. Eligibility

The eligible population is **every enabled workspace member**, not every ready
one. This is the clause M146 was missing.

A member whose index this runtime refused is still a place the name could live.
M146 filtered such members out of the probe pool and then reported uniqueness
over what remained — which silently converted "we did not ask them" into "they
do not have it". Under M147 an unready member is `unknown` and blocks the claim,
naming itself and its reason in the refusal.

```text
M146:  ready members only -> one match -> selected
M147:  all enabled members -> one match + one refused index -> unproven
```

### What this does NOT change

- **`no_match` is unaffected.** It declines to answer, so no wrong repository can
  be selected by it; an unknown member does not need to convert a refusal into a
  different refusal. The excluded members are already reported in diagnostics.
- **Index-free tiers are unaffected.** Explicit selection and absolute-path
  containment decide a *location* from the request, the registration and the
  filesystem. Neither makes a global-negative claim, so neither waits on one.
  Measured by `workspaceProductContext.test.ts::a path-routed answer beside a
  stale member is unaffected`.

## 5. Bounds

Two bounds now exist because they bound different things:

| Bound | Default | Governs |
| --- | --- | --- |
| `maxDeepProbes` | 8 | The indexed-**path** lane, which reads a member's whole indexed path set |
| `maxPresenceScans` | 1024 | The exact-**symbol** lane, one keyed membership question per member |

`maxDeepProbes` is unchanged. M147 explicitly does not raise it: raising a cap
moves the cliff, and the ceiling was never about the number 8.

A member past `maxPresenceScans` is `unknown / beyond_scan_bound`, so a scan
that cannot reach the whole workspace fails closed exactly as a truncated deep
search did. The bound protects cost; it never buys a claim.

## 6. Access paths, and the rule against assumed performance

Membership is answered by one statement:

```sql
SELECT 1 FROM symbols WHERE local_name = ? OR fq_name = ? LIMIT 1
```

There is deliberately **not** an indexed variant and a fallback variant. A
database carrying `idx_symbols_local_name` and `idx_symbols_fq_name` answers it
with keyed lookups; one without them scans the symbol table. The rows considered
are identical either way, so the two paths *cannot* disagree — the equivalence
is structural rather than asserted.

What differs is latency, by up to 12x on real repositories, so the path taken is
**observed and reported** rather than assumed:

```text
probe.membershipAccessPath() -> indexed | fallback | unreported
```

read from the database catalogue, not inferred from configuration. Half the
access path reports `fallback`: a router bounding its cost on "indexed" must not
be told so until both lookups are keyed.

Equivalence is measured over a repository's entire name population, with the
access path added and removed underneath the same probe, in
`symbolMembership.test.ts`. The same sweep pins the property the whole proof
rests on: **no false negatives**. One name wrongly reported absent is one rival
owner recorded as proven absent, which is a false uniqueness claim.

## 7. What a false uniqueness claim would require

The failure this milestone exists to prevent, and every gate now standing in
front of it:

| Failure | Blocked by |
| --- | --- |
| A name present but reported absent | Whole-population no-false-negative sweep, both access paths |
| A member never asked, counted as absent | Eligibility over all enabled members; `unknown` blocks |
| A refused index supplying absence | `index_refused` is `unknown`, never `definitely_absent` |
| A bound hiding a rival owner | `beyond_scan_bound` is `unknown`, fails closed |
| Registration order deciding the owner | Proof is order-invariant in verdict and in every reported field |

## 8. Dependency direction

The proof is **query-time routing logic** and consumes nothing persisted beyond
the index a member already has. It therefore does not enter the M146-A
derivation fingerprints, and a change to the rule above cannot invalidate an
index. That direction is deliberate and is the same one M146-B established: a
routing edit must never trigger a rebuild.

The name access path, if it is ever added to stored indexes, sits on the other
side of that line — it is a property of the database, which is why the probe
reads it from the catalogue instead of assuming it.

## 9. What would reintroduce `possibly_present`

If a future mechanism answers membership inexactly — a Bloom filter, a hashed
digest with unresolved collisions — its positive answer is not presence. The
contract would then read:

```text
summary says absent    -> definitely_absent, safe negative proof
summary says maybe     -> deep-probe that member before counting it an owner
```

with `unknown` unchanged. The proof rule in section 3 is already expressed over
final states, so it would need no amendment; only the collection stage would
gain a resolve step. M147 measured those mechanisms and did not need one — see
`stage5_m147_presence_mechanism_comparison.md`.
