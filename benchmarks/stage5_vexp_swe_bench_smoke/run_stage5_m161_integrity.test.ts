import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { verifyInstance } from "./run_stage5_m161_integrity";

/**
 * §122/§123 — the integrity gate reports a count of CORPUS_INVALID cases, and a
 * zero from it is only evidence once the detector has been shown to fire. These
 * build real git repositories and drive the same code path the live gate uses.
 */

async function git(cwd: string, args: readonly string[]): Promise<string> {
  const proc = Bun.spawn(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t",
    },
  });
  const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  if (code !== 0) throw new Error(`git ${args.join(" ")} failed`);
  return out.trim();
}

let root = "";
let commit = "";

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "m161-integrity-"));
  const clone = path.join(root, "acme__pkg");
  await mkdir(path.join(clone, "pkg"), { recursive: true });
  await git(root, ["init", "-q", "-b", "main", "acme__pkg"]);
  await writeFile(path.join(clone, "pkg", "mod.py"), "x = 1\n");
  await writeFile(path.join(clone, "README.md"), "hi\n");
  await git(clone, ["add", "-A"]);
  await git(clone, ["commit", "-qm", "base"]);
  commit = await git(clone, ["rev-parse", "HEAD"]);
});

afterAll(async () => {
  if (root.length > 0) await rm(root, { recursive: true, force: true });
});

function kase(over: Partial<Parameters<typeof verifyInstance>[0]> = {}) {
  return {
    instanceId: "acme__pkg-1",
    repo: "acme/pkg",
    baseCommit: commit,
    expectedFiles: ["pkg/mod.py"],
    goldFilesCreatedByPatch: [] as string[],
    order: 1,
    ...over,
  };
}

describe("M161 integrity gate — known positives (§122)", () => {
  test("VALID when the revision resolves and every required gold file is in the tree", async () => {
    const record = await verifyInstance(kase(), root);
    expect(record.status).toBe("VALID");
    expect(record.failure).toBeNull();
    expect(record.commitResolved).toBe(true);
    expect(record.treePaths).toBe(2);
    expect(record.missingGoldFiles).toEqual([]);
    expect(record.attempts).toBe(1);
  });

  test("GOLD_FIXTURE_ABSENT_FROM_CHECKOUT fires when the gold path is not in the tree", async () => {
    const record = await verifyInstance(kase({ expectedFiles: ["pkg/gone.py"] }), root);
    expect(record.status).toBe("CORPUS_INVALID");
    expect(record.failure).toBe("GOLD_FIXTURE_ABSENT_FROM_CHECKOUT");
    expect(record.missingGoldFiles).toEqual(["pkg/gone.py"]);
    // The tree itself read fine — this is the half-extracted-source case M160 caught,
    // not an unavailable revision, and the two must not collapse into one bucket.
    expect(record.commitResolved).toBe(true);
    expect(record.treePaths).toBe(2);
  });

  test("SOURCE_REVISION_UNAVAILABLE fires when the base commit cannot be resolved", async () => {
    const record = await verifyInstance(kase({ baseCommit: "0".repeat(40) }), root);
    expect(record.status).toBe("CORPUS_INVALID");
    expect(record.failure).toBe("SOURCE_REVISION_UNAVAILABLE");
    expect(record.commitResolved).toBe(false);
    // §“one attempt is not a measurement” — it must have retried before concluding.
    expect(record.attempts).toBe(4);
  }, 60_000);

  test("a gold file the patch CREATES is not required to exist at base", async () => {
    const record = await verifyInstance(
      kase({ expectedFiles: ["pkg/mod.py", "pkg/new.py"], goldFilesCreatedByPatch: ["pkg/new.py"] }),
      root,
    );
    expect(record.status).toBe("VALID");
    expect(record.requiredGoldFiles).toEqual(["pkg/mod.py"]);
  });

  test("the tree hash binds tree membership", async () => {
    const first = await verifyInstance(kase(), root);
    const clone = path.join(root, "acme__pkg");
    await writeFile(path.join(clone, "pkg", "extra.py"), "y = 2\n");
    await git(clone, ["add", "-A"]);
    await git(clone, ["commit", "-qm", "extra"]);
    const moved = await verifyInstance(kase({ baseCommit: await git(clone, ["rev-parse", "HEAD"]) }), root);
    expect(moved.status).toBe("VALID");
    expect(moved.treeHash).not.toBe(first.treeHash);
  });
});
