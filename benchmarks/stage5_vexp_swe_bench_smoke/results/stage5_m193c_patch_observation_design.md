# M193C — patch-observation design

Companion to `stage5_m193c_final_report.md`. That document reports what was
measured; this one records what was decided and what was rejected.

## The governing invariant

```
PATCH_SNAPSHOT(before) → observation → repository state after
```

must satisfy

```
Git / index / worktree / untracked state after == before
```

except for changes caused by the agent or the command being observed.

The invariant is **"the snapshot performs no repository mutation"**, not
"the snapshot mutates and rolls back". The difference is not stylistic. It
determines whether the property survives a crash, a hook, a clean filter, or a
second observer.

## Why staging-as-a-query was chosen originally, and why it is wrong

`git add -A` / `git diff --cached` / `git reset` is the standard idiom for "one
unified diff covering tracked *and* untracked changes", because `git diff HEAD`
alone does not see untracked files. The idiom is a write used as a read.

Three costs, in increasing order of how hard they are to see:

1. **It destroys staged state.** `git reset` is a mixed reset. Any arm that runs
   `git add` finds its index emptied by the instrument measuring it.
2. **It reclassifies a rename.** A staged rename comes back as an unstaged
   deletion plus an *untracked* file — a state the agent never created.
3. **It survived review because the subject was too weak.** The fake agent never
   staged, so the instrumentation differed from the thing it stood in for in
   exactly the direction that hid the defect.

## Alternatives considered

### A. Temporary index file (`GIT_INDEX_FILE=/tmp/…` + `git add -A`)

Rejected. It would preserve the agent's index, but:

- `git add` writes blobs into the object database, so the observation is still a
  write; it only moves which state it writes.
- `git add` runs clean filters and can be affected by hooks and config, so what
  the snapshot reports becomes a function of repository configuration.
- The temporary index is itself a resource to create, secure and remove, and a
  crash between creation and removal leaves debris in the checkout the agent can
  see.

§8 asks that a temporary-index technique be adopted only after proving a
read-only construction impossible. It is not impossible — see C.

### B. Save and restore the real index

Rejected for the same reason, more strongly: restoration is a second mutation
surface, a crash between save and restore corrupts the subject, and concurrent
observation becomes dangerous rather than merely wasteful.

### C. Two read-only lanes, merged (adopted)

```
tracked, current bytes    git diff --no-renames HEAD -- . <exclusions>
untracked, current bytes  git ls-files --others --exclude-standard -z -- . <exclusions>
                          then per file: git diff --no-index --no-renames -- /dev/null <path>
observational state       git status --porcelain=v2 -z -- . <exclusions>
```

The load-bearing discovery is that **git special-cases `/dev/null` in
`--no-index`** and emits the canonical `diff --git a/P b/P` + `new file mode`
header — byte-for-byte what staging that file would have produced. The premise
behind M193B's residual note ("it must stage to get untracked files into a
unified diff") was false.

`diff HEAD` compares the base commit to the *working tree*, which is what makes
the staged/unstaged distinction irrelevant to the answer while leaving it intact
in the repository. A file staged as S1 and then edited to S2 reports S2, and the
index is never consulted as a staging area.

## Decisions inside the adopted design

### `--no-renames`

Rename detection has been on by default since git 2.9. It collapses a move to a
single `R100` entry whose body is `similarity index` and carries none of the new
file's content. `--no-renames` states the intent instead of inheriting a
default, keeps both paths visible, and matches the M193B changed-source
authority — the patch and the freshness proof must agree about what the agent
changed.

§19 explicitly permits delete-plus-add. Applying either form to the base commit
produces byte-identical trees with identical modes; this was measured, not
assumed.

### Path-order merge rather than lane concatenation

Concatenating the lanes would be deterministic but would place untracked files
after all tracked ones. Merging per-path chunks in git's own bytewise path order
reproduces `diff --cached` ordering exactly, so the only byte differences from
the superseded capture are the two intended ones. Sort keys come from
`--name-only -z`, which needs no unquoting, and the chunk count is cross-checked
against that list.

### Clamping the untracked executable bit

The tracked lane runs under `core.fileMode=false`, where git does not trust the
filesystem's executable bit; `add -A` therefore recorded every new file
`100644`. `--no-index` reads the bit directly and says `100755`.

Two defensible answers. The truthful-mode answer would change the patch bytes
for any agent-created executable; the clamp reproduces exactly what the frozen
capture produced. M193C is chartered to change how the patch is obtained, not
what it is, so the clamp wins — and the observed mode is recorded in
`untrackedRealModes` rather than erased, per §12. Symlinks (`120000`) are a
different object type and are passed through unclamped.

### One shell invocation

Sections could have been separate `exec_raw` calls, which would read better. A
single invocation is used because the agent may still be running: two round
trips give the tree two chances to move between the enumeration and the patch.
Each section carries its own exit status, read from `${PIPESTATUS[0]}`
immediately after its own pipeline — `$?` after an assignment would report the
last stage of the pipeline, not git's.

Payloads are base64-encoded because `-z` output carries NUL bytes and a shell
variable cannot hold one; command substitution would silently truncate a path
list. `base64 | tr -d '\n'` rather than `base64 -w0`, because the wrapping flag
is a GNU extension and the images are not contracted to provide one.

### Fail closed

A snapshot that did not demonstrably complete returns `PATCH_SNAPSHOT_UNKNOWN`
with an empty patch **flagged as a refusal**. An empty patch and a snapshot that
did not answer are the same string and must not be the same conclusion. §30 is
explicit that the repository is never written to in order to make a state
representable; there is no staging fallback.

## Boundary between intermediate and final

§27 allows the final post-agent extraction weaker observational constraints,
since mutating the index after the agent stops cannot influence its behaviour.
The weaker path was not taken: both use the same authority.

Nothing argued for a second mechanism. The final patch is index-independent, and
the dry run now demonstrates it — the fake agent leaves both a staged blob and a
staged add of a since-deleted file in the index all the way to submission, and
the final patch is byte-identical to the M193/M193A/M193B baselines regardless.

## The purity instrument

`repository_state_command()` captures HEAD, `git status --porcelain=v2 -z`, the
full index from `git ls-files -s -z`, and content hashes for every untracked and
every changed tracked path. Deliberately **not** scoped by the exclusion
pathspec: purity is a claim about the whole repository, including the regions
the snapshot is supposed to ignore.

It is used three ways, and the third is what makes the first two evidence:

1. around every snapshot in the dry-run lifecycle,
2. around every case in the synthetic matrix,
3. around the **superseded** command, on the same real container trees, where it
   reports 6 mutations.

Without (3), "0 mutations" would be indistinguishable from an instrument that
cannot report one — the M193B lesson about guards whose failure nobody can
construct on demand. The same reasoning drives the inventory's `gateCanFail`
self-test.
