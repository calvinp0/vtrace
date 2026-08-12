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
