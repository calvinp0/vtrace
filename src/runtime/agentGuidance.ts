import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const VTRACE_GUIDANCE_START = "<!-- vtrace:start -->";
const VTRACE_GUIDANCE_END = "<!-- vtrace:end -->";

export const VtraceGuidanceTarget = Object.freeze({
  AgentsMd: "AGENTS.md",
  ClaudeMd: "CLAUDE.md",
});

export type VtraceGuidanceTarget =
  (typeof VtraceGuidanceTarget)[keyof typeof VtraceGuidanceTarget];

/**
 * Every tool named here MUST be exposed in `tools/list`. `search_symbols` was
 * named here for a long time while being registered as a hidden legacy tool, so
 * agents were told to call something they could not see — the M132 incident.
 * `toolGuidanceConsistency.test.ts` now enforces the containment.
 */
export const VTRACE_AGENT_GUIDANCE_BLOCK = [
  VTRACE_GUIDANCE_START,
  "## Vtrace Agent Guidance",
  "",
  "- Use `get_code_context` for broad repo-understanding, debugging, refactor, and code-context tasks.",
  "- `get_code_context` returns bounded task-relevant evidence, not an exhaustive listing. What it omits is unsearched, not absent — never conclude from a miss that something does not exist.",
  "- Before writing a new helper, treat a `get_code_context` miss as inconclusive: confirm with an exact symbol/path lookup or ordinary text search first.",
  "- If `get_code_context` reports `stale_index`, `missing_index`, or `repo_not_ready`, call `index_repo` and then retry `get_code_context`.",
  "- Use `get_code_context` for exact symbol lookup too; it resolves a named symbol and returns its source with surrounding context.",
  "- Use `get_skeleton` when a file path is already known and a structural overview is needed.",
  "- Use `get_impact_graph` for known-symbol blast radius, dependents, callers, or references.",
  "- Use `get_context_capsule` only when lower-level capsule output is specifically needed.",
  "- `run_pipeline` remains available as the stable equivalent of `get_code_context`.",
  "- Vtrace answers about the current indexed source state only. Whether another branch, the PR base, or `origin/main` contains something is a Git question, not a Vtrace one.",
  "",
  "### Git worktrees",
  "",
  "- Vtrace queries are scoped to one Git worktree. Pass `repo_root` with the worktree you are working in; without it the server answers from the checkout it was launched in, reported as `routingSource: process_default`.",
  "- Nested linked worktrees are excluded from their parent's index, so a parent query never returns duplicate copies of the same file.",
  "- Use `auto_refresh: if_stale` to refresh the requested worktree. It only ever refreshes that worktree; it never repurposes another worktree's index.",
  VTRACE_GUIDANCE_END,
  "",
].join("\n");

export interface AgentGuidanceInstallResult {
  repoRoot: string;
  path: string;
  target: VtraceGuidanceTarget;
  action: "created" | "updated" | "unchanged";
}

export async function writeVtraceAgentGuidanceBlock(
  repoRoot: string,
  target: VtraceGuidanceTarget = VtraceGuidanceTarget.AgentsMd,
): Promise<AgentGuidanceInstallResult> {
  const resolvedRepoRoot = path.resolve(repoRoot);
  const guidancePath = path.join(resolvedRepoRoot, target);
  const existing = await readTextFileIfPresent(guidancePath);
  const next = upsertVtraceAgentGuidanceBlock(existing ?? "");

  const action = existing === undefined
    ? "created"
    : existing === next
      ? "unchanged"
      : "updated";

  if (action !== "unchanged") {
    await writeFile(guidancePath, next);
  }

  return {
    repoRoot: resolvedRepoRoot,
    path: guidancePath,
    target,
    action,
  };
}

export function upsertVtraceAgentGuidanceBlock(
  existing: string,
): string {
  const startIndex = existing.indexOf(VTRACE_GUIDANCE_START);
  const endIndex = existing.indexOf(VTRACE_GUIDANCE_END);

  if (startIndex >= 0 && endIndex >= startIndex) {
    const blockEnd = endIndex + VTRACE_GUIDANCE_END.length;
    const suffixStart = blockEnd < existing.length && existing[blockEnd] === "\n"
      ? blockEnd + 1
      : blockEnd;

    return `${existing.slice(0, startIndex)}${VTRACE_AGENT_GUIDANCE_BLOCK}${existing.slice(suffixStart)}`;
  }

  const trimmed = existing.trimEnd();

  return trimmed.length === 0
    ? VTRACE_AGENT_GUIDANCE_BLOCK
    : `${trimmed}\n\n${VTRACE_AGENT_GUIDANCE_BLOCK}`;
}

async function readTextFileIfPresent(
  targetPath: string,
): Promise<string | undefined> {
  try {
    return await readFile(targetPath, "utf8");
  } catch (error) {
    if (isMissingFileError(error)) {
      return undefined;
    }

    throw error;
  }
}

function isMissingFileError(error: unknown): boolean {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && error.code === "ENOENT";
}
