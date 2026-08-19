/**
 * M162-B — pure wiring for the CALLABLE arm.
 *
 * Everything here is a value transformation so it can be asserted offline: the
 * MCP configuration handed to the live agent, the tool-permission list, and the
 * per-arm expectations that prove BASELINE and STATIC stay uncontaminated.
 *
 * The governing lesson from M162-A, one level up: an implemented tool is not a
 * discoverable tool, a discoverable tool is not an allowed tool, and an allowed
 * tool is not a correctly routed one. Each of those is a separate assertion
 * below rather than an assumption.
 */

/**
 * The frozen model-visible surface. Serving more would reintroduce the
 * per-turn prompt-prefix tax M162 exists to test — the full registry costs
 * ~5.5k schema tokens against ~1.9k for these two.
 */
export const FROZEN_CALLABLE_TOOL_IDS = Object.freeze([
  "get_code_context",
  "get_impact_graph",
] as const);

/**
 * MCP server key in the agent's config. Claude Code derives the model-visible
 * tool name from it, so this string is load-bearing: changing it renames every
 * tool the agent sees and silently invalidates the allow-list.
 */
export const VTRACE_MCP_SERVER_NAME = "vtrace";

export type Stage5CallableArm = "baseline" | "static" | "callable";

/**
 * Claude Code namespaces MCP tools as `mcp__<server>__<tool>`.
 *
 * This is the name the agent sees, the name `--allowedTools` must contain, and
 * the name telemetry will match on. Internal ids are not interchangeable with
 * it anywhere in the live path.
 */
export function mcpToolName(toolId: string, serverName: string = VTRACE_MCP_SERVER_NAME): string {
  return `mcp__${serverName}__${toolId}`;
}

/** The model-visible names of the frozen set, in frozen order. */
export function frozenCallableMcpToolNames(
  serverName: string = VTRACE_MCP_SERVER_NAME,
): readonly string[] {
  return FROZEN_CALLABLE_TOOL_IDS.map((toolId) => mcpToolName(toolId, serverName));
}

export interface VtraceMcpConfigInput {
  /** The agent's ACTUAL task workspace — never a shared clone or the vtrace checkout. */
  readonly repoRoot: string;
  /** Absolute path to the vtrace CLI entry the server is started from. */
  readonly cliEntry: string;
  /** Runtime used to execute the CLI entry (the harness already resolves one). */
  readonly runtime: string;
  readonly serverName?: string;
  readonly toolIds?: readonly string[];
}

export interface VtraceMcpConfig {
  readonly mcpServers: Readonly<Record<string, {
    readonly command: string;
    readonly args: readonly string[];
  }>>;
}

/**
 * Build the `--mcp-config` payload for one task.
 *
 * `--repo` binds the server to the agent's own workspace at startup, which is
 * what makes M132 worktree authority hold: the server cannot answer about a
 * shared benchmark clone or a stale ARC index because it was never bound to
 * one. `--tools` restricts the visible surface at the source rather than
 * relying on the allow-list to hide anything, so the unlisted twelve never
 * reach the prompt at all.
 */
export function buildVtraceMcpConfig(input: VtraceMcpConfigInput): VtraceMcpConfig {
  const serverName = input.serverName ?? VTRACE_MCP_SERVER_NAME;
  const toolIds = input.toolIds ?? FROZEN_CALLABLE_TOOL_IDS;

  return {
    mcpServers: {
      [serverName]: {
        command: input.runtime,
        args: [
          input.cliEntry,
          "mcp-serve",
          "--repo",
          input.repoRoot,
          "--tools",
          toolIds.join(","),
        ],
      },
    },
  };
}

/**
 * The ordinary tool allow-list the external harness hardcodes. Duplicated here
 * as an expectation, not a source of truth: the parity control compares against
 * what the harness actually passes and fails if these drift apart.
 */
export const HARNESS_DEFAULT_ALLOWED_TOOLS = Object.freeze([
  "Edit", "Write", "Bash", "Read", "Glob", "Grep", "TodoWrite",
]);

/**
 * CALLABLE's allow-list: the ordinary tools, unchanged and in order, plus
 * exactly the two frozen VTRACE names.
 *
 * Narrow by construction. A wildcard would let any future registered tool
 * become callable without passing through the frozen-set review, which is the
 * failure mode that makes an architecture experiment untestable.
 */
export function buildCallableAllowedTools(
  baseTools: readonly string[] = HARNESS_DEFAULT_ALLOWED_TOOLS,
  serverName: string = VTRACE_MCP_SERVER_NAME,
): readonly string[] {
  return [...baseTools, ...frozenCallableMcpToolNames(serverName)];
}

export interface ArmToolPermissions {
  readonly arm: Stage5CallableArm;
  readonly allowedTools: readonly string[];
  readonly vtraceToolNames: readonly string[];
  readonly mcpServersConfigured: readonly string[];
  readonly strictMcpConfig: boolean;
}

/** The expected permission shape of each arm, for the parity control. */
export function expectedArmToolPermissions(
  arm: Stage5CallableArm,
  baseTools: readonly string[] = HARNESS_DEFAULT_ALLOWED_TOOLS,
): ArmToolPermissions {
  if (arm === "callable") {
    return {
      arm,
      allowedTools: buildCallableAllowedTools(baseTools),
      vtraceToolNames: frozenCallableMcpToolNames(),
      mcpServersConfigured: [VTRACE_MCP_SERVER_NAME],
      strictMcpConfig: true,
    };
  }

  return {
    arm,
    allowedTools: [...baseTools],
    vtraceToolNames: [],
    mcpServersConfigured: [],
    strictMcpConfig: true,
  };
}

export interface ArmParityFinding {
  readonly ok: boolean;
  readonly issues: readonly string[];
}

/**
 * Prove the three arms differ ONLY by VTRACE affordances.
 *
 * Experimental parity is the whole basis for attributing an outcome difference
 * to architecture: if CALLABLE quietly gained or lost an ordinary tool, every
 * downstream comparison would be measuring that instead.
 */
export function checkArmToolParity(
  arms: readonly ArmToolPermissions[],
): ArmParityFinding {
  const issues: string[] = [];
  const byArm = new Map(arms.map((entry) => [entry.arm, entry] as const));

  for (const arm of ["baseline", "static", "callable"] as const) {
    if (!byArm.has(arm)) issues.push(`missing arm: ${arm}`);
  }
  if (issues.length > 0) return { ok: false, issues: Object.freeze(issues) };

  const baseline = byArm.get("baseline")!;
  const staticArm = byArm.get("static")!;
  const callable = byArm.get("callable")!;

  const ordinary = (entry: ArmToolPermissions): readonly string[] =>
    entry.allowedTools.filter((tool) => !tool.startsWith("mcp__"));

  const baselineOrdinary = ordinary(baseline).join(",");
  if (ordinary(staticArm).join(",") !== baselineOrdinary) {
    issues.push("STATIC ordinary tool permissions differ from BASELINE");
  }
  if (ordinary(callable).join(",") !== baselineOrdinary) {
    issues.push("CALLABLE ordinary tool permissions differ from BASELINE");
  }

  for (const entry of [baseline, staticArm]) {
    if (entry.vtraceToolNames.length !== 0) {
      issues.push(`${entry.arm.toUpperCase()} exposes VTRACE tools: ${entry.vtraceToolNames.join(",")}`);
    }
    if (entry.mcpServersConfigured.length !== 0) {
      issues.push(`${entry.arm.toUpperCase()} configures MCP servers: ${entry.mcpServersConfigured.join(",")}`);
    }
    if (entry.allowedTools.some((tool) => tool.startsWith("mcp__"))) {
      issues.push(`${entry.arm.toUpperCase()} allow-list contains an MCP tool`);
    }
  }

  const expectedCallable = frozenCallableMcpToolNames();
  // Exact equality, not a subset check: a superset would mean an unreviewed
  // thirteenth tool reached the agent.
  if (callable.vtraceToolNames.join(",") !== expectedCallable.join(",")) {
    issues.push(
      `CALLABLE VTRACE tool set is ${callable.vtraceToolNames.join(",")}, expected ${expectedCallable.join(",")}`,
    );
  }
  for (const name of expectedCallable) {
    if (!callable.allowedTools.includes(name)) {
      issues.push(`CALLABLE allow-list is missing ${name}, so the tool would be visible but unusable`);
    }
  }

  for (const entry of [baseline, staticArm, callable]) {
    if (!entry.strictMcpConfig) issues.push(`${entry.arm.toUpperCase()} is not running under --strict-mcp-config`);
  }

  return { ok: issues.length === 0, issues: Object.freeze(issues) };
}
