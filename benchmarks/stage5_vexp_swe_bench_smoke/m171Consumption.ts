/**
 * M171 — what the agent actually DID with the orientation it was handed.
 *
 * §39/§40/§41. The metric that matters for a first-orientation product is not
 * "did the packet contain every support item" but "did it contain the location
 * the agent went to next". This module derives that from real transcripts.
 *
 * Three definitions are frozen here BEFORE any result is computed, because §41
 * forbids moving the boundary after seeing the numbers:
 *
 *   REPOSITORY ACTION       a tool call that names a repository file: Read,
 *                           Edit, Write, NotebookEdit, or a Grep/Glob carrying
 *                           an explicit path or glob. A Bash command is recorded
 *                           but never counted — parsing a shell line for "the
 *                           file it meant" is a guess, and a guess cannot decide
 *                           a gate.
 *
 *   FIRST MEANINGFUL ACTION the first repository action strictly after the
 *                           orientation result.
 *
 *   EARLY PHASE             every repository action strictly before the first
 *                           Edit / Write / NotebookEdit. If the run never edits,
 *                           the early phase is every repository action.
 *
 * PURE. The caller supplies parsed transcript rows and a surfaced-location set.
 */

export const ActionKind = Object.freeze({
  Read: "READ",
  Edit: "EDIT",
  Search: "SEARCH",
  Shell: "SHELL",
  Other: "OTHER",
});
export type ActionKind = (typeof ActionKind)[keyof typeof ActionKind];

export interface RepositoryAction {
  readonly order: number;
  readonly tool: string;
  readonly kind: ActionKind;
  /** Repo-relative when it could be made so; absolute otherwise. Null for shell. */
  readonly path: string | null;
  readonly countsAsRepositoryAction: boolean;
}

const EDIT_TOOLS = new Set(["Edit", "Write", "NotebookEdit", "MultiEdit"]);
const READ_TOOLS = new Set(["Read", "NotebookRead"]);
const SEARCH_TOOLS = new Set(["Grep", "Glob"]);

/** Strip whatever workspace prefix the harness used, so paths compare to index paths. */
export function toRepoRelative(rawPath: string): string {
  const normalized = rawPath.replace(/\\/g, "/");
  const marker = /\.bench-repos\/[^/]+\/(.*)$/.exec(normalized);
  if (marker !== null) return marker[1]!;
  const workspace = /\/results\/workspaces\/[^/]+\/[^/]+\/(.*)$/.exec(normalized);
  if (workspace !== null) return workspace[1]!;
  return normalized.replace(/^\.\//, "");
}

/**
 * A repo-relative path, or null when the argument names no file INSIDE the
 * repository — the repository root itself, an absolute path the prefix rules
 * could not reduce, or `.`.
 *
 * This distinction is load-bearing and conservative. A `Grep` scoped at the repo
 * root names no file, so no file list can support it; counting it as an
 * unsupported repository action would credit any future projection with an
 * improvement it did not make. Excluding it RAISES the status-quo support rate
 * that a projection must then preserve.
 */
export function repoRelativeOrNull(rawPath: string): string | null {
  const relative = toRepoRelative(rawPath).trim();
  if (relative === "" || relative === "." || relative === "/" || relative.startsWith("/")) return null;
  return relative;
}

export function classifyAction(tool: string, input: Record<string, unknown>, order: number): RepositoryAction {
  const rawFilePath = typeof input.file_path === "string" ? input.file_path
    : typeof input.notebook_path === "string" ? input.notebook_path : null;
  const filePath = rawFilePath === null ? null : repoRelativeOrNull(rawFilePath);
  if (EDIT_TOOLS.has(tool)) {
    return { order, tool, kind: ActionKind.Edit, path: filePath, countsAsRepositoryAction: filePath !== null };
  }
  if (READ_TOOLS.has(tool)) {
    return { order, tool, kind: ActionKind.Read, path: filePath, countsAsRepositoryAction: filePath !== null };
  }
  if (SEARCH_TOOLS.has(tool)) {
    const rawScope = typeof input.path === "string" ? input.path : typeof input.glob === "string" ? input.glob : null;
    const scope = rawScope === null ? null : repoRelativeOrNull(rawScope);
    return { order, tool, kind: ActionKind.Search, path: scope, countsAsRepositoryAction: scope !== null };
  }
  if (tool === "Bash") {
    return { order, tool, kind: ActionKind.Shell, path: null, countsAsRepositoryAction: false };
  }
  return { order, tool, kind: ActionKind.Other, path: null, countsAsRepositoryAction: false };
}

export interface ConsumptionVerdict {
  readonly firstMeaningfulAction: RepositoryAction | null;
  readonly firstActionSupported: boolean | null;
  readonly earlyPhaseActions: readonly RepositoryAction[];
  readonly earlyPhaseSupported: number;
  readonly earlyPhaseTotal: number;
  readonly earlyPhaseSupportRate: number | null;
  /** Locations offered and never opened — the packet's dead weight on this run. */
  readonly surfacedNeverTouched: readonly string[];
  /** Locations the agent reached that the packet never named. */
  readonly touchedNeverSurfaced: readonly string[];
  readonly firstEditPath: string | null;
  readonly firstEditSupported: boolean | null;
}

/**
 * `surfaced` is a set of repo-relative FILE paths. File-level, not symbol-level,
 * on purpose: a Read names a file, so a symbol-level comparison would score the
 * packet against a question the transcript cannot answer.
 */
export function judgeConsumption(
  actions: readonly RepositoryAction[],
  surfaced: ReadonlySet<string>,
): ConsumptionVerdict {
  const repositoryActions = actions.filter((action) => action.countsAsRepositoryAction && action.path !== null);
  const firstEditIndex = repositoryActions.findIndex((action) => action.kind === ActionKind.Edit);
  const earlyPhase = firstEditIndex === -1 ? repositoryActions : repositoryActions.slice(0, firstEditIndex);
  const first = repositoryActions[0] ?? null;
  const supported = (path: string | null): boolean => path !== null && surfaced.has(path);

  const touched = new Set(repositoryActions.map((action) => action.path!).filter((path) => path !== null));
  const earlySupported = earlyPhase.filter((action) => supported(action.path)).length;
  const firstEdit = firstEditIndex === -1 ? null : repositoryActions[firstEditIndex]!;

  return Object.freeze({
    firstMeaningfulAction: first,
    firstActionSupported: first === null ? null : supported(first.path),
    earlyPhaseActions: Object.freeze(earlyPhase),
    earlyPhaseSupported: earlySupported,
    earlyPhaseTotal: earlyPhase.length,
    earlyPhaseSupportRate: earlyPhase.length === 0 ? null : earlySupported / earlyPhase.length,
    surfacedNeverTouched: Object.freeze([...surfaced].filter((path) => !touched.has(path)).sort()),
    touchedNeverSurfaced: Object.freeze([...touched].filter((path) => !surfaced.has(path)).sort()),
    firstEditPath: firstEdit?.path ?? null,
    firstEditSupported: firstEdit === null ? null : supported(firstEdit.path),
  });
}
