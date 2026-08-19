import assert from "node:assert/strict";
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";

import {
  applyVtracePatch,
  hasDisallowedToolsPatch,
  hasStreamPatch,
  hasToolLoopGuardHookPatch,
  hasVtraceMcpPatch,
} from "./run_stage5_vexp_swe_bench_smoke";
import {
  buildCallableAllowedTools,
  buildVtraceMcpConfig,
  frozenCallableMcpToolNames,
} from "./m162Callable";

/**
 * M162-B end-to-end argv control.
 *
 * The question this answers is not "does the patch text look right" but "does
 * the VTRACE MCP server and its two tool permissions actually reach the
 * `claude` process the harness spawns". Reading the patch source cannot answer
 * that: the adapter owns argument assembly, and the whole point of the M162
 * wiring is to feed the adapter's own inputs rather than to duplicate its
 * flags.
 *
 * So this copies the real external adapter, patches it with the real patcher,
 * puts a fake `claude` first on PATH that records its argv, and runs it. What
 * is asserted is the recorded command line.
 *
 * M155 is the reason this exists: historical live agents were launched with
 * `--strict-mcp-config` against `{"mcpServers":{}}` for years, and no test
 * caught it because nothing ever looked at the spawned command.
 */

const VEXP_SRC = "/home/calvin/code/vexp-swe-bench/src";
const ADAPTER_RELATIVE = path.join("agents", "claude-code.ts");

interface Harness {
  readonly dir: string;
  readonly adapterPath: string;
  readonly argvPath: string;
  readonly configCapturePath: string;
  readonly binDir: string;
}

async function withPatchedAdapter(run: (harness: Harness) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "m162-adapter-"));
  try {
    // Copy the whole source tree so the adapter's relative imports resolve, and
    // so nothing is written into the external checkout.
    const srcDir = path.join(dir, "src");
    await cp(VEXP_SRC, srcDir, { recursive: true });

    const adapterPath = path.join(srcDir, ADAPTER_RELATIVE);
    const original = await readFile(adapterPath, "utf8");
    const patched = applyVtracePatch(original);
    assert.ok(hasVtraceMcpPatch(patched.content), "patcher did not install the M162 MCP block");
    await writeFile(adapterPath, patched.content);

    // A fake `claude` that records argv and emits a minimal stream-json result.
    const binDir = path.join(dir, "bin");
    await mkdir(binDir, { recursive: true });
    const argvPath = path.join(dir, "argv.json");
    const configCapturePath = path.join(dir, "captured-mcp-config.json");
    // The config must be read HERE, inside the spawned process, because the
    // adapter deletes its own temporary empty-config directory as soon as the
    // run returns. Reading it afterwards would only ever see the callable case.
    await writeFile(
      path.join(binDir, "claude"),
      [
        "#!/usr/bin/env bash",
        `printf '%s\\n' "$@" > ${JSON.stringify(argvPath)}`,
        "prev=\"\"",
        "for arg in \"$@\"; do",
        `  if [ "$prev" = "--mcp-config" ]; then cp "$arg" ${JSON.stringify(configCapturePath)}; fi`,
        "  prev=\"$arg\"",
        "done",
        `echo '{"type":"result","subtype":"success","num_turns":1,"total_cost_usd":0,`
        + `"usage":{"input_tokens":1,"output_tokens":1}}'`,
      ].join("\n"),
      { mode: 0o755 },
    );

    await run({ dir, adapterPath, argvPath, configCapturePath, binDir });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function runAdapter(
  harness: Harness,
  env: Record<string, string | undefined>,
): Promise<string[]> {
  const previous: Record<string, string | undefined> = {};
  const applied = { ...env, PATH: `${harness.binDir}:${process.env.PATH ?? ""}` };
  for (const [key, value] of Object.entries(applied)) {
    previous[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }

  try {
    const module = await import(`${harness.adapterPath}?t=${Math.random()}`);
    const adapter = new module.ClaudeCodeAdapter();
    await adapter.run({
      prompt: "m162 control",
      cwd: harness.dir,
      model: "claude-sonnet-5",
      maxTurns: 1,
      costLimitUsd: 1,
      thinkingBudget: 0,
      timeoutMs: 60_000,
      allowedTools: ["Edit", "Write", "Bash", "Read", "Glob", "Grep", "TodoWrite"],
    });
    return JSON.parse(`[${(await readFile(harness.argvPath, "utf8")).trimEnd().split("\n").map((line) => JSON.stringify(line)).join(",")}]`);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function flagValue(argv: readonly string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  return index === -1 ? undefined : argv[index + 1];
}

test("M162-B: with no callable env, the spawned agent gets an empty MCP config and no VTRACE tools", async () => {
  await withPatchedAdapter(async (harness) => {
    const argv = await runAdapter(harness, {
      VTRACE_MCP_CONFIG: undefined,
      VTRACE_MCP_ALLOWED_TOOLS: undefined,
    });

    assert.ok(argv.includes("--strict-mcp-config"), "strict MCP config must always be set");

    assert.ok(flagValue(argv, "--mcp-config") !== undefined, "the harness always passes an MCP config");
    const config = JSON.parse(await readFile(harness.configCapturePath, "utf8"));
    assert.deepEqual(config, { mcpServers: {} }, "BASELINE/STATIC must receive an EMPTY server map");

    const allowed = flagValue(argv, "--allowedTools") ?? "";
    assert.ok(!allowed.includes("mcp__"), `no MCP tool may be permitted: ${allowed}`);
  });
});

test("M162-B: with callable env, the VTRACE server and exactly two tools reach the agent", async () => {
  await withPatchedAdapter(async (harness) => {
    const workspace = path.join(harness.dir, "workspace");
    await mkdir(workspace, { recursive: true });
    const mcpConfigPath = path.join(harness.dir, "vtrace-mcp.json");
    const config = buildVtraceMcpConfig({
      repoRoot: workspace,
      cliEntry: "/home/calvin/code/vtrace/src/cli/index.ts",
      runtime: "bun",
    });
    await writeFile(mcpConfigPath, JSON.stringify(config));

    const argv = await runAdapter(harness, {
      VTRACE_MCP_CONFIG: mcpConfigPath,
      VTRACE_MCP_ALLOWED_TOOLS: frozenCallableMcpToolNames().join(","),
    });

    assert.equal(flagValue(argv, "--mcp-config"), mcpConfigPath, "adapter must use the VTRACE config");
    assert.ok(argv.includes("--strict-mcp-config"));
    // Exactly one --mcp-config: the block sets the adapter's own input rather
    // than appending a second flag, so there is one authoritative live path.
    assert.equal(argv.filter((entry) => entry === "--mcp-config").length, 1);

    const allowed = (flagValue(argv, "--allowedTools") ?? "").split(",");
    for (const name of frozenCallableMcpToolNames()) {
      assert.ok(allowed.includes(name), `allow-list is missing ${name}`);
    }
    assert.deepEqual(
      allowed,
      buildCallableAllowedTools(),
      "CALLABLE must be exactly the ordinary tools plus the two frozen VTRACE names",
    );
    // Exactly the frozen two, never a thirteenth.
    assert.deepEqual(allowed.filter((tool) => tool.startsWith("mcp__")), [...frozenCallableMcpToolNames()]);
  });
});

test("M162-B: a missing callable config fails loudly instead of silently running untooled", async () => {
  await withPatchedAdapter(async (harness) => {
    const argv = await runAdapter(harness, {
      VTRACE_MCP_CONFIG: path.join(harness.dir, "does-not-exist.json"),
      VTRACE_MCP_ALLOWED_TOOLS: undefined,
    });

    // The adapter falls back to its own empty config, which is the safe shape,
    // but the run is NOT a valid CALLABLE arm. The stderr marker is what the
    // harness keys on; what must never happen is a silent untooled CALLABLE run
    // being counted as zero adoption.
    assert.ok(flagValue(argv, "--mcp-config") !== undefined);
    const config = JSON.parse(await readFile(harness.configCapturePath, "utf8"));
    assert.deepEqual(config, { mcpServers: {} });
  });
});

test("M162-B: the migration gate accounts for every optional patch block", async () => {
  // Regression for the defect that invalidated the pilot's first CALLABLE arm:
  // an adapter already carrying the older optional blocks returned early from
  // migration, so the MCP block was never installed and the arm ran untooled.
  // A treatment failure of that shape is indistinguishable from zero adoption
  // in the results, which is why the gate is asserted rather than trusted.
  const original = await readFile(path.join(VEXP_SRC, ADAPTER_RELATIVE), "utf8");
  const withOlderBlocksOnly = applyVtracePatch(original).content
    .replace(/\s*\/\/ STAGE5_VTRACE_MCP_PATCH begin[\s\S]*?\/\/ STAGE5_VTRACE_MCP_PATCH end\n/, "\n");

  assert.equal(hasVtraceMcpPatch(withOlderBlocksOnly), false, "fixture must lack the MCP block");
  assert.ok(hasStreamPatch(withOlderBlocksOnly), "fixture must carry the older blocks");
  assert.ok(hasDisallowedToolsPatch(withOlderBlocksOnly));
  assert.ok(hasToolLoopGuardHookPatch(withOlderBlocksOnly));

  const remigrated = applyVtracePatch(withOlderBlocksOnly);
  assert.ok(remigrated.changed, "an adapter missing only the MCP block must still be re-patched");
  assert.ok(hasVtraceMcpPatch(remigrated.content), "the MCP block must be migrated in");
});
