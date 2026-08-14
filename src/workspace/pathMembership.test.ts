import { describe, expect, test } from "bun:test";

import {
  createPathMembershipResolver,
  PathMembershipStatus,
  SelectedPathMembership,
  pathsShareSuffixBoundary,
  type PathMembershipScope,
} from "./pathMembership";

function scope(
  alias: string,
  worktreeRoot: string,
  paths: readonly string[],
): PathMembershipScope {
  return {
    worktreeId: `wt-${alias}`,
    repositoryId: `repo-${alias}`,
    alias,
    worktreeRoot,
    indexedPaths: () => paths,
  };
}

// Laid out as psf/requests actually was at 1724: the test file sits at the repo
// root, which is what lets the reporter's `/Users/hwkns/test_requests.py` line
// up on a segment boundary at all.
const REQUESTS = scope("requests", "/home/calvin/code/requests", [
  "requests/sessions.py",
  "requests/adapters.py",
  "requests/api.py",
  "test_requests.py",
]);

const URLLIB3 = scope("urllib3", "/home/calvin/code/urllib3", [
  "src/urllib3/connectionpool.py",
  "src/urllib3/response.py",
]);

describe("M145 path membership — single repository (§126)", () => {
  const resolve = (hint: string) => createPathMembershipResolver([REQUESTS]).resolve(hint);

  test("an absolute path inside the worktree naming an indexed file is exact", () => {
    const result = resolve("/home/calvin/code/requests/requests/sessions.py");

    expect(result.status).toBe(PathMembershipStatus.Exact);
    expect(result.worktreeId).toBe("wt-requests");
    expect(result.matches[0]?.kind).toBe("exact");
  });

  test("a repo-relative path resolves uniquely without any filesystem claim", () => {
    const result = resolve("requests/sessions.py");

    expect(result.status).toBe(PathMembershipStatus.UniqueResolved);
    expect(result.matches[0]?.kind).toBe("suffix");
  });

  test("a reporter's absolute path with a unique suffix resolves, but not as exact", () => {
    // M144's psf/requests-1724 case: this file never existed on this machine.
    const result = resolve("/Users/hwkns/test_requests.py");

    expect(result.status).toBe(PathMembershipStatus.UniqueResolved);
    expect(result.matches[0]?.matchedPaths).toEqual(["test_requests.py"]);
  });

  test("a reporter path whose suffix does not line up stays external", () => {
    // Sharing only a basename is not sharing a segment suffix: the repository
    // holds `test_requests.py`, and `hwkns/test_requests.py` is not a suffix of
    // it. The rule declines rather than reaching for the nearest filename.
    const nested = scope("nested", "/w/nested", ["tests/test_requests.py"]);
    const result = createPathMembershipResolver([nested]).resolve("/Users/hwkns/test_requests.py");

    expect(result.status).toBe(PathMembershipStatus.External);
  });

  test("a standard-library path outside the workspace is external, not unresolved", () => {
    expect(resolve("/usr/lib/python2.7/httplib.py").status).toBe(PathMembershipStatus.External);
  });

  test("an installed copy is judged by the indexed file list, never by site-packages", () => {
    // M144's django-12774: frames run through an installed copy of the very
    // repository under test, so the prefix cannot decide externality.
    const django = scope("django", "/home/calvin/code/django", ["django/db/models/query.py"]);
    const result = createPathMembershipResolver([django])
      .resolve("/app/venv/lib/python3.8/site-packages/django/db/models/query.py");

    expect(result.status).toBe(PathMembershipStatus.UniqueResolved);
  });

  test("a Windows-shaped installed path normalizes to the same answer", () => {
    const sphinx = scope("sphinx", "/home/calvin/code/sphinx", ["sphinx/domains/python.py"]);
    const result = createPathMembershipResolver([sphinx])
      .resolve("C:\\path\\to\\site-packages\\sphinx\\domains\\python.py");

    expect(result.status).toBe(PathMembershipStatus.UniqueResolved);
  });

  test("a bare relative fragment that matches nothing is unresolved, not external", () => {
    expect(resolve("nowhere/missing.py").status).toBe(PathMembershipStatus.Unresolved);
  });

  test("a deleted file is simply not a member", () => {
    expect(resolve("requests/removed_module.py").status).toBe(PathMembershipStatus.Unresolved);
  });
});

describe("M145 path membership — segment boundaries (§33)", () => {
  const resolve = createPathMembershipResolver([
    scope("a", "/w/a", ["foo/bar.py", "src/package/module.py"]),
  ]).resolve;

  test.each([
    ["myfoo/bar.py"],
    ["prefixfoo/bar.py"],
    ["foo/bar.py.bak"],
  ])("%s does not match foo/bar.py", (hint) => {
    expect(resolve(hint).status).not.toBe(PathMembershipStatus.UniqueResolved);
  });

  test("a genuine segment suffix does match", () => {
    expect(resolve("package/module.py").status).toBe(PathMembershipStatus.UniqueResolved);
  });

  test("the boundary rule is symmetric and rejects sibling directories", () => {
    expect(pathsShareSuffixBoundary("a/widgets.py", "b/widgets.py")).toBe(false);
    expect(pathsShareSuffixBoundary("related.py", "unrelated.py")).toBe(false);
    expect(pathsShareSuffixBoundary("src/a/widgets.py", "a/widgets.py")).toBe(true);
  });
});

describe("M145 path membership — workspace collisions (§30, §31, §35)", () => {
  const COLLIDING_A = scope("a", "/w/a", ["src/foo/bar.py"]);
  const COLLIDING_B = scope("b", "/w/b", ["src/foo/bar.py"]);

  test("the same relative path in two repositories is ambiguous, never resolved", () => {
    const result = createPathMembershipResolver([COLLIDING_A, COLLIDING_B]).resolve("src/foo/bar.py");

    expect(result.status).toBe(PathMembershipStatus.Ambiguous);
    expect(result.worktreeId).toBeNull();
    expect(result.matches.map((match) => match.alias).sort()).toEqual(["a", "b"]);
  });

  test("registration order does not decide an ambiguity", () => {
    const forward = createPathMembershipResolver([COLLIDING_A, COLLIDING_B]).resolve("src/foo/bar.py");
    const reversed = createPathMembershipResolver([COLLIDING_B, COLLIDING_A]).resolve("src/foo/bar.py");

    expect(forward.status).toBe(reversed.status);
    expect(forward.matches.map((match) => match.alias).sort())
      .toEqual(reversed.matches.map((match) => match.alias).sort());
  });

  test("a reporter's absolute path over a colliding suffix is ambiguous too", () => {
    const result = createPathMembershipResolver([
      scope("a", "/w/a", ["tests/test_requests.py"]),
      scope("b", "/w/b", ["tests/test_requests.py"]),
    ]).resolve("/Users/hwkns/tests/test_requests.py");

    expect(result.status).toBe(PathMembershipStatus.Ambiguous);
  });

  test("an exact path inside one worktree beats a colliding suffix elsewhere", () => {
    // Both members index `src/foo/bar.py`, so both produce a suffix match. Only
    // one of them CONTAINS the named location, and that outranks the other.
    const result = createPathMembershipResolver([
      scope("a", "/w/a", ["src/foo/bar.py"]),
      scope("b", "/w/b", ["src/foo/bar.py"]),
    ]).resolve("/w/a/src/foo/bar.py");

    expect(result.status).toBe(PathMembershipStatus.Exact);
    expect(result.worktreeId).toBe("wt-a");
    expect(result.matches).toHaveLength(1);
  });

  test("adding a colliding repository leaves an absolute path unambiguous", () => {
    const alone = createPathMembershipResolver([scope("a", "/w/a", ["src/foo/bar.py"])])
      .resolve("/w/a/src/foo/bar.py");
    const beside = createPathMembershipResolver([
      scope("a", "/w/a", ["src/foo/bar.py"]),
      scope("b", "/w/b", ["src/foo/bar.py"]),
    ]).resolve("/w/a/src/foo/bar.py");

    expect(beside.status).toBe(alone.status);
    expect(beside.worktreeId).toBe(alone.worktreeId);
  });

  test("a requests frame never resolves into urllib3 just because both are registered", () => {
    const result = createPathMembershipResolver([REQUESTS, URLLIB3]).resolve("requests/sessions.py");

    expect(result.status).toBe(PathMembershipStatus.UniqueResolved);
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0]?.alias).toBe("requests");
  });
});

describe("M145 path membership — the selected repository (§100)", () => {
  test("a path owned by another registered repository is external to the selected one", () => {
    const result = createPathMembershipResolver([REQUESTS, URLLIB3], "wt-requests")
      .resolve("src/urllib3/connectionpool.py");

    // Workspace-wide it resolves; for an A-routed request it is still outside.
    expect(result.status).toBe(PathMembershipStatus.UniqueResolved);
    expect(result.selected).toBe(SelectedPathMembership.ExternalToSelected);
    expect(result.matches[0]?.alias).toBe("urllib3");
  });

  test("a path the selected repository owns is a member", () => {
    const result = createPathMembershipResolver([REQUESTS, URLLIB3], "wt-requests")
      .resolve("requests/adapters.py");

    expect(result.selected).toBe(SelectedPathMembership.Member);
  });

  test("standard-library paths stay external for the selected repository", () => {
    const result = createPathMembershipResolver([REQUESTS, URLLIB3], "wt-requests")
      .resolve("/usr/lib/python2.7/httplib.py");

    expect(result.selected).toBe(SelectedPathMembership.External);
  });
});

describe("M145 path membership — cost (§74, §118)", () => {
  test("a task with no path evidence reads no path list", () => {
    const resolver = createPathMembershipResolver([REQUESTS]);

    expect(resolver.materialized()).toBe(false);
  });

  test("repeated hints reuse one prepared index", () => {
    let reads = 0;
    const counted: PathMembershipScope = {
      ...REQUESTS,
      indexedPaths: () => {
        reads += 1;
        return ["requests/sessions.py"];
      },
    };
    const resolver = createPathMembershipResolver([counted]);
    resolver.resolve("requests/sessions.py");
    resolver.resolve("requests/other.py");
    resolver.resolve("requests/sessions.py");

    expect(reads).toBe(1);
  });
});
