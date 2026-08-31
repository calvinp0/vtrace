/**
 * M193C §28/§29 — the observation-mutation inventory.
 *
 * Every place the acquisition infrastructure can write to Git or to the source
 * tree, classified by WHEN it runs relative to the agent. The milestone's
 * invariant is not "the harness never writes" — setup checks out the base
 * commit, and the controls deliberately stage in order to have something to
 * observe — it is that nothing which runs WHILE the agent may still execute
 * writes anything the agent can see (§29).
 *
 * Classification is by the label the command was executed under, not by
 * eyeballing. An occurrence whose label matches no rule is reported as
 * UNCLASSIFIED and fails the gate, so a new mutating call added later cannot
 * pass by being unrecognised.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const DIR = import.meta.dir;

/** The acquisition infrastructure, in the order a run touches it. */
const SOURCES = [
  "m193_container_adapter.py",
  "m193a_source_version_probe.py",
  "m193b_changed_source.py",
  "m193c_patch_snapshot.py",
  "run_stage5_m193_preflight.py",
  "run_stage5_m193_dry_run.py",
  "run_stage5_m193b_container_control.py",
  "run_stage5_m193c_container_control.py",
  "run_stage5_m193a_bytecode_reproduction.py",
];

/** Verbs that can change Git state or the working tree. */
const MUTATING = ["add", "reset", "restore", "checkout", "stash", "commit", "mv", "rm", "apply", "update-index"];
const MUTATING_RE = new RegExp(String.raw`git\b(?:\s+-C\s+\S+)?(?:\s+-c\s+\S+)*\s+(${MUTATING.join("|")})\b`, "g");

type Category =
  | "documentation"
  | "report_text"
  | "setup"
  | "agent_action"
  | "observation"
  | "falsification_control"
  | "final_extraction"
  | "cleanup";

const CATEGORIES: Category[] = [
  "documentation",
  "report_text",
  "setup",
  "agent_action",
  "observation",
  "falsification_control",
  "final_extraction",
  "cleanup",
];

/**
 * label -> category. The keys are the labels `exec_raw` was called with, which
 * is what actually determines when a command runs.
 */
const LABEL_RULES: Array<[RegExp, Category]> = [
  // runs before the agent exists
  [/^setup_/, "setup"],
  [/^normalize_ownership$/, "setup"],
  // performed BY the subject, or by a script standing in for it
  [/^m193[bc]_(stage|rename)_/, "agent_action"],
  [/^agent_/, "agent_action"],
  [/^apply_gold$/, "agent_action"],
  // deliberately impure, so that "0 mutations" is a measurement
  [/^control_poison_(install|remove)$/, "falsification_control"],
  [/superseded_authority$/, "falsification_control"],
  // §29: everything that may run while the agent is still executing. These
  // rules exist so the gate below can actually fail: without them nothing could
  // ever be classified "observation" and the count would be zero by
  // construction rather than by measurement.
  [/^capture_diff$/, "observation"],
  [/^repository_state$/, "observation"],
  [/^changed_source/, "observation"],
  [/^module_witness$/, "observation"],
  [/^source_version/, "observation"],
  [/^bytecode_/, "observation"],
  [/^m193c_(status|index|p3_staged)_(before|after)$/, "observation"],
  [/^m193[bc]_(status|staged|show|pick)/, "observation"],
  [/^inspect$/, "observation"],
  [/^validation_/, "observation"],
  [/^control_(prime|stale_read|healthy_read|site_packages)$/, "observation"],
];

type Row = {
  file: string;
  line: number;
  verb: string;
  label: string | null;
  category: Category | "UNCLASSIFIED";
  text: string;
};

/**
 * True when the match sits in a string that DESCRIBES a command rather than one
 * that runs it: a dict value in a report, or a named constant.
 */
function isReportText(line: string): boolean {
  return /^\s*"?[\w]+"?\s*[:=]\s*f?["']/.test(line);
}

/** True when the match sits inside a comment or a docstring rather than code. */
function isProse(lines: string[], idx: number): boolean {
  const line = lines[idx];
  if (/^\s*#/.test(line)) return true;
  // a docstring body: an odd number of triple quotes opened above and not yet closed
  let open = false;
  for (let i = 0; i < idx; i++) {
    const q = (lines[i].match(/"""/g) ?? []).length;
    for (let k = 0; k < q; k++) open = !open;
  }
  return open;
}

/** The label the surrounding exec_raw / command builder was called with. */
function findLabel(lines: string[], idx: number): string | null {
  // forwards: `label="x"` or a positional `, "x")` within the same call
  for (let i = idx; i < Math.min(idx + 20, lines.length); i++) {
    const m =
      lines[i].match(/label=["']([\w.]+)["']/) ??
      // a positional label: `120, "capture_diff")` or its own line in a
      // multi-line call, which is how most of this infrastructure writes it
      lines[i].match(/,\s*["']([a-z][\w.]*)["']\s*,?\s*\)?\s*$/) ??
      lines[i].match(/^\s*["']([a-z][\w.]*)["'],\s*$/);
    if (m) return m[1];
    if (i > idx && /^(def |class )/.test(lines[i])) break;
  }
  // backwards: the enclosing def
  for (let i = idx; i >= 0; i--) {
    const m = lines[i].match(/^\s*def (\w+)/);
    if (m) return `def:${m[1]}`;
  }
  return null;
}

function classify(label: string | null): Category | "UNCLASSIFIED" {
  if (label === null) return "UNCLASSIFIED";
  for (const [re, cat] of LABEL_RULES) if (re.test(label)) return cat;
  if (label.startsWith("def:")) return "UNCLASSIFIED";
  return "UNCLASSIFIED";
}

const rows: Row[] = [];
for (const file of SOURCES) {
  const text = readFileSync(join(DIR, file), "utf8");
  const lines = text.split("\n");
  lines.forEach((line, i) => {
    for (const m of line.matchAll(MUTATING_RE)) {
      const prose = isProse(lines, i);
      const report = !prose && isReportText(line);
      const label = prose || report ? null : findLabel(lines, i);
      rows.push({
        file,
        line: i + 1,
        verb: m[1],
        label,
        category: prose ? "documentation" : report ? "report_text" : classify(label),
        text: line.trim().slice(0, 140),
      });
    }
  });
}

// the pure builders, executed exactly as production would build them
const builders = [
  ["patch_snapshot_command", Bun.spawnSync(["python3", "-c", pyPrint("m193c_patch_snapshot", "patch_snapshot_command(['build'])")], { cwd: DIR })],
  ["repository_state_command", Bun.spawnSync(["python3", "-c", pyPrint("m193c_patch_snapshot", "repository_state_command()")], { cwd: DIR })],
  ["changed_source_command", Bun.spawnSync(["python3", "-c", pyPrint("m193b_changed_source", "changed_source_command(['build'])")], { cwd: DIR })],
] as const;

function pyPrint(mod: string, expr: string): string {
  return `import sys; sys.path.insert(0, ${JSON.stringify(DIR)});\nfrom ${mod} import *\nprint(${expr})`;
}

const builderRows = builders.map(([name, proc]) => {
  const cmd = new TextDecoder().decode(proc.stdout);
  const verbs = [...cmd.matchAll(MUTATING_RE)].map((m) => m[1]);
  return { builder: name, mutatingVerbs: verbs, readOnly: verbs.length === 0, bytes: cmd.trim().length };
});

// ── the gate must be able to fail ───────────────────────────────────────
//
// M193B's lesson: a check whose failure nobody can construct on demand has not
// been tested. `intermediateObservationMutations === 0` is only evidence if a
// mutating call under an observation label would actually be counted, so one is
// synthesised here and pushed through the SAME classifier.
const SYNTHETIC_IMPURE = [
  '        rec = self.exec_raw(',
  '            "git add -A; git diff --cached; git reset -q",',
  '            timeout=300,',
  '            label="capture_diff",',
  '        )',
];
const syntheticLabel = findLabel(SYNTHETIC_IMPURE, 1);
const syntheticCategory = classify(syntheticLabel);
const gateCanFail = syntheticCategory === "observation";

const unclassified = rows.filter((r) => r.category === "UNCLASSIFIED");
const duringAgent = rows.filter((r) => r.category === "observation");

const doc = {
  schemaVersion: "stage5.m193c.observation-inventory.v1",
  milestone: "M193C",
  liveModelCalls: 0,
  liveModelSpendUsd: 0,
  sourcesScanned: SOURCES.length,
  mutatingVerbs: MUTATING,
  occurrences: rows.length,
  byCategory: Object.fromEntries(
    [...CATEGORIES, "UNCLASSIFIED"].map((c) => [c, rows.filter((r) => r.category === c).length]),
  ),
  /** §29: nothing that runs while the agent may still execute may mutate. */
  intermediateObservationMutations: duringAgent.length,
  gateSelfTest: {
    syntheticImpureObservation: SYNTHETIC_IMPURE.join("\n"),
    resolvedLabel: syntheticLabel,
    classifiedAs: syntheticCategory,
    /** false here would mean the zero above is an artefact, not a measurement */
    gateCanFail,
  },
  unclassified,
  observationBuilders: builderRows,
  rows,
  verdict:
    unclassified.length === 0 && duringAgent.length === 0 && gateCanFail && builderRows.every((b) => b.readOnly)
      ? "NO_INTERMEDIATE_OBSERVATION_MUTATES"
      : "OBSERVATION_MUTATION_PRESENT",
};

const out = process.argv[2] ?? join(DIR, "results", "stage5_m193c_observation_inventory.json");
writeFileSync(out, JSON.stringify(doc, null, 2) + "\n");
console.log(`wrote ${out}`);
console.log(`occurrences: ${doc.occurrences}`);
console.log(`byCategory: ${JSON.stringify(doc.byCategory)}`);
console.log(`observation builders read-only: ${builderRows.every((b) => b.readOnly)}`);
console.log(`gate self-test (synthetic impure observation classified): ${syntheticCategory} -> canFail=${gateCanFail}`);
console.log(`verdict: ${doc.verdict}`);
if (unclassified.length) {
  console.log("UNCLASSIFIED:");
  for (const u of unclassified) console.log(`  ${u.file}:${u.line} git ${u.verb} label=${u.label} :: ${u.text}`);
}
