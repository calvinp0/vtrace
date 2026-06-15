// Actionability hints for likely generated / co-edit artifact dependencies.
//
// SCOPE: advisory annotation only. This is a CHEAP, DETERMINISTIC heuristic that
// runs over file paths that are ALREADY in the capsule (selected pivots/support)
// plus the workspace file index. It runs NO agents, NO Docker, calls NO model,
// and — critically — it NEVER touches retrieval: it does not generate candidates,
// re-rank, re-score, or change role assignment. It reads the final selection and
// the file map, and emits a small, bounded list of "you changed the source, the
// generated artifact may also need updating" reminders.
//
// Motivation: some SWE fixes localize the right SOURCE file but still fail because
// a paired GENERATED artifact (a PLY/yacc parser table, a lockfile, a snapshot, a
// compiled/auto-generated output) must be regenerated or updated alongside it. The
// agent edits `foo/grammar.py` correctly but never notices the adjacent
// `foo/grammar_parsetab.py`. A compact hint closes that gap.
//
// NOTHING HERE IS PROJECT-SPECIFIC. The detection keys off generic conventions:
// PLY's `def p_<rule>` grammar functions and `*_parsetab.py` / `*_lextab.py`
// generated tables, basename-linked siblings, and "automatically generated / do
// not edit" file headers. No instance ids, no hardcoded file names.

import { readFileSync } from "node:fs";
import path from "node:path";
import type { Database } from "bun:sqlite";

import { listAllFilePaths } from "../db/repositories/filesRepository";

/**
 * A follow-through obligation that the hint must drive the agent past mere
 * awareness: regenerating/updating the artifact LOCALLY is not enough — if the
 * artifact is part of the tracked repo state, the regenerated/updated version has
 * to land in the SUBMITTED diff, or the change never reaches review/CI. This is the
 * gap M4.4 observed on a real parser-table case: the agent deleted/regenerated the
 * table in the workspace, but the submitted patch still only touched the source.
 */
export interface ActionabilityPatchObligation {
  /**
   * `ensure_related_artifact_in_final_diff` — the generated/co-edit artifact must
   * land in the submitted diff (regenerating it locally is not enough).
   * `consider_coedit_files_in_final_diff` — a multi-file fix shape: inspect each
   * co-edit candidate and either edit it or rule it out, and include every required
   * edit in the final diff (do not finalize after editing only the lead pivot).
   */
  kind: "ensure_related_artifact_in_final_diff" | "consider_coedit_files_in_final_diff";
  /** Compact, rendered reminder of the final-diff obligation. */
  text: string;
}

/**
 * A single actionability hint: a likely generated / co-edit artifact paired with
 * the source file the agent is editing. Product-shaped (camelCase) so it projects
 * onto the MCP/CLI surface unchanged.
 */
export interface ActionabilityHint {
  /**
   * `generated_artifact` — the related file is a recognised generated/compiled
   * artifact (parser table, "do not edit" header). `co_edit_dependency` — the
   * relation is by name/adjacency only (weaker; "consider also updating").
   * `multi_file_coedit` — the selected context suggests a coordinated fix across
   * several surfaced files (cross-module pivots, or sibling pivots plus coupled
   * caller/handler support); see `relatedFiles` for the full co-edit candidate set.
   */
  kind: "generated_artifact" | "co_edit_dependency" | "multi_file_coedit";
  /** The source / lead-pivot file in the capsule the agent is likely to edit. */
  sourceFile: string;
  /**
   * The paired artifact that may also need regenerating/updating. For
   * `multi_file_coedit` this is the FIRST co-edit candidate (kept for back-compat);
   * the complete candidate list is in `relatedFiles`.
   */
  relatedFile: string;
  /**
   * The full set of co-edit candidate files (present for `multi_file_coedit`). The
   * agent should inspect each and either edit it or rule it out. `relatedFile`
   * always equals `relatedFiles[0]` when this is set, so single-file consumers stay
   * unchanged. Absent for `generated_artifact` / `co_edit_dependency`.
   */
  relatedFiles?: string[];
  confidence: "low" | "medium" | "high";
  /** Up to 2 short evidence bullets (why this relation was inferred). */
  evidence: string[];
  /** The compact, rendered call to action (regenerate/update the artifact). */
  hint: string;
  /**
   * Follow-through obligation: ensure the regenerated/updated artifact reaches the
   * submitted diff (not just a local side effect). Present for generated-artifact
   * hints, where the related file is part of the tracked repo state.
   */
  patchObligation?: ActionabilityPatchObligation;
}

export interface DetectActionabilityHintsInput {
  db: Database;
  repoRoot: string;
  /** Paths of the files already selected into the capsule (pivots + support). */
  candidatePaths: readonly string[];
}

// Bounds so the section stays compact regardless of how noisy a workspace is.
const MAX_HINTS = 3;
const MAX_EVIDENCE_PER_HINT = 2;
// Only the head of a generated artifact is scanned for the "do not edit" banner —
// such banners are emitted at the very top of the file. Bounded read keeps this cheap.
const ARTIFACT_HEAD_BYTES = 4096;

// PLY grammar functions are named `def p_<rule>(...)`. Lexer rule functions
// (`t_<token>`) are not grammar productions and are deliberately not matched.
const GRAMMAR_FUNCTION = /^\s*def\s+p_[A-Za-z_]\w*\s*\(/m;
// References to the PLY/yacc/lex parser-generator toolchain anywhere in the file.
const PARSER_TOOLING = /\b(?:ply|yacc|lex)\b/i;
// A recognised generated parser/lexer table basename (PLY convention + bare forms).
const GENERATED_TABLE_BASENAME = /(?:_parsetab|_lextab)\.py$|^(?:parsetab|lextab)\.py$|^parser\.out$/;
// "Automatically generated / do not edit" banners commonly emitted by codegen.
const GENERATED_BANNER =
  /\b(?:automatically generated|auto[- ]?generated|generated by|do not edit|do not modify|created by)\b/i;

interface PathParts {
  readonly dir: string;
  readonly base: string;
  readonly stem: string;
  readonly ext: string;
}

function splitPath(filePath: string): PathParts {
  const slash = filePath.lastIndexOf("/");
  const dir = slash >= 0 ? filePath.slice(0, slash + 1) : "";
  const base = slash >= 0 ? filePath.slice(slash + 1) : filePath;
  const dot = base.lastIndexOf(".");
  const stem = dot > 0 ? base.slice(0, dot) : base;
  const ext = dot > 0 ? base.slice(dot) : "";
  return { dir, base, stem, ext };
}

function readHead(repoRoot: string, relPath: string, maxBytes: number): string | undefined {
  try {
    const buf = readFileSync(path.join(repoRoot, relPath));
    return buf.subarray(0, maxBytes).toString("utf8");
  } catch {
    return undefined;
  }
}

function readWhole(repoRoot: string, relPath: string): string | undefined {
  try {
    return readFileSync(path.join(repoRoot, relPath)).toString("utf8");
  } catch {
    return undefined;
  }
}

function isGeneratedBasename(filePath: string): boolean {
  return GENERATED_TABLE_BASENAME.test(splitPath(filePath).base);
}

/**
 * Detect likely generated / co-edit artifact dependencies for the capsule's
 * selected files. Pure heuristic over `candidatePaths` + the workspace file set;
 * never mutates the DB and never consults gold-patch data. Returns at most
 * `MAX_HINTS` hints, deterministically ordered.
 */
export function detectActionabilityHints(
  input: DetectActionabilityHintsInput,
): ActionabilityHint[] {
  const { db, repoRoot } = input;
  // Workspace file set: lets us see a generated artifact (e.g. `cds_parsetab.py`)
  // that was NEVER retrieved into the capsule but lives next to an edited source.
  const allPaths = new Set(listAllFilePaths(db));

  // Unique, deterministically ordered source candidates. A generated artifact is
  // never itself a "source" to hint on — skip it as a source so we don't tell the
  // agent to regenerate the table when editing the table.
  const sources = [...new Set(input.candidatePaths)]
    .filter((candidate) => !isGeneratedBasename(candidate))
    .sort();

  const hints: ActionabilityHint[] = [];
  const seen = new Set<string>();

  for (const sourcePath of sources) {
    if (hints.length >= MAX_HINTS) break;
    const parts = splitPath(sourcePath);
    const sourceText = readWhole(repoRoot, sourcePath);
    const hasGrammar = sourceText !== undefined && GRAMMAR_FUNCTION.test(sourceText);
    const hasTooling = sourceText !== undefined && PARSER_TOOLING.test(sourceText);

    // Candidate paired artifacts in the SAME directory, name-linked to the source.
    // PLY emits `<stem>_parsetab.py` / `<stem>_lextab.py` next to the grammar.
    const candidates: Array<{ rel: string; tableKind: "parsetab" | "lextab" }> = [
      { rel: `${parts.dir}${parts.stem}_parsetab.py`, tableKind: "parsetab" },
      { rel: `${parts.dir}${parts.stem}_lextab.py`, tableKind: "lextab" },
    ];

    for (const candidate of candidates) {
      if (hints.length >= MAX_HINTS) break;
      if (!allPaths.has(candidate.rel)) continue;
      if (candidate.rel === sourcePath) continue;
      const dedupeKey = `${sourcePath}\0${candidate.rel}`;
      if (seen.has(dedupeKey)) continue;

      const artifactHead = readHead(repoRoot, candidate.rel, ARTIFACT_HEAD_BYTES);
      const hasBanner = artifactHead !== undefined && GENERATED_BANNER.test(artifactHead);

      const evidence: string[] = [];
      // Source-side signal first (it justifies WHY editing this file is the trigger).
      if (hasGrammar) {
        evidence.push("source defines PLY-style grammar functions (def p_*)");
      } else if (hasTooling) {
        evidence.push("source references a parser generator (ply/yacc/lex)");
      }
      // Artifact-side signal.
      if (hasBanner) {
        evidence.push(`adjacent ${candidate.tableKind} carries an auto-generated/do-not-edit banner`);
      } else {
        evidence.push(`adjacent generated parser table (${splitPath(candidate.rel).base})`);
      }

      // Confidence: explicit grammar/tooling signal AND a recognised generated
      // table (banner or name) → high; one strong signal → medium; otherwise low.
      const strongSource = hasGrammar || hasTooling;
      const strongArtifact = hasBanner || GENERATED_TABLE_BASENAME.test(splitPath(candidate.rel).base);
      const confidence: ActionabilityHint["confidence"] =
        strongSource && strongArtifact ? "high" : strongSource || strongArtifact ? "medium" : "low";

      const relatedBase = splitPath(candidate.rel).base;
      hints.push({
        kind: "generated_artifact",
        sourceFile: sourcePath,
        relatedFile: candidate.rel,
        confidence,
        evidence: evidence.slice(0, MAX_EVIDENCE_PER_HINT),
        hint:
          "If you change parser/grammar rules here, regenerate or update the generated "
          + "parser table.",
        // Follow-through: the regenerated table is part of the tracked repo state
        // (it was found in the workspace index), so it must be in the SUBMITTED diff
        // — a local delete/regenerate is a side effect that never reaches the patch.
        patchObligation: {
          kind: "ensure_related_artifact_in_final_diff",
          text:
            `Ensure the regenerated/updated ${relatedBase} is included in your final `
            + "submitted diff if it is tracked — a local delete/regenerate alone does not "
            + "reach the patch.",
        },
      });
      seen.add(dedupeKey);
    }
  }

  return hints;
}
