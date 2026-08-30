# M193 — host-agent / container execution contract

Frozen before any live agent call. Nothing in this document is optional at run
time; the launcher asserts each clause and refuses to spawn a model if one fails.

## 1. Why there is a seam at all

M191 established that the shared `.bench-repos` host environment cannot validate:
dependencies are absent, the runner does not start, and 486 of 486 guarded arms
carried a harness-wipe signature. M192 then established that the substrate that
*can* validate already exists — one prebuilt Docker image per SWE-bench instance,
with the repository's own dependencies and a `/testbed` checkout — and recommended
`HOST_AGENT_CONTAINER_EXECUTION_PREFERRED`.

That recommendation leaves one question open, and it is the question this document
answers: the agent's file tools run on the host, and the interpreter that can
actually import the package runs in the container. Those two must address the same
bytes.

## 2. One authoritative mutable checkout

There is no host checkout *and* a container checkout. There is one tree:

```
  <arm_root>/testbed          (host path, owned by the host user)
        │
        └── bind-mounted at /testbed inside the instance container
```

Established once per arm:

1. `docker create` a throwaway container from the instance image.
2. `docker cp <c>:/testbed <arm_root>/testbed` — extract the checkout, with its
   build output and compiled extensions, to the host.
3. Remove the throwaway container.
4. `docker run -d -v <arm_root>/testbed:/testbed --workdir /testbed <image>`.

The mount path inside the container is `/testbed`, unchanged, so the image's
editable install — a `.pth` or `egg-link` naming that absolute path — keeps
resolving. This was verified rather than assumed: under the mount,
`flask.__file__` is `/testbed/src/flask/__init__.py`, and a value written to that
file from the host is read back by the container's interpreter.

There is no synchronisation step because there is nothing to synchronise.

**Consequence for §39.** `authoritativeCheckoutMaintained` is an assertion the
launcher can actually check: the mount must still be present, and the container's
`/testbed` and the host's `<arm_root>/testbed` must report the same inode for a
canary file at the end of the arm. If they diverge the run is `RUN_INVALID`.

## 3. What the checkout is at the moment the agent starts

The instance image's `/testbed` is **not** at the task's base commit. It sits at a
later branch tip of which the base commit is an ancestor; swebench's own eval
script checks the base out at run time. The arm setup does the same:

```
git config --global --add safe.directory /testbed   # the mount gives the tree host
                                                    # ownership while the container
                                                    # runs as root
git checkout -f <base_commit>
```

and then asserts `git rev-parse HEAD == base_commit`. An arm that cannot reach its
own base commit is `PREFLIGHT_FAILED` and no model is launched.

## 4. Command routing (§25)

```
  agent issues Bash(command)
        │
        ▼
  PreToolUse hook rewrites updatedInput.command
        │
        ▼
  docker exec  --workdir /testbed  --user root
        trap 'chown -R <host_uid>:<host_gid> /testbed' EXIT
        source /opt/miniconda3/bin/activate && conda activate <env>
        cd /testbed
        <command>
        │
        ▼
  stdout / stderr / exit status returned to the agent unchanged
```

**Everything runs in the container. Nothing runs on the host.** §25 warns against
an ambiguous hybrid, and a command classifier would produce exactly one: `pwd`
would answer about the host while `pytest` answered about the container, and the
agent would be reasoning about two filesystems at once. Because the checkout is a
single tree visible at the same path from both sides, routing everything is both
simpler and semantically total.

Classification of the examples §25 asks about is therefore uniform:

| command | runs |
|---|---|
| `pwd`, `ls`, `cat`, `grep`, `rg` | container |
| `git diff`, `git status` | container |
| `python`, `pytest`, project test runner | container |
| build commands | container |
| file writes from Bash | container |
| file writes from Read/Edit/Write/Glob/Grep | host, same inodes |

### 4.1 The conda activation is not optional

The image's default interpreter is the miniconda **base** environment, in which
the project package is simply absent — `import flask` raises `ModuleNotFoundError`
in an unmodified `pallets/flask` container. SWE-bench's eval script activates a
per-instance environment first, and the adapter reproduces that exactly. The
environment name is read out of the instance's own generated eval script rather
than hardcoded.

An adapter that skipped this would hand the agent an interpreter that cannot
import the code it is editing, and every validation attempt in the corpus would
be a false negative.

### 4.2 The ownership trap

`docker cp` writes the extracted tree as the host user; the container runs as
root. Two consequences, both handled:

* git refuses to operate across the ownership boundary until told the directory is
  safe — hence the `safe.directory` call in setup.
* A file the container creates is root-owned on the host, and the agent's `Edit`
  tool would then fail with `EACCES`. The wrapper's `EXIT` trap normalises
  ownership after every command, including commands that end in `exec` or `exit`.

### 4.3 The workdir is passed explicitly, always

`docker exec` inherits the image's `WORKDIR` when none is supplied. M192 showed
that `psf/requests` resolves an installed copy from any working directory other
than the checkout, and that its validation is correct today only because the eval
script happens to `cd /testbed` first. The adapter never relies on that: `workdir`
is an explicit argument on every call, and `workdirIsPinned()` is asserted per
validation event.

The one deliberate exception is the robustness probe, which must observe what
happens *without* the pin. It passes `pin_cwd=False`. This is not a loophole — it
is the measurement, and an early version of this harness that lacked it reported
`psf/requests` as `EDITABLE_INSTALL`, which is false. An instrument has to be able
to step outside the guarantee it is verifying.

## 5. Patch extraction

```
git -c core.fileMode=false add -A -- . ':(exclude)<preexisting untracked>' ...
git -c core.fileMode=false diff --cached
git reset -q
```

The exclusion list is captured **before the agent exists**, from
`git status --porcelain` immediately after the base checkout. It is not a guess:
`psf/requests-1142` ships an untracked `build/` directory inside `/testbed`, and a
naive `git add -A` — which is what vexp-swe-bench's `capturePatch` does — would
put environment build output into the model patch. Files the agent creates are
still captured, because SWE-bench permits new source files.

`core.fileMode=false` is set because the bind mount can perturb modes.

## 6. Credentials and the trust boundary (§35)

```
   host                                  container
   ────────────────────────────          ─────────────────────────
   Claude Code CLI                       bash, python, pytest, git
   credentials                           the checkout
   model API connection
        │  command text  ─────────────▶
        ◀───────────────  bytes
```

No API key, credential file, token or config directory is copied into a SWE-bench
image. The container receives shell command text and returns stdout, stderr and an
exit status. No committed artifact contains a credential.

## 7. Cleanup and isolation

Every container is named `m193-<instance_id>` so ownership is unambiguous. Teardown
removes the container and the host mount. Arms never share a mount, a container, or
a container name. The preflight verifies the cleanup path before the model is
launched, not after.

## 8. Two hooks, declared

The acquisition installs exactly two hooks, passed explicitly with `--settings`:

| hook | purpose | visible to the model? |
|---|---|---|
| `PreToolUse` on `Bash` | rewrite `updatedInput.command` to route into the container | no — the model sees ordinary Bash output |
| `PostToolUse` on `Edit`/`Write`/`Bash`, and `Stop` | record a diff snapshot at a boundary | no — the hooks emit no additional context |

Neither adds text to the model's context, neither alters what the model is asked
to do, and both apply identically to every arm. They are the execution substrate,
not a treatment. They are declared here rather than left implicit precisely
because §33 requires that the distinction be legible.

## 9. Preconditions the launcher enforces per arm

From `stage5_m193_treatment_audit.json`:

1. a private `CLAUDE_CONFIG_DIR` containing credentials only — this host has a
   user-level `~/.claude/CLAUDE.md` that would otherwise be loaded into every arm;
2. an explicitly constructed environment with no `VTRACE_*` or `VEXP_*` key;
3. a working directory under the arm mount root, never inside the vtrace repo;
4. an empty MCP config with `--strict-mcp-config`;
5. `--settings` naming only the two hooks above;
6. the Claude Code CLI version asserted before launch;
7. any instruction file native to the benchmark repository recorded separately
   from experimental injection, and preserved.

A failed precondition is `TREATMENT_CONTAMINATION`: the arm is `RUN_INVALID` and is
not rerunnable.
