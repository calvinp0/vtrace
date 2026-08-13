// M142 Workstream C — behavioural concept-owner retrieval.
//
// The capability: given behaviour described in prose, find the module that owns
// the concept even when none of its symbol names matches the wording, and admit
// the answer-bearing definitions inside it.
//
// The controls matter as much as the capability. A lane that expands files is
// one bad gate away from returning half the repository, so the explicit-lookup
// and vague-query cases are tested here alongside the recovery.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "bun:test";
import type { Database } from "bun:sqlite";

import { openIndexerDatabase } from "../db/sqlite";
import { indexProject } from "../indexer/indexProject";
import { isStructuralSymbolKind } from "../domain/types";
import { deriveQueryIntent } from "./querySemantics";
import { hybridRetrieve, HybridCandidateSource } from "./hybridRetrieval";
import { shapeSweQuery } from "../capsule/sweQueryShaping";
import {
  behavioralObjectives,
  evaluateConceptOwnerIntent,
  objectiveProvenance,
  retrieveConceptOwners,
  CONCEPT_OWNER_DEFAULTS,
  type ObjectiveProvenanceRow,
} from "./conceptOwnerRetrieval";

async function indexRepo(files: Record<string, string>): Promise<{ db: Database; repoRoot: string }> {
  const repoRoot = mkdtempSync(path.join(tmpdir(), "m142-owner-"));
  for (const [relPath, content] of Object.entries(files)) {
    const absPath = path.join(repoRoot, relPath);
    mkdirSync(path.dirname(absPath), { recursive: true });
    writeFileSync(absPath, content);
  }
  const db = openIndexerDatabase();
  await indexProject({ repoRoot, db });
  return { db, repoRoot };
}

/**
 * §40's hard generic fixture: a module owns the concept through several
 * medium-strength definitions, while a differently-named symbol elsewhere shares
 * more of the request's wording but answers a different quantity.
 */
const DISPLACEMENT_FILES: Record<string, string> = {
  "pkg/normal_mode_checks.py":
    "\"\"\"Checks over normal-mode behaviour.\"\"\"\n\n"
    + "def evaluate_mode_displacement(vectors, threshold):\n"
    + "    \"\"\"Evaluate how far each item is displaced along the mode.\"\"\"\n"
    + "    return [v for v in vectors if v > threshold]\n\n"
    + "def identify_displaced_atoms(vectors, threshold):\n"
    + "    \"\"\"Identify which items are displaced beyond the threshold.\"\"\"\n"
    + "    return [i for i, v in enumerate(vectors) if v > threshold]\n\n"
    + "def summarize_mode_behaviour(vectors):\n"
    + "    \"\"\"Summarize the normal-mode behaviour implied by the displacement values.\"\"\"\n"
    + "    return {'displaced': identify_displaced_atoms(vectors, 0.1)}\n",
  "pkg/counting.py":
    "def get_expected_num_items_with_largest_displacement(rms_values):\n"
    + "    \"\"\"Return the expected number of items associated with the largest displacement.\"\"\"\n"
    + "    return len(rms_values)\n",
  "pkg/unrelated.py":
    "def render_report(rows):\n"
    + "    \"\"\"Render a table of rows.\"\"\"\n"
    + "    return rows\n",
};

const intentFor = (task: string) =>
  shapeSweQuery({ problemStatement: task }).derivedIntent ?? deriveQueryIntent(task);

// --- gating controls -----------------------------------------------------------

test("M142-C: an explicit symbol lookup does not trigger owner expansion", () => {
  const gate = evaluateConceptOwnerIntent(intentFor("find function get_bonds"));
  assert.equal(gate.active, false);
  assert.equal(gate.reason, "explicit symbol lookup");
});

test("M142-C: a broad vague question does not trigger owner expansion", () => {
  const gate = evaluateConceptOwnerIntent(intentFor("How does it work?"));
  assert.equal(gate.active, false);
  assert.match(gate.reason ?? "", /behavioural objective/);
});

test("M142-C: question framing is not mistaken for behavioural objectives", () => {
  const objectives = behavioralObjectives(intentFor("How does this actually work, and when should it be used?"));
  for (const framing of ["how", "does", "this", "when", "should", "work", "used"]) {
    assert.equal(objectives.includes(framing), false, `"${framing}" is question framing, not an objective`);
  }
});

test("M142-C: a capability lookup is answered by a definition, not a module", () => {
  const gate = evaluateConceptOwnerIntent(
    intentFor("is there already a function that returns a dihedral angle given three vectors?"),
  );
  assert.equal(gate.active, false);
});

// --- capability ----------------------------------------------------------------

test("M142-C: the owning module is found when no symbol name matches the wording", async () => {
  const repo = await indexRepo(DISPLACEMENT_FILES);
  try {
    const task = "How are displacement values analysed to determine normal mode behaviour?";
    const result = retrieveConceptOwners({
      db: repo.db,
      intent: intentFor(task),
      representedDefinitionsByFile: new Map(),
      existingSymbolIds: new Set(),
    });
    assert.equal(result.diagnostics.active, true);
    const owners = result.diagnostics.owners.map((owner) => owner.path);
    assert.ok(
      owners.includes("pkg/normal_mode_checks.py"),
      `expected the owning module among owners; got ${owners.join(", ")}`,
    );
    assert.ok(
      result.candidates.some((candidate) => candidate.symbol.filePath === "pkg/normal_mode_checks.py"),
      "the owner must contribute answer-bearing definitions",
    );
  } finally {
    repo.db.close();
  }
});

test("M142-C: owner scoring performs zero source reads", async () => {
  const repo = await indexRepo(DISPLACEMENT_FILES);
  try {
    const result = retrieveConceptOwners({
      db: repo.db,
      intent: intentFor("How are displacement values analysed to determine normal mode behaviour?"),
      representedDefinitionsByFile: new Map(),
      existingSymbolIds: new Set(),
    });
    assert.equal(result.diagnostics.sourceReads, 0);
  } finally {
    repo.db.close();
  }
});

// --- bounds --------------------------------------------------------------------

test("M142-C: admission is bounded by the configured caps", async () => {
  const files: Record<string, string> = {};
  // Many plausible owners; the caps must hold regardless.
  for (let index = 0; index < 40; index += 1) {
    files[`pkg/module_${index}.py`] =
      `def analyse_displacement_${index}(values):\n`
      + `    """Analyse the displacement values for normal mode behaviour."""\n`
      + `    return values\n\n`
      + `def report_displacement_${index}(values):\n`
      + `    """Report the normal mode displacement behaviour."""\n`
      + `    return values\n\n`
      + `def check_displacement_${index}(values):\n`
      + `    """Check the normal mode displacement behaviour."""\n`
      + `    return values\n\n`
      + `def audit_displacement_${index}(values):\n`
      + `    """Audit the normal mode displacement behaviour."""\n`
      + `    return values\n`;
  }
  const repo = await indexRepo(files);
  try {
    const result = retrieveConceptOwners({
      db: repo.db,
      intent: intentFor("How are displacement values analysed to determine normal mode behaviour?"),
      representedDefinitionsByFile: new Map(),
      existingSymbolIds: new Set(),
    });
    assert.ok(
      result.diagnostics.owners.length <= CONCEPT_OWNER_DEFAULTS.maxConceptOwnerFiles,
      `owner cap exceeded: ${result.diagnostics.owners.length}`,
    );
    assert.ok(
      result.candidates.length <= CONCEPT_OWNER_DEFAULTS.maxConceptOwnerCandidates,
      `candidate cap exceeded: ${result.candidates.length}`,
    );
    for (const owner of result.diagnostics.owners) {
      const fromOwner = result.candidates.filter((candidate) => candidate.ownerPath === owner.path);
      assert.ok(
        fromOwner.length <= CONCEPT_OWNER_DEFAULTS.maxDefinitionsPerConceptOwner,
        `per-owner cap exceeded for ${owner.path}: ${fromOwner.length}`,
      );
    }
    assert.equal(result.diagnostics.ownerCapReached, true);
    assert.equal(result.diagnostics.sourceReads, 0);
  } finally {
    repo.db.close();
  }
});

test("M142-C: a well-represented owner is not topped up", async () => {
  const repo = await indexRepo(DISPLACEMENT_FILES);
  try {
    const result = retrieveConceptOwners({
      db: repo.db,
      intent: intentFor("How are displacement values analysed to determine normal mode behaviour?"),
      representedDefinitionsByFile: new Map([
        ["pkg/normal_mode_checks.py", CONCEPT_OWNER_DEFAULTS.maxDefinitionsPerConceptOwner],
      ]),
      existingSymbolIds: new Set(),
    });
    assert.equal(
      result.candidates.some((candidate) => candidate.ownerPath === "pkg/normal_mode_checks.py"),
      false,
      "an owner the pool already carries in full must not be topped up",
    );
    assert.ok(result.diagnostics.ownersAlreadyRepresented >= 1);
  } finally {
    repo.db.close();
  }
});

// --- structural invariant ------------------------------------------------------

test("M142-C: no structural module node is ever admitted", async () => {
  const repo = await indexRepo(DISPLACEMENT_FILES);
  try {
    const task = "How are displacement values analysed to determine normal mode behaviour?";
    const shaped = shapeSweQuery({ problemStatement: task });
    const retrieval = hybridRetrieve(repo.db, {
      query: shaped.query,
      shaped,
      taskText: task,
      maxResults: 25,
    });
    for (const candidate of retrieval.candidates) {
      assert.equal(
        isStructuralSymbolKind(candidate.kind),
        false,
        `${candidate.fqName} is a structural node and must never be a candidate`,
      );
    }
    const owned = retrieval.candidates.filter((candidate) =>
      candidate.sources.includes(HybridCandidateSource.ConceptOwner));
    for (const candidate of owned) {
      assert.notEqual(candidate.localName, "<module>");
    }
  } finally {
    repo.db.close();
  }
});

test("M142-C: the lane can be disabled outright", async () => {
  const repo = await indexRepo(DISPLACEMENT_FILES);
  try {
    const task = "How are displacement values analysed to determine normal mode behaviour?";
    const shaped = shapeSweQuery({ problemStatement: task });
    const retrieval = hybridRetrieve(repo.db, {
      query: shaped.query,
      shaped,
      taskText: task,
      maxResults: 25,
      enableConceptOwnerRetrieval: false,
    });
    assert.equal(retrieval.conceptOwner.active, false);
    assert.equal(retrieval.conceptOwner.inactiveReason, "disabled by caller");
    assert.equal(
      retrieval.candidates.some((candidate) =>
        candidate.sources.includes(HybridCandidateSource.ConceptOwner)),
      false,
    );
  } finally {
    repo.db.close();
  }
});

// --- §14 non-displacement contract ---------------------------------------------

/**
 * A pool that genuinely overflows, with the owner file OUTSIDE the top of it.
 * The filler definitions all match the request's wording, so ordinary ranking
 * fills the cap with them and the concept-owner recoveries have to come from
 * somewhere — which is exactly the situation the eviction rule mishandled.
 */
const EVICTION_FILES: Record<string, string> = {
  "pkg/normal_mode_checks.py":
    "\"\"\"Checks over normal-mode behaviour.\"\"\"\n\n"
    + "def evaluate_mode_displacement(vectors, threshold):\n"
    + "    \"\"\"Evaluate how far each item is displaced along the mode.\"\"\"\n"
    + "    return [v for v in vectors if v > threshold]\n\n"
    + "def identify_displaced_atoms(vectors, threshold):\n"
    + "    \"\"\"Identify which items are displaced beyond the threshold.\"\"\"\n"
    + "    return [i for i, v in enumerate(vectors) if v > threshold]\n\n"
    + "def summarize_mode_behaviour(vectors):\n"
    + "    \"\"\"Summarize the normal-mode behaviour implied by the displacement values.\"\"\"\n"
    + "    return {'displaced': identify_displaced_atoms(vectors, 0.1)}\n",
  "pkg/filler.py": Array.from(
    { length: 30 },
    (_unused, index) =>
      `def analyse_displacement_value_${index}(values):\n`
      + `    """Analyse displacement values for mode ${index}."""\n`
      + "    return values\n",
  ).join("\n"),
};

const EVICTION_TASK = "How are displacement values analysed to determine normal mode behaviour?";

/**
 * The lane must not buy its slots from the ranking.
 *
 * The first cut displaced the weakest ordinary candidates, on the M140-C
 * precedent. That is safe for a lane whose findings ARE the answer, and unsafe
 * here, because the output cap does not only decide what is delivered — it is the
 * evidence base that later, rank-derived inferences read. Measured on
 * django-11815: four recoveries evicted four ranked candidates, two of them from
 * the gold directory, which turned `resolveLocalSubsystem`'s 8-vs-7 majority into
 * a 6-vs-6 tie broken the other way. The elected subsystem moved, the gold lead
 * became "generic infrastructure outside the issue's subsystem", and it fell from
 * lead to support to discarded — with its own score never changing.
 *
 * Stated as an invariant rather than as that case: whatever ordinary ranking would
 * have returned is still returned once the lane runs.
 */
test("M142-C: recovered definitions never evict an organically ranked candidate", async () => {
  const repo = await indexRepo(EVICTION_FILES);
  try {
    const shaped = shapeSweQuery({ problemStatement: EVICTION_TASK });
    // Small enough that the pool genuinely overflows, so admission has to choose.
    const maxResults = 4;
    const base = { query: shaped.query, shaped, taskText: EVICTION_TASK, maxResults };

    const without = hybridRetrieve(repo.db, { ...base, enableConceptOwnerRetrieval: false });
    const admitted = hybridRetrieve(repo.db, base);

    const recovered = admitted.candidates.filter((candidate) =>
      candidate.sources.includes(HybridCandidateSource.ConceptOwner));
    assert.ok(recovered.length > 0, "fixture must actually exercise concept-owner admission");

    const survived = new Set(admitted.candidates.map((candidate) => candidate.symbolId));
    for (const candidate of without.candidates) {
      assert.ok(
        survived.has(candidate.symbolId),
        `${candidate.fqName} was ranked into the pool and the concept-owner lane evicted it`,
      );
    }
    // Still bounded: the lane cannot grow the pool past its own cap.
    assert.ok(
      admitted.candidates.length <= maxResults + CONCEPT_OWNER_DEFAULTS.maxConceptOwnerCandidates,
      `pool grew to ${admitted.candidates.length}, beyond the lane's own bound`,
    );
  } finally {
    repo.db.close();
  }
});

test("M142-C: the lane does not change what ordinary ranking already leads with", async () => {
  const repo = await indexRepo(EVICTION_FILES);
  try {
    const shaped = shapeSweQuery({ problemStatement: EVICTION_TASK });
    const base = { query: shaped.query, shaped, taskText: EVICTION_TASK, maxResults: 4 };
    const without = hybridRetrieve(repo.db, { ...base, enableConceptOwnerRetrieval: false });
    const admitted = hybridRetrieve(repo.db, base);
    assert.equal(
      admitted.candidates[0]?.fqName,
      without.candidates[0]?.fqName,
      "a rescue lane whose findings rank last must not move the top of the ranking",
    );
  } finally {
    repo.db.close();
  }
});

/**
 * §24's generic objective-hygiene fixture. One module genuinely implements the
 * requested behaviour. Two others are full of definitions named after the
 * REPORT's vocabulary — who touched the ticket, what the evidence block is
 * called — which is rare text and therefore high-IDF text.
 *
 * No term here comes from any real case.
 */
const PROVENANCE_FILES: Record<string, string> = {
  "pkg/maintenance_windows.py":
    "\"\"\"Scheduling of maintenance windows.\"\"\"\n\n"
    + "def reschedule_overlapping_window(windows, candidate):\n"
    + "    \"\"\"Reschedule a maintenance window that overlaps an existing one.\"\"\"\n"
    + "    return [w for w in windows if w != candidate]\n\n"
    + "def detect_window_overlap(windows):\n"
    + "    \"\"\"Detect whether any maintenance window overlaps another.\"\"\"\n"
    + "    return any(a.end > b.start for a, b in zip(windows, windows[1:]))\n\n"
    + "def shift_window_start(window, delta):\n"
    + "    \"\"\"Shift the start of an overlapping window by the given delta.\"\"\"\n"
    + "    return window.start + delta\n",
  "pkg/ticket_audit.py":
    "\"\"\"Audit trail for tickets.\"\"\"\n\n"
    + "def record_last_modified(ticket, actor):\n"
    + "    \"\"\"Record who last modified the ticket.\"\"\"\n"
    + "    return {'ticket': ticket, 'modified_by': actor}\n\n"
    + "def read_last_modified(ticket):\n"
    + "    \"\"\"Read the last modified marker for a ticket.\"\"\"\n"
    + "    return ticket.get('modified_by')\n\n"
    + "def purge_modified_markers(tickets):\n"
    + "    \"\"\"Purge every last modified marker.\"\"\"\n"
    + "    return [t for t in tickets if 'modified_by' not in t]\n",
  "pkg/crash_reports.py":
    "\"\"\"Crash report rendering.\"\"\"\n\n"
    + "def render_traceback_block(frames):\n"
    + "    \"\"\"Render a traceback block for a crash report.\"\"\"\n"
    + "    return '\\n'.join(frames)\n\n"
    + "def collect_traceback_frames(exc):\n"
    + "    \"\"\"Collect traceback frames from an exception.\"\"\"\n"
    + "    return getattr(exc, 'frames', [])\n\n"
    + "def summarize_traceback(frames):\n"
    + "    \"\"\"Summarize a traceback for display.\"\"\"\n"
    + "    return frames[:3]\n",
};

/** Behaviour + an issue byline + labelled evidence, exactly as a tracker emits it. */
const PROVENANCE_TASK =
  "Overlapping maintenance windows are not rescheduled. — (last modified by qvornex)\n"
  + "Errors: WindowConflictError\n"
  + "Traceback: WindowConflictError: window overlaps an existing window";

test("M142-C: report metadata is not a behavioural objective", async () => {
  const { db, repoRoot } = await indexRepo(PROVENANCE_FILES);
  const intent = deriveQueryIntent(PROVENANCE_TASK);
  const provenance = objectiveProvenance(intent);
  const roleOf = (term: string): ObjectiveProvenanceRow | undefined =>
    provenance.find((row) => row.objective === term);

  // The byline names a person and a moment in the ticket's life, not behaviour.
  for (const term of ["last", "modified", "qvornex"]) {
    const row = roleOf(term);
    assert.ok(row !== undefined, `expected ${term} to be a candidate objective`);
    assert.deepEqual(row.roles, ["attribution_byline"]);
    assert.equal(row.eligible, false);
  }

  // "Traceback:" announces evidence. It is a container, never its content.
  const traceback = roleOf("traceback");
  assert.ok(traceback !== undefined);
  assert.deepEqual(traceback.roles, ["evidence_section_label"]);
  assert.equal(traceback.eligible, false);

  // The evidence PAYLOAD is behaviour-bearing and survives.
  assert.equal(roleOf("window")?.eligible, true);
  assert.equal(roleOf("overlap")?.eligible, true);

  const objectives = behavioralObjectives(intent);
  for (const term of ["last", "modified", "qvornex", "traceback"]) {
    assert.ok(!objectives.includes(term), `${term} should not be an objective`);
  }

  const result = retrieveConceptOwners({
    db,
    intent,
    representedDefinitionsByFile: new Map(),
    existingSymbolIds: new Set(),
  });
  const ownerPaths = result.diagnostics.owners.map((owner) => owner.path);
  assert.ok(
    ownerPaths.includes("pkg/maintenance_windows.py"),
    `expected the implementing module to be elected, got ${ownerPaths.join(", ")}`,
  );
  assert.ok(
    !ownerPaths.includes("pkg/ticket_audit.py"),
    "a module named after the ticket's audit trail must not own a scheduling bug",
  );
  db.close();
  assert.ok(repoRoot.length > 0);
});

test("M142-C: the same words stay eligible when the request is actually about them", async () => {
  const { db } = await indexRepo(PROVENANCE_FILES);
  // §25. Nothing about the TOKENS was banned — only their role in that request.
  const intent = deriveQueryIntent("How is the last modified marker for a ticket recorded and read?");
  const provenance = objectiveProvenance(intent);
  for (const term of ["last", "modified"]) {
    const row = provenance.find((r) => r.objective === term);
    assert.ok(row !== undefined, `expected ${term} to be a candidate objective`);
    assert.deepEqual(row.roles, ["task_behavior"]);
    assert.equal(row.eligible, true, `${term} must remain eligible when the request asks about it`);
  }
  const result = retrieveConceptOwners({
    db,
    intent,
    representedDefinitionsByFile: new Map(),
    existingSymbolIds: new Set(),
  });
  assert.equal(result.diagnostics.owners[0]?.path, "pkg/ticket_audit.py");
  db.close();
});

test("M142-C: a traceback question still reaches the module that builds tracebacks", async () => {
  const { db } = await indexRepo(PROVENANCE_FILES);
  const intent = deriveQueryIntent("Where is the traceback for a crash report collected and rendered?");
  const objectives = behavioralObjectives(intent);
  assert.ok(objectives.includes("traceback"), "traceback is the subject of this request, not a label");
  const result = retrieveConceptOwners({
    db,
    intent,
    representedDefinitionsByFile: new Map(),
    existingSymbolIds: new Set(),
  });
  assert.equal(result.diagnostics.owners[0]?.path, "pkg/crash_reports.py");
  db.close();
});

/**
 * Three owner files, three admissible definitions each, an overall cap of six.
 * Draining owners in order spent the whole budget on the first two and left the
 * third with nothing, every time — the third slot was dead by construction.
 */
const THREE_OWNER_FILES: Record<string, string> = {
  "pkg/alpha_registry.py":
    "def register_alpha_binding(name, value):\n"
    + "    \"\"\"Register a binding for the alpha registry.\"\"\"\n    return (name, value)\n\n"
    + "def resolve_alpha_binding(name):\n"
    + "    \"\"\"Resolve a binding from the alpha registry.\"\"\"\n    return name\n\n"
    + "def drop_alpha_binding(name):\n"
    + "    \"\"\"Drop a binding from the alpha registry.\"\"\"\n    return name\n",
  "pkg/beta_registry.py":
    "def register_beta_binding(name, value):\n"
    + "    \"\"\"Register a binding for the beta registry.\"\"\"\n    return (name, value)\n\n"
    + "def resolve_beta_binding(name):\n"
    + "    \"\"\"Resolve a binding from the beta registry.\"\"\"\n    return name\n\n"
    + "def drop_beta_binding(name):\n"
    + "    \"\"\"Drop a binding from the beta registry.\"\"\"\n    return name\n",
  "pkg/gamma_registry.py":
    "def register_gamma_binding(name, value):\n"
    + "    \"\"\"Register a binding for the gamma registry.\"\"\"\n    return (name, value)\n\n"
    + "def resolve_gamma_binding(name):\n"
    + "    \"\"\"Resolve a binding from the gamma registry.\"\"\"\n    return name\n\n"
    + "def drop_gamma_binding(name):\n"
    + "    \"\"\"Drop a binding from the gamma registry.\"\"\"\n    return name\n",
};

test("M142-C: every elected owner gets a candidate slot", async () => {
  const { db } = await indexRepo(THREE_OWNER_FILES);
  const intent = deriveQueryIntent(
    "How is a binding registered, resolved and dropped from the registry?");
  const result = retrieveConceptOwners({
    db,
    intent,
    representedDefinitionsByFile: new Map(),
    existingSymbolIds: new Set(),
  });
  const owners = result.diagnostics.owners.map((owner) => owner.path);
  assert.equal(owners.length, 3, `expected three elected owners, got ${owners.join(", ")}`);
  assert.ok(result.candidates.length <= CONCEPT_OWNER_DEFAULTS.maxConceptOwnerCandidates);

  const contributingFiles = new Set(result.candidates.map((c) => c.ownerPath));
  for (const owner of owners) {
    assert.ok(
      contributingFiles.has(owner),
      `owner ${owner} was elected but contributed no candidate; `
      + `contributions came only from ${[...contributingFiles].join(", ")}`,
    );
  }
  db.close();
});
