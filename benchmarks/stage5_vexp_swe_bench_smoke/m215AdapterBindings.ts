/**
 * M215 §44, §60 — how the executor is bound to a substrate, and which bindings
 * exist.
 *
 * The executor takes containers, the agent and the evaluator as interfaces.
 * That is what made the whole enforcement layer falsifiable at zero cost, and
 * it is also where the milestone's honest residual lives: exactly one binding
 * is implemented, and it is the synthetic one.
 *
 * The alternative was to write a Docker + Claude-Code-CLI + swebench binding
 * that nothing in this milestone could run — no container was started, no
 * provider was contacted, no evaluation image was pulled — and to report the
 * executor as ready on the strength of code that had never executed. M213 and
 * M214 both refused that trade for their own blockers, and a $700 cohort is not
 * the place to start making it.
 *
 * So the gap is a named gate with an address rather than a hole spread across
 * the readiness table: `DOCKER_SWEBENCH` is DECLARED and UNIMPLEMENTED, the
 * launcher refuses it, and the work it names is written down.
 *
 * M216 UPDATE. The binding now exists, and its status is no longer a literal.
 * Writing "IMPLEMENTED" by hand would be the hand-set readiness §59 forbids —
 * an edit that broke every adapter would leave the gate green — so the status is
 * DERIVED from `dockerSwebenchBindingEvidence`: the three production adapter
 * constructors must exist, and a real-substrate evidence document must show the
 * controls passing, containers actually started, no frozen task touched and $0
 * spent. Remove any of those and the binding falls back to
 * DECLARED_UNIMPLEMENTED and the launcher refuses again.
 */

import type { AgentAdapter, ContainerAdapter, EvaluatorAdapter } from "./m215LaunchExecutor";
import { type BindingExerciseEvidence, dockerSwebenchBindingEvidence } from "./m216BindingEvidence";

export type BindingId = "SYNTHETIC" | "DOCKER_SWEBENCH";

export type BindingStatus = "IMPLEMENTED" | "DECLARED_UNIMPLEMENTED";

export interface AdapterBinding {
  readonly id: BindingId;
  readonly status: BindingStatus;
  /** Whether a binding may produce authoritative COHORT outcomes. */
  readonly authoritative: boolean;
  readonly description: string;
  readonly outstandingWork: readonly string[];
  readonly inheritedFrom: readonly string[];
}

/**
 * The reason DOCKER_SWEBENCH is not implemented, when it is not.
 *
 * Kept as a function rather than a snapshot so the readiness report can say
 * WHICH half is missing — no adapter, or an adapter nothing ran — instead of
 * reporting the same sentence for two different problems.
 */
export function dockerSwebenchEvidence(): BindingExerciseEvidence {
  return dockerSwebenchBindingEvidence();
}

export const M215_ADAPTER_BINDINGS: readonly AdapterBinding[] = Object.freeze([
  Object.freeze({
    id: "SYNTHETIC",
    status: "IMPLEMENTED",
    authoritative: false,
    description:
      "Deterministic in-process stand-ins for the container, the agent and the evaluator. Every "
      + "gate, ordering rule, ledger write and patch-capture derivation on the paid path is the "
      + "same code this binding exercises; only the three expensive things are replaced.",
    outstandingWork: [],
    inheritedFrom: ["M215 m215Fixtures.ts"],
  }),
  Object.freeze({
    id: "DOCKER_SWEBENCH",
    status: (dockerSwebenchBindingEvidence().exercised
      ? "IMPLEMENTED"
      : "DECLARED_UNIMPLEMENTED") as BindingStatus,
    authoritative: true,
    description:
      "The real substrate: one swebench==4.1.0 per-instance evaluation image per task, a headless "
      + "Claude Code CLI process per run, and the official evaluator. Implemented in M216 over "
      + "M193's container authority, M193C's patch-snapshot authority and M194's launch and "
      + "evaluation paths, through one JSON substrate boundary that carries operations only.",
    outstandingWork: dockerSwebenchBindingEvidence().exercised ? [] : [
      "ContainerAdapter over M193's container authority (m193_container_adapter.py): image pull, "
      + "single bind-mounted tree, authoritative reset to the frozen base commit, tracked-source "
      + "digest, and the pre-agent untracked snapshot at DIRECTORY granularity",
      "AgentAdapter over the pinned Claude Code CLI: stream-json parsing for the provider init "
      + "event (the model-identity gate's only authoritative input), ordered tool/shell/edit "
      + "telemetry, turn accounting and provider-reported cost",
      "EvaluatorAdapter over swebench==4.1.0 run_evaluation, returning the raw result and an exit "
      + "status distinct from 'the task was unresolved'",
      "A zero-cost Docker smoke that starts one image, resets, snapshots and captures an empty "
      + "patch, on a task OUTSIDE the frozen 100, before any paid row is attempted",
      "M193's five audited instrument defects re-checked against this binding, including the .pyc "
      + "staleness that once hid an edit",
    ],
    inheritedFrom: [
      "m193_container_adapter.py", "m193c_patch_snapshot.py", "run_stage5_m194_acquire.py",
      "m193aArmEnvironment.ts", "m216_substrate_bridge.py", "m216ProductionAdapters.ts",
    ],
  }),
]);

export function bindingFor(id: BindingId): AdapterBinding {
  const binding = M215_ADAPTER_BINDINGS.find((entry) => entry.id === id);
  if (binding === undefined) throw new Error(`unknown adapter binding: ${id}`);
  return binding;
}

export class BindingUnavailableError extends Error {
  constructor(binding: AdapterBinding, reasons: readonly string[] = []) {
    super(
      `adapter binding ${binding.id} is ${binding.status}, so it cannot produce an authoritative `
      + `cohort outcome. ${reasons.length > 0 ? `Why: ${reasons.join("; ")}. ` : ""}`
      + `Outstanding: ${binding.outstandingWork.join("; ") || "(none recorded)"}`,
    );
    this.name = "BindingUnavailableError";
  }
}

export interface ResolvedAdapters {
  readonly container: ContainerAdapter;
  readonly agent: AgentAdapter;
  readonly evaluator: EvaluatorAdapter;
}

/**
 * Fail closed on an unimplemented binding.
 *
 * The refusal is a throw rather than a fallback to the synthetic adapters,
 * because a cohort that silently ran against fakes would produce a full ledger,
 * a complete N and an entirely fictional result.
 */
export function assertBindingUsable(id: BindingId): AdapterBinding {
  const binding = bindingFor(id);
  if (binding.status !== "IMPLEMENTED") {
    throw new BindingUnavailableError(
      binding, id === "DOCKER_SWEBENCH" ? dockerSwebenchBindingEvidence().reasons : [],
    );
  }
  return binding;
}

/** Whether any binding capable of producing authoritative outcomes exists yet. */
export function authoritativeBindingAvailable(): boolean {
  return M215_ADAPTER_BINDINGS.some(
    (binding) => binding.authoritative && binding.status === "IMPLEMENTED",
  );
}
