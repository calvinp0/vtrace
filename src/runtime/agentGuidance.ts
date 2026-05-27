import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const VTRACE_GUIDANCE_START = "<!-- vtrace:start -->";
const VTRACE_GUIDANCE_END = "<!-- vtrace:end -->";

export const VTRACE_AGENT_GUIDANCE_BLOCK = [
  VTRACE_GUIDANCE_START,
  "## Vtrace Agent Guidance",
  "",
  "- Use `get_code_context` for broad repo-understanding, debugging, refactor, and code-context tasks.",
  "- Use `get_code_context` before manual grep or opening many files.",
  "- `get_code_context` may refresh a stale index automatically. If it reports that automatic refresh was unavailable, call `index_repo` and retry.",
  "- Use `get_impact_graph` for known-symbol impact or blast-radius questions.",
  "- Still follow existing repo rules such as GitNexus impact checks before editing symbols.",
  VTRACE_GUIDANCE_END,
  "",
].join("\n");

export interface AgentGuidanceInstallResult {
  repoRoot: string;
  path: string;
  action: "created" | "updated" | "unchanged";
}

export async function writeVtraceAgentGuidanceBlock(
  repoRoot: string,
): Promise<AgentGuidanceInstallResult> {
  const resolvedRepoRoot = path.resolve(repoRoot);
  const agentsPath = path.join(resolvedRepoRoot, "AGENTS.md");
  const existing = await readTextFileIfPresent(agentsPath);
  const next = upsertVtraceAgentGuidanceBlock(existing ?? "");

  const action = existing === undefined
    ? "created"
    : existing === next
      ? "unchanged"
      : "updated";

  if (action !== "unchanged") {
    await writeFile(agentsPath, next);
  }

  return {
    repoRoot: resolvedRepoRoot,
    path: agentsPath,
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
