# M149 claim model

The rule every consumer below routing must obey:

> Evidence may be combined, but uncertainty may not disappear in the combining.

Concretely, a consumer may narrow a claim freely. It may never widen the claim's
**scope** or strengthen its **authority** past what the observations support.
Those are two separate axes and both are enforced in
`src/workspace/evidenceClaims.ts`.

## Scope

```
member_local  <  scanned_members  <  enabled_members  <  workspace
```

`workspace` is deliberately wider than `enabled_members`: a disabled member is
outside the population any lane asked, so **no lane may make a claim about the
workspace as a whole**. That is not a technicality — it is the same shape of
error M147 fixed, one level up.

`scopeWithin(claimed, proven)` is the mechanical form of §32.

## Negative claim strength

```
not_observed  <  bounded_absence  <  authoritative_absence
```

| strength | means | may be stated over |
| --- | --- | --- |
| `not_observed` | nobody authoritative was asked, or the source cannot settle absence at all | nothing |
| `bounded_absence` | every member that answered did so from an exact source, but others did not answer | `scanned_members` |
| `authoritative_absence` | every member in the claimed scope answered from an exact source | the scanned scope |

`classifyNegativeClaim` returns the strongest strength a coverage record earns:

- capability cannot settle absence → `not_observed`
- `answered === 0` → `not_observed`
- `complete` → `authoritative_absence`
- otherwise → `bounded_absence`

The middle case is the deliberate design choice. A partial scan still settles the
members that answered, and collapsing that to `not_observed` would throw away a
real answer to "is this symbol in any repository I can actually query". The
protection is not to discard the negative but to stop it escalating:
`canClaimAbsence` permits a `bounded_absence` at `scanned_members` and below, and
nowhere wider.

`refusedWithoutEvidence` and `omittedByBound` weaken a claim **identically** —
both prevent escalation — but they stay separate fields, because their remedies
differ. You repair a refused index; you raise a bound. A consumer that cannot
tell them apart sends someone to the wrong fix.

## Positive claim strength

```
supporting_hint  <  observed_positive
```

Only two values, on purpose. A repository holding a definition and a repository
holding a caller are both *observed*; what differs is the kind of relation seen,
not how sure we are of seeing it. Collapsing those two questions onto one scale
is exactly how "has supporting code" becomes "owns the behaviour" (§22).

## Completeness is per capability, never global

| capability | a miss settles member-local absence? | why |
| --- | --- | --- |
| `path_membership` | yes | `files` carries a UNIQUE covering index on `path` (M148-B) |
| `symbol_exact_lookup` | yes | equality on `local_name` / `fq_name` (M147) |
| `ranked_retrieval` | **no** | capped, ranked and fuzzy — a miss proves nothing |

A single `complete: true` spanning all three would be the defect this model
exists to prevent, so an `EvidenceCoverage` always names the capability it is
complete *for*.

### Access path is not an authority axis

`CAPABILITY_SETTLES_MEMBER_ABSENCE` is deliberately **not** keyed on M148-A's
`nameLookupAccess`. There is one membership statement; an index carrying
`idx_symbols_local_name` answers it with a keyed lookup and one without it scans
the symbol table, and the rows considered are identical either way. A `fallback`
answer is exactly as authoritative as an `indexed` one — only slower. Treating
`indexed` as "true" and `fallback` as "uncertain" would invent a distinction the
storage layer does not have (§21).

## Coverage object

```
capability              which evidence source answered
purpose                 deciding | support
scope                   the population the scan was meant to cover
considered / answered   counts, not lists
refusedWithoutEvidence  repair the index
omittedByBound          raise the bound
unknownOther            ready but unanswerable
complete                DERIVED, never set by a caller
examples                capped at 4
examplesOmitted         the rest, as a count
```

`complete` is derived inside `composeCoverage` rather than passed in, so a
caller cannot assert a completeness it did not have.

Every list in this layer truncates at **4** — the same width M145 chose for
matched paths and M146 for reported candidates. Verdicts are computed from the
totals, never from the truncated lists, so **truncating the report cannot change
what the report concludes**.
