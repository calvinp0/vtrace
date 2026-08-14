// M145 §98/§157: does M144's path membership answer the same way through the
// M145 resolver?
//
// The collapse argument is that with one scope `ambiguous` cannot arise and
// `exact` implies a suffix match, so `exact | unique_resolved` is exactly the
// set M144's boolean called true. An argument is not evidence. This replays
// M144's own corpus of path shapes through BOTH forms — the legacy single-repo
// predicate and the workspace-aware resolver — and requires them to agree on
// every case.
//
// No agent, Docker, VEXP, network, or paid API is used.

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { createRepositoryPathPredicate } from "../../src/retrieval/repositoryPathMembership";
import {
  createPathMembershipResolver,
  PathMembershipStatus,
} from "../../src/workspace/pathMembership";

/**
 * The path shapes M144 recorded, with the repository layout each one was
 * observed against. Every entry is a real shape from the M144 corpus, not an
 * invented one: the five in `§4` of its final report plus the frame cases that
 * motivated the milestone.
 */
const CORPUS = [
  {
    case: "requests-1724 deepest in-repo frame",
    indexed: ["requests/sessions.py", "requests/adapters.py", "requests/api.py", "test_requests.py"],
    hints: [
      "requests/sessions.py",
      "/Users/hwkns/test_requests.py",
      "/usr/lib/python2.7/httplib.py",
      "/usr/lib/python2.7/socket.py",
    ],
  },
  {
    case: "django-12774 frames through an installed copy",
    indexed: ["django/db/models/query.py", "django/db/models/sql/compiler.py"],
    hints: [
      "/app/venv/lib/python3.8/site-packages/django/db/models/query.py",
      "django/db/models/query.py",
      "./django/db/models/sql/compiler.py",
      "/usr/lib/python3.8/sre_parse.py",
    ],
  },
  {
    case: "xarray-3677 repo-relative shapes",
    indexed: ["xarray/core/merge.py", "xarray/core/dataset.py"],
    hints: ["xarray/core/merge.py", "./xarray/core/dataset.py", "core/merge.py", "/usr/lib/python3.8/copy.py"],
  },
  {
    case: "pylint-8898 windows and installed shapes",
    indexed: ["pylint/config/argument.py", "pylint/lint/pylinter.py"],
    hints: [
      "\\path\\to\\site-packages\\pylint\\config\\argument.py",
      "pylint/config/argument.py",
      "C:/venv/lib/site-packages/pylint/lint/pylinter.py",
      "/usr/lib/python3.10/re.py",
    ],
  },
  {
    case: "sympy-13372 evalf shapes",
    indexed: ["sympy/core/evalf.py", "sympy/core/mul.py"],
    hints: ["./sympy/core/evalf.py", "sympy/core/mul.py", "core/evalf.py", "/usr/lib/python3.9/inspect.py"],
  },
  {
    case: "negative controls: near-miss segment boundaries",
    indexed: ["foo/bar.py", "a/widgets.py", "related.py"],
    hints: ["myfoo/bar.py", "foo/bar.py.bak", "prefixfoo/bar.py", "b/widgets.py", "unrelated.py", "foo/bar.py"],
  },
] as const;

async function main(): Promise<void> {
  const outDir = path.resolve(process.argv[2] ?? "benchmarks/stage5_vexp_swe_bench_smoke/results");
  const rows = [];
  let disagreements = 0;

  for (const entry of CORPUS) {
    const legacy = createRepositoryPathPredicate(entry.indexed);
    const resolver = createPathMembershipResolver([{
      worktreeId: "active",
      repositoryId: "active",
      alias: "active",
      worktreeRoot: "",
      indexedPaths: () => entry.indexed,
    }]);

    for (const hint of entry.hints) {
      const legacyMember = legacy(hint);
      const resolution = resolver.resolve(hint);
      const resolverMember = resolution.status === PathMembershipStatus.Exact
        || resolution.status === PathMembershipStatus.UniqueResolved;
      const agrees = legacyMember === resolverMember;
      if (!agrees) disagreements += 1;

      rows.push({
        case: entry.case,
        hint,
        legacyMember,
        resolverStatus: resolution.status,
        resolverMember,
        agrees,
      });
    }
  }

  const output = {
    schemaVersion: "stage5.m145.m144-membership-parity.v1",
    note: "Legacy single-repository boolean vs the M145 workspace-aware resolver collapsed to one scope. Disagreement on any shape would mean M144 behaviour moved.",
    total: rows.length,
    disagreements,
    pass: disagreements === 0,
    rows,
  };

  await mkdir(outDir, { recursive: true });
  await writeFile(
    path.join(outDir, "stage5_m145_m144_membership_parity.json"),
    `${JSON.stringify(output, null, 2)}\n`,
    "utf8",
  );
  process.stdout.write(`m145 <- m144 membership parity: ${rows.length - disagreements}/${rows.length} agree\n`);
  if (disagreements > 0) process.exitCode = 1;
}

if (import.meta.main) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exit(1);
  });
}
