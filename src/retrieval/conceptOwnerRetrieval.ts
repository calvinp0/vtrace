// Behavioural concept-owner retrieval (M142 Workstream C).
//
// WHY THIS EXISTS
// ----------------
// Every existing lane is SYMBOL-centric: it finds a definition because the query
// named it, spelled part of it, quoted a literal it emits, or reached it from
// something else that matched. All of those need the request to make contact with
// one definition.
//
// The product workflow asks by BEHAVIOUR, precisely because reuse discovery
// cannot assume the caller already knows the symbol name. Measured on ARC: "how
// does ARC verify that a saddle point actually connects the intended reactants
// and products by looking at how the atoms move in the imaginary vibration?"
// returned nothing from `arc/checks/nmd.py` — not a low-ranked candidate, not a
// dropped one. The module that owns the concept never entered the pool, because
// no single symbol inside it matched the wording well enough to be found.
//
// It could still be RECOGNISED, though: seventeen definitions in one small file,
// several of them individually mediocre matches, together describing exactly the
// requested behaviour. That is the signal this lane reads — evidence aggregated
// per FILE rather than per symbol.
//
// WHAT IT IS NOT
// ----------------
// It is not a ranking change. Owner files that the pool ALREADY represents are
// skipped entirely, so the lane is strictly additive: it can introduce a
// candidate, never reorder existing ones. It is not a source reader — owner
// scoring touches indexed metadata only, so deciding which three files matter
// costs zero file reads. And it never makes a module scope answer-bearing: a
// file is identified as an owner, and the answer-bearing DEFINITIONS inside it
// are what get admitted (M140 structural-node backstop preserved).
//
// No embeddings, no model, no external service. Deterministic given the index.

import type { Database } from "bun:sqlite";

import { listAllSymbols } from "../db/repositories/symbolsRepository";
import { isStructuralSymbolKind, SymbolKind, type SymbolRecord } from "../domain/types";
import { evaluateOrchestrationIntent, type DerivedQueryIntent } from "./querySemantics";
import { tokenize } from "./hybridScoring";

/** Kinds that can answer a behavioural question. */
const ANSWER_BEARING_KINDS: ReadonlySet<SymbolKind> = new Set([
  SymbolKind.Function,
  SymbolKind.Method,
  SymbolKind.Class,
]);

/**
 * Interrogative, auxiliary and discourse vocabulary that belongs to the QUESTION
 * rather than to the behaviour being asked about.
 *
 * This is ordinary text processing, not symbol-intent determination — that lives
 * in the typed grammar (`exactSymbolEligibleTerms`). Its only job here is to stop
 * "how does it work?" from being read as three behavioural objectives.
 */
const QUESTION_FRAME_WORDS: ReadonlySet<string> = new Set([
  "how", "does", "do", "did", "is", "are", "was", "were", "what", "when", "where",
  "which", "why", "who", "whom", "whose", "the", "and", "for", "with", "from",
  "that", "this", "these", "those", "be", "been", "being", "can", "could",
  "should", "would", "will", "shall", "may", "might", "must", "has", "have",
  "had", "actually", "really", "just", "still", "then", "than", "there", "here",
  "any", "all", "not", "but", "into", "onto", "out", "our", "its", "it",
  "they", "them", "their", "you", "your", "we", "use", "used", "uses", "using",
  "get", "gets", "got", "make", "makes", "made", "work", "works", "way", "ways",
  "come", "comes", "like", "such", "some", "each", "very", "much", "more", "most",
]);

/**
 * Where in the request a token came from.
 *
 * Workstream A established that not every prose token is IDENTIFIER intent.
 * The same distinction is needed one level up: not every prose token is a
 * BEHAVIOURAL OBJECTIVE. A request carries structure — a description of the
 * behaviour, evidence attached to it, the labels announcing that evidence, and
 * metadata about the report itself — and only some of it describes what the
 * software does.
 *
 * Measured on django-11815: fourteen objectives, of which `last`, `modified`
 * and `oasl` came from the issue byline "(last modified by oasl)" and
 * `traceback` from the `Traceback:` label. Those tokens are rare across files,
 * so IDF made them the most decisive objectives in the set, and the lane
 * elected `template/defaultfilters.py` as the owner of a migrations bug.
 */
export type ObjectiveSourceRole =
  | "task_behavior"
  | "evidence_payload"
  | "evidence_section_label"
  | "attribution_byline";

/**
 * Roles that describe the software rather than the report.
 *
 * Evidence PAYLOAD is behaviour-bearing: `ValueError` in a pasted traceback is
 * a real thing the code raises. Evidence LABELS are not — `Traceback:` names
 * the container, never its content, exactly as a structural module node is
 * never answer-bearing (M140). Attribution describes who filed the issue.
 */
const BEHAVIOUR_BEARING_ROLES: ReadonlySet<ObjectiveSourceRole> = new Set([
  "task_behavior",
  "evidence_payload",
]);

/**
 * Labels that introduce a block of evidence.
 *
 * Deliberately short, and confined to forms actually measured in the corpus
 * (present in 23 of the 50 frozen tasks) plus the canonical Python traceback
 * header a user pastes verbatim. This is not a stopword list and must not grow
 * into one: a token is ineligible only where it occurs AS a label, and the same
 * word remains a perfectly good objective anywhere else in the request.
 */
const EVIDENCE_SECTION_LABEL = /^[\s>*\-]*(errors?|failing tests?|traceback|stack trace)\s*:/i;

/** The header line of a pasted Python traceback. Announces evidence; is not evidence. */
const PYTHON_TRACEBACK_HEADER = /^\s*traceback \(most recent call last\)\s*:?/i;

/**
 * Issue-tracker attribution. Describes the RECORD, not the software.
 *
 * Anchored on the verb-plus-`by` shape so it cannot swallow an ordinary
 * parenthetical: "(last modified by oasl)" matches, "(returns None by default)"
 * does not.
 */
const ATTRIBUTION_BYLINE =
  /\(\s*(?:last\s+)?(?:modified|reported|created|submitted|updated|opened|filed)\s+by\b[^)]*\)/gi;

export interface ObjectiveProvenanceRow {
  readonly objective: string;
  /** Every role this token was observed in, deduplicated. */
  readonly roles: readonly ObjectiveSourceRole[];
  readonly eligible: boolean;
  readonly reason?: string;
}

interface TaskSegment {
  readonly role: ObjectiveSourceRole;
  readonly text: string;
}

/**
 * Split a request into typed segments.
 *
 * Line-oriented, because that is the structure the text actually has: a
 * behavioural description followed by labelled evidence blocks. Nothing is
 * inferred that the request does not literally carry.
 */
function segmentTask(task: string): TaskSegment[] {
  const segments: TaskSegment[] = [];
  for (const line of task.split("\n")) {
    const header = PYTHON_TRACEBACK_HEADER.exec(line);
    if (header !== null && header[0].trim().length > 0) {
      segments.push({ role: "evidence_section_label", text: header[0] });
      segments.push({ role: "evidence_payload", text: line.slice(header[0].length) });
      continue;
    }
    const label = EVIDENCE_SECTION_LABEL.exec(line);
    if (label !== null) {
      segments.push({ role: "evidence_section_label", text: label[1] ?? "" });
      segments.push({ role: "evidence_payload", text: line.slice(label[0].length) });
      continue;
    }
    let behaviour = line;
    for (const byline of line.matchAll(ATTRIBUTION_BYLINE)) {
      segments.push({ role: "attribution_byline", text: byline[0] });
    }
    behaviour = behaviour.replace(ATTRIBUTION_BYLINE, " ");
    segments.push({ role: "task_behavior", text: behaviour });
  }
  return segments;
}

/** Stemmed content tokens of a span, using the same folding as objectives. */
function segmentTerms(text: string): Set<string> {
  const terms = new Set<string>();
  for (const raw of tokenize(text)) {
    const term = stem(raw);
    if (term.length >= 3) terms.add(term);
  }
  return terms;
}

export interface ConceptOwnerOptions {
  /** How many owner FILES may contribute candidates. */
  readonly maxConceptOwnerFiles?: number;
  /** How many definitions each owner file may contribute. */
  readonly maxDefinitionsPerConceptOwner?: number;
  /** Overall cap on admitted candidates. */
  readonly maxConceptOwnerCandidates?: number;
  /** Behavioural objectives required before the lane runs at all. */
  readonly minObjectives?: number;
  /** Owner score an admitted file must reach. */
  readonly minOwnerScore?: number;
}

export const CONCEPT_OWNER_DEFAULTS = Object.freeze({
  maxConceptOwnerFiles: 3,
  maxDefinitionsPerConceptOwner: 3,
  maxConceptOwnerCandidates: 6,
  minObjectives: 3,
  minOwnerScore: 0.35,
});

/**
 * Ceiling on what owner evidence is worth in the ranking.
 *
 * "This file, by aggregate evidence, owns the concept" is comparable to one
 * strong single signal (a symbol-name match weighs 1.2) — enough to bring a
 * definition into contention, deliberately far below the anchor tier (2.5) where
 * an author-marked pointer sits. A concept owner is an inference; an anchor is a
 * statement.
 */
export const CONCEPT_OWNER_MAX_CONTRIBUTION = 1.0;

export interface ConceptOwnerFile {
  readonly path: string;
  readonly ownerScore: number;
  /** Query objectives this file covers, strongest first. */
  readonly supportingObjectives: readonly string[];
  /** Distinct definitions in the file that carry at least one objective. */
  readonly supportingDefinitions: number;
  /** Answer-bearing definitions in the file overall. */
  readonly totalDefinitions: number;
  readonly idfCoverage: number;
  readonly concentration: number;
  readonly reason: string;
}

export interface ConceptOwnerCandidate {
  readonly symbol: SymbolRecord;
  readonly ownerPath: string;
  readonly ownerScore: number;
  /** Bounded ranking contribution, already capped. */
  readonly contribution: number;
  readonly matchedObjectives: readonly string[];
  readonly reason: string;
}

export interface ConceptOwnerDiagnostics {
  readonly active: boolean;
  readonly inactiveReason?: string;
  readonly objectives: readonly string[];
  /** Why each candidate objective was or was not eligible (§18). */
  readonly objectiveProvenance: readonly ObjectiveProvenanceRow[];
  /** Objectives rejected as non-behavioural, for evidence. */
  readonly ineligibleObjectives: readonly string[];
  readonly filesExamined: number;
  readonly owners: readonly ConceptOwnerFile[];
  readonly ownerCapReached: boolean;
  readonly candidatesAdmitted: number;
  /** Owner files skipped because the pool already represents them. */
  readonly ownersAlreadyRepresented: number;
  /** Source file reads performed. Structurally zero; reported so it stays so. */
  readonly sourceReads: number;
}

export interface ConceptOwnerResult {
  readonly candidates: readonly ConceptOwnerCandidate[];
  readonly diagnostics: ConceptOwnerDiagnostics;
}

export function inactiveConceptOwner(reason: string): ConceptOwnerDiagnostics {
  return {
    active: false,
    inactiveReason: reason,
    objectives: [],
    objectiveProvenance: [],
    ineligibleObjectives: [],
    filesExamined: 0,
    owners: [],
    ownerCapReached: false,
    candidatesAdmitted: 0,
    ownersAlreadyRepresented: 0,
    sourceReads: 0,
  };
}

export interface ConceptOwnerInput {
  readonly db: Database;
  readonly intent: DerivedQueryIntent;
  /**
   * How many definitions of each file the deliverable pool already carries.
   *
   * File presence alone is the wrong test: on the ARC normal-mode question the
   * pool DID contain `arc/checks/nmd.py` — via `get_bond_length_in_reaction`,
   * reached incidentally by graph expansion — while the definition that answers
   * the question was absent. Skipping the file because it appeared would suppress
   * exactly the recovery the lane exists for. An owner is skipped only once the
   * pool carries as many of its definitions as the lane would ever contribute.
   */
  readonly representedDefinitionsByFile: ReadonlyMap<string, number>;
  /** Symbols already in the pool, so the lane never duplicates one. */
  readonly existingSymbolIds: ReadonlySet<string>;
  readonly options?: ConceptOwnerOptions;
}

/**
 * Whether a behavioural request has enough substance for owner aggregation.
 *
 * Two things disqualify a request. An explicit symbol lookup already knows what
 * it wants, and expanding it to whole files would answer a question nobody asked
 * (§50). And a request with almost no behavioural content ("how does ARC work?")
 * would make every file in the repository a partial match (§51) — it reduces to
 * one objective, below the floor.
 */
export function evaluateConceptOwnerIntent(
  intent: DerivedQueryIntent,
  options: ConceptOwnerOptions = {},
): { active: boolean; objectives: string[]; reason?: string } {
  const config = { ...CONCEPT_OWNER_DEFAULTS, ...stripUndefined(options) };
  if (intent.kind === "capability_lookup") {
    return { active: false, objectives: [], reason: "capability lookup wants a definition, not a module" };
  }
  const orchestration = evaluateOrchestrationIntent(intent);
  if (orchestration.suppressedBy === "explicit symbol lookup command") {
    return { active: false, objectives: [], reason: "explicit symbol lookup" };
  }
  const objectives = behavioralObjectives(intent);
  if (objectives.length < config.minObjectives) {
    return {
      active: false,
      objectives,
      reason: `only ${objectives.length} behavioural objective(s); ${config.minObjectives} required`,
    };
  }
  return { active: true, objectives };
}

/**
 * The concepts a behavioural request is about.
 *
 * Question framing is removed, and so is the repository's own name — "ARC" in
 * "how does ARC decide…" is routing metadata, and treating it as an objective
 * makes every file under `arc/` a partial owner (measured: it did).
 */
export function behavioralObjectives(intent: DerivedQueryIntent): string[] {
  return objectiveProvenance(intent).filter((row) => row.eligible).map((row) => row.objective);
}

/**
 * Every candidate objective with the request roles it was observed in, and
 * whether that makes it eligible.
 *
 * ELIGIBILITY IS DECIDED BY ROLE; IDF ONLY WEIGHTS WHAT SURVIVES. A rare token
 * is a strong objective, but rarity can never make a token an objective in the
 * first place — the same asymmetry Workstream B established for centrality.
 *
 * A token stays eligible if ANY of its occurrences is behaviour-bearing, which
 * is what keeps "where is this traceback generated?" working: there `traceback`
 * is the request, not a label above someone else's evidence. A token that
 * cannot be attributed to any segment stays eligible too — this filter removes
 * what it can positively identify as non-behavioural, and defaults to keeping.
 */
export function objectiveProvenance(intent: DerivedQueryIntent): ObjectiveProvenanceRow[] {
  const projectReferences = new Set(intent.projectReferences.map((term) => stem(term.toLowerCase())));
  const frame = new Set([...QUESTION_FRAME_WORDS].map(stem));
  const segments = segmentTask(intent.originalTask);
  const rolesByTerm = new Map<string, Set<ObjectiveSourceRole>>();
  for (const segment of segments) {
    for (const term of segmentTerms(segment.text)) {
      let roles = rolesByTerm.get(term);
      if (roles === undefined) {
        roles = new Set();
        rolesByTerm.set(term, roles);
      }
      roles.add(segment.role);
    }
  }

  const seen = new Set<string>();
  const rows: ObjectiveProvenanceRow[] = [];
  for (const raw of tokenize(intent.positiveSearchText)) {
    const term = stem(raw);
    if (term.length < 3 || seen.has(term)) continue;
    if (QUESTION_FRAME_WORDS.has(term) || frame.has(term) || projectReferences.has(term)) continue;
    seen.add(term);
    const roles = [...(rolesByTerm.get(term) ?? new Set<ObjectiveSourceRole>())];
    const behavioural = roles.some((role) => BEHAVIOUR_BEARING_ROLES.has(role));
    const eligible = roles.length === 0 || behavioural;
    rows.push({
      objective: term,
      roles,
      eligible,
      reason: eligible
        ? undefined
        : `occurs only as ${roles.join(" / ")}; describes the report, not the behaviour`,
    });
  }
  return rows;
}

interface RankedDefinition {
  readonly definition: { symbol: SymbolRecord; objectives: Set<string> };
  readonly weight: number;
}

interface FileEvidence {
  covered: Set<string>;
  named: Set<string>;
  basename: Set<string>;
  definitions: Map<string, { symbol: SymbolRecord; objectives: Set<string> }>;
  total: number;
}

/**
 * Aggregate per-file evidence and admit the strongest definitions of the best
 * owners. Indexed metadata only — names, signatures, docstrings, paths.
 */
export function retrieveConceptOwners(input: ConceptOwnerInput): ConceptOwnerResult {
  const config = { ...CONCEPT_OWNER_DEFAULTS, ...stripUndefined(input.options ?? {}) };
  const gate = evaluateConceptOwnerIntent(input.intent, config);
  const provenance = objectiveProvenance(input.intent);
  if (!gate.active) {
    return {
      candidates: [],
      diagnostics: {
        ...inactiveConceptOwner(gate.reason ?? "not a behavioural request"),
        objectiveProvenance: provenance,
        ineligibleObjectives: provenance.filter((row) => !row.eligible).map((row) => row.objective),
      },
    };
  }
  const objectives = gate.objectives;

  const symbols = listAllSymbols(input.db);
  const objectiveSet = new Set(objectives);
  const byFile = new Map<string, FileEvidence>();
  for (const symbol of symbols) {
    if (isStructuralSymbolKind(symbol.kind)) continue;
    if (isTestPath(symbol.filePath)) continue;
    let entry = byFile.get(symbol.filePath);
    if (entry === undefined) {
      entry = { covered: new Set(), named: new Set(), basename: new Set(), definitions: new Map(), total: 0 };
      const basename = symbol.filePath.slice(symbol.filePath.lastIndexOf("/") + 1);
      for (const token of tokenize(basename).map(stem)) {
        if (objectiveSet.has(token)) {
          entry.basename.add(token);
          entry.covered.add(token);
        }
      }
      for (const token of tokenize(symbol.filePath).map(stem)) {
        if (objectiveSet.has(token)) entry.covered.add(token);
      }
      byFile.set(symbol.filePath, entry);
    }
    if (!ANSWER_BEARING_KINDS.has(symbol.kind)) continue;
    entry.total += 1;
    const nameTokens = new Set(tokenize(symbol.localName).map(stem));
    const allTokens = new Set([
      ...nameTokens,
      ...tokenize(symbol.signature ?? "").map(stem),
      ...tokenize(symbol.docstring ?? "").map(stem),
    ]);
    for (const objective of objectives) {
      if (!allTokens.has(objective)) continue;
      entry.covered.add(objective);
      if (nameTokens.has(objective)) entry.named.add(objective);
      let definition = entry.definitions.get(symbol.fqName);
      if (definition === undefined) {
        definition = { symbol, objectives: new Set() };
        entry.definitions.set(symbol.fqName, definition);
      }
      definition.objectives.add(objective);
    }
  }

  // An objective present in most files is not evidence; one concentrated in a few
  // is. Document frequency is computed over the files actually in contention, so
  // the weighting adapts to the repository rather than to a fixed vocabulary.
  const fileCount = byFile.size;
  const documentFrequency = new Map<string, number>();
  for (const evidence of byFile.values()) {
    for (const objective of evidence.covered) {
      documentFrequency.set(objective, (documentFrequency.get(objective) ?? 0) + 1);
    }
  }
  const idf = new Map(objectives.map((objective) =>
    [objective, Math.log((fileCount + 1) / ((documentFrequency.get(objective) ?? 0) + 1))]));
  const idfTotal = objectives.reduce((sum, objective) => sum + (idf.get(objective) ?? 0), 0);

  const scored: ConceptOwnerFile[] = [];
  for (const [path, evidence] of byFile) {
    if (evidence.definitions.size === 0) continue;
    // A term in a symbol NAME or the file BASENAME is a naming decision; the same
    // term inside a docstring is a mention. Weight the decision higher.
    let weighted = 0;
    for (const objective of evidence.covered) {
      const base = idf.get(objective) ?? 0;
      weighted += base * (evidence.basename.has(objective) ? 2 : evidence.named.has(objective) ? 1.5 : 1);
    }
    const idfCoverage = idfTotal === 0 ? 0 : Math.min(1, weighted / idfTotal);
    const corroboration = Math.min(1, evidence.definitions.size / 3);
    const concentration = evidence.total === 0 ? 0 : Math.min(1, evidence.definitions.size / evidence.total);
    const ownerScore = round(idfCoverage * 0.6 + corroboration * 0.2 + concentration * 0.2);
    if (ownerScore < config.minOwnerScore) continue;
    const supporting = [...evidence.covered]
      .sort((left, right) => (idf.get(right) ?? 0) - (idf.get(left) ?? 0) || left.localeCompare(right));
    scored.push({
      path,
      ownerScore,
      supportingObjectives: supporting,
      supportingDefinitions: evidence.definitions.size,
      totalDefinitions: evidence.total,
      idfCoverage: round(idfCoverage),
      concentration: round(concentration),
      reason:
        `${evidence.definitions.size} of ${evidence.total} definitions cover `
        + `${supporting.length}/${objectives.length} requested concepts (${supporting.slice(0, 4).join(", ")})`,
    });
  }
  scored.sort((left, right) => right.ownerScore - left.ownerScore || left.path.localeCompare(right.path));

  // An owner already carrying its full share of the deliverable pool is skipped:
  // the lane recovers what nothing reached, and topping up a well-represented
  // file would be a ranking change dressed up as a rescue.
  const roomFor = (path: string): number =>
    config.maxDefinitionsPerConceptOwner - (input.representedDefinitionsByFile.get(path) ?? 0);
  const unrepresented = scored.filter((owner) => roomFor(owner.path) > 0);
  const alreadyRepresented = scored.length - unrepresented.length;

  const selectedOwners = unrepresented.slice(0, config.maxConceptOwnerFiles);

  const candidates: ConceptOwnerCandidate[] = [];
  const queues: { owner: ConceptOwnerFile; ranked: RankedDefinition[]; budget: number }[] = [];
  for (const owner of selectedOwners) {
    const evidence = byFile.get(owner.path);
    if (evidence === undefined) continue;
    const ranked = [...evidence.definitions.values()]
      .map((definition) => ({
        definition,
        // A module's PUBLIC surface is what owns its concept; its underscore-
        // prefixed helpers implement it. Both are answer-bearing, but when a
        // request describes what a module does, the entry point answers it and
        // the helper elaborates. A multiplier rather than a filter: a private
        // definition with far better coverage still wins.
        weight: [...definition.objectives].reduce((sum, objective) => sum + (idf.get(objective) ?? 0), 0)
          * (definition.symbol.localName.startsWith("_") ? 1 : 1.25),
      }))
      .sort((left, right) =>
        right.weight - left.weight
        || left.definition.symbol.fqName.localeCompare(right.definition.symbol.fqName));
    queues.push({ owner, ranked, budget: roomFor(owner.path) });
  }

  // Admit one definition per owner per pass rather than draining each owner in
  // turn. With three owner files, three definitions each and an overall cap of
  // six, draining meant the first two owners consumed the whole budget and THE
  // THIRD OWNER SLOT WAS DEAD BY CONSTRUCTION. Measured on the ARC normal-mode
  // request: `arc/checks/nmd.py` was elected owner #3 and contributed nothing,
  // which is the case this lane was built for. Every bound is unchanged — same
  // owner count, same per-owner budget, same total.
  const cursors = queues.map(() => 0);
  const taken = queues.map(() => 0);
  for (let pass = 0; pass < config.maxDefinitionsPerConceptOwner; pass += 1) {
    if (candidates.length >= config.maxConceptOwnerCandidates) break;
    for (let index = 0; index < queues.length; index += 1) {
      if (candidates.length >= config.maxConceptOwnerCandidates) break;
      const queue = queues[index];
      if (queue === undefined || taken[index]! >= queue.budget) continue;
      let next: RankedDefinition | undefined;
      while (cursors[index]! < queue.ranked.length) {
        const entry = queue.ranked[cursors[index]!]!;
        cursors[index]! += 1;
        if (input.existingSymbolIds.has(entry.definition.symbol.id)) continue;
        next = entry;
        break;
      }
      if (next === undefined) continue;
      taken[index]! += 1;
      const owner = queue.owner;
      const { definition, weight } = next;
      {
      const definitionCoverage = idfTotal === 0 ? 0 : Math.min(1, weight / idfTotal);
      // Owner strength decides how much the file's ownership is worth; the
      // definition's own coverage decides how much of that this definition earns.
      const contribution = round(Math.min(
        CONCEPT_OWNER_MAX_CONTRIBUTION,
        CONCEPT_OWNER_MAX_CONTRIBUTION * owner.ownerScore * (0.5 + 0.5 * definitionCoverage),
      ));
      const matched = [...definition.objectives]
        .sort((left, right) => (idf.get(right) ?? 0) - (idf.get(left) ?? 0) || left.localeCompare(right));
      candidates.push({
        symbol: definition.symbol,
        ownerPath: owner.path,
        ownerScore: owner.ownerScore,
        contribution,
        matchedObjectives: matched,
        reason:
          `${owner.path} appears to own this behaviour (${owner.reason}); this definition covers `
          + `${matched.slice(0, 4).join(", ")}`,
      });
      }
    }
  }

  return {
    candidates,
    diagnostics: {
      active: true,
      objectives,
      objectiveProvenance: provenance,
      ineligibleObjectives: provenance.filter((row) => !row.eligible).map((row) => row.objective),
      filesExamined: byFile.size,
      owners: selectedOwners,
      ownerCapReached: unrepresented.length > config.maxConceptOwnerFiles,
      candidatesAdmitted: candidates.length,
      ownersAlreadyRepresented: alreadyRepresented,
      // Owner scoring reads indexed metadata only. Reported rather than asserted
      // so a future change that starts reading files shows up here.
      sourceReads: 0,
    },
  };
}

/**
 * Is this path test code? Exported because M153's behavioural routing probe must
 * answer the same question, and two definitions of "is a test" that could drift
 * apart is exactly the kind of parallel authority the architecture forbids.
 */
export function isTestPath(filePath: string): boolean {
  return /(^|\/)tests?\//.test(filePath)
    || /(^|\/)(?:test_[^/]+|[^/]+_test)\.[^/]+$/.test(filePath);
}

/** Conservative English plural/gerund folding so `reactants` ~ `reactant`. */
function stem(term: string): string {
  if (term.length > 4 && term.endsWith("ies")) return `${term.slice(0, -3)}y`;
  if (term.length > 5 && term.endsWith("ing")) return term.slice(0, -3);
  if (term.length > 4 && /(?:ss|x|z|ch|sh)es$/.test(term)) return term.slice(0, -2);
  if (term.length > 3 && term.endsWith("s") && !term.endsWith("ss")) return term.slice(0, -1);
  return term;
}

function round(value: number): number {
  return Math.round(value * 1e4) / 1e4;
}

function stripUndefined<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as Partial<T>;
}
