// Project/repository-name signals for literal anchoring.
//
// WHY THIS EXISTS
// ----------------
// High-signal literal anchoring treats an ALL-CAPS token in the task as a
// deliberate pointer at code: it resolves the term to exact-case symbols and to
// matching path segments. That is right for `FITS`, `CDS`, `MRT`. It is wrong for
// the token that happens to be the repository's own name.
//
// In the ARC repository, "How does ARC handle linear segments and dummy atoms in
// Z-matrices?" anchored on `ARC` and pulled in `arc/main.py::ARC` (exact-case
// class) plus arbitrary files whose path contains the `arc/` segment — which is
// EVERY file in the package. A pure geometry question spent budget on the project
// entry-point class because the project is called ARC. Users write "How does X
// handle…", "Where does X…", "Why does X…" constantly; the project name in that
// position is context, not a target.
//
// WHAT THIS DOES NOT DO
// ----------------
// It does not blacklist the token. Another repository may legitimately contain an
// important class named `ARC`, and a user may explicitly ask about this one. The
// rule is scoped to the repository's OWN name and yields whenever the task shows
// explicit symbol-reference evidence. It is deterministic string analysis — no
// model, no heuristic scoring.
//
// SOURCE OF THE NAME
// ----------------
// The repository root's basename, normalised. Deliberately not package metadata:
// vtrace does not parse pyproject.toml / package.json for indexed repositories
// today, and adding that parsing for this one rule would be a much larger and
// less predictable surface than the problem justifies (M132 §26).

import path from "node:path";

/** Normalised aliases for a repository/project name. Lowercase, punctuation-folded. */
export type ProjectNameAliases = ReadonlySet<string>;

export const NO_PROJECT_NAME_ALIASES: ProjectNameAliases = new Set<string>();

/**
 * Aliases for the project a repository root names. `/home/x/ARC` yields `arc`;
 * `/home/x/my-project` yields `my-project` and `my_project` so the separator
 * spelling in prose cannot defeat the match.
 *
 * Very short names are ignored: a one- or two-character basename is far more
 * likely to collide with a real identifier than to be used as a project
 * reference, and the anchor extractor already floors acronyms at three
 * characters.
 */
export function resolveProjectNameAliases(repoRoot: string): ProjectNameAliases {
  const basename = path.basename(path.resolve(repoRoot)).trim().toLowerCase();
  if (basename.length < 3) return NO_PROJECT_NAME_ALIASES;
  // A basename that is not a plain name (a version suffix, a dotted directory)
  // is not a reliable project alias; require an identifier-ish shape.
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(basename)) return NO_PROJECT_NAME_ALIASES;

  const aliases = new Set<string>([basename]);
  const separatorFolded = basename.replace(/[-.]/g, "_");
  if (separatorFolded !== basename) aliases.add(separatorFolded);
  const hyphenated = basename.replace(/[_.]/g, "-");
  if (hyphenated !== basename) aliases.add(hyphenated);
  return aliases;
}

/** True when `term` names the project rather than a symbol the caller asked about. */
export function isGenericProjectReference(input: {
  readonly term: string;
  readonly task: string;
  readonly aliases: ProjectNameAliases;
}): boolean {
  if (input.aliases.size === 0) return false;
  if (!input.aliases.has(normalizeTerm(input.term))) return false;
  return !hasExplicitSymbolEvidence(input.task, input.term);
}

/**
 * Deterministic evidence that the task means the SYMBOL named `term`, not the
 * project. Any single hit preserves ordinary anchoring.
 *
 * The patterns are code-shaped or explicitly nominal — a declaration, a member
 * access, a call, a path-qualified symbol, an author-marked literal, or the word
 * "class"/"symbol" adjacent to the term. Prose like "How does ARC handle X" hits
 * none of them.
 */
export function hasExplicitSymbolEvidence(task: string, term: string): boolean {
  const escaped = escapeRegExp(term);
  const patterns: RegExp[] = [
    // Declaration: `class ARC`, `class ARC(Base)`.
    new RegExp(`\\bclass\\s+${escaped}\\b`),
    // Nominal reference: `the ARC class`, `ARC class`, `symbol ARC`, `ARC symbol`.
    new RegExp(`\\b${escaped}\\s+(?:class|symbol|constructor|object|instance)\\b`, "i"),
    new RegExp(`\\b(?:class|symbol|constructor)\\s+${escaped}\\b`, "i"),
    // Member access or call: `ARC.__init__`, `ARC(`, `ARC()`.
    new RegExp(`\\b${escaped}\\.[A-Za-z_]`),
    new RegExp(`\\b${escaped}\\s*\\(`),
    // Path-qualified symbol: `arc/main.py::ARC`.
    new RegExp(`[\\w./-]+::${escaped}\\b`),
    // Author-marked literal: `` `ARC` `` or "ARC". Marking it up is a deliberate
    // act that distinguishes the identifier from the project reference.
    new RegExp("[`'\"]" + escaped + "[`'\"]"),
  ];
  return patterns.some((pattern) => pattern.test(task));
}

function normalizeTerm(term: string): string {
  return term.trim().toLowerCase().replace(/\/+$/, "");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
