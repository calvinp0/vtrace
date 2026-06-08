// Stage 5R workspace-prep tests (cross-repo helpers).
//
// These cover the PURE pieces of cross-repo preparation — repo→URL/dir mapping,
// lazy bench-clone creation, and CLI defaulting — without any network or git
// fetch. The actual fetch/index path is exercised by running the script for real
// against the SWE-bench data; these guard the logic that decides WHERE and HOW.

import assert from "node:assert/strict";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "bun:test";

import {
  CROSS_REPO_30_INSTANCES,
  CROSS_REPO_EXPANSION_INSTANCES,
  CROSS_REPO_INSTANCES,
  benchRepoDir,
  ensureBenchRepo,
  parsePrepareArgs,
  repoToGitUrl,
} from "./prepare_stage5_workspaces";

test("CROSS_REPO_INSTANCES is a 10–20 instance, entirely non-Django set", () => {
  assert.ok(CROSS_REPO_INSTANCES.length >= 10 && CROSS_REPO_INSTANCES.length <= 20);
  assert.ok(CROSS_REPO_INSTANCES.every((id) => !id.startsWith("django__")));
  // No duplicates.
  assert.equal(new Set(CROSS_REPO_INSTANCES).size, CROSS_REPO_INSTANCES.length);
  // Spans multiple repos (the whole point).
  const repos = new Set(CROSS_REPO_INSTANCES.map((id) => id.split("-").slice(0, -1).join("-")));
  assert.ok(repos.size >= 5, `expected >=5 distinct repos, got ${repos.size}`);
});

test("CROSS_REPO_30_INSTANCES is the 16-instance set plus a non-Django expansion, no dups", () => {
  // The 30-set is a superset of the 16-set and stays entirely non-Django.
  assert.ok(CROSS_REPO_30_INSTANCES.length >= 28 && CROSS_REPO_30_INSTANCES.length <= 32);
  assert.ok(CROSS_REPO_30_INSTANCES.every((id) => !id.startsWith("django__")));
  // No duplicate instance IDs anywhere in the combined set.
  assert.equal(new Set(CROSS_REPO_30_INSTANCES).size, CROSS_REPO_30_INSTANCES.length);
  // Every original-16 instance is carried forward.
  for (const id of CROSS_REPO_INSTANCES) assert.ok(CROSS_REPO_30_INSTANCES.includes(id));
  // The expansion adds NEW ids only (none already in the 16-set).
  assert.ok(CROSS_REPO_EXPANSION_INSTANCES.every((id) => !CROSS_REPO_INSTANCES.includes(id)));
  // Repo diversity grows: the 30-set spans more distinct repos than the 16-set,
  // including brand-new ones (xarray / seaborn / pylint).
  const repos = new Set(CROSS_REPO_30_INSTANCES.map((id) => id.replace(/-\d+$/, "")));
  assert.ok(repos.size >= 10, `expected >=10 distinct repos, got ${repos.size}`);
  assert.ok(CROSS_REPO_30_INSTANCES.some((id) => id.startsWith("pydata__xarray-")));
  assert.ok(CROSS_REPO_30_INSTANCES.some((id) => id.startsWith("mwaskom__seaborn-")));
  assert.ok(CROSS_REPO_30_INSTANCES.some((id) => id.startsWith("pylint-dev__pylint-")));
});

test("parsePrepareArgs --cross-repo-30 targets the 30-set on the cross_repo root", () => {
  const cfg = parsePrepareArgs(["--cross-repo-30"]);
  assert.equal(cfg.crossRepo, true);
  assert.deepEqual([...cfg.instances], [...CROSS_REPO_30_INSTANCES]);
  // Same cross_repo workspace root as the 16-set, so the indexed 16 are reused.
  assert.match(cfg.outRoot, /workspaces[\\/]cross_repo$/);
});

test("repoToGitUrl maps an owner/name slug to its GitHub URL", () => {
  assert.equal(repoToGitUrl("sympy/sympy"), "https://github.com/sympy/sympy.git");
  assert.equal(repoToGitUrl("psf/requests"), "https://github.com/psf/requests.git");
});

test("benchRepoDir uses the owner__name convention under the root", () => {
  assert.equal(benchRepoDir("/r", "sympy/sympy"), path.join("/r", "sympy__sympy"));
  assert.equal(benchRepoDir("/r", "pytest-dev/pytest"), path.join("/r", "pytest-dev__pytest"));
});

test("ensureBenchRepo creates a fresh git clone with an origin (no history fetch)", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "vtrace-r5r-bench-"));
  const dir = await ensureBenchRepo(root, "psf/requests");
  assert.equal(dir, path.join(root, "psf__requests"));
  assert.ok(existsSync(path.join(dir, ".git")));
  // Idempotent: a second call returns the same dir without throwing.
  const again = await ensureBenchRepo(root, "psf/requests");
  assert.equal(again, dir);
});

test("parsePrepareArgs --cross-repo flips defaults to the cross-repo set and root", () => {
  const cfg = parsePrepareArgs(["--cross-repo"]);
  assert.equal(cfg.crossRepo, true);
  assert.deepEqual([...cfg.instances], [...CROSS_REPO_INSTANCES]);
  assert.match(cfg.outRoot, /workspaces[\\/]cross_repo$/);
});

test("parsePrepareArgs default (no --cross-repo) keeps the Django expansion behavior", () => {
  const cfg = parsePrepareArgs([]);
  assert.equal(cfg.crossRepo, false);
  assert.match(cfg.outRoot, /workspaces[\\/]expanded$/);
  assert.ok(cfg.instances.every((id) => id.startsWith("django__")));
});

test("parsePrepareArgs honors explicit --instances / --out-root over the cross-repo defaults", () => {
  const cfg = parsePrepareArgs(["--cross-repo", "--instances", "a-1,b-2", "--out-root", "/tmp/custom"]);
  assert.deepEqual([...cfg.instances], ["a-1", "b-2"]);
  assert.equal(cfg.outRoot, "/tmp/custom");
});
