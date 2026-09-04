/**
 * M216 §59 — the DOCKER_SWEBENCH binding's status, DERIVED.
 *
 * M215 wrote `status: "DECLARED_UNIMPLEMENTED"` as a literal, which was honest
 * then and would be dangerous now: flipping a string to "IMPLEMENTED" is exactly
 * the hand-set readiness §59 forbids, and it would let a future edit that broke
 * every adapter leave the gate table green.
 *
 * So the status is a function of two facts that can each be false:
 *
 *   1. the three production adapter constructors exist,
 *   2. a real-substrate evidence document exists, its controls all passed, it
 *      actually started containers, it touched no frozen task, and it spent $0.
 *
 * Delete the evidence, break a control, or remove an adapter and the binding
 * returns to DECLARED_UNIMPLEMENTED, G35 fails, and the launcher refuses. That
 * is the property that makes F41–F43 falsifiable rather than decorative.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import {
  M216AgentAdapter,
  M216ContainerAdapter,
  M216EvaluatorAdapter,
} from "./m216ProductionAdapters";

export const M216_REAL_SUBSTRATE_EVIDENCE_FILE = "stage5_m216_real_substrate.json" as const;

export interface AdapterConstructors {
  readonly container: unknown;
  readonly agent: unknown;
  readonly evaluator: unknown;
}

export const M216_PRODUCTION_ADAPTERS: AdapterConstructors = Object.freeze({
  container: M216ContainerAdapter,
  agent: M216AgentAdapter,
  evaluator: M216EvaluatorAdapter,
});

export interface RealSubstrateEvidence {
  readonly suitePasses: boolean;
  readonly controlCount: number;
  readonly satisfied: number;
  readonly failures: readonly string[];
  readonly guardFiresControls: number;
  readonly guardSilentControls: number;
  readonly containersStarted: number;
  readonly containersTornDown: number;
  readonly frozenInstancesTouched: readonly string[];
  readonly nonFrozenInstancesTouched: readonly string[];
  readonly liveModelSpendUsd: number;
  readonly providerCalls: number;
}

export interface BindingExerciseEvidence {
  readonly exercised: boolean;
  readonly adaptersPresent: boolean;
  readonly evidencePresent: boolean;
  readonly evidence: RealSubstrateEvidence | null;
  readonly reasons: readonly string[];
}

function isConstructor(candidate: unknown): boolean {
  return typeof candidate === "function" && candidate.prototype !== undefined;
}

/**
 * Whether the real substrate binding has been implemented AND run.
 *
 * "Implemented" alone is not the bar M215 set. Its whole closing argument was
 * that shipping a binding nothing had executed would let a future operator
 * believe it had been verified, so this function requires the evidence of an
 * actual exercise and reports which half is missing.
 */
export function dockerSwebenchBindingEvidence(options: {
  readonly resultsDir?: string;
  readonly adapters?: Partial<AdapterConstructors>;
} = {}): BindingExerciseEvidence {
  const reasons: string[] = [];
  const adapters = { ...M216_PRODUCTION_ADAPTERS, ...options.adapters };
  const missing = (["container", "agent", "evaluator"] as const)
    .filter((name) => !isConstructor(adapters[name]));
  for (const name of missing) {
    reasons.push(`production ${name} adapter is absent; the binding cannot produce an outcome`);
  }
  const adaptersPresent = missing.length === 0;

  const resultsDir = options.resultsDir ?? join(import.meta.dir, "results");
  const path = join(resultsDir, M216_REAL_SUBSTRATE_EVIDENCE_FILE);
  if (!existsSync(path)) {
    reasons.push(
      `no real-substrate evidence at ${M216_REAL_SUBSTRATE_EVIDENCE_FILE}; a binding nothing has `
      + "run is not a binding that has been verified",
    );
    return {
      exercised: false, adaptersPresent, evidencePresent: false, evidence: null,
      reasons: Object.freeze(reasons),
    };
  }

  let evidence: RealSubstrateEvidence;
  try {
    evidence = JSON.parse(readFileSync(path, "utf8")) as RealSubstrateEvidence;
  } catch (error) {
    reasons.push(`real-substrate evidence is unreadable: ${(error as Error).message}`);
    return {
      exercised: false, adaptersPresent, evidencePresent: false, evidence: null,
      reasons: Object.freeze(reasons),
    };
  }

  if (!evidence.suitePasses) {
    reasons.push(`real-substrate controls failed: ${evidence.failures.join(", ") || "unnamed"}`);
  }
  if (evidence.satisfied !== evidence.controlCount) {
    reasons.push(
      `${evidence.satisfied}/${evidence.controlCount} real-substrate controls satisfied`,
    );
  }
  if (evidence.containersStarted <= 0) {
    reasons.push("no real container was started; the binding was declared, not exercised");
  }
  if (evidence.frozenInstancesTouched.length > 0) {
    reasons.push(
      `the real substrate touched frozen tasks outside a cohort: `
      + `${evidence.frozenInstancesTouched.join(", ")}`,
    );
  }
  if (evidence.liveModelSpendUsd !== 0 || evidence.providerCalls !== 0) {
    reasons.push(
      `the exercise was not zero-spend: ${evidence.providerCalls} provider calls, `
      + `$${evidence.liveModelSpendUsd}`,
    );
  }

  return {
    exercised: adaptersPresent && reasons.length === 0,
    adaptersPresent,
    evidencePresent: true,
    evidence,
    reasons: Object.freeze(reasons),
  };
}
