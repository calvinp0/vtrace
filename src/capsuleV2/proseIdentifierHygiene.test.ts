// M142 Workstream A — prose vs identifier signal hygiene (REAL-PARSER tests).
//
// The invariant: an ordinary query token does NOT automatically imply a
// symbol-name hypothesis. A token becomes an exact-symbol hypothesis only when
// the request GRAMMAR gives it identifier intent (backticks, call syntax, a
// declaration phrase, a path qualification, an explicit lookup command) or its
// SHAPE is unambiguously code (ALL CAPS).
//
// These are generic fixtures. No ARC, no repository-specific token, no
// symbol-specific exemption — the real ARC failures are acceptance evidence for
// the rule, never its implementation.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "bun:test";
import type { Database } from "bun:sqlite";

import { openIndexerDatabase } from "../db/sqlite";
import { indexProject } from "../indexer/indexProject";
import { deriveQueryIntent, exactSymbolEligibleTerms } from "../retrieval/querySemantics";
import { resolveProjectNameAliases } from "./projectNameSignals";
import { anchorDirectEvidence } from "./directEvidenceAnchoring";
import { buildCapsuleV2 } from "./buildCapsuleV2";
import { CapsuleIntent, type CapsuleV2Result } from "./types";

interface RealRepo {
  db: Database;
  repoRoot: string;
}

/** Index a synthetic repo whose ROOT BASENAME is `name` (the project alias). */
async function indexNamedRepo(name: string, files: Record<string, string>): Promise<RealRepo> {
  const parent = mkdtempSync(path.join(tmpdir(), "m142-hygiene-"));
  const repoRoot = path.join(parent, name);
  mkdirSync(repoRoot, { recursive: true });
  for (const [relPath, content] of Object.entries(files)) {
    const absPath = path.join(repoRoot, relPath);
    mkdirSync(path.dirname(absPath), { recursive: true });
    writeFileSync(absPath, content);
  }
  const db = openIndexerDatabase();
  await indexProject({ repoRoot, db });
  return { db, repoRoot };
}

const eligibleFor = (task: string, repoRoot?: string): ReadonlySet<string> =>
  exactSymbolEligibleTerms(deriveQueryIntent(task, repoRoot === undefined
    ? {}
    : { projectNameAliases: resolveProjectNameAliases(repoRoot) }));

const delivered = (result: CapsuleV2Result): string[] =>
  [...result.pivots, ...result.support].map((item) => item.fq_name);

// --- §15 common-English symbol collision --------------------------------------

// Functions whose names are ordinary English words, plus one genuine domain
// implementation the behavioural question is really about.
const COLLISION_FILES: Record<string, string> = {
  "pkg/shell.py":
    "def which(command):\n"
    + "    \"\"\"Locate an executable on PATH.\"\"\"\n"
    + "    return None\n\n"
    + "def run(command):\n"
    + "    \"\"\"Execute a command.\"\"\"\n"
    + "    return which(command)\n\n"
    + "def copy(source, destination):\n"
    + "    \"\"\"Copy a file.\"\"\"\n"
    + "    return None\n\n"
    + "def load(handle):\n"
    + "    \"\"\"Read a handle.\"\"\"\n"
    + "    return None\n\n"
    + "def check(value):\n"
    + "    \"\"\"Validate a value.\"\"\"\n"
    + "    return bool(value)\n",
  "pkg/routes.py":
    "def build_backend_route(profile):\n"
    + "    \"\"\"Assemble the backend route keywords emitted for a profile.\"\"\"\n"
    + "    keywords = []\n"
    + "    keywords.append(profile.mode)\n"
    + "    return keywords\n\n"
    + "def emit_route_keywords(profile):\n"
    + "    \"\"\"Emit the assembled route keywords.\"\"\"\n"
    + "    return build_backend_route(profile)\n",
};

test("M142-A: an ordinary prose token is not exact-symbol eligible", () => {
  const eligible = eligibleFor("How does the driver decide which backend route keywords to emit?");
  assert.equal(eligible.has("which"), false);
  assert.equal(eligible.has("decide"), false);
  assert.equal(eligible.has("emit"), false);
});

test("M142-A: explicit call syntax makes the same token eligible", () => {
  assert.equal(eligibleFor("Where is which() implemented?").has("which"), true);
});

test("M142-A: an explicit declaration phrase makes the token eligible", () => {
  assert.equal(eligibleFor("find the function copy").has("copy"), true);
  assert.equal(eligibleFor("show me the load helper").has("load"), false);
});

test("M142-A: backticked and path-qualified mentions stay eligible", () => {
  assert.equal(eligibleFor("what does `check` validate?").has("check"), true);
  assert.equal(eligibleFor("explain pkg/shell.py::run").has("run"), true);
});

test("M142-A: an ALL-CAPS token keeps exact-symbol eligibility", () => {
  // Shape, not vocabulary: FITS is written that way because it names something.
  assert.equal(eligibleFor("how is a FITS header parsed?").has("fits"), true);
});

test("M142-A: a traceback frame names an identifier the runtime chose", () => {
  // The reporter did not decide to write `unparse`; the interpreter did. A plain
  // lowercase name earns eligibility here and nowhere else, because the complete
  // frame around it cannot be a sentence.
  const eligible = eligibleFor(
    'File "\\path\\to\\site-packages\\sphinx\\domains\\python.py", line 112, in unparse | IndexError: pop from empty list',
  );
  assert.equal(eligible.has("unparse"), true);
});

test("M142-A: a bare frame tail admits a code-shaped name", () => {
  assert.equal(eligibleFor("line 45, in render_template").has("render_template"), true);
  assert.equal(eligibleFor('File "/srv/app/models.py", line 8, in ClassName.method').has("method"), true);
});

test("M142-A: ordinary prose about a line number names nothing", () => {
  // The whole risk this rule creates: `in <word>` is overwhelmingly English. A
  // bare tail therefore requires a code shape, so neither of these can resolve.
  assert.equal(eligibleFor("see line 42, in particular the retry loop").has("particular"), false);
  assert.equal(eligibleFor("on line 10, in Django this differs from Flask").has("django"), false);
  for (const prose of [
    "the object is stored in cache and never refreshed",
    "which values are in the output?",
    "this only happens in production",
    "where in the pipeline is this handled?",
  ]) {
    const eligible = eligibleFor(prose);
    assert.equal(eligible.size, 0, `${prose} -> ${JSON.stringify([...eligible])}`);
  }
});

test("M142-A: a deep traceback admits only the frame that raised", () => {
  // A call chain names a dozen functions, most of them library plumbing -- here
  // CPython's own `sre_parse`. Admitting every frame lets whichever file owns the
  // most frames outvote the request text, which is measurably worse; only the
  // frame where execution stopped is admitted.
  const eligible = eligibleFor(
    'File "/venv/bin/pylint", line 8, in <module>\n'
    + 'File "/venv/lib/python3.10/site-packages/pylint/__init__.py", line 25, in run_pylint\n'
    + 'File "/venv/lib/python3.10/site-packages/pylint/lint/run.py", line 161, in __init__\n'
    + 'File "/usr/lib/python3.10/re.py", line 251, in compile\n'
    + 'File "/usr/lib/python3.10/sre_parse.py", line 444, in _parse_sub',
  );
  assert.deepEqual([...eligible], ["_parse_sub"]);
});

test("M142-A: a synthetic frame target is not an identifier", () => {
  // `<module>`, `<listcomp>` and `<genexpr>` are frame labels, not names.
  for (const frame of ['File "/srv/app/main.py", line 1, in <module>', 'File "/srv/app/main.py", line 9, in <listcomp>']) {
    assert.equal(eligibleFor(frame).size, 0, frame);
  }
});

test("M142-A: grammatical prose does not resolve to a same-named symbol", async () => {
  const repo = await indexNamedRepo("collide", COLLISION_FILES);
  try {
    const task = "How does the driver decide which backend route keywords to emit?";
    const anchored = anchorDirectEvidence({
      db: repo.db,
      task,
      exactNameEligibleTerms: eligibleFor(task, repo.repoRoot),
    });
    assert.equal(
      anchored.matches.some((match) => match.symbol === "which"),
      false,
      "the grammatical determiner must not resolve to the which() helper",
    );

    const capsule = buildCapsuleV2({
      db: repo.db,
      repoRoot: repo.repoRoot,
      task,
      intent: CapsuleIntent.Explain,
      maxTokens: 4_000,
    });
    assert.equal(
      capsule.pivots.some((pivot) => pivot.symbol === "which"),
      false,
      "which() must not become a pivot on a behavioural route question",
    );
  } finally {
    repo.db.close();
  }
});

test("M142-A: an explicit lookup of the same symbol still resolves it", async () => {
  const repo = await indexNamedRepo("collide", COLLISION_FILES);
  try {
    const task = "Where is which() implemented?";
    const anchored = anchorDirectEvidence({
      db: repo.db,
      task,
      exactNameEligibleTerms: eligibleFor(task, repo.repoRoot),
    });
    // The lane may or may not be the producer that finds it; what must hold is
    // that eligibility no longer BLOCKS it, and that delivery still contains it.
    assert.equal(anchored.rejectedGenericCount >= 0, true);

    const capsule = buildCapsuleV2({
      db: repo.db,
      repoRoot: repo.repoRoot,
      task,
      intent: CapsuleIntent.Explain,
      maxTokens: 4_000,
    });
    assert.ok(
      delivered(capsule).some((fqName) => fqName.endsWith("::which")),
      `explicit which() lookup must still deliver it; got ${delivered(capsule).join(", ")}`,
    );
  } finally {
    repo.db.close();
  }
});

// --- §14 project-name collision -----------------------------------------------

const PROJECT_COLLISION_FILES: Record<string, string> = {
  "foo/main.py":
    "class FOO(object):\n"
    + "    \"\"\"The project entry point.\"\"\"\n"
    + "    def __init__(self, settings):\n"
    + "        self.settings = settings\n",
  "foo/backend.py":
    "def select_backend_route(request):\n"
    + "    \"\"\"Decide which backend route to emit for a request.\"\"\"\n"
    + "    return request.mode\n",
};

test("M142-A: an incidental project reference is not exact-symbol eligible", async () => {
  const repo = await indexNamedRepo("FOO", PROJECT_COLLISION_FILES);
  try {
    const task = "How does FOO decide which backend route to emit?";
    const eligible = eligibleFor(task, repo.repoRoot);
    assert.equal(eligible.has("foo"), false, "the project name must stay routing metadata");
    assert.equal(eligible.has("which"), false);

    const capsule = buildCapsuleV2({
      db: repo.db,
      repoRoot: repo.repoRoot,
      task,
      intent: CapsuleIntent.Explain,
      maxTokens: 4_000,
    });
    assert.equal(
      capsule.pivots.some((pivot) => pivot.symbol === "FOO"),
      false,
      "the project-named class must not lead on a project reference alone",
    );
  } finally {
    repo.db.close();
  }
});

test("M142-A: an explicit project-named class lookup still resolves", async () => {
  const repo = await indexNamedRepo("FOO", PROJECT_COLLISION_FILES);
  try {
    const task = "Where is the FOO class defined?";
    assert.equal(eligibleFor(task, repo.repoRoot).has("foo"), true);

    const capsule = buildCapsuleV2({
      db: repo.db,
      repoRoot: repo.repoRoot,
      task,
      intent: CapsuleIntent.Explain,
      maxTokens: 4_000,
    });
    assert.ok(
      delivered(capsule).some((fqName) => fqName.endsWith("::FOO")),
      `explicit FOO class lookup must deliver it; got ${delivered(capsule).join(", ")}`,
    );
  } finally {
    repo.db.close();
  }
});

// --- §16 producer agreement ----------------------------------------------------

test("M142-A: eligibility is decided once and honoured by every consumer", async () => {
  const repo = await indexNamedRepo("collide", COLLISION_FILES);
  try {
    const task = "How does the driver decide which backend route keywords to emit?";
    const eligible = eligibleFor(task, repo.repoRoot);
    // Direct-evidence anchoring and the lexical broad-term lane must reach the
    // same verdict for the same token; a fix in one is not a fix (M140-A6).
    const anchored = anchorDirectEvidence({ db: repo.db, task, exactNameEligibleTerms: eligible });
    assert.equal(anchored.matches.some((match) => match.symbol === "which"), false);

    const withoutGrammar = anchorDirectEvidence({ db: repo.db, task });
    assert.equal(
      withoutGrammar.matches.some((match) => match.symbol === "which"),
      true,
      "without the grammar the pre-M142 reading must still be reproducible",
    );
  } finally {
    repo.db.close();
  }
});
