# M147 Workstream A — identifier population audit

What must a presence proof cover, and how large is that population? Answered
before designing anything, because a universal presence system for identifier
classes routing never consults would be work spent on the wrong question.

Data: `stage5_m147_identifier_population.json` (13 real repositories).

## 1. What routing actually asks

`RepositoryProbe` has exactly two questions, and they map to two tiers:

| Tier | Question | Reads |
| --- | --- | --- |
| `indexed_path` | which relative paths does this repository index? | `files.path` |
| `exact_symbol` | does this repository define this exact name? | `symbols.local_name` OR `symbols.fq_name` |

Nothing else. There is no document-key lane, no config-key lane, no FTS lane in
repository selection — those live in repository-local retrieval, which routing
composes rather than reaches into.

## 2. Scope decision: exact symbols only

M147 covers the **exact-symbol** lane and deliberately not the path lane.

The measured M146 ceiling is exact-symbol uniqueness. The path lane does not
share it in practice: absolute-path containment (tier 1, index-free) decides
first and needs no index at all, scaling to 1000 members with **zero indexes
opened in ~2 ms**. A relative path reaching the indexed lane is a real but
different case, and §16's instruction is explicit — do not broaden until exact
symbol absence is solved.

The residual is recorded honestly in the report rather than quietly fixed:
the `indexed_path` tier still nominates over ready members only, so an unready
member cannot refute a path-uniqueness claim either. It retains M146's
truncation guard, so it fails closed; it does not yet have the eligibility rule
M147 gives the symbol lane.

## 3. Populations

`routable` is the union of `local_name` and `fq_name`, because the membership
query keys on either.

| Repository | Files | Symbols | Unique simple | Unique FQN | **Routable** | Name bytes | Index size |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| psf__requests-1142 | 69 | 765 | 573 | 763 | 1,336 | 47 KB | 4 MB |
| pallets__flask-5014 | 80 | 1,085 | 893 | 1,081 | 1,974 | 63 KB | 3 MB |
| mwaskom__seaborn-3187 | 152 | 3,164 | 2,412 | 3,153 | 5,565 | 196 KB | 10 MB |
| pydata__xarray-2905 | 152 | 5,377 | 3,859 | 5,357 | 9,216 | 358 KB | 17 MB |
| pytest-dev__pytest-10051 | 245 | 5,158 | 4,247 | 5,127 | 9,374 | 376 KB | 15 MB |
| sphinx-doc__sphinx-7462 | 460 | 7,539 | 3,988 | 7,532 | 11,520 | 434 KB | 21 MB |
| pylint-dev__pylint-4551 | 806 | 7,833 | 4,558 | 7,632 | 12,190 | 549 KB | 20 MB |
| **ARC** | 325 | 9,014 | 6,811 | 8,994 | **15,805** | 738 KB | 98 MB |
| scikit-learn-10844 | 750 | 11,090 | 6,728 | 10,745 | 17,473 | 736 KB | 34 MB |
| matplotlib-22719 | 906 | 14,794 | 8,610 | 14,092 | 22,702 | 861 KB | 41 MB |
| astropy-14365 | 951 | 21,561 | 14,122 | 21,288 | 35,410 | 1.5 MB | 63 MB |
| sympy-12419 | 1,116 | 24,863 | 14,954 | 24,833 | 39,787 | 1.5 MB | 74 MB |
| **TCKDB_v2** | 1,231 | 30,945 | 18,220 | 30,945 | **49,218** | 3.0 MB | 539 MB |

## 4. What the numbers changed

**The populations are small, and that is the finding.** 1.3k–49k names per
repository, 47 KB–3.0 MB of raw name text. At this scale the interesting
question is not "how do we compress the name set" — every candidate structure
fits comfortably — but "what does it cost to *consult* it", which turned out to
be dominated by how the existing index is read, not by how a new structure would
be stored. That redirected the milestone from designing a summary to measuring
the probe.

**Simple names are heavily reused within a repository.** ARC has 9,014 symbols
under 6,811 distinct simple names; TCKDB 30,945 under 18,220. Routing does not
care — the question is repository-level presence, so one match is enough and
multiplicity inside a repository never reaches the proof. It matters only for
sizing: the structure needs the distinct-name count, not the symbol count.

**FQN collisions inside a repository are essentially nil.** TCKDB has zero
(30,945 symbols, 30,945 distinct FQNs); ARC has 20. So an FQN hint is close to a
unique key within a repository, while a simple name is not — which is why the
membership query has to consider both columns and why an access path on only one
of them leaves the query scanning.

**Index size does not track name count.** TCKDB's index is 539 MB for 49k names;
astropy's is 63 MB for 35k. The bulk is documents and chunks, not symbols. That
mattered later: absence cost scales with the *file* size the working set has to
hold, not with the name population, which is why the 98 MB ARC index degrades
superlinearly at 100 members while a 3.8 MB one does not.
