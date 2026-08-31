/**
 * M193C §20 — the patch-snapshot authority, falsified against real Git.
 *
 * M193/M193A/M193B captured the interactive diff with `git add -A` ->
 * `git diff --cached` -> `git reset`. The bytes were right and the subject was
 * destroyed to get them: a mixed reset unstages everything, so an agent that
 * deliberately staged work had its index emptied by the instrument measuring
 * it, and a staged rename came back as an untracked file.
 *
 * These controls do not re-implement either version. They build a real
 * repository containing every Git state a Claude Code arm can leave behind,
 * run the EXACT shell string production runs, parse it with the EXACT parser
 * production parses with, and fingerprint the repository either side of the
 * observation — so the test fails if the authority ever regresses to something
 * that writes, including regressing back to `add -A`/`reset`.
 *
 * The first control runs the OLD command on purpose. A purity assertion that
 * has never seen an impure observation has not been shown to be able to fail.
 */

import { beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const MODULE_DIR = import.meta.dir;

function sh(cmd: string, cwd: string): { out: string; code: number } {
  const r = spawnSync("bash", ["-c", cmd], { cwd, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  return { out: r.stdout ?? "", code: r.status ?? -1 };
}

/** Runs a snippet against the production Python modules, returning parsed JSON. */
function py(snippet: string): any {
  const r = spawnSync(
    "python3",
    ["-c", `import sys, json\nsys.path.insert(0, ${JSON.stringify(MODULE_DIR)})\n${snippet}`],
    { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
  );
  if (r.status !== 0) throw new Error(`python failed: ${r.stderr}`);
  return JSON.parse(r.stdout);
}

const q = (v: unknown) => JSON.stringify(v);

/** The exact production command strings. */
const patchCommand = (pre: string[]): string =>
  py(
    `from m193c_patch_snapshot import patch_snapshot_command\n` +
      `print(json.dumps(patch_snapshot_command(${q(pre)})))`,
  );
const stateCommand = (): string =>
  py(`from m193c_patch_snapshot import repository_state_command\nprint(json.dumps(repository_state_command()))`);

/** The production parser, over stdout production would have captured. */
const parseSnapshot = (stdout: string): any =>
  py(
    `from m193c_patch_snapshot import parse_patch_snapshot_output\n` +
      `print(json.dumps(parse_patch_snapshot_output(${q(stdout)}, "/testbed")))`,
  );
const parseState = (stdout: string): any =>
  py(
    `from m193c_patch_snapshot import parse_repository_state_output\n` +
      `print(json.dumps(parse_repository_state_output(${q(stdout)})))`,
  );
// The states go over as JSON *text* and are parsed on the Python side: `true`
// and `null` are not Python literals, so interpolating the objects into source
// would be a NameError rather than a comparison.
const stateDiff = (before: any, after: any): string[] =>
  py(
    `from m193c_patch_snapshot import repository_state_differences\n` +
      `print(json.dumps(repository_state_differences(json.loads(${q(JSON.stringify(before))}), ` +
      `json.loads(${q(JSON.stringify(after))}))))`,
  );

/** The pre-M193C production command, kept only so purity can be shown to fail. */
const INVASIVE_COMMAND =
  "git -c core.fileMode=false add -A -- . >/dev/null 2>&1; " +
  "git -c core.fileMode=false diff --cached; rc=$?; git reset -q >/dev/null 2>&1; exit $rc";

let PATCH_CMD: string;
let STATE_CMD: string;

beforeAll(() => {
  PATCH_CMD = patchCommand([]);
  STATE_CMD = stateCommand();
});

function newRepo(name: string): string {
  const repo = mkdtempSync(join(tmpdir(), `m193c-${name}-`));
  sh("git init -q . && git config user.email t@t.t && git config user.name t && git config commit.gpgsign false", repo);
  return repo;
}

function write(repo: string, rel: string, body: string): void {
  const abs = join(repo, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, body);
}

function captureState(repo: string): any {
  return parseState(sh(STATE_CMD, repo).out);
}

/** Observe, and report both the answer and everything the observation moved. */
function observe(repo: string, pre: string[] = []): { snap: any; moved: string[] } {
  const before = captureState(repo);
  const cmd = pre.length ? patchCommand(pre) : PATCH_CMD;
  const snap = parseSnapshot(sh(cmd, repo).out);
  const after = captureState(repo);
  return { snap, moved: stateDiff(before, after) };
}

/** The base commit every fixture starts from. */
function base(repo: string): void {
  write(repo, "A.py", "S0\n");
  write(repo, "C.py", "keep\n");
  write(repo, "D.py", "del\n");
  write(repo, "E_old.py", "old\n");
  sh("git add -A && git commit -qm base", repo);
}

// ── §35 G1 — the defect the milestone exists to close ───────────────────

describe("G1 the pre-M193C capture mutated the agent's index", () => {
  test("add -A / diff --cached / reset destroys staged state, and the purity probe sees it", () => {
    const repo = newRepo("g1");
    base(repo);
    write(repo, "A.py", "S1\n");
    sh("git add A.py", repo);
    write(repo, "A.py", "S2\n");
    sh("git mv E_old.py E_new.py", repo);

    const stagedBefore = sh("git ls-files -s A.py", repo).out.trim();
    const before = captureState(repo);
    sh(INVASIVE_COMMAND, repo);
    const after = captureState(repo);
    const stagedAfter = sh("git ls-files -s A.py", repo).out.trim();

    expect(stagedAfter).not.toBe(stagedBefore);
    const moved = stateDiff(before, after);
    expect(moved).toContain("index changed");
    expect(moved).toContain("status changed");
    // the staged rename came back as an untracked file
    expect(sh("git status --porcelain", repo).out).toContain("?? E_new.py");
  });
});

// ── §35 G2 — the replacement issues no mutating verb ────────────────────

describe("G2 the snapshot command performs no repository write", () => {
  test("no add / reset / restore / checkout / stash / commit anywhere in the command", () => {
    for (const cmd of [patchCommand([]), patchCommand(["build/", "docs/_build/"]), stateCommand()]) {
      expect(cmd).not.toMatch(/git\b[^;|]*\b(add|reset|restore|checkout|stash|commit|update-index|apply|mv|rm)\b/);
    }
  });

  test("every git verb used is a reader", () => {
    const verbs = new Set(
      [
        ...patchCommand([]).matchAll(/git(?:\s+-c\s+\S+)*\s+([a-z-]+)/g),
        ...stateCommand().matchAll(/git(?:\s+-c\s+\S+)*\s+([a-z-]+)/g),
      ].map((m) => m[1]),
    );
    expect([...verbs].sort()).toEqual(["diff", "ls-files", "rev-parse", "status"]);
  });
});

// ── §20 the P1..P7 matrix ───────────────────────────────────────────────

type Case = {
  id: string;
  build: (repo: string) => void;
  /** substrings the captured patch must contain */
  expect: string[];
  /** substrings the captured patch must NOT contain */
  reject?: string[];
};

const CASES: Case[] = [
  {
    id: "P1 staged only",
    build: (r) => {
      write(r, "A.py", "S1\n");
      sh("git add A.py", r);
    },
    expect: ["diff --git a/A.py b/A.py", "+S1"],
  },
  {
    id: "P2 unstaged only",
    build: (r) => write(r, "C.py", "keep-modified\n"),
    expect: ["diff --git a/C.py b/C.py", "+keep-modified"],
  },
  {
    id: "P3 staged S1 + unstaged S2",
    build: (r) => {
      write(r, "A.py", "S1\n");
      sh("git add A.py", r);
      write(r, "A.py", "S2\n");
    },
    expect: ["diff --git a/A.py b/A.py", "+S2"],
    reject: ["+S1"],
  },
  {
    id: "P4 untracked only",
    build: (r) => write(r, "B.py", "brand new\n"),
    expect: ["diff --git a/B.py b/B.py", "new file mode 100644", "+brand new"],
  },
  {
    id: "P5 deletion",
    build: (r) => sh("git rm -q D.py", r),
    expect: ["diff --git a/D.py b/D.py", "deleted file mode 100644", "-del"],
  },
  {
    id: "P6 rename",
    build: (r) => sh("git mv E_old.py E_new.py", r),
    // §19: delete-plus-add is the permitted representation, and unlike R100 it
    // carries the new file's content
    expect: ["diff --git a/E_new.py b/E_new.py", "diff --git a/E_old.py b/E_old.py", "deleted file mode 100644"],
    reject: ["similarity index", "rename from"],
  },
  {
    id: "P7 mixed all classes",
    build: (r) => {
      write(r, "A.py", "S1\n");
      sh("git add A.py", r);
      write(r, "A.py", "S2\n");
      write(r, "C.py", "keep-modified\n");
      write(r, "B.py", "brand new\n");
      sh("git rm -q --cached D.py && rm -f D.py", r);
      sh("git mv E_old.py E_new.py", r);
    },
    expect: ["+S2", "+keep-modified", "+brand new", "a/D.py", "a/E_new.py", "a/E_old.py"],
    reject: ["+S1", "similarity index"],
  },
];

describe("§20 Git-state purity matrix", () => {
  for (const c of CASES) {
    test(c.id, () => {
      const repo = newRepo(c.id.split(" ")[0].toLowerCase());
      base(repo);
      c.build(repo);

      const statusBefore = sh("git status --porcelain=v2", repo).out;
      const indexBefore = sh("git ls-files -s", repo).out;
      const { snap, moved } = observe(repo);

      // discovered and represented
      expect(snap.ok).toBe(true);
      expect(snap.status).toBe("PATCH_SNAPSHOT_OK");
      for (const s of c.expect) expect(snap.patch).toContain(s);
      for (const s of c.reject ?? []) expect(snap.patch).not.toContain(s);

      // preserved: index, worktree, untracked, status
      expect(moved).toEqual([]);
      expect(sh("git ls-files -s", repo).out).toBe(indexBefore);
      expect(sh("git status --porcelain=v2", repo).out).toBe(statusBefore);
    });
  }
});

// ── §14 the primary falsification ───────────────────────────────────────

describe("§14 staged S1 + unstaged S2", () => {
  test("captures S2 and leaves S1 in the index", () => {
    const repo = newRepo("s1s2");
    base(repo);
    write(repo, "A.py", "S1\n");
    sh("git add A.py", repo);
    write(repo, "A.py", "S2\n");

    const stagedBlob = sh("git rev-parse :A.py", repo).out.trim();
    const worktreeBlob = sh("git hash-object A.py", repo).out.trim();
    expect(stagedBlob).not.toBe(worktreeBlob);

    const { snap, moved } = observe(repo);
    expect(snap.patch).toContain("+S2");
    expect(snap.patch).not.toContain("+S1");
    expect(moved).toEqual([]);
    expect(sh("git rev-parse :A.py", repo).out.trim()).toBe(stagedBlob);
    expect(sh("git hash-object A.py", repo).out.trim()).toBe(worktreeBlob);
    expect(sh("git status --porcelain A.py", repo).out.trim()).toBe("MM A.py");
    expect(snap.gitState.staged).toContain("A.py");
    expect(snap.gitState.unstaged).toContain("A.py");
  });
});

// ── §10 exclusion, §11 canonicalisation, §12 classification ─────────────

describe("§10 pre-agent untracked baseline", () => {
  test("environment build output stays out of the patch; agent files stay in", () => {
    const repo = newRepo("excl");
    base(repo);
    write(repo, "build/artifact.o", "environment\n");
    write(repo, "agent_new.py", "agent\n");

    const { snap, moved } = observe(repo, ["build"]);
    expect(snap.patch).toContain("a/agent_new.py");
    expect(snap.patch).not.toContain("artifact.o");
    expect(snap.untrackedPaths).toEqual(["agent_new.py"]);
    expect(moved).toEqual([]);
  });
});

describe("§11 canonicalisation", () => {
  test("one patch in git's own path order regardless of which lane a file came through", () => {
    const repo = newRepo("order");
    base(repo);
    write(repo, "A.py", "S2\n"); // tracked
    write(repo, "B.py", "new\n"); // untracked, sorts between A and C
    write(repo, "C.py", "keep-modified\n"); // tracked
    const { snap } = observe(repo);
    const order = [...snap.patch.matchAll(/^diff --git a\/(\S+) b\//gm)].map((m: any) => m[1]);
    expect(order).toEqual(["A.py", "B.py", "C.py"]);
  });

  test("the same tree produces the same bytes twice", () => {
    const repo = newRepo("determinism");
    base(repo);
    write(repo, "A.py", "S2\n");
    write(repo, "z_new.py", "z\n");
    write(repo, "a_new.py", "a\n");
    expect(observe(repo).snap.patch).toBe(observe(repo).snap.patch);
  });

  test("an empty untracked file is still a new file", () => {
    const repo = newRepo("empty");
    base(repo);
    write(repo, "__init__.py", "");
    const { snap, moved } = observe(repo);
    expect(snap.patch).toContain("diff --git a/__init__.py b/__init__.py");
    expect(snap.patch).toContain("new file mode 100644");
    expect(moved).toEqual([]);
  });

  test("an untracked binary is classified rather than mistaken for text", () => {
    const repo = newRepo("binary");
    base(repo);
    writeFileSync(join(repo, "blob.dat"), Buffer.from([0, 1, 2, 255, 0, 7]));
    const { snap, moved } = observe(repo);
    expect(snap.binaryPaths).toEqual(["blob.dat"]);
    expect(snap.patch).toContain("Binary files /dev/null and b/blob.dat differ");
    expect(moved).toEqual([]);
  });

  test("the executable bit follows core.fileMode=false, and the real mode is recorded not erased", () => {
    const repo = newRepo("mode");
    base(repo);
    write(repo, "run.sh", "#!/bin/sh\necho hi\n");
    chmodSync(join(repo, "run.sh"), 0o755);
    const { snap } = observe(repo);
    // what `add -A` under core.fileMode=false produced before M193C
    expect(snap.patch).toContain("new file mode 100644");
    expect(snap.patch).not.toContain("new file mode 100755");
    expect(snap.untrackedRealModes).toEqual({ "run.sh": "100755" });
  });
});

describe("§12 the agent's Git state is recorded, not erased", () => {
  test("staged, unstaged, untracked, deleted and renamed are reported separately", () => {
    const repo = newRepo("classify");
    base(repo);
    write(repo, "A.py", "S1\n");
    sh("git add A.py", repo);
    write(repo, "A.py", "S2\n");
    write(repo, "C.py", "keep-modified\n");
    write(repo, "B.py", "new\n");
    sh("git rm -q --cached D.py && rm -f D.py", repo);
    sh("git mv E_old.py E_new.py", repo);

    const { snap } = observe(repo);
    expect(snap.gitState.staged).toEqual(["A.py", "D.py", "E_new.py"]);
    expect(snap.gitState.unstaged).toEqual(["A.py", "C.py"]);
    expect(snap.gitState.untracked).toEqual(["B.py"]);
    expect(snap.gitState.deleted).toEqual(["D.py"]);
    expect(snap.gitState.renamed).toEqual(["E_old.py -> E_new.py"]);
  });
});

// ── §30 failure semantics ───────────────────────────────────────────────

describe("§30 a snapshot that did not answer is not an empty patch", () => {
  test("truncated output is refused", () => {
    const r = parseSnapshot("TN  0\nTP  0\n");
    expect(r.ok).toBe(false);
    expect(r.status).toBe("PATCH_SNAPSHOT_UNKNOWN");
    expect(r.patch).toBe("");
  });

  test("a non-zero git exit is refused rather than read as no changes", () => {
    const r = parseSnapshot("TN  128\nTP  128\nST  0\nUL 0\nEND\n");
    expect(r.ok).toBe(false);
    expect(r.error).toContain("exited 128");
  });

  test("names and chunks disagreeing is refused", () => {
    const b64 = (s: string) => Buffer.from(s).toString("base64");
    const stdout =
      `TN ${b64("A.py\0B.py\0")} 0\n` +
      `TP ${b64("diff --git a/A.py b/A.py\n@@ -1 +1 @@\n-x\n+y\n")} 0\n` +
      `ST  0\nUL 0\nEND\n`;
    const r = parseSnapshot(stdout);
    expect(r.ok).toBe(false);
    expect(r.error).toContain("1 chunk(s) for 2 named path(s)");
  });

  test("a genuinely clean tree is OK and empty, not a refusal", () => {
    const repo = newRepo("clean");
    base(repo);
    const { snap, moved } = observe(repo);
    expect(snap.ok).toBe(true);
    expect(snap.patch).toBe("");
    expect(moved).toEqual([]);
  });
});

// ── §22 the fake agent stages deliberately ──────────────────────────────

describe("§22 an agent that stages sees the state it created", () => {
  test("stage, edit again, observe repeatedly, then read git status", () => {
    const repo = newRepo("fakeagent");
    base(repo);

    // the agent edits and stages, exactly as a Bash-capable arm can
    write(repo, "A.py", "S1\n");
    sh("git add A.py", repo);
    const intendedIndex = sh("git ls-files -s", repo).out;

    // ... and then edits again without staging
    write(repo, "A.py", "S2\n");
    const intendedStatus2 = sh("git status --porcelain", repo).out;
    const intendedIndex2 = sh("git ls-files -s", repo).out;
    expect(intendedIndex2).toBe(intendedIndex);
    expect(intendedStatus2.trim()).toBe("MM A.py");

    // telemetry observes three times, as a lifecycle would
    for (let i = 0; i < 3; i++) {
      const { snap, moved } = observe(repo);
      expect(snap.patch).toContain("+S2");
      expect(moved).toEqual([]);
    }

    // the agent's next command sees exactly what it created
    expect(sh("git status --porcelain", repo).out).toBe(intendedStatus2);
    expect(sh("git ls-files -s", repo).out).toBe(intendedIndex2);
    expect(sh("git diff --cached --name-only", repo).out.trim()).toBe("A.py");
  });
});
