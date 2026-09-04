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
 */

import type { AgentAdapter, ContainerAdapter, EvaluatorAdapter } from "./m215LaunchExecutor";

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
    status: "DECLARED_UNIMPLEMENTED",
    authoritative: true,
    description:
      "The real substrate: one swebench==4.1.0 per-instance evaluation image per task, a headless "
      + "Claude Code CLI process per run, and the official evaluator. Not implemented in M215 and "
      + "therefore not verified by anything in it.",
    outstandingWork: [
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
    ],
  }),
]);

export function bindingFor(id: BindingId): AdapterBinding {
  const binding = M215_ADAPTER_BINDINGS.find((entry) => entry.id === id);
  if (binding === undefined) throw new Error(`unknown adapter binding: ${id}`);
  return binding;
}

export class BindingUnavailableError extends Error {
  constructor(binding: AdapterBinding) {
    super(
      `adapter binding ${binding.id} is ${binding.status}. M215 built and falsified the executor `
      + "and its enforcement; it did not implement this binding, and nothing in M215 exercised it. "
      + `Outstanding: ${binding.outstandingWork.join("; ")}`,
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
  if (binding.status !== "IMPLEMENTED") throw new BindingUnavailableError(binding);
  return binding;
}

/** Whether any binding capable of producing authoritative outcomes exists yet. */
export function authoritativeBindingAvailable(): boolean {
  return M215_ADAPTER_BINDINGS.some(
    (binding) => binding.authoritative && binding.status === "IMPLEMENTED",
  );
}
