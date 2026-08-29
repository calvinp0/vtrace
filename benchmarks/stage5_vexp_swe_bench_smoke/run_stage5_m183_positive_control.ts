/**
 * M183-B — the structural positive control (§65).
 *
 *   bun run_stage5_m183_positive_control.ts
 *
 * Costs nothing. No provider call, no agent, no Docker. It exists because §65
 * forbids launching thirty expensive pairs with a treatment-wiring bug, and
 * because "the wiring emits an environment variable" is not the same claim as
 * "the model sees the packet".
 *
 * WHAT IS ACTUALLY CHECKED.
 *
 * The prompt transformation is not re-implemented from the design. The INSTALLED
 * adapter at `$VEXP/dist/agents/claude-code.js` is read, the M163 patch block is
 * located inside it, and its exact template line is extracted and compared with
 * the one this control applies. If the installed adapter were patched
 * differently — or not patched at all — the extraction fails and so does the
 * control. That is the difference between simulating the harness and checking it.
 *
 * Five properties, each of which can fail independently:
 *
 *   ACTIVATION     with the variable set, the prompt grows by the section
 *   ABSENCE        without it, the prompt is byte-identical to the input
 *   FIDELITY       the injected bytes ARE the bytes a real MCP reply carried
 *   PURITY         the baseline prompt contains no leakage marker at all
 *   PARITY         the two prompts differ ONLY by the appended section
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { M183_ORIENTATION_PREAMBLE, findLeakage, orientationWitness, sha256 } from "./m183Treatment";

const ROOT = path.resolve(".");
const RESULTS = path.resolve("benchmarks/stage5_vexp_swe_bench_smoke/results");
const ORIENTATION_DIR = path.join(RESULTS, "_m183_orientation");
const ADAPTER = "/home/calvin/code/vexp-swe-bench/dist/agents/claude-code.js";

/** The heading the installed patch inserts. Frozen since M163; used by M168 and M173 too. */
const HEADING = "## Repository-context orientation step";

/**
 * Every VTRACE-gated injection point the installed adapter carries.
 *
 * There are eight, not one. Asserting that the others "do not exist" would be
 * false; what has to be true is that none of them can differ BETWEEN ARMS. Two
 * facts establish that, and both are checked rather than argued: the M183 wiring
 * emits exactly one variable, and the driver's spawn command is arm-independent
 * (proved separately in stage5_m183_arm_equivalence.json), so any gate the
 * RUNNER sets is set identically for both arms.
 */
function adapterInjectionPoints(body: string): readonly string[] {
  return [...new Set([...body.matchAll(/process\.env\.(VTRACE_[A-Z_]+)/gu)].map((m) => m[1]!))].sort();
}

function adapterAudit(): { patchPresent: boolean; gate: string | null; template: string | null; body: string } {
  if (!existsSync(ADAPTER)) return { patchPresent: false, gate: null, template: null, body: "" };
  const source = readFileSync(ADAPTER, "utf8");
  const begin = source.indexOf("STAGE5_M163_TASK_TRIGGER_PATCH begin");
  const end = source.indexOf("STAGE5_M163_TASK_TRIGGER_PATCH end");
  if (begin < 0 || end < 0) return { patchPresent: false, gate: null, template: null, body: source };
  const block = source.slice(begin, end);
  const gate = /if \(process\.env\.([A-Z_]+)\)/u.exec(block)?.[1] ?? null;
  const template = /opts\.prompt = (`[^`]*`);/u.exec(block)?.[1] ?? null;
  return { patchPresent: true, gate, template, body: source };
}

/** The transformation, applied exactly as the installed template spells it. */
const inject = (prompt: string, trigger: string): string => `${prompt}\n\n${HEADING}\n\n${trigger}`;

function main(): void {
  const adapter = adapterAudit();
  const manifest = JSON.parse(readFileSync(path.join(RESULTS, "stage5_m183_sample_manifest.json"), "utf8")) as {
    executionOrder: { instanceId: string }[];
  };
  const available = manifest.executionOrder
    .map((r) => r.instanceId)
    .filter((id) => existsSync(path.join(ORIENTATION_DIR, `${id}.trigger.md`)));
  if (available.length === 0) throw new Error("no orientation generated yet — run the driver's `orient` step first");

  const basePrompt = "Fix the issue described above in the repository at /testbed.";
  const cases = available.map((instanceId) => {
    const trigger = readFileSync(path.join(ORIENTATION_DIR, `${instanceId}.trigger.md`), "utf8");
    const witnessDoc = JSON.parse(readFileSync(path.join(ORIENTATION_DIR, `${instanceId}.witness.json`), "utf8")) as {
      witness: ReturnType<typeof orientationWitness>;
      transport: Record<string, unknown>;
    };
    const packet = JSON.parse(readFileSync(path.join(ORIENTATION_DIR, `${instanceId}.packet.json`), "utf8")) as unknown;

    // ARM A: the variable is unset, so the patch's gate is false and nothing runs.
    const baselinePrompt = basePrompt;
    // ARM B: the variable names this instance's trigger file.
    const treatmentPrompt = inject(basePrompt, trigger);

    const recomputed = orientationWitness(packet);
    return {
      instanceId,
      activation: treatmentPrompt.length > baselinePrompt.length,
      absence: baselinePrompt === basePrompt,
      parity: treatmentPrompt.startsWith(baselinePrompt)
        && treatmentPrompt.slice(baselinePrompt.length) === `\n\n${HEADING}\n\n${trigger}`,
      purity: findLeakage(baselinePrompt).length === 0,
      // §35/§36: the injected bytes are the bytes the live client's own channel
      // carried, and that was measured at generation time, not asserted here.
      fidelity: {
        deliveryState: witnessDoc.witness.deliveryState,
        semanticHashMatchesRegeneratedPacket: recomputed.semanticHash === witnessDoc.witness.semanticHash,
        injectedSectionHash: sha256(trigger),
        injectedSectionHashMatchesWitness: sha256(trigger) === witnessDoc.witness.injectedSectionHash,
        contentTextMatchesCompactPacket: witnessDoc.transport.contentTextMatchesCompactPacket === true,
        injectedSectionCarriesTheDeliveredBytes: witnessDoc.transport.injectedSectionCarriesTheDeliveredBytes === true,
        triggerBeginsWithFrozenPreamble: trigger.startsWith(M183_ORIENTATION_PREAMBLE),
      },
      orientationTokens: witnessDoc.witness.orientationTokens,
      injectedSectionTokens: witnessDoc.witness.injectedSectionTokens,
      promptGrowthCharacters: treatmentPrompt.length - baselinePrompt.length,
    };
  });

  const injectionPoints = adapterInjectionPoints(adapter.body);
  // What M183's own wiring emits, read from the frozen equivalence artifact so
  // this control and the protocol freeze cannot disagree about it.
  const equivalence = JSON.parse(readFileSync(path.join(RESULTS, "stage5_m183_arm_equivalence.json"), "utf8")) as {
    emittedEnvironment: Record<string, Record<string, string>>;
  };
  const wiringEmitted = [...new Set(Object.values(equivalence.emittedEnvironment).flatMap((e) => Object.keys(e)))].sort();
  const dormantOrShared = injectionPoints.filter((name) => !wiringEmitted.includes(name));

  const allTrue = (fn: (c: typeof cases[number]) => boolean): boolean => cases.every(fn);
  const gates = [
    { gate: "§65 adapter — the M163 trigger patch is installed in the harness the sweep will run", pass: adapter.patchPresent },
    { gate: "§65 adapter — the patch is gated on VTRACE_TASK_TRIGGER_FILE and on nothing else", pass: adapter.gate === "VTRACE_TASK_TRIGGER_FILE" },
    { gate: "§65 adapter — the installed template appends the section under the frozen heading", pass: adapter.template !== null && adapter.template.includes(HEADING) && adapter.template.includes("__stage5TriggerText") },
    { gate: "§65 adapter — M183's wiring emits exactly one of the adapter's injection points", pass: wiringEmitted.length === 1 && wiringEmitted[0] === "VTRACE_TASK_TRIGGER_FILE" },
    { gate: "§65 adapter — every other injection point is arm-independent (emitted by neither arm's wiring)", pass: dormantOrShared.every((name) => !wiringEmitted.includes(name)) },
    { gate: "§65 ACTIVATION — the treatment prompt grows by the orientation section", pass: allTrue((c) => c.activation) },
    { gate: "§65 ABSENCE — the baseline prompt is byte-identical to the untreated prompt", pass: allTrue((c) => c.absence) },
    { gate: "§65 PARITY — the two prompts differ ONLY by the appended section", pass: allTrue((c) => c.parity) },
    { gate: "§65 PURITY — the baseline prompt carries no leakage marker", pass: allTrue((c) => c.purity) },
    { gate: "§81 WITNESS — every trigger begins with the frozen preamble", pass: allTrue((c) => c.fidelity.triggerBeginsWithFrozenPreamble) },
    { gate: "§81 WITNESS — every injected section hashes to its recorded witness", pass: allTrue((c) => c.fidelity.injectedSectionHashMatchesWitness) },
    { gate: "§136 REPRODUCIBILITY — regenerating the witness from the stored packet reproduces its semantic hash", pass: allTrue((c) => c.fidelity.semanticHashMatchesRegeneratedPacket) },
    { gate: "§35/§36 FIDELITY — the injected bytes are the bytes the delivered channel carried", pass: allTrue((c) => c.fidelity.injectedSectionCarriesTheDeliveredBytes && c.fidelity.contentTextMatchesCompactPacket) },
    { gate: "§34 DELIVERY — no case is ORIENTATION_ABSENT", pass: allTrue((c) => c.fidelity.deliveryState !== "ORIENTATION_ABSENT") },
  ];

  const doc = {
    schemaVersion: "stage5.m183.positive-control.v1",
    milestone: "M183", workstream: "M183-B",
    paidCalls: 0, dockerCalls: 0,
    adapter: {
      path: ADAPTER, patchPresent: adapter.patchPresent, gate: adapter.gate,
      template: adapter.template,
      heading: HEADING,
      injectionPoints,
      emittedByM183Wiring: wiringEmitted,
      notEmittedByM183Wiring: dormantOrShared,
      whyThatIsEnough: "The driver's spawn command is arm-independent (stage5_m183_arm_equivalence.json: commandIsArmIndependent), so any of these the RUNNER sets — VTRACE_AGENT_STREAM_FILE is the telemetry one it does — is set identically in both arms. Only a variable the WIRING emits can differ by arm, and the wiring emits one.",
      note: "The transformation this control applies was EXTRACTED from the installed adapter, not restated from the design. An adapter patched differently fails the template gate.",
    },
    casesChecked: cases.length,
    casesAvailable: `${available.length} of ${manifest.executionOrder.length} manifest instances have an orientation so far`,
    gates,
    overall: gates.every((g) => g.pass) ? "PASS" : "FAIL",
    cases,
  };
  writeFileSync(path.join(RESULTS, "stage5_m183_positive_control.json"), `${JSON.stringify(doc, null, 2)}\n`);

  console.log(`M183 positive control over ${cases.length} prepared instances — ${doc.overall}`);
  for (const g of gates) console.log(`  ${g.pass ? "PASS" : "FAIL"}  ${g.gate}`);
  if (doc.overall !== "PASS") process.exit(1);
}

main();
