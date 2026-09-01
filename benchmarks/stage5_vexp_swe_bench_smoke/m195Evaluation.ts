/**
 * M195 - the evaluation layer.
 *
 * Everything the derivation is forbidden to see lives here, and nothing here
 * runs until the candidate set has already been frozen and hashed. The split is
 * the M185/M189 principle restated: final outcome may evaluate a pre-decision
 * prediction; it may not generate or classify the evidence used to make it.
 *
 * Frozen by results/stage5_m195_preregistration.md at 8655851a.
 */

import type { Candidate, Family, RepoFacts } from "./m195Mechanism";
import { isTestPath } from "./m195Mechanism";

export type Relation =
  | "EXACT_MATCH"
  | "EQUIVALENT"
  | "BROADER_THAN_CANDIDATE"
  | "DIFFERENT_VALIDATION"
  | "NO_VALIDATION";

export const RELATION_RANK: Record<Relation, number> = {
  EXACT_MATCH: 0,
  EQUIVALENT: 1,
  BROADER_THAN_CANDIDATE: 2,
  DIFFERENT_VALIDATION: 3,
  NO_VALIDATION: 4,
};

export type DecisionClass =
  | "I6_NO_REPOSITORY_DERIVABLE_VALIDATION_OBLIGATION"
  | "I6_RELEVANT_VALIDATION_ALREADY_SELECTED"
  | "I6_VALIDATION_SELECTION_MISS"
  | "VALIDATION_EVIDENCE_UNUSABLE"
  | "CANDIDATE_FIRED_NOT_CONFIRMED";

// ── the agent's own validation target set ───────────────────────────

export interface ValidationTargets {
  files: string[];
  nodes: string[];
  dirs: string[];
  labels: string[];
  wholeSuite: boolean;
}

const NODE_TOKEN = /^([\w./-]+\.py)::([\w[\]\-.]+)$/;

/**
 * Django's label grammar: `auth_tests.test_forms.TestX.test_y`. The label is
 * walked component by component against the tracked tree, so a label that names
 * a file is distinguished from one that names a whole app directory - the
 * difference between EXACT_MATCH and BROADER_THAN_CANDIDATE.
 */
export function djangoLabelToPath(label: string, tracked: Set<string>, dirs: Set<string>):
  { path: string; kind: "file" | "dir" } | null {
  const parts = label.split(".");
  for (let i = parts.length; i >= 1; i--) {
    const joined = `tests/${parts.slice(0, i).join("/")}`;
    if (tracked.has(`${joined}.py`)) return { path: `${joined}.py`, kind: "file" };
    if (dirs.has(joined)) return { path: joined, kind: "dir" };
  }
  return null;
}

export function parseValidationTargets(repo: string, command: string, facts: RepoFacts): ValidationTargets {
  const tracked = new Set(facts.trackedPaths);
  const dirSet = new Set(facts.trackedPaths.map((p) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "")));
  const out: ValidationTargets = { files: [], nodes: [], dirs: [], labels: [], wholeSuite: false };
  const raw = command.replace(/[`'"]/g, " ").split(/\s+/).filter(Boolean);
  const usesRuntests = /runtests\.py/.test(command);

  for (let i = 0; i < raw.length; i++) {
    const tok = (raw[i] as string).replace(/[,;]+$/, "");
    if (tok.startsWith("-")) {
      if (tok === "-k" || tok === "-m") i++; // consume the expression; not a path target
      continue;
    }
    const nm = NODE_TOKEN.exec(tok);
    if (nm) {
      out.files.push(nm[1] as string);
      out.nodes.push(tok);
      continue;
    }
    if (tok.endsWith(".py")) {
      if (!/runtests\.py$|^bin\/test$|setup\.py$/.test(tok)) out.files.push(tok);
      continue;
    }
    if (dirSet.has(tok.replace(/\/$/, ""))) {
      out.dirs.push(tok.replace(/\/$/, ""));
      continue;
    }
    if (usesRuntests && /^[A-Za-z_][\w.]*$/.test(tok) && !/^(python|bash|sh|cd|env)$/.test(tok)) {
      const r = djangoLabelToPath(tok, tracked, dirSet);
      if (r) {
        out.labels.push(tok);
        if (r.kind === "file") out.files.push(r.path);
        else out.dirs.push(r.path);
      }
    }
  }
  out.wholeSuite =
    out.files.length === 0 && out.nodes.length === 0 && out.dirs.length === 0 && out.labels.length === 0;
  return out;
}

/** One command the agent actually issued inside the credit window. */
export interface ObservedValidation {
  targets: ValidationTargets;
  runnerStarted: boolean;
}

/**
 * §10 — the frozen relation between one candidate and one observed command.
 *
 * EXACT_MATCH and EQUIVALENT are questions about what the agent *selected*, so
 * they hold whether or not the runner went on to start. BROADER_THAN_CANDIDATE
 * and DIFFERENT_VALIDATION are questions about what a run *covered*, and §10
 * defines the latter as "a runner started, but its target set does not contain
 * the candidate" - so a `python -c` reproduction script, which starts no runner
 * at all, is not a different validation. It is no validation.
 */
export function relateOne(cand: Candidate, obs: ObservedValidation, changedStems: string[]): Relation {
  const { targets } = obs;
  if (targets.files.includes(cand.path)) return "EXACT_MATCH";
  if (cand.node && targets.nodes.includes(`${cand.path}::${cand.node}`)) return "EXACT_MATCH";
  if (cand.path.endsWith(".py")) {
    const dir = cand.path.slice(0, cand.path.lastIndexOf("/"));
    const sibling = targets.files.find(
      (f) =>
        f.startsWith(`${dir}/`) &&
        !f.slice(dir.length + 1).includes("/") &&
        changedStems.some((s) => s.length > 2 && f.includes(s)),
    );
    if (sibling) return "EQUIVALENT";
  }
  if (!obs.runnerStarted) return "NO_VALIDATION";
  if (targets.dirs.some((d) => cand.path === d || cand.path.startsWith(`${d}/`))) {
    return "BROADER_THAN_CANDIDATE";
  }
  if (targets.wholeSuite) return "BROADER_THAN_CANDIDATE";
  return "DIFFERENT_VALIDATION";
}

/** Best relation a candidate achieves across every command in the credit window. */
export function relateCandidate(
  cand: Candidate,
  commands: ObservedValidation[],
  changedStems: string[],
): Relation {
  if (commands.length === 0) return "NO_VALIDATION";
  let best: Relation = "NO_VALIDATION";
  for (const t of commands) {
    const r = relateOne(cand, t, changedStems);
    if (RELATION_RANK[r] < RELATION_RANK[best]) best = r;
  }
  return best;
}

// ── §11 relevance oracle (evaluation-only) ──────────────────────────

export interface GoldEvidence {
  testPatchPaths: string[];
  failToPassPaths: string[];
  failToPassNodes: string[];
}

const DIFF_PATH = /^diff --git a\/(\S+) b\/(\S+)$/;
const F2P_PYTEST = /^([\w./-]+\.py)::(.+)$/;
const F2P_UNITTEST = /^(\w+)\s+\(([\w.]+)\)/;

/**
 * The gold columns, reduced to the two things §11 allows: which test files the
 * reference patch touches, and which files hold a FAIL_TO_PASS node.
 * PASS_TO_PASS is deliberately absent - including it would make nearly every
 * pre-existing test "relevant" and would inflate every relevance-dependent gate.
 */
export function goldEvidence(row: { test_patch: string; FAIL_TO_PASS: string }, facts: RepoFacts): GoldEvidence {
  const testPatchPaths: string[] = [];
  for (const line of (row.test_patch ?? "").split("\n")) {
    const m = DIFF_PATH.exec(line);
    if (m) testPatchPaths.push(m[2] as string);
  }
  let nodes: string[] = [];
  try {
    nodes = JSON.parse(row.FAIL_TO_PASS ?? "[]");
  } catch {
    nodes = [];
  }
  const paths = new Set<string>();
  for (const n of nodes) {
    const p = F2P_PYTEST.exec(n);
    if (p) {
      paths.add(p[1] as string);
      continue;
    }
    const u = F2P_UNITTEST.exec(n);
    if (u) {
      const dotted = (u[2] as string).split(".");
      for (let i = dotted.length; i >= 1; i--) {
        const cand = `tests/${dotted.slice(0, i).join("/")}.py`;
        if (facts.trackedPaths.includes(cand)) {
          paths.add(cand);
          break;
        }
      }
    }
  }
  return { testPatchPaths: [...new Set(testPatchPaths)].sort(), failToPassPaths: [...paths].sort(), failToPassNodes: nodes };
}

export function isRelevant(cand: Candidate, gold: GoldEvidence): boolean {
  if (gold.testPatchPaths.includes(cand.path)) return true;
  if (gold.failToPassPaths.includes(cand.path)) return true;
  if (cand.node && gold.failToPassNodes.some((n) => n === `${cand.path}::${cand.node}` || n.startsWith(`${cand.node} (`))) {
    return true;
  }
  return false;
}

// ── §12 classification ──────────────────────────────────────────────

export interface DecisionInputs {
  candidateCount: number;
  bestRelation: Relation;
  anyRelevant: boolean;
  attemptsInWindow: number;
  anyTrustworthyInWindow: boolean;
}

export function classifyDecisionPoint(i: DecisionInputs): DecisionClass {
  if (i.candidateCount === 0) return "I6_NO_REPOSITORY_DERIVABLE_VALIDATION_OBLIGATION";
  if (i.bestRelation === "EXACT_MATCH" || i.bestRelation === "EQUIVALENT") {
    return "I6_RELEVANT_VALIDATION_ALREADY_SELECTED";
  }
  if ((i.bestRelation === "DIFFERENT_VALIDATION" || i.bestRelation === "NO_VALIDATION") && i.anyRelevant) {
    return "I6_VALIDATION_SELECTION_MISS";
  }
  if (i.attemptsInWindow > 0 && !i.anyTrustworthyInWindow) return "VALIDATION_EVIDENCE_UNUSABLE";
  return "CANDIDATE_FIRED_NOT_CONFIRMED";
}

// ── §13 the nine gates ──────────────────────────────────────────────

export interface FamilyScore {
  family: Family | "I6-UNION";
  fingerprintDiffs: number;
  medianCandidates: number;
  p90Candidates: number;
  maxCandidates: number;
  emptyRatePct: number;
  missTasks: number;
  missRepos: number;
  successWitnesses: number;
  successWitnessRepos: number;
  unnecessaryFireRatePctResolved: number;
  redundantRecommendationRatePct: number;
  largestTaskSharePct: number;
  missPrecision: number;
}

export interface GateResult {
  id: string;
  requirement: string;
  observed: string;
  pass: boolean;
}

export function evaluateGates(s: FamilyScore): GateResult[] {
  const g = (id: string, requirement: string, observed: string | number, pass: boolean): GateResult => ({
    id,
    requirement,
    observed: String(observed),
    pass,
  });
  return [
    g("G1", "blind replay: 0 differing candidate-set fingerprints", s.fingerprintDiffs, s.fingerprintDiffs === 0),
    g("G2", "median <= 3 and p90 <= 3 candidates", `median ${s.medianCandidates}, p90 ${s.p90Candidates}`,
      s.medianCandidates <= 3 && s.p90Candidates <= 3),
    g("G3", ">= 3 distinct tasks with a selection miss", s.missTasks, s.missTasks >= 3),
    g("G4", "those misses span >= 3 distinct repositories", s.missRepos, s.missRepos >= 3),
    g("G5", ">= 2 success-side witnesses across >= 2 repositories",
      `${s.successWitnesses} witnesses / ${s.successWitnessRepos} repos`,
      s.successWitnesses >= 2 && s.successWitnessRepos >= 2),
    g("G6", "unnecessary fire rate on resolved arms <= 50%", `${s.unnecessaryFireRatePctResolved}%`,
      s.unnecessaryFireRatePctResolved <= 50),
    g("G7", "redundant recommendation rate < 80%", `${s.redundantRecommendationRatePct}%`,
      s.redundantRecommendationRatePct < 80),
    g("G8", "largest single task contributes < 50% of miss specimens", `${s.largestTaskSharePct}%`,
      s.largestTaskSharePct < 50),
    g("G9", "miss precision >= 0.50", s.missPrecision.toFixed(2), s.missPrecision >= 0.5),
  ];
}

export const changedStemsOf = (changedSourcePaths: string[]): string[] =>
  changedSourcePaths
    .filter((p) => p.endsWith(".py") && !isTestPath(p))
    .map((p) => (p.includes("/") ? p.slice(p.lastIndexOf("/") + 1) : p).replace(/\.py$/, ""));
