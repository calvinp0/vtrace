/**
 * M195 - the I6 validation-selection mechanism, as a pure module.
 *
 * The module is split the way the milestone requires the *evidence* to be split.
 * `deriveCandidates` takes an `I6DecisionPointEvidence` and nothing else. That
 * object is built by copying a whitelist into a fresh structure, so the gold
 * patch, the reference test patch, the arm's resolution, the agent's next
 * validation command and every event at or after the decision point are not
 * merely unread here - they are absent. `evaluateCandidate` is the only place
 * that is allowed to see any of them, and it runs after the candidate set has
 * already been hashed.
 *
 * Frozen by benchmarks/.../results/stage5_m195_preregistration.md at 8655851a.
 * No rule in this file may be changed in response to a scoring result.
 */

import { createHash } from "node:crypto";
import type { SemanticTestResult } from "./m193Acquisition";

export const M195_SCHEMA_VERSION = "stage5.m195.mechanism.v1";
export const M195_MAX_TARGETS = 3; // §8

export type Family = "I6-A" | "I6-B" | "I6-C" | "I6-D";
export const M195_FAMILIES: readonly Family[] = Object.freeze(["I6-A", "I6-B", "I6-C", "I6-D"]);

// ── repository facts (base commit, materialised offline) ────────────

export interface RepoFacts {
  headSha: string;
  trackedPaths: string[];
  pyFiles: string[];
  testFiles: string[];
  testImports: Record<string, { modules: string[]; names: string[] }>;
  testDefs: Record<string, { functions: string[]; classes: string[] }>;
  packageRoots: string[];
  centralTestRoots: string[];
  nativeRunners: Record<string, boolean>;
}

// ── the blind evidence object ───────────────────────────────────────

export type DecisionPointKind = "DP_EDIT" | "DP_POST_FAILED_VALIDATION";

/** A prior event, redacted to a field whitelist. Nothing here is in the future. */
export interface RedactedEvent {
  sequence: number;
  type: "edit" | "validation_attempt" | "observation";
  diffHash?: string;
  command?: string;
  runnerStarted?: boolean;
  semanticResult?: SemanticTestResult;
}

export interface I6DecisionPointEvidence {
  decisionPointId: string;
  armId: string;
  instanceId: string;
  repo: string;
  sequence: number;
  kind: DecisionPointKind;
  /** The untreated baseline prompt the agent was given. */
  taskText: string;
  /** The agent's own diff at this instant, from the frozen M194 snapshot. */
  currentDiffText: string;
  changedSourcePaths: string[];
  changedSymbols: string[];
  priorEvents: RedactedEvent[];
  /** Only for DP_POST_FAILED_VALIDATION: output the agent had already seen. */
  observedFailureText: string | null;
  repoFacts: RepoFacts;
}

// ── candidates ──────────────────────────────────────────────────────

export type Specificity = "EXACT_TEST" | "TEST_FILE" | "TEST_DIRECTORY" | "SUITE" | "UNKNOWN";

export interface Candidate {
  family: Family;
  /** Repository-relative test file, or directory when specificity says so. */
  path: string;
  node: string | null;
  specificity: Specificity;
  rank: number;
  /** Structured derivation, not prose. The prose summarises this; §45. */
  rule: string;
  evidence: Record<string, string | string[]>;
  command: string;
}

export interface FamilyCandidates {
  family: Family;
  candidates: Candidate[];
  /** Size before the §8 bound was applied - a mechanism that had to truncate
   *  240 importers to 3 is not bounded, it is sampled, and that is measured. */
  preCapCount: number;
  abstained: boolean;
}

// ── diff parsing (pre-decision, from the frozen snapshot only) ───────

const DIFF_PATH = /^diff --git a\/(\S+) b\/(\S+)$/;
const HUNK = /^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@ ?(.*)$/;
const DEF_IN_LINE = /^[+-]\s*(?:async\s+)?(?:def|class)\s+(\w+)/;
const DEF_IN_CONTEXT = /(?:def|class)\s+(\w+)/;

export function parseChangedPaths(diffText: string): string[] {
  const out = new Set<string>();
  for (const line of diffText.split("\n")) {
    const m = DIFF_PATH.exec(line);
    if (m) out.add(m[2] as string);
  }
  return [...out].sort();
}

export function parseChangedSymbols(diffText: string): string[] {
  const out = new Set<string>();
  for (const line of diffText.split("\n")) {
    const h = HUNK.exec(line);
    if (h) {
      const c = DEF_IN_CONTEXT.exec(h[1] ?? "");
      if (c) out.add(c[1] as string);
      continue;
    }
    const d = DEF_IN_LINE.exec(line);
    if (d) out.add(d[1] as string);
  }
  return [...out].sort();
}

// ── path helpers ────────────────────────────────────────────────────

const dirname = (p: string): string => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");
const basename = (p: string): string => (p.includes("/") ? p.slice(p.lastIndexOf("/") + 1) : p);
const stemOf = (p: string): string => basename(p).replace(/\.py$/, "");

/** The extractor's rule, restated: strip the longest package root prefix. */
export function dottedOf(path: string, packageRoots: string[]): string {
  let stem = path.replace(/\.py$/, "").replace(/\/__init__$/, "");
  let best = "";
  for (const r of packageRoots) {
    if (r && stem.startsWith(`${r}/`) && r.length > best.length) best = r;
  }
  if (best) stem = stem.slice(best.length + 1);
  return stem.replace(/\//g, ".");
}

export function isTestPath(p: string): boolean {
  if (!p.endsWith(".py")) return false;
  const b = basename(p);
  if (b === "__init__.py" || b === "conftest.py" || b === "setup.py") return false;
  if (b.startsWith("test_") || b.endsWith("_test.py") || b === "tests.py") return true;
  return dirname(p)
    .split("/")
    .some((d) => d === "tests" || d === "testing" || d === "test");
}

// ── §9 native validation command derivation ─────────────────────────

export function deriveCommand(repo: string, path: string, node: string | null, facts: RepoFacts): string {
  if (repo === "django/django") {
    if (!path.startsWith("tests/")) return "UNKNOWN";
    const rel = path.slice("tests/".length).replace(/\.py$/, "");
    const label = node ? `${rel.replace(/\//g, ".")}.${node}` : rel.replace(/\//g, ".");
    return `./tests/runtests.py ${label}`;
  }
  if (repo === "sympy/sympy") return `bin/test ${path}`;
  void facts;
  return node ? `python -m pytest ${path}::${node}` : `python -m pytest ${path}`;
}

// ── §7 the four frozen families ─────────────────────────────────────

const cap = <T>(xs: T[]): T[] => xs.slice(0, M195_MAX_TARGETS);

function mk(
  family: Family,
  path: string,
  node: string | null,
  specificity: Specificity,
  rank: number,
  rule: string,
  evidence: Record<string, string | string[]>,
  ev: I6DecisionPointEvidence,
): Candidate {
  return {
    family,
    path,
    node,
    specificity,
    rank,
    rule,
    evidence,
    command: deriveCommand(ev.repo, path, node, ev.repoFacts),
  };
}

/** I6-A — changed-source test affinity. */
export function deriveA(ev: I6DecisionPointEvidence): FamilyCandidates {
  const tracked = new Set(ev.repoFacts.trackedPaths);
  const dirs = new Set(ev.repoFacts.trackedPaths.map(dirname));
  const found: Array<{ tier: number; c: Candidate }> = [];
  const seen = new Set<string>();

  const add = (tier: number, path: string, rule: string, evidence: Record<string, string | string[]>) => {
    if (seen.has(path)) return;
    seen.add(path);
    found.push({ tier, c: mk("I6-A", path, null, "TEST_FILE", 0, rule, evidence, ev) });
  };

  for (const p of ev.changedSourcePaths) {
    if (!p.endsWith(".py") || isTestPath(p)) continue;
    const stem = stemOf(p);
    const d = dirname(p);

    // A1 sibling mirror
    const a1 = `${d}/tests/test_${stem}.py`;
    if (tracked.has(a1)) add(1, a1, "A1_sibling_mirror", { changedFile: p, mirror: a1 });

    // A2 package mirror, nearest ancestor first
    const parts = d.split("/").filter(Boolean);
    for (let i = parts.length - 1; i >= 0; i--) {
      const anc = parts.slice(0, i).join("/");
      const a2 = anc ? `${anc}/tests/test_${stem}.py` : `tests/test_${stem}.py`;
      if (tracked.has(a2)) {
        add(2, a2, "A2_package_mirror", { changedFile: p, ancestor: anc || ".", mirror: a2 });
        break;
      }
    }

    // A3 central mirror
    for (const root of ev.repoFacts.centralTestRoots) {
      const rel = parts.slice(1).join("/"); // drop the top package component
      for (const a3 of [
        rel ? `${root}/${rel}/test_${stem}.py` : `${root}/test_${stem}.py`,
        `${root}/test_${stem}.py`,
      ]) {
        if (tracked.has(a3)) add(3, a3, "A3_central_mirror", { changedFile: p, root, mirror: a3 });
      }
    }

    // A4 Django app-label mirror
    if (p.startsWith("django/")) {
      const names = [stem, parts[parts.length - 1] ?? ""].filter(Boolean);
      for (const n of names) {
        const labelDir = `tests/${n}`;
        if (!dirs.has(labelDir)) continue;
        const inner = [`${labelDir}/tests.py`, `${labelDir}/test_${stem}.py`].find((x) => tracked.has(x));
        if (inner) add(4, inner, "A4_django_app_label", { changedFile: p, label: n, mirror: inner });
        else {
          if (seen.has(labelDir)) continue;
          seen.add(labelDir);
          found.push({
            tier: 4,
            c: mk("I6-A", labelDir, null, "TEST_DIRECTORY", 0, "A4_django_app_label_dir",
              { changedFile: p, label: n }, ev),
          });
        }
      }
    }
  }

  found.sort((a, b) => a.tier - b.tier || a.c.path.localeCompare(b.c.path));
  const candidates = cap(found.map((f) => f.c)).map((c, i) => ({ ...c, rank: i + 1 }));
  return { family: "I6-A", candidates, preCapCount: found.length, abstained: found.length === 0 };
}

/** I6-B — affected-consumer validation. Validation targets only; never edits. */
export function deriveB(ev: I6DecisionPointEvidence): FamilyCandidates {
  const roots = ev.repoFacts.packageRoots;
  const changedModules = ev.changedSourcePaths
    .filter((p) => p.endsWith(".py") && !isTestPath(p))
    .map((p) => dottedOf(p, roots));
  if (changedModules.length === 0) {
    return { family: "I6-B", candidates: [], preCapCount: 0, abstained: true };
  }
  const symbolQualified = new Set<string>();
  for (const m of changedModules) for (const s of ev.changedSymbols) symbolQualified.add(`${m}.${s}`);

  const tier1: Array<{ path: string; via: string }> = [];
  const tier2: Array<{ path: string; via: string }> = [];
  for (const t of ev.repoFacts.testFiles) {
    const mods = ev.repoFacts.testImports[t]?.modules ?? [];
    if (mods.length === 0) continue;
    const modHit = changedModules.find((m) => mods.includes(m));
    if (!modHit) continue;
    const symHit = mods.find((m) => symbolQualified.has(m));
    (symHit ? tier1 : tier2).push({ path: t, via: symHit ?? modHit });
  }
  // Ordering is alphabetical on purpose. Ranking a consumer higher because its
  // filename looks like the changed module would smuggle I6-A's affinity signal
  // into I6-B and make the two families impossible to tell apart.
  tier1.sort((a, b) => a.path.localeCompare(b.path));
  tier2.sort((a, b) => a.path.localeCompare(b.path));
  const ordered = [...tier1, ...tier2];
  const candidates = cap(ordered).map((x, i) =>
    ({ ...mk("I6-B", x.path, null, "TEST_FILE", i + 1,
        tier1.some((t) => t.path === x.path) ? "B1_imports_changed_symbol" : "B2_imports_changed_module",
        { changedModules, importEdge: x.via }, ev) }));
  return { family: "I6-B", candidates, preCapCount: ordered.length, abstained: ordered.length === 0 };
}

/** I6-C — task/repository test cue. Behavioural prose alone never fires. */
const NODE_ID = /([\w./-]+\.py)::([\w[\]\-.]+)/g;
const TEST_PATH = /((?:[\w.-]+\/)*test_[\w-]+\.py)/g;
const BARE_TEST = /\btest_[a-z0-9_]+\b/g;
const DOTTED = /\b([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)+)\b/g;

export function deriveC(ev: I6DecisionPointEvidence): FamilyCandidates {
  const tracked = new Set(ev.repoFacts.trackedPaths);
  const text = ev.taskText;
  const explicit: Candidate[] = [];
  const derived: Candidate[] = [];
  const seen = new Set<string>();

  const push = (into: Candidate[], path: string, node: string | null, spec: Specificity,
                rule: string, evidence: Record<string, string | string[]>) => {
    const key = `${path}::${node ?? ""}`;
    if (seen.has(key)) return;
    seen.add(key);
    into.push(mk("I6-C", path, node, spec, 0, rule, evidence, ev));
  };

  for (const m of text.matchAll(NODE_ID)) {
    const [, p, n] = m;
    if (p && tracked.has(p)) push(explicit, p, n ?? null, "EXACT_TEST", "C1_explicit_node_id", { cue: m[0] });
  }
  for (const m of text.matchAll(TEST_PATH)) {
    const p = m[1] as string;
    if (tracked.has(p)) push(explicit, p, null, "TEST_FILE", "C1_explicit_test_path", { cue: p });
  }
  // A bare `test_foo` counts only when the repository actually defines it.
  const byStem = new Map<string, string[]>();
  for (const t of ev.repoFacts.testFiles) {
    const s = stemOf(t);
    byStem.set(s, [...(byStem.get(s) ?? []), t]);
  }
  for (const m of text.matchAll(BARE_TEST)) {
    const name = m[0];
    const owners = ev.repoFacts.testFiles.filter((t) =>
      (ev.repoFacts.testDefs[t]?.functions ?? []).includes(name),
    );
    if (owners.length === 1 && owners[0]) {
      push(explicit, owners[0], name, "EXACT_TEST", "C1_explicit_test_name", { cue: name });
    } else if (owners.length === 0) {
      for (const t of byStem.get(name) ?? []) {
        push(explicit, t, null, "TEST_FILE", "C1_explicit_test_module", { cue: name });
      }
    }
  }
  // Identifier-derived: a dotted API name maps to an existing test module only
  // through a component that names one. Prose never reaches here.
  const comps = new Set<string>();
  for (const m of text.matchAll(DOTTED)) {
    const parts = (m[1] as string).split(".");
    for (const c of parts.slice(-2)) if (/^[a-z_]\w*$/.test(c) && c.length > 2) comps.add(c);
  }
  for (const c of [...comps].sort()) {
    for (const t of byStem.get(`test_${c}`) ?? []) {
      push(derived, t, null, "TEST_FILE", "C2_identifier_derived", { component: c });
    }
  }

  const ordered = [...explicit, ...derived];
  const candidates = cap(ordered).map((c, i) => ({ ...c, rank: i + 1 }));
  return { family: "I6-C", candidates, preCapCount: ordered.length, abstained: ordered.length === 0 };
}

/** I6-D — prior-failure refinement. Only where a failure was already observed. */
const FAILED_LINE = /^(?:FAILED|ERROR)\s+([\w./-]+\.py)(?:::([\w[\]\-.]+))?/gm;
const COLLECT_ERR = /ERROR collecting ([\w./-]+\.py)/g;
const UNITTEST_FAIL = /^(?:FAIL|ERROR):\s+(\w+)\s+\(([\w.]+)\)/gm;

export function deriveD(ev: I6DecisionPointEvidence): FamilyCandidates {
  if (ev.kind !== "DP_POST_FAILED_VALIDATION" || !ev.observedFailureText) {
    return { family: "I6-D", candidates: [], preCapCount: 0, abstained: true };
  }
  const tracked = new Set(ev.repoFacts.trackedPaths);
  const text = ev.observedFailureText;
  const out: Candidate[] = [];
  const seen = new Set<string>();
  const push = (path: string, node: string | null, spec: Specificity, rule: string,
                evidence: Record<string, string | string[]>) => {
    const key = `${path}::${node ?? ""}`;
    if (seen.has(key) || !tracked.has(path)) return;
    seen.add(key);
    out.push(mk("I6-D", path, node, spec, 0, rule, evidence, ev));
  };

  for (const m of text.matchAll(FAILED_LINE)) {
    push(m[1] as string, m[2] ?? null, m[2] ? "EXACT_TEST" : "TEST_FILE", "D1_reported_failure", { line: m[0] });
  }
  for (const m of text.matchAll(NODE_ID)) {
    push(m[1] as string, m[2] ?? null, "EXACT_TEST", "D2_node_id_in_output", { cue: m[0] });
  }
  for (const m of text.matchAll(COLLECT_ERR)) {
    push(m[1] as string, null, "TEST_FILE", "D3_collection_error", { cue: m[0] });
  }
  for (const m of text.matchAll(UNITTEST_FAIL)) {
    const dotted = (m[2] as string).split(".");
    const modPath = ev.repoFacts.testFiles.find((t) => dotted.includes(stemOf(t)));
    if (modPath) push(modPath, m[1] as string, "EXACT_TEST", "D4_unittest_failure", { cue: m[0] });
  }

  const candidates = cap(out).map((c, i) => ({ ...c, rank: i + 1 }));
  return { family: "I6-D", candidates, preCapCount: out.length, abstained: out.length === 0 };
}

/** The whole derivation. Takes blind evidence and returns candidates only. */
export function deriveCandidates(ev: I6DecisionPointEvidence): FamilyCandidates[] {
  const families = [deriveA(ev), deriveB(ev), deriveC(ev), deriveD(ev)];
  // I6-UNION is a reported aggregate over the frozen four, not a fifth family.
  return families;
}

export function unionOf(families: FamilyCandidates[]): FamilyCandidates {
  const seen = new Set<string>();
  const merged: Candidate[] = [];
  for (const f of families) {
    for (const c of f.candidates) {
      const key = `${c.path}::${c.node ?? ""}`;
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(c);
    }
  }
  return {
    family: "I6-A", // structural placeholder; the row is labelled I6-UNION by the driver
    candidates: cap(merged).map((c, i) => ({ ...c, rank: i + 1 })),
    preCapCount: merged.length,
    abstained: merged.length === 0,
  };
}

// ── fingerprints (§57) ──────────────────────────────────────────────

const sha = (s: string): string => createHash("sha256").update(s).digest("hex");

export function candidateSetHash(families: FamilyCandidates[]): string {
  return sha(
    JSON.stringify(
      families.map((f) => ({
        family: f.family,
        preCapCount: f.preCapCount,
        candidates: f.candidates.map((c) => [c.family, c.path, c.node, c.specificity, c.rank, c.rule, c.command]),
      })),
    ),
  );
}

export function derivationInputHash(ev: I6DecisionPointEvidence): string {
  return sha(
    JSON.stringify({
      id: ev.decisionPointId,
      kind: ev.kind,
      taskText: sha(ev.taskText),
      currentDiffText: sha(ev.currentDiffText),
      changedSourcePaths: ev.changedSourcePaths,
      changedSymbols: ev.changedSymbols,
      priorEvents: ev.priorEvents,
      observedFailureText: ev.observedFailureText === null ? null : sha(ev.observedFailureText),
      repoFacts: sha(JSON.stringify(ev.repoFacts)),
    }),
  );
}

export function tracePrefixHash(events: RedactedEvent[]): string {
  return sha(JSON.stringify(events));
}
