// M26 — dry-run artifact planner for the future isolated agent-command verifier.
//
// This module is a PURE, no-Docker, no-execution planner. Given the captured artifacts of a
// past run (a patch + the agent-selected test commands + their fair-verification provenance),
// it decides whether a single test command COULD be fairly and safely re-run against the
// patch in an isolated SWE-bench testbed — WITHOUT running anything. It never spawns an agent,
// never starts Docker, never executes the command, and never invokes SWE-bench grading. The
// only side effect (in the runner glue, not here) is writing one `_agent_test_command_plan.json`.
//
// It is deliberately conservative and honest:
//   - it selects AT MOST ONE command (the first that classifies as a test command),
//   - it refuses any command that is not provably agent-discovered (reusing the M23 fairness
//     verdict), is wrapped in a shell pipeline, or contains an unsafe token,
//   - `verificationPatchState.canVerifyFinalPatch` is hard-wired to false (dry run cannot
//     verify anything), and
//   - the expected SWE-bench image key is derived from the documented TestSpec format, or
//     reported as null with a blocker when it cannot be computed.

import { createHash } from "node:crypto";
import {
  classifyTestFramework,
  type ParsedTestStatus,
  type TestFramework,
  type TestProvenanceClass,
  type VerificationProvenance,
} from "./toolOutputCapture";

export const PLAN_MODE = "plan-agent-test-command" as const;

export type PatchSource = "original_model_patch" | "pivot_revision_revised";
export type CommandSource = "first_pass_test_commands" | "pivot_revision_test_commands";

// -------------------------------------------------------------------------------------------
// Command safety / fairness gating (PURE).
// -------------------------------------------------------------------------------------------

export interface CommandSafety {
  allowed: boolean;
  reason: string;
  /** True when the command is a test command wrapped in a shell pipeline/redirect: it carries
   *  diagnostic value but cannot be fairly re-executed as captured. */
  diagnosticOnly?: boolean;
}

// Outright-rejected tokens: a fair, isolated re-run must never mutate the repo/network/system.
// Matched with word boundaries so `rm` does not fire on `form` nor `apt` on `adapter`.
export const REJECTED_COMMAND_TOKENS: ReadonlyArray<{ token: string; re: RegExp }> = [
  { token: "rm", re: /(^|\s)rm(\s|$)/ },
  { token: "git reset", re: /\bgit\s+reset\b/ },
  { token: "git clean", re: /\bgit\s+clean\b/ },
  { token: "curl", re: /(^|\s)curl\b/ },
  { token: "wget", re: /(^|\s)wget\b/ },
  { token: "pip install", re: /\bpip[0-9.]*\s+install\b/ },
  { token: "npm install", re: /\bnpm\s+install\b/ },
  { token: "conda install", re: /\bconda\s+install\b/ },
  { token: "apt", re: /(^|\s)apt(-get)?\b/ },
  { token: "sudo", re: /(^|\s)sudo\b/ },
];

// Shell control operators: their presence means the captured command is a pipeline/redirect
// (e.g. `... 2>&1 | head -50`), which we will not run as-captured under fair mode.
export const SHELL_OPERATOR_TOKENS: ReadonlyArray<{ token: string; re: RegExp }> = [
  { token: "&&", re: /&&/ },
  { token: "||", re: /\|\|/ },
  { token: "|", re: /\|/ },
  { token: ";", re: /;/ },
  { token: ">>", re: />>/ },
  { token: ">", re: />/ },
  { token: "<", re: /</ },
];

// Frameworks whose canonical invocation runs a focused suite WITHOUT explicit test selectors
// (so gate 6 is satisfied even when `selectedTests` is empty). pytest/unittest are intentionally
// excluded: we will not re-run a whole pytest/unittest suite as "the smallest relevant test".
const FRAMEWORKS_RUNNABLE_WITHOUT_SELECTORS: ReadonlySet<TestFramework> = new Set<TestFramework>([
  "tox",
  "npm",
  "bun",
  "cargo",
  "go",
]);

// Classify whether a command may be FAIRLY EXECUTED as captured. Order of severity:
//   1) a rejected/unsafe token  -> hard reject (allowed=false, not diagnostic),
//   2) a shell operator         -> diagnosticOnly (allowed=false), cannot run as captured,
//   3) a recognized test form   -> allowed,
//   4) anything else            -> not a recognized fair test command.
// PURE: inspects the string only; never sanitizes, rewrites, or runs it.
export function classifyCommandSafety(command: string): CommandSafety {
  const rejected = REJECTED_COMMAND_TOKENS.find((t) => t.re.test(command));
  if (rejected !== undefined) {
    return { allowed: false, reason: `contains rejected token "${rejected.token}"` };
  }
  const operator = SHELL_OPERATOR_TOKENS.find((t) => t.re.test(command));
  if (operator !== undefined) {
    return {
      allowed: false,
      diagnosticOnly: true,
      reason: `shell pipeline/redirect token "${operator.token}" — not fair-executable as captured`,
    };
  }
  const framework = classifyTestFramework(command);
  if (framework === "unknown") {
    return { allowed: false, reason: "not a recognized fair test command form" };
  }
  return { allowed: true, reason: `allowed fair test form (${framework})` };
}

// -------------------------------------------------------------------------------------------
// Expected SWE-bench image / testbed identity (PURE; derived from the documented TestSpec).
// -------------------------------------------------------------------------------------------

export interface ImagePlan {
  instanceId: string;
  /** The computed instance image key, or null when it cannot be derived (e.g. no instance id). */
  expectedImageKey: string | null;
  imageNamespace?: string;
  architecture?: string;
  /** Human-readable note on HOW the key was (or was not) derived — never guess silently. */
  derivation: string;
  /** The in-container repo path SWE-bench mounts the testbed at. */
  testbed?: string;
}

// Derive the expected instance image key the way SWE-bench's `TestSpec.instance_image_key` does:
//   sweb.eval.<arch>.<instance_id.lower()>:<tag>
// and, when a namespace is in force (SWE-bench's `run_evaluation` defaults namespace="swebench",
// which `vexp` does NOT override), prefix `<namespace>/` and remap `__` -> `_1776_` (docker tags
// forbid a bare double underscore). Verified against the installed swebench harness/test_spec.
// Returns expectedImageKey=null + an honest derivation note when no instance id is available.
export function deriveExpectedImageKey(input: {
  instanceId: string;
  arch?: string;
  /** null => local image (no namespace prefix, no remap); undefined => SWE-bench default. */
  namespace?: string | null;
  instanceImageTag?: string;
}): ImagePlan {
  const instanceId = input.instanceId.trim();
  if (instanceId.length === 0) {
    return {
      instanceId: "",
      expectedImageKey: null,
      derivation: "unavailable_in_ts_dry_run: no instance id resolvable from captured artifacts",
    };
  }
  const arch = input.arch ?? "x86_64";
  const namespace = input.namespace === undefined ? "swebench" : input.namespace;
  const tag = input.instanceImageTag ?? "latest";
  const base = `sweb.eval.${arch}.${instanceId.toLowerCase()}:${tag}`;
  const expectedImageKey =
    namespace === null ? base : `${namespace}/${base}`.replace(/__/g, "_1776_");
  const derivation =
    `swebench TestSpec.instance_image_key: sweb.eval.<arch>.<instance_id.lower()>:<tag>` +
    `; arch defaults to x86_64 (make_test_spec), tag "${tag}"` +
    (namespace === null
      ? "; namespace=none ⇒ local image (no __→_1776_ remap)"
      : `; namespace "${namespace}" ⇒ remote image (__→_1776_ remap applied)`) +
    "; verified against installed swebench harness/test_spec/test_spec.py";
  return {
    instanceId,
    expectedImageKey,
    ...(namespace === null ? {} : { imageNamespace: namespace }),
    architecture: arch,
    derivation,
    testbed: "/testbed",
  };
}

// -------------------------------------------------------------------------------------------
// The plan.
// -------------------------------------------------------------------------------------------

// One candidate test command from the requested source, already carrying its fair-verification
// provenance (computed upstream by the M23 `buildFairVerificationReport`) so the planner only
// applies the gates and never re-derives provenance.
export interface PlanCommandCandidate {
  command: string;
  framework: TestFramework;
  selectedTests: string[];
  provenance: VerificationProvenance;
  parsedOutcomeStatus: ParsedTestStatus;
}

export interface AgentTestCommandPlan {
  mode: typeof PLAN_MODE;
  sourceRunLabel: string;
  instanceId: string;
  patchSource: PatchSource;
  patchPath: string | null;
  patchSha256: string | null;
  commandSource: CommandSource;
  selectedCommand: string | null;
  selectedTests: string[];
  commandFramework: TestFramework | null;
  commandSafety: CommandSafety;
  fairProvenance: {
    classification: TestProvenanceClass | null;
    allowedForFairVerification: boolean;
    evidence: string[];
  };
  verificationPatchState: {
    canVerifyFinalPatch: false;
    reason: "dry_run_only";
  };
  imagePlan: ImagePlan;
  plannedArtifacts: string[];
  eligibleForFutureExecution: boolean;
  blockers: string[];
}

export interface BuildPlanInput {
  sourceRunLabel: string;
  instanceId: string;
  patchSource: PatchSource;
  patchPath: string | null;
  /** The patch text (null when the requested patch artifact is missing). */
  patchText: string | null;
  commandSource: CommandSource;
  /** Candidate test commands from the requested source, in capture order. */
  candidates: readonly PlanCommandCandidate[];
  imagePlan: ImagePlan;
  /** Artifact paths the dry-run / future executor would produce (the plan json + future logs). */
  plannedArtifacts: readonly string[];
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

// Compose the dry-run plan. PURE. Selects the first candidate that classifies as a test command,
// then applies the six fairness/safety gates, accumulating an honest blocker for each that fails.
// `eligibleForFutureExecution` is true ONLY when there are zero blockers. Never executes anything;
// `verificationPatchState.canVerifyFinalPatch` is always false (a dry run verifies nothing).
export function buildAgentTestCommandPlan(input: BuildPlanInput): AgentTestCommandPlan {
  const blockers: string[] = [];

  // Patch resolution (gate: the requested patch artifact must exist).
  const patchSha256 = input.patchText === null ? null : sha256(input.patchText);
  if (input.patchText === null) {
    blockers.push(`patch source "${input.patchSource}" artifact not found`);
  }

  // Image key (gate: must be derivable).
  if (input.imagePlan.expectedImageKey === null) {
    blockers.push("image_key_not_computed");
  }

  // Selection: the first candidate that classifies as a test command.
  const selected = input.candidates.find((c) => c.framework !== "unknown") ?? null;

  let commandSafety: CommandSafety;
  let fairProvenance: AgentTestCommandPlan["fairProvenance"];

  if (selected === null) {
    blockers.push("no test command found in command source");
    commandSafety = { allowed: false, reason: "no command selected" };
    fairProvenance = { classification: null, allowedForFairVerification: false, evidence: [] };
  } else {
    commandSafety = classifyCommandSafety(selected.command);
    fairProvenance = {
      classification: selected.provenance.classification,
      allowedForFairVerification: selected.provenance.allowedForFairVerification,
      evidence: [...selected.provenance.evidence],
    };

    // Gate 1: classified as a test command (guaranteed by selection, asserted for completeness).
    if (selected.framework === "unknown") {
      blockers.push("selected command is not a recognized test command");
    }
    // Gates 2 & 3: provenance must be provably agent-owned (not injected_metadata/ambiguous/unknown).
    if (!selected.provenance.allowedForFairVerification) {
      blockers.push(
        `provenance "${selected.provenance.classification}" is not allowed for fair verification`,
      );
    }
    // Gates 4 & 5: safety policy (rejected tokens / shell pipeline).
    if (!commandSafety.allowed) {
      blockers.push(
        commandSafety.diagnosticOnly === true
          ? `command not fair-executable as captured: ${commandSafety.reason}`
          : `command rejected by safety policy: ${commandSafety.reason}`,
      );
    }
    // Gate 6: must have selected tests OR be a framework that runs without explicit selectors.
    if (
      selected.selectedTests.length === 0 &&
      !FRAMEWORKS_RUNNABLE_WITHOUT_SELECTORS.has(selected.framework)
    ) {
      blockers.push(
        `no selected tests and framework "${selected.framework}" needs explicit test selectors`,
      );
    }
  }

  return {
    mode: PLAN_MODE,
    sourceRunLabel: input.sourceRunLabel,
    instanceId: input.instanceId,
    patchSource: input.patchSource,
    patchPath: input.patchPath,
    patchSha256,
    commandSource: input.commandSource,
    selectedCommand: selected?.command ?? null,
    selectedTests: selected ? [...selected.selectedTests] : [],
    commandFramework: selected?.framework ?? null,
    commandSafety,
    fairProvenance,
    verificationPatchState: { canVerifyFinalPatch: false, reason: "dry_run_only" },
    imagePlan: input.imagePlan,
    plannedArtifacts: [...input.plannedArtifacts],
    eligibleForFutureExecution: blockers.length === 0,
    blockers,
  };
}
