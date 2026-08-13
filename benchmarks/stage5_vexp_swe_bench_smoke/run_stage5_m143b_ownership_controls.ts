// M143 Workstream B — generic ownership controls + the Gaussian acceptance.
//
// The five-case audit (`run_stage5_m143b_ownership_evidence_audit.ts`) measures
// the REAL title cases. This runner measures the two things that audit cannot:
//
//   1. GENERIC fixtures (§20-§22, §56-§59), on real indexes built by the real
//      indexer, so the ceiling is shown to be structural rather than Django's.
//   2. The Gaussian hard acceptance (§24, §55) against the exact recorded
//      behavioural query wording.
//
// THE ONE MECHANISM UNDER TEST
// ----------------------------
// Of every relation class M143-B audited, exactly one survived as a candidate:
// INTERFACE-OVERRIDE OWNERSHIP. A class that inherits a base and redefines one
// of that base's methods has taken responsibility for that method's behaviour —
// which is a repository fact, not a name coincidence, and is asymmetric in
// exactly the way §37 requires.
//
// Inheritance is NOT persisted as its own edge type (`edges.edge_type` is one of
// contains/imports/calls/references, and the Python parser's `inheritance`
// reference kind is collapsed into `references` before it is written). It is
// still recoverable: a class-to-class `references` edge plus a `contains` member
// intersection reconstructs the override surface without a schema change.
//
// This runner MEASURES that mechanism. It does not ship it.
//
// No agent, Docker, VEXP, network, or paid API is used.
//
//   bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m143b_ownership_controls.ts \
//     [--arc-index <path>] --out <dir>

import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Database } from "bun:sqlite";

import { openIndexerDatabase } from "../../src/db/sqlite";
import { indexProject } from "../../src/indexer/indexProject";
import { shapeSweQuery } from "../../src/capsule/sweQueryShaping";
import { behavioralObjectives } from "../../src/retrieval/conceptOwnerRetrieval";
import { deriveQueryIntent } from "../../src/retrieval/querySemantics";
import { prepareRunnerOutput } from "./lib/runnerPaths";

const RUNNER_NAME = "m143b_ownership_controls";

/** The exact recorded ARC behavioural query. Not paraphrased (§24, §69). */
const GAUSSIAN_QUERY = "How does ARC decide which Gaussian route keywords to emit?";

const tokens = (text: string): string[] =>
  text
    .split(/[^A-Za-z0-9]+/)
    .flatMap((part) => part.replace(/([a-z0-9])([A-Z])/g, "$1 $2").split(/\s+/))
    .map((token) => token.toLowerCase())
    .filter((token) => token.length > 2);

const stem = (token: string): string => token.replace(/(ies|ing|ed|es|s)$/, "");

export interface OverrideEvidence {
  readonly className: string;
  readonly filePath: string;
  /** Base classes reached by a class-to-class `references` edge. */
  readonly bases: readonly string[];
  /** Members this class redefines from one of those bases. */
  readonly overrides: readonly string[];
  /** Members it declares that no base declares. */
  readonly ownMembers: readonly string[];
}

/**
 * Reconstruct a class's override surface from the relations the index really
 * has. Bounded: one query for the class's members, one for its base-candidate
 * references, one for each base's members.
 */
export function overrideEvidence(db: Database, classFqName: string): OverrideEvidence {
  const row = db
    .query(`SELECT s.id, f.path FROM symbols s JOIN files f ON f.id = s.file_id WHERE s.fq_name = ?`)
    .get(classFqName) as { id: string; path: string } | null;
  if (row === null) {
    return { className: classFqName, filePath: "", bases: [], overrides: [], ownMembers: [] };
  }
  const members = (fqName: string): string[] =>
    (db.query(`SELECT local_name FROM symbols WHERE fq_name LIKE ?`).all(`${fqName}.%`) as { local_name: string }[])
      .map((member) => member.local_name);

  // A class-to-class `references` edge is how inheritance survives persistence.
  const bases = (
    db
      .query(
        `SELECT ds.fq_name AS fq FROM edges e
           JOIN symbols ds ON ds.id = e.dst_symbol_id
          WHERE e.src_symbol_id = ? AND e.edge_type = 'references' AND ds.kind = 'class'`,
      )
      .all(row.id) as { fq: string }[]
  ).map((base) => base.fq);

  const own = members(classFqName);
  const baseMembers = new Set(bases.flatMap(members));
  return {
    className: classFqName,
    filePath: row.path,
    bases,
    overrides: own.filter((member) => baseMembers.has(member)),
    ownMembers: own.filter((member) => !baseMembers.has(member)),
  };
}

export type OwnershipState = "confirmed_owner" | "ambiguous";

export interface OwnershipVerdict {
  readonly state: OwnershipState;
  readonly matchedObjectives: readonly string[];
  readonly reason: string;
}

/**
 * The mechanism under test: a candidate is a CONFIRMED OWNER of the requested
 * behaviour when it overrides an interface member whose name corresponds to what
 * the request asks for. Anything else ABSTAINS — never demote on ignorance
 * (§49, §50).
 */
export function classifyOwnership(
  evidence: OverrideEvidence,
  objectives: readonly string[],
): OwnershipVerdict {
  const surface = new Set(evidence.overrides.flatMap(tokens).map(stem));
  const matched = objectives.filter((objective) => surface.has(stem(objective)));
  if (evidence.overrides.length > 0 && matched.length > 0) {
    return {
      state: "confirmed_owner",
      matchedObjectives: matched,
      reason: `overrides ${evidence.overrides.join("/")} from ${evidence.bases.join("/")}; request names ${matched.join("/")}`,
    };
  }
  return {
    state: "ambiguous",
    matchedObjectives: [],
    reason:
      evidence.overrides.length === 0
        ? "no interface-override surface recovered"
        : `override surface (${evidence.overrides.join("/")}) shares no term with the request`,
  };
}

const objectivesFor = (query: string): string[] => {
  const shaped = shapeSweQuery({ problemStatement: query });
  return [...behavioralObjectives(shaped.derivedIntent ?? deriveQueryIntent(query))];
};

interface Scenario {
  readonly id: string;
  readonly purpose: string;
  readonly files: Readonly<Record<string, string>>;
  readonly queries: ReadonlyArray<{ readonly query: string; readonly expect: string }>;
  readonly candidates: readonly string[];
  /** Pairs whose direct relation is reported, as `subject|owner`. */
  readonly relationPairs?: readonly (readonly [string, string])[];
}

const SCENARIOS: readonly Scenario[] = [
  {
    id: "subject_vs_owner",
    purpose:
      "§20/§57: the task names an entity, but the behaviour is implemented by a generic helper that "
      + "operates on instances polymorphically and never names the entity.",
    files: {
      "app/__init__.py": "",
      "app/fields/__init__.py": "",
      "app/fields/relations.py":
        "class BaseField:\n    def db_type(self, connection):\n        raise NotImplementedError\n\n\n"
        + "class LinkField(BaseField):\n    \"\"\"A link between two records.\"\"\"\n\n"
        + "    def __init__(self, target, on_delete):\n        self.target = target\n        self.on_delete = on_delete\n\n"
        + "    def db_type(self, connection):\n        return connection.link_type()\n",
      "app/schema/__init__.py": "",
      "app/schema/planner.py":
        "class ChangePlanner:\n"
        + "    def generate_altered_fields(self, old_state, new_state):\n"
        + "        for name, field in self.changed_fields(old_state, new_state):\n"
        + "            dependency = self.dependencies_for(field)\n            self.record(dependency)\n\n"
        + "    def dependencies_for(self, field):\n"
        + "        if field.remote_target is not None:\n            return (field.remote_target, 'cross_module')\n        return None\n",
    },
    queries: [
      {
        query: "changing a plain field to a LinkField does not create a cross-module dependency in the planner",
        expect: "app/schema/planner.py owns the behaviour; LinkField is the subject",
      },
    ],
    candidates: ["app/fields/relations.py::LinkField", "app/schema/planner.py::ChangePlanner"],
    relationPairs: [["app/fields/relations.py::LinkField", "app/schema/planner.py::ChangePlanner"]],
  },
  {
    id: "title_is_owner",
    purpose: "§21/§58: the task names a class and the behaviour really lives in that class's own method.",
    files: {
      "app/__init__.py": "",
      "app/widgets.py":
        "class BaseWidget:\n    def validate(self, value):\n        raise NotImplementedError\n\n\n"
        + "class NameWidget(BaseWidget):\n"
        + "    def validate(self, value):\n        return value.strip().islower()\n",
    },
    queries: [
      { query: "NameWidget validate mixed-case names incorrectly", expect: "NameWidget retains authority" },
    ],
    candidates: ["app/widgets.py::NameWidget"],
  },
  {
    id: "parser_vs_adapter",
    purpose:
      "§27/§56: same domain, two same-named-entity classes; the requested ACTION must pick between them.",
    files: {
      "backend/__init__.py": "",
      "backend/base.py":
        "class Backend:\n    def write_input(self, job):\n        raise NotImplementedError\n\n"
        + "    def parse_output(self, log):\n        raise NotImplementedError\n",
      "backend/adapter.py":
        "from backend.base import Backend\n\n\nclass ToolAdapter(Backend):\n"
        + "    def write_input(self, job):\n        return self.render_keywords(job)\n\n"
        + "    def render_keywords(self, job):\n        return ' '.join(job.keywords)\n",
      "backend/parser.py":
        "from backend.base import Backend\n\n\nclass ToolParser(Backend):\n"
        + "    def parse_output(self, log):\n        return self.read_energies(log)\n\n"
        + "    def read_energies(self, log):\n        return [line for line in log if 'energy' in line]\n",
    },
    queries: [
      { query: "How is backend input written before execution?", expect: "ToolAdapter" },
      { query: "How is backend output parsed?", expect: "ToolParser" },
      { query: "How does the backend decide which route keywords to emit?", expect: "ABSTAIN (vocabulary gap)" },
    ],
    candidates: ["backend/adapter.py::ToolAdapter", "backend/parser.py::ToolParser"],
  },
  {
    id: "caller_vs_helper",
    purpose:
      "§38: a call edge alone does not say who OWNS the behaviour — the caller may control it and the "
      + "callee may be an incidental utility.",
    files: {
      "svc/__init__.py": "",
      "svc/pipeline.py":
        "class Pipeline:\n"
        + "    def apply_discount(self, order):\n"
        + "        rate = self.lookup_rate(order.tier)\n        return order.total * (1 - rate)\n\n"
        + "    def lookup_rate(self, tier):\n        return {'gold': 0.2}.get(tier, 0.0)\n",
    },
    queries: [{ query: "discount is applied at the wrong rate for gold tier orders", expect: "ambiguous by call edge alone" }],
    candidates: ["svc/pipeline.py::Pipeline"],
  },
  {
    id: "ambiguous_abstain",
    purpose: "§22/§50: entity, helper and controller all plausible; no relation proves the edit site.",
    files: {
      "amb/__init__.py": "",
      "amb/entity.py": "class Report:\n    def __init__(self, rows):\n        self.rows = rows\n",
      "amb/helper.py": "def summarise(report):\n    return len(report.rows)\n",
      "amb/controller.py": "def build_summary(report):\n    return {'n': summarise(report)}\n",
    },
    queries: [{ query: "Report summary count is wrong when rows are filtered", expect: "ABSTAIN" }],
    candidates: ["amb/entity.py::Report"],
  },
];

async function materialise(scenario: Scenario): Promise<{ db: Database; repoRoot: string }> {
  const repoRoot = await mkdtemp(path.join(tmpdir(), `vtrace-m143b-${scenario.id}-`));
  for (const [relPath, content] of Object.entries(scenario.files)) {
    const absPath = path.join(repoRoot, relPath);
    await mkdir(path.dirname(absPath), { recursive: true });
    await writeFile(absPath, content, "utf8");
  }
  const db = openIndexerDatabase();
  await indexProject({ repoRoot, db });
  return { db, repoRoot };
}

function directRelations(db: Database, fromFq: string, toFq: string): Record<string, number> {
  const rows = db
    .query(
      `SELECT e.edge_type AS t, COUNT(*) AS n FROM edges e
         JOIN symbols ss ON ss.id = e.src_symbol_id
         JOIN symbols ds ON ds.id = e.dst_symbol_id
        WHERE (ss.fq_name = ? OR ss.fq_name LIKE ?) AND (ds.fq_name = ? OR ds.fq_name LIKE ?)
        GROUP BY e.edge_type`,
    )
    .all(fromFq, `${fromFq}.%`, toFq, `${toFq}.%`) as { t: string; n: number }[];
  return Object.fromEntries(rows.map((row) => [row.t, row.n]));
}

async function main(): Promise<void> {
  const arcIndexFlag = process.argv.indexOf("--arc-index");
  const arcIndex = arcIndexFlag === -1 ? undefined : process.argv[arcIndexFlag + 1];
  const out = await prepareRunnerOutput({ argv: process.argv, runner: RUNNER_NAME });

  const controls: unknown[] = [];
  const timings: Array<{ scenario: string; ms: number }> = [];

  for (const scenario of SCENARIOS) {
    const { db } = await materialise(scenario);
    const startedAt = performance.now();
    try {
      const evidence = scenario.candidates.map((fqName) => overrideEvidence(db, fqName));
      const queries = scenario.queries.map((entry) => {
        const objectives = objectivesFor(entry.query);
        return {
          query: entry.query,
          expectation: entry.expect,
          objectives,
          verdicts: evidence.map((candidate) => ({
            candidate: candidate.className,
            overrides: candidate.overrides,
            ...classifyOwnership(candidate, objectives),
          })),
        };
      });
      const relations = (scenario.relationPairs ?? []).map(([from, to]) => ({
        from,
        to,
        forward: directRelations(db, from, to),
        reverse: directRelations(db, to, from),
      }));
      controls.push({ id: scenario.id, purpose: scenario.purpose, evidence, relations, queries });
      timings.push({ scenario: scenario.id, ms: Number((performance.now() - startedAt).toFixed(2)) });
    } finally {
      db.close();
    }
  }

  const controlsPath = path.join(out.dir, "stage5_m143_behavior_owner_generic_controls.json");
  await writeFile(
    controlsPath,
    `${JSON.stringify(
      {
        schemaVersion: "stage5.m143b.generic-ownership-controls.v1",
        purpose:
          "M143-B §82: generic subject-vs-owner, title-is-owner, parser-vs-adapter, action-switch, "
          + "caller-vs-helper and ambiguous controls, measured on real indexes.",
        mechanismUnderTest:
          "interface-override ownership: a class that redefines a base's member owns that member's behaviour; "
          + "elected only when the request names that member. Measured, NOT shipped.",
        controls,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  // --- Gaussian hard acceptance (§55) -------------------------------------
  let gaussian: unknown = { measured: false, reason: "--arc-index not supplied" };
  if (arcIndex !== undefined) {
    const db = new Database(arcIndex, { readonly: true });
    const startedAt = performance.now();
    try {
      const objectives = objectivesFor(GAUSSIAN_QUERY);
      const adapter = overrideEvidence(db, "arc/job/adapters/gaussian.py::GaussianAdapter");
      const parser = overrideEvidence(db, "arc/parser/adapters/gaussian.py::GaussianParser");
      gaussian = {
        measured: true,
        query: GAUSSIAN_QUERY,
        queryIsExactRecordedWording: true,
        objectives,
        expectedOwner: "arc/job/adapters/gaussian.py",
        adapter: { ...adapter, verdict: classifyOwnership(adapter, objectives) },
        parser: { ...parser, verdict: classifyOwnership(parser, objectives) },
        acceptance: {
          adapterPreferredForStructuralReason:
            classifyOwnership(adapter, objectives).state === "confirmed_owner"
            && classifyOwnership(parser, objectives).state !== "confirmed_owner",
        },
        elapsedMs: Number((performance.now() - startedAt).toFixed(2)),
      };
    } finally {
      db.close();
    }
  }
  const gaussianPath = path.join(out.dir, "stage5_m143_gaussian_behavior_owner.json");
  await writeFile(
    gaussianPath,
    `${JSON.stringify(
      {
        schemaVersion: "stage5.m143b.gaussian-behavior-owner.v1",
        purpose: "M143-B §83: adapter-vs-parser structural ownership on the exact recorded ARC query.",
        gaussian,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  const perfPath = path.join(out.dir, "stage5_m143_behavior_owner_performance.json");
  await writeFile(
    perfPath,
    `${JSON.stringify(
      {
        schemaVersion: "stage5.m143b.behavior-owner-performance.v1",
        purpose: "M143-B §85: cost of the override-evidence probe.",
        note:
          "Per candidate: 1 symbol lookup + 1 member query + 1 base-reference query + 1 member query per base. "
          + "No transitive walk, no source reads.",
        graphQueriesPerCandidate: "3 + (1 per base)",
        sourceReadsPerCandidate: 0,
        scenarioTimings: timings,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  process.stdout.write(`${JSON.stringify(controls, null, 2).slice(0, 200)}\n`);
  process.stdout.write(`wrote:\n  ${controlsPath}\n  ${gaussianPath}\n  ${perfPath}\n`);
}

if (import.meta.main) {
  await main();
}
