/**
 * M193 §33/§34 — prove the baseline condition is actually untreated.
 *
 * Runs immediately before each arm and again as a committed audit here. It
 * looks for every route by which VTRACE, VEXP or Stage 5 instructions could
 * reach an agent that is supposed to be seeing none of them.
 *
 *   bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m193_treatment_audit.ts
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const RESULTS = join(import.meta.dir, "results");
const OUT = join(RESULTS, "stage5_m193_treatment_audit.json");
const VEXP = "/home/calvin/code/vexp-swe-bench";
const HOME = process.env.HOME ?? "/home/calvin";

interface Finding {
  id: string;
  severity: "BLOCKING" | "MITIGATED" | "INFORMATIONAL";
  what: string;
  evidence: string;
  mitigation: string;
}

const findings: Finding[] = [];

function add(f: Finding) {
  findings.push(f);
}

// ── 1. instruction files reachable from an agent working directory ──

/**
 * Claude Code walks upward from its cwd collecting CLAUDE.md, so the mount root
 * matters as much as the mount itself. The acquisition's working directory is
 * the bind-mounted checkout; anything above it on the host is a live exposure
 * route.
 */
const INSTRUCTION_FILES = ["CLAUDE.md", "AGENTS.md", ".claude", ".cursorrules", "GEMINI.md"];

function ancestorInstructionFiles(start: string): string[] {
  const hits: string[] = [];
  let dir = resolve(start);
  for (;;) {
    for (const name of INSTRUCTION_FILES) {
      const p = join(dir, name);
      if (existsSync(p)) hits.push(p);
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return hits;
}

const PROPOSED_MOUNT_ROOT = "/tmp/m193_arms";
const ancestorHits = ancestorInstructionFiles(PROPOSED_MOUNT_ROOT);
add({
  id: "T1_ancestor_instruction_files",
  severity: ancestorHits.length ? "BLOCKING" : "MITIGATED",
  what: "instruction files reachable by walking up from the agent's working directory",
  evidence: ancestorHits.length ? ancestorHits.join(", ") : `none above ${PROPOSED_MOUNT_ROOT}`,
  mitigation:
    "The arm working directory is a bind-mount root under /tmp with no instruction file on any ancestor. The repository's own CLAUDE.md at /home/calvin/code/vtrace is therefore unreachable, and the acquisition must never run with a cwd inside this repository.",
});

// A user-level CLAUDE.md is loaded regardless of cwd.
const userMemory = join(HOME, ".claude", "CLAUDE.md");
add({
  id: "T2_user_level_instructions",
  severity: existsSync(userMemory) ? "BLOCKING" : "MITIGATED",
  what: "a user-level CLAUDE.md is loaded into every session regardless of working directory",
  evidence: existsSync(userMemory) ? `${userMemory} exists (${statSync(userMemory).size} bytes)` : "absent",
  mitigation:
    "Each arm must launch with a private CLAUDE_CONFIG_DIR pointing at a scratch directory containing only credentials, so no user-level memory, output style, or settings file reaches the agent. This is a hard precondition, not a preference: the file exists on this host and would otherwise be injected into every arm.",
});

// ── 2. hooks and settings ───────────────────────────────────────────

const settingsPaths = [
  join(HOME, ".claude", "settings.json"),
  join(HOME, ".claude", "settings.local.json"),
  join(import.meta.dir, "..", "..", ".claude", "settings.json"),
  join(import.meta.dir, "..", "..", ".claude", "settings.local.json"),
];
const presentSettings = settingsPaths.filter((p) => existsSync(p));
const hookBearing = presentSettings.filter((p) => {
  try {
    return typeof (JSON.parse(readFileSync(p, "utf8")) as Record<string, unknown>).hooks === "object";
  } catch {
    return false;
  }
});
add({
  id: "T3_ambient_hooks",
  severity: hookBearing.length ? "BLOCKING" : "MITIGATED",
  what: "hook definitions that would fire inside an acquisition arm",
  evidence: hookBearing.length ? hookBearing.join(", ") : `no hooks in ${presentSettings.length} settings file(s) found`,
  mitigation:
    "The private CLAUDE_CONFIG_DIR excludes these. The only hooks an arm loads are the two declared execution-adapter hooks, passed explicitly via --settings.",
});

// ── 3. MCP ──────────────────────────────────────────────────────────

add({
  id: "T4_mcp_servers",
  severity: "MITIGATED",
  what: "MCP servers, including VTRACE's own, reaching the agent",
  evidence: "the manifest pins an empty {\"mcpServers\":{}} config with --strict-mcp-config",
  mitigation:
    "--strict-mcp-config makes the passed config the only source of servers, so neither user-level nor project-level MCP configuration is consulted.",
});

// ── 4. the VEXP checkout and its Stage 5 shim ───────────────────────

let vexpDirt = -1;
let vexpHead = "";
try {
  vexpHead = execFileSync("git", ["-C", VEXP, "rev-parse", "HEAD"]).toString().trim();
  vexpDirt = execFileSync("git", ["-C", VEXP, "status", "--porcelain"]).toString().trim().split("\n").filter(Boolean).length;
} catch {
  /* not a git checkout */
}
const shim = join(VEXP, "dist", "agents", "claude-code.js");
const shimPatched = existsSync(shim) && readFileSync(shim, "utf8").includes("STAGE5_VTRACE");
add({
  id: "T5_vexp_agent_shim",
  severity: shimPatched ? "MITIGATED" : "INFORMATIONAL",
  what: "the vexp-swe-bench agent adapter carries VTRACE's Stage 5 injection patches",
  evidence: shimPatched
    ? `${shim} contains STAGE5_VTRACE patch markers; vexp HEAD ${vexpHead.slice(0, 12)} with ${vexdirtSafe(vexpDirt)} dirty entries`
    : "no Stage 5 markers found in the vexp adapter",
  mitigation:
    "The acquisition does NOT run through vexp-swe-bench. It spawns the installed Claude Code CLI directly, so the patched adapter is never loaded. The patches are env-gated and inert without VTRACE_* variables, but the acquisition does not rely on that: it does not execute this file at all.",
});

function vexdirtSafe(n: number): string {
  return n < 0 ? "unknown" : String(n);
}

add({
  id: "T6_vexp_prompt_reuse",
  severity: "INFORMATIONAL",
  what: "the acquisition reuses vexp-swe-bench's task prompt text",
  evidence: "src/harness/loader.ts buildPrompt, copied verbatim into the manifest",
  mitigation:
    "M188 established that this prompt injects no orientation and no repository context. It is copied into the manifest as literal text rather than imported, so a later edit to the dirty VEXP checkout cannot silently change the acquisition's prompt.",
});

// ── 5. environment variables ────────────────────────────────────────

const vtraceEnv = Object.keys(process.env).filter((k) => k.startsWith("VTRACE") || k.startsWith("VEXP"));
add({
  id: "T7_environment_variables",
  severity: vtraceEnv.length ? "BLOCKING" : "MITIGATED",
  what: "VTRACE_/VEXP_ environment variables inherited by the agent process",
  evidence: vtraceEnv.length ? vtraceEnv.join(", ") : "none set in the auditing process",
  mitigation:
    "Each arm is spawned with an explicitly constructed environment rather than an inherited one, and the launcher asserts that no VTRACE_* or VEXP_* key survives into it.",
});

// ── 6. shell startup files ──────────────────────────────────────────

const startupFiles = [".bashrc", ".bash_profile", ".profile", ".zshrc"].map((f) => join(HOME, f)).filter(existsSync);
add({
  id: "T8_shell_startup_files",
  severity: "MITIGATED",
  what: "shell startup files injecting aliases or instructions into agent commands",
  evidence: startupFiles.length ? startupFiles.join(", ") : "none",
  mitigation:
    "Irrelevant by construction: every agent Bash command executes inside the instance container via a non-login, non-interactive `bash -c`, so no host startup file is sourced.",
});

// ── 7. VTRACE daemon / sockets ──────────────────────────────────────

/**
 * Reported by name PREFIX, not by full path. These are mkdtemp-style names whose
 * random suffix changes on every run and carries no information; including it
 * would make this audit differ from itself on a re-run for no reason.
 */
function findSockets(dir: string): string[] {
  try {
    return [
      ...new Set(
        readdirSync(dir)
          .filter((f) => f.toLowerCase().includes("vtrace"))
          .map((f) => join(dir, f.replace(/-[A-Za-z0-9]{6,}$/, "-*"))),
      ),
    ].sort();
  } catch {
    return [];
  }
}
const sockets = [...findSockets("/tmp"), ...findSockets(join(HOME, ".vtrace"))];
add({
  id: "T9_vtrace_daemon_sockets",
  severity: sockets.length ? "INFORMATIONAL" : "MITIGATED",
  what: "a reachable VTRACE daemon socket or state directory",
  evidence: sockets.length ? sockets.slice(0, 5).join(", ") : "none found under /tmp or ~/.vtrace",
  mitigation:
    "Unreachable from the agent regardless: the agent has no MCP server and every command it runs executes inside a container with no host socket bind-mounted.",
});

// ── 8. benchmark-native instruction files ───────────────────────────

add({
  id: "T10_benchmark_native_instruction_files",
  severity: "INFORMATIONAL",
  what: "instruction files belonging to the benchmark repository itself at its base commit",
  evidence: "recorded per arm by the launcher, not removed",
  mitigation:
    "These are the benchmark's normal condition and are preserved (§33). They are recorded in a separate telemetry field from experimental injection so the two can never be conflated, and their presence is reported per repository in the corpus accounting.",
});

const blocking = findings.filter((f) => f.severity === "BLOCKING");
const doc = {
  schemaVersion: "stage5.m193.treatment-audit.v1",
  milestone: "M193",
  question:
    "Can VTRACE, VEXP or Stage 5 instructions reach an agent in the BASELINE_ONLY condition by any route, and is each route closed by a stated precondition rather than by luck?",
  auditedAt: "deterministic; no model invoked",
  proposedArmWorkingDirectoryRoot: PROPOSED_MOUNT_ROOT,
  vexpCheckout: { path: VEXP, head: vexpHead, dirtyEntries: vexpDirt, agentShimPatched: shimPatched },
  findings,
  blockingCount: blocking.length,
  blockingIds: blocking.map((f) => f.id),
  verdict:
    blocking.length === 0
      ? "TREATMENT_ABSENCE_ACHIEVABLE_WITHOUT_PRECONDITIONS"
      : "TREATMENT_ABSENCE_ACHIEVABLE_ONLY_UNDER_STATED_PRECONDITIONS",
  preconditionsForEveryArm: [
    "launch with a private CLAUDE_CONFIG_DIR containing credentials only",
    "launch with an explicitly constructed environment carrying no VTRACE_/VEXP_ key",
    "working directory is the bind-mount root under /tmp, never inside the vtrace repository",
    "an empty MCP config with --strict-mcp-config",
    "--settings pointing only at the two declared execution-adapter hooks",
    "assert the Claude Code CLI version before launching",
    "record any benchmark-native instruction file separately from experimental injection",
  ],
  liveObservationFields: [
    "vexpCheckout.dirtyEntries — a real measurement of a working tree that changes as other work touches it; it is reported, not asserted stable",
  ],
  reproducibility:
    "Every field except vexpCheckout.dirtyEntries (and the same count quoted in T5) is stable across re-runs on an unchanged host. Socket names are reported by prefix because their random suffixes carry no information.",
  enforcement:
    "The launcher must re-run these checks per arm and refuse to spawn the model if any precondition is unmet. An arm whose audit fails is recorded TREATMENT_CONTAMINATION and is RUN_INVALID; it is not rerunnable.",
};

writeFileSync(OUT, `${JSON.stringify(doc, null, 2)}\n`);
console.log(`wrote ${OUT}`);
console.log(`verdict: ${doc.verdict}`);
for (const f of findings) console.log(`  ${f.severity.padEnd(14)} ${f.id}  ${f.evidence.slice(0, 90)}`);
