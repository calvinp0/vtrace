#!/usr/bin/env bun
// M76 executable PostToolUse hook for the tool-loop guard (runtime_injection mode).
//
// Registered into the live `claude -p` run via a `--settings` file whose PostToolUse
// hook command is `bun <thisfile>` (see buildToolLoopGuardHookSettings + the adapter
// hook patch block in run_stage5_vexp_swe_bench_smoke.ts). Claude Code invokes it
// once per tool result, passing the event JSON on stdin; if the deterministic
// detector decides the agent is looping, it prints a PostToolUse output carrying
// `additionalContext` (the <VTRACE_TOOL_LOOP_GUARD> recovery message) which the model
// sees on its next turn.
//
// This file is a THIN I/O shell over the PURE `runToolLoopGuardHook`: it wires real
// stdin/fs/env and prints stdout. All logic + fail-closed behavior live in the pure
// function, so they are unit-testable without a live agent. The hook ALWAYS exits 0
// and ALWAYS prints a well-formed PostToolUse payload — on any failure it emits the
// inert no-op (never injects, never crashes the agent turn loop).
//
// Env (set by the harness only in runtime_injection mode):
//   VTRACE_TOOL_LOOP_GUARD_STATE_FILE   explicit per-run state file, OR
//   VTRACE_TOOL_LOOP_GUARD_STATE_DIR    dir the hook keys by session id
//   VTRACE_TOOL_LOOP_GUARD_CONFIG       optional JSON config override
//   VTRACE_TOOL_LOOP_GUARD_LOG_FILE     optional injection-event log (JSONL)

import { readFileSync, writeFileSync, appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import {
  runToolLoopGuardHook,
  TOOL_LOOP_GUARD_HOOK_NOOP_STDOUT,
  type ToolLoopGuardHookEnv,
  type ToolLoopGuardHookIo,
} from "./toolLoopGuardRuntime";

function readStdin(): string {
  try {
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

const io: ToolLoopGuardHookIo = {
  readState(stateFile) {
    try {
      return readFileSync(stateFile, "utf8");
    } catch {
      return null;
    }
  },
  writeState(stateFile, content) {
    try {
      mkdirSync(dirname(stateFile), { recursive: true });
    } catch {
      // ignore — writeFileSync below surfaces a real failure into the outer catch
    }
    writeFileSync(stateFile, content, "utf8");
  },
  appendLog(logFile, line) {
    try {
      mkdirSync(dirname(logFile), { recursive: true });
      appendFileSync(logFile, `${line}\n`, "utf8");
    } catch {
      // logging is best-effort; never fail the hook over it
    }
  },
};

const env: ToolLoopGuardHookEnv = {
  stateFile: process.env.VTRACE_TOOL_LOOP_GUARD_STATE_FILE,
  stateDir: process.env.VTRACE_TOOL_LOOP_GUARD_STATE_DIR,
  configJson: process.env.VTRACE_TOOL_LOOP_GUARD_CONFIG,
  logFile: process.env.VTRACE_TOOL_LOOP_GUARD_LOG_FILE,
};

try {
  const result = runToolLoopGuardHook(readStdin(), env, io);
  process.stdout.write(result.stdout);
} catch {
  // Belt-and-suspenders: runToolLoopGuardHook already fails closed, but guarantee a
  // well-formed inert payload + zero exit even if stdout/env access throws.
  process.stdout.write(TOOL_LOOP_GUARD_HOOK_NOOP_STDOUT);
}
process.exit(0);
