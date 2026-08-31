/**
 * M193B §19 — the changed-source authority, falsified against real Git.
 *
 * M193A's report described the changed-source set as `git diff --cached
 * --name-only`. The committed implementation was `git add -A` -> that command
 * -> `git reset -q`, which read the working tree correctly but wrote to the
 * index to do it and collapsed a detected rename to its destination path.
 *
 * These controls do not re-implement either version. They build a real
 * repository containing every state a Claude Code arm can leave behind, run
 * the EXACT shell string production builds, and parse it with the EXACT parser
 * production parses with — so the test fails if the authority ever regresses
 * to something weaker, including regressing back to `--cached` alone.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const MODULE_DIR = import.meta.dir;

function sh(cmd: string, cwd: string): { out: string; code: number } {
  const r = spawnSync("bash", ["-c", cmd], { cwd, encoding: "utf8" });
  return { out: r.stdout ?? "", code: r.status ?? -1 };
}

/** Runs a snippet against the production Python modules, returning parsed JSON. */
function py(snippet: string): any {
  const r = spawnSync(
    "python3",
    ["-c", `import sys, json\nsys.path.insert(0, ${JSON.stringify(MODULE_DIR)})\n${snippet}`],
    { encoding: "utf8" },
  );
  if (r.status !== 0) throw new Error(`python failed: ${r.stderr}`);
  return JSON.parse(r.stdout);
}

/** The production command string, for the given pre-agent untracked snapshot. */
function productionCommand(preexisting: string[]): string {
  return py(
    `from m193b_changed_source import changed_source_command\n` +
      `print(json.dumps(changed_source_command(${JSON.stringify(preexisting)})))`,
  );
}

/** The production parser, over stdout production would have captured. */
function productionParse(stdout: string, root: string): any {
  return py(
    `from m193b_changed_source import parse_changed_source_output\n` +
      `print(json.dumps(parse_changed_source_output(${JSON.stringify(stdout)}, ${JSON.stringify(root)})))`,
  );
}

const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");

// ── the fixture: every change class an arm can produce, in one tree ─────

let repo: string;
let preexisting: string[];
/** The staged-then-further-edited bytes. C3's whole point. */
const C3_STAGED_S1 = "C3 = 1  # staged\n";
const C3_WORKTREE_S2 = "C3 = 2  # current bytes, never staged\n";

function write(rel: string, body: string): void {
  const abs = join(repo, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, body);
}

beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), "m193b-changed-source-"));
  sh("git init -q . && git config user.email t@t.t && git config user.name t && git config commit.gpgsign false", repo);
  write("pkg/c1_unstaged.py", "C1 = 0\n");
  write("pkg/c2_staged.py", "C2 = 0\n");
  write("pkg/c3_mixed.py", "C3 = 0\n");
  write("pkg/c5_deleted.py", "C5 = 0\n");
  write("pkg/c6_old_name.py", "C6 = 0\n");
  write(".gitignore", "*.ignored\n");
  sh("git add -A && git commit -qm base", repo);

  // The environment's own untracked build output, recorded BEFORE the agent
  // exists — exactly what M193A's setup() snapshots (§10).
  write("build/lib/env_artifact.py", "BUILD = 0\n");
  write("build/env_top.py", "BUILD = 0\n");
  preexisting = sh("git status --porcelain", repo)
    .out.split("\n")
    .filter((l) => l.startsWith("??"))
    .map((l) => l.slice(3).trim().replace(/\/$/, ""));

  // ── the agent ──
  write("pkg/c1_unstaged.py", "C1 = 1  # never staged\n"); // C1
  write("pkg/c2_staged.py", "C2 = 1\n");
  sh("git add pkg/c2_staged.py", repo); // C2
  write("pkg/c3_mixed.py", C3_STAGED_S1);
  sh("git add pkg/c3_mixed.py", repo);
  write("pkg/c3_mixed.py", C3_WORKTREE_S2); // C3: staged S1, worktree S2
  write("pkg/c4_new_untracked.py", "C4 = 1\n"); // C4
  sh("rm pkg/c5_deleted.py", repo); // C5
  sh("git mv pkg/c6_old_name.py pkg/c6_new_name.py", repo); // C6
  write("scratch.ignored", "ignored by .gitignore\n");
  write("build/env_top.py", "BUILD = 1  # agent touched a pre-agent artifact\n");
});

afterAll(() => rmSync(repo, { recursive: true, force: true }));

// ── §5 the golden anti-control ─────────────────────────────────────────

describe("§5 cached-only anti-control", () => {
  const cachedOnly = () =>
    sh("git diff --cached --name-only", repo).out.split("\n").filter(Boolean);

  test("misses an unstaged tracked edit", () => {
    expect(cachedOnly()).not.toContain("pkg/c1_unstaged.py");
  });

  test("misses a new untracked source file", () => {
    expect(cachedOnly()).not.toContain("pkg/c4_new_untracked.py");
  });

  test("misses an unstaged deletion", () => {
    expect(cachedOnly()).not.toContain("pkg/c5_deleted.py");
  });

  test("misses the vacated path of a rename", () => {
    // Rename detection is on by default since git 2.9, and --name-only prints
    // one path for an R100. This is the defect the production authority must
    // not share, and it is invisible unless asserted.
    expect(cachedOnly()).toContain("pkg/c6_new_name.py");
    expect(cachedOnly()).not.toContain("pkg/c6_old_name.py");
  });
});

// ── §4 the change-class matrix, through production's own bytes ─────────

describe("§4 production authority over C1–C7", () => {
  let rels: string[];
  let state: any;

  beforeAll(() => {
    const cmd = productionCommand(preexisting);
    const raw = sh(cmd, repo).out;
    state = productionParse(raw, "/testbed");
    rels = state.relativePaths;
  });

  test("the authority does not silently degrade to --cached", () => {
    expect(productionCommand(preexisting)).not.toContain("--cached");
    expect(productionCommand(preexisting)).not.toContain("add -A");
  });

  test("enumeration succeeded", () => {
    expect(state.ok).toBe(true);
    expect(state.error).toBeNull();
    expect(state.exitCodes).toEqual({ tracked: 0, untracked: 0 });
  });

  test("C1 unstaged modification", () => expect(rels).toContain("pkg/c1_unstaged.py"));
  test("C2 staged modification", () => expect(rels).toContain("pkg/c2_staged.py"));
  test("C3 staged + further unstaged", () => expect(rels).toContain("pkg/c3_mixed.py"));
  test("C4 new untracked source", () => expect(rels).toContain("pkg/c4_new_untracked.py"));
  test("C5 deletion", () => expect(rels).toContain("pkg/c5_deleted.py"));
  test("C6 rename keeps BOTH sides", () => {
    expect(rels).toContain("pkg/c6_new_name.py");
    expect(rels).toContain("pkg/c6_old_name.py");
  });

  test("C7 the mixed union, exactly once and nothing else", () => {
    expect(rels).toEqual([
      "pkg/c1_unstaged.py",
      "pkg/c2_staged.py",
      "pkg/c3_mixed.py",
      "pkg/c4_new_untracked.py",
      "pkg/c5_deleted.py",
      "pkg/c6_new_name.py",
      "pkg/c6_old_name.py",
    ]);
    expect(new Set(rels).size).toBe(rels.length);
  });

  test("§10 pre-existing untracked output is not an agent change", () => {
    expect(rels).not.toContain("build/lib/env_artifact.py");
    // Even after the agent writes to one: the exclusion is by path, and M193A's
    // frozen pre-agent snapshot is what decides ownership.
    expect(rels).not.toContain("build/env_top.py");
  });

  test("§9 gitignored files are not agent source", () => {
    expect(rels).not.toContain("scratch.ignored");
  });

  test("paths are absolute under the checkout root", () => {
    expect(state.paths).toContain("/testbed/pkg/c4_new_untracked.py");
    expect(state.paths.length).toBe(rels.length);
  });
});

// ── §3, §7 observation must not write ──────────────────────────────────

describe("§3 the authority does not mutate agent state", () => {
  test("the index and worktree are byte-identical across an observation", () => {
    const before = sh("git status --porcelain && git diff --cached | sha256sum && git diff | sha256sum", repo).out;
    sh(productionCommand(preexisting), repo);
    const after = sh("git status --porcelain && git diff --cached | sha256sum && git diff | sha256sum", repo).out;
    expect(after).toBe(before);
  });

  test("the agent's own staging survives (the add -A/reset pattern destroyed it)", () => {
    sh(productionCommand(preexisting), repo);
    const staged = sh("git diff --cached --name-only", repo).out.split("\n").filter(Boolean);
    expect(staged).toContain("pkg/c2_staged.py");
    expect(staged).toContain("pkg/c3_mixed.py");
  });
});

// ── §8 current bytes, not the staged blob ──────────────────────────────

describe("§8 current filesystem bytes are authoritative", () => {
  test("the staged blob and the worktree really do differ", () => {
    const stagedBlob = sh("git show :pkg/c3_mixed.py", repo).out;
    expect(stagedBlob).toBe(C3_STAGED_S1);
    expect(readFileSync(join(repo, "pkg/c3_mixed.py"), "utf8")).toBe(C3_WORKTREE_S2);
  });

  test("the source-version probe hashes S2, not the staged S1", () => {
    // End-to-end: enumerate with the production authority, then hand the result
    // to the production probe exactly as the container does.
    const raw = sh(productionCommand(preexisting), repo).out;
    const state = productionParse(raw, repo);
    const probe = py(
      `import importlib.util\n` +
        `spec = importlib.util.spec_from_file_location("p", ${JSON.stringify(join(MODULE_DIR, "m193a_source_version_probe.py"))})\n` +
        `m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)\n` +
        `print(json.dumps(m.probe(${JSON.stringify(join(repo, "pkg/c3_mixed.py"))}.split("\\u0000"))))`,
    );
    const rec = probe.files[0];
    expect(rec.sourceSha256).toBe(sha(C3_WORKTREE_S2));
    expect(rec.sourceSha256).not.toBe(sha(C3_STAGED_S1));
    expect(state.relativePaths).toContain("pkg/c3_mixed.py");
  });

  test("a deletion reaches the probe rather than vanishing", () => {
    const probe = py(
      `import importlib.util\n` +
        `spec = importlib.util.spec_from_file_location("p", ${JSON.stringify(join(MODULE_DIR, "m193a_source_version_probe.py"))})\n` +
        `m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)\n` +
        `print(json.dumps(m.probe([${JSON.stringify(join(repo, "pkg/c5_deleted.py"))}, ${JSON.stringify(join(repo, "pkg/c6_old_name.py"))}])))`,
    );
    // §11: absent source with no sourceless bytecode standing in for it is the
    // honest verdict; what matters is that the path was classified at all.
    expect(probe.files.map((f: any) => f.verdict)).toEqual([
      "COMPILED_FROM_CURRENT_SOURCE",
      "COMPILED_FROM_CURRENT_SOURCE",
    ]);
  });
});

// ── §2 the enumeration fails closed ────────────────────────────────────

describe("§2 an enumeration that did not complete is not an empty one", () => {
  const ok = 'pkg/a.py\n__M193B_TRACKED_RC=0\npkg/b.py\n__M193B_UNTRACKED_RC=0\n';

  test("a clean empty tree is ok with zero paths", () => {
    const r = productionParse("__M193B_TRACKED_RC=0\n__M193B_UNTRACKED_RC=0\n", "/testbed");
    expect(r.ok).toBe(true);
    expect(r.paths).toEqual([]);
  });

  test("the healthy shape parses to both halves", () => {
    const r = productionParse(ok, "/testbed");
    expect(r.ok).toBe(true);
    expect(r.relativePaths).toEqual(["pkg/a.py", "pkg/b.py"]);
    expect(r.trackedCount).toBe(1);
    expect(r.untrackedCount).toBe(1);
  });

  test("a failing git exit refuses, and reports no paths", () => {
    const r = productionParse("__M193B_TRACKED_RC=128\n__M193B_UNTRACKED_RC=0\n", "/testbed");
    expect(r.ok).toBe(false);
    expect(r.paths).toEqual([]);
    expect(r.error).toContain("128");
  });

  test("truncated output refuses rather than reporting a short set", () => {
    const r = productionParse("pkg/a.py\n__M193B_TRACKED_RC=0\npkg/b.py\n", "/testbed");
    expect(r.ok).toBe(false);
    expect(r.error).toContain("exit statuses");
  });

  test("a path git had to quote refuses rather than being split wrong", () => {
    const r = productionParse('"pkg/we\\nird.py"\n__M193B_TRACKED_RC=0\n__M193B_UNTRACKED_RC=0\n', "/testbed");
    expect(r.ok).toBe(false);
    expect(r.error).toContain("quoted form");
  });
});

// ── §5 the superseded implementation, reproduced ───────────────────────

describe("§5 the M193A add -A/--cached/reset implementation, on a throwaway copy", () => {
  let copy: string;

  beforeAll(() => {
    copy = mkdtempSync(join(tmpdir(), "m193b-superseded-"));
    sh(`cp -a ${JSON.stringify(repo)}/. ${JSON.stringify(copy)}/`, tmpdir());
  });
  afterAll(() => rmSync(copy, { recursive: true, force: true }));

  const superseded = (): string[] => {
    const excl = preexisting.map((p) => `':(exclude)${p}'`).join(" ");
    return sh(
      `git -c core.fileMode=false add -A -- . ${excl} >/dev/null 2>&1; ` +
        `git -c core.fileMode=false diff --cached --name-only; ` +
        `git reset -q >/dev/null 2>&1`,
      copy,
    ).out.split("\n").filter(Boolean);
  };

  test("it did see the unstaged and untracked classes", () => {
    const seen = superseded();
    expect(seen).toContain("pkg/c1_unstaged.py");
    expect(seen).toContain("pkg/c4_new_untracked.py");
    expect(seen).toContain("pkg/c5_deleted.py");
  });

  test("but it dropped the vacated path of a rename", () => {
    expect(superseded()).not.toContain("pkg/c6_old_name.py");
  });

  test("and each observation destroyed whatever the agent had staged", () => {
    // A pristine copy: the observations above have already reset `copy`, which
    // is itself the finding.
    const fresh = mkdtempSync(join(tmpdir(), "m193b-superseded-staging-"));
    try {
      sh(`cp -a ${JSON.stringify(repo)}/. ${JSON.stringify(fresh)}/`, tmpdir());
      const stagedBefore = sh("git diff --cached --name-only", fresh).out.split("\n").filter(Boolean);
      expect(stagedBefore).toContain("pkg/c2_staged.py");
      const excl = preexisting.map((p) => `':(exclude)${p}'`).join(" ");
      sh(
        `git -c core.fileMode=false add -A -- . ${excl} >/dev/null 2>&1; ` +
          `git -c core.fileMode=false diff --cached --name-only >/dev/null; ` +
          `git reset -q >/dev/null 2>&1`,
        fresh,
      );
      expect(sh("git diff --cached --name-only", fresh).out.split("\n").filter(Boolean)).toEqual([]);
    } finally {
      rmSync(fresh, { recursive: true, force: true });
    }
  });
});

// ── §12 the evidence record the classifier consumes ────────────────────

describe("§12 changedSourceFileCount is the enumerated set", () => {
  const evidence = (probe: any) =>
    py(
      `from m193b_changed_source import build_source_version_evidence\n` +
        `print(json.dumps(build_source_version_evidence(json.loads(${JSON.stringify(JSON.stringify(probe))}), ` +
        `is_validation_attempt=True, runner_started=True, state_hash_before="h", state_hash_after="h")))`,
    );

  test("a complete probe leaves the length guard satisfied", () => {
    const e = evidence({
      probeRan: true,
      requestedPaths: ["/testbed/a.py", "/testbed/b.py"],
      files: [{ verdict: "COMPILED_FROM_CURRENT_SOURCE" }, { verdict: "CACHE_MATCHES_CURRENT_SOURCE" }],
    });
    expect(e.changedSourceFileCount).toBe(2);
    expect(e.fileVerdicts.length).toBe(2);
  });

  test("a probe that answered for fewer files than were enumerated is detectable", () => {
    // Under M193A both sides came from `files`, so this could never be seen.
    const e = evidence({
      probeRan: true,
      requestedPaths: ["/testbed/a.py", "/testbed/b.py", "/testbed/c.py"],
      files: [{ verdict: "COMPILED_FROM_CURRENT_SOURCE" }],
    });
    expect(e.changedSourceFileCount).toBe(3);
    expect(e.fileVerdicts.length).toBe(1);
    expect(e.changedSourceFileCount).not.toBe(e.fileVerdicts.length);
  });

  test("a refused enumeration carries its reason and no phantom empty set", () => {
    const e = evidence({ probeRan: false, requestedPaths: [], error: "changed-source enumeration failed: x" });
    expect(e.probeRan).toBe(false);
    expect(e.changedSourceFileCount).toBe(0);
    expect(e.error).toContain("enumeration failed");
  });
});
