import assert from "node:assert/strict";
import { test } from "bun:test";

import { type PatchProbeSummary, type PythonParser, summarizePatch } from "./stage5_patch_probes";
import { type PatchCriticInput, buildDeterministicPatchCriticReport } from "./stage5_patch_critic";
import {
  type CriticCaller,
  type PatchCriticReport,
  DISABLED_META,
  buildCriticArtifacts,
  buildCriticPrompt,
  extractJsonObject,
  liveCriticRunMetaFields,
  parseCriticReport,
  runLiveCritic,
} from "./stage5_patch_critic_live";

const PARSE_OK: PythonParser = () => ({ ok: true });

// requests broad rewrite → deterministic minimality fail → deterministic repair_required=true.
const REQ_BROAD_REWRITE = [
  "diff --git a/requests/models.py b/requests/models.py",
  "--- a/requests/models.py",
  "+++ b/requests/models.py",
  "@@ -394,16 +394,16 @@ class PreparedRequest:",
  "-        if not unicode_is_ascii(host):",
  "-            try:",
  "-                host = self._get_idna_encoded_host(host)",
  "-            except UnicodeError:",
  "-                raise InvalidURL('URL has an invalid label.')",
  "-        elif host.startswith(u'*'):",
  "-            raise InvalidURL('URL has an invalid label.')",
  "-        elif host is None:",
  "-            raise ValueError('host cannot be None')",
  "-        else:",
  "+        if host is None:",
  "+            raise ValueError('host cannot be None')",
  "+        if not unicode_is_ascii(host):",
  "+            host = self._get_idna_encoded_host(host)",
].join("\n");

function inputFor(patch: string, instanceId = "psf__requests-5414", runLabel = "synthetic-req"): PatchCriticInput {
  const probeSummary: PatchProbeSummary = summarizePatch({
    instanceId,
    runLabel,
    patch,
    toolCalls: null,
    stdout: null,
    stderr: null,
    parsePython: PARSE_OK,
  });
  return {
    instanceId,
    runLabel,
    repo: "psf/requests",
    issueText: "URL with empty/invalid IDNA label should raise InvalidURL.",
    firstPatch: patch,
    editedFiles: probeSummary.editedFiles,
    patchChars: probeSummary.patchChars,
    probeSummary,
    treatmentMetadata: { pivotCheckInjected: true, editGuardInjected: false, patchVerifyInjected: null },
    contextSignals: { hiddenPivotsInspected: null, hiddenPivotsEdited: null, orderedToolLogPresent: true },
  };
}

// A valid critic JSON response matching the deterministic verdict (repair_required=true).
function validReportJson(repairRequired: boolean): string {
  return JSON.stringify({
    scope_ok: null,
    scope_evidence: "No inserted method pattern for this instance.",
    failing_behavior_handled: true,
    failing_behavior_evidence: "Patch references empty/idna handling.",
    minimality_ok: !repairRequired,
    minimality_evidence: repairRequired ? "Broad rewrite: many deletions of existing branches." : "Small additive patch.",
    test_evidence_ok: false,
    test_evidence: "No named test command observed.",
    risk: repairRequired ? "high" : "low",
    repair_required: repairRequired,
    repair_reason: repairRequired ? "Broad control-flow rewrite." : "",
    repair_instructions: repairRequired ? "Prefer a minimal additive validation." : "",
    confidence: repairRequired ? "high" : "medium",
    evidence_probe_ids: ["minimality_rewrite_risk"],
  });
}

// A caller that records the prompt it received and returns a canned response.
function mockCaller(response: string, opts: { throws?: boolean } = {}): { caller: CriticCaller; prompts: string[]; calls: number } {
  const prompts: string[] = [];
  let calls = 0;
  const caller: CriticCaller = async (prompt) => {
    calls += 1;
    prompts.push(prompt);
    if (opts.throws) throw new Error("simulated invocation failure");
    return { raw: response, model: "mock-critic", costUsd: 0.01, inputTokens: 1234, outputTokens: 56 };
  };
  return {
    caller,
    prompts,
    get calls() {
      return calls;
    },
  };
}

// ---------------------------------------------------------------------------
// 3. Critic input is built from bounded PatchCriticInput / 4. prompt is strict-JSON, no repair.
// ---------------------------------------------------------------------------
test("buildCriticPrompt asks for strict JSON, forbids repair, and includes bounded probe facts", () => {
  const prompt = buildCriticPrompt(inputFor(REQ_BROAD_REWRITE));
  assert.ok(prompt.includes("Return ONLY valid JSON"));
  assert.ok(/do NOT repair/i.test(prompt));
  assert.ok(prompt.includes("PatchCriticReport"));
  assert.ok(prompt.includes("minimality_rewrite_risk")); // deterministic probe fact included
  assert.ok(prompt.includes("Do not use hidden tests or gold patches"));
  // Bounded: the prompt is not a repo dump; it contains the diff but no extra file bodies.
  assert.ok(prompt.includes("First patch (unified diff):"));
});

// ---------------------------------------------------------------------------
// extractJsonObject tolerates fences/prose around the JSON.
// ---------------------------------------------------------------------------
test("extractJsonObject pulls the first balanced object out of noisy text", () => {
  const noisy = 'Here is the report:\n```json\n{"a": {"b": 1}, "c": "}"}\n```\nDone.';
  const json = extractJsonObject(noisy);
  assert.ok(json !== null);
  assert.deepEqual(JSON.parse(json!), { a: { b: 1 }, c: "}" });
  assert.equal(extractJsonObject("no object here"), null);
});

// ---------------------------------------------------------------------------
// 5. Valid critic JSON is parsed and validated.
// ---------------------------------------------------------------------------
test("parseCriticReport parses + validates a well-formed report", () => {
  const res = parseCriticReport(validReportJson(true), "psf__requests-5414", "synthetic-req", ["minimality_rewrite_risk"]);
  assert.equal(res.ok, true);
  assert.equal(res.report!.repair_required, true);
  assert.equal(res.report!.instanceId, "psf__requests-5414"); // authoritative from args
  // Backfills evidence_probe_ids from known ids when the model omits them.
  const noIds = JSON.parse(validReportJson(true));
  delete noIds.evidence_probe_ids;
  const res2 = parseCriticReport(JSON.stringify(noIds), "psf__requests-5414", "r", ["edited_files", "minimality_rewrite_risk"]);
  assert.equal(res2.ok, true);
  assert.deepEqual(res2.report!.evidence_probe_ids, ["edited_files", "minimality_rewrite_risk"]);
});

test("parseCriticReport rejects invalid output (empty evidence / non-JSON)", () => {
  const badEvidence = JSON.parse(validReportJson(true));
  badEvidence.scope_evidence = "";
  assert.equal(parseCriticReport(JSON.stringify(badEvidence), "i", "r", ["x"]).ok, false);
  assert.equal(parseCriticReport("not json at all", "i", "r", ["x"]).ok, false);
});

// ---------------------------------------------------------------------------
// 1 & 2. Disabled by default: runLiveCritic(enabled:false) calls nothing and stays inert.
// ---------------------------------------------------------------------------
test("runLiveCritic short-circuits when disabled — no caller call, inert meta", async () => {
  const input = inputFor(REQ_BROAD_REWRITE);
  const det = buildDeterministicPatchCriticReport(input);
  const m = mockCaller(validReportJson(true));
  const outcome = await runLiveCritic({ enabled: false, input, deterministicReport: det, caller: m.caller, criticModel: null });
  assert.equal(m.calls, 0); // never called
  assert.deepEqual(outcome.meta, DISABLED_META);
  assert.equal(outcome.report, null);
  assert.equal(outcome.raw, null);
  assert.equal(outcome.prompt, null);
});

// ---------------------------------------------------------------------------
// 8. Deterministic vs live repair agreement is computed.
// ---------------------------------------------------------------------------
test("runLiveCritic computes agreement with the deterministic verdict", async () => {
  const input = inputFor(REQ_BROAD_REWRITE);
  const det = buildDeterministicPatchCriticReport(input);
  assert.equal(det.repair_required, true); // deterministic baseline for requests broad rewrite

  // Agreeing critic.
  const agree = mockCaller(validReportJson(true));
  const oAgree = await runLiveCritic({ enabled: true, input, deterministicReport: det, caller: agree.caller, criticModel: "m" });
  assert.equal(oAgree.meta.validReport, true);
  assert.equal(oAgree.meta.liveRepairRequired, true);
  assert.equal(oAgree.meta.deterministicRepairRequired, true);
  assert.equal(oAgree.meta.agreementWithDeterministic, true);
  assert.equal(oAgree.meta.criticInputTokens, 1234);
  assert.equal(oAgree.meta.criticCostUsd, 0.01);

  // Disagreeing critic (says no repair).
  const disagree = mockCaller(validReportJson(false));
  const oDis = await runLiveCritic({ enabled: true, input, deterministicReport: det, caller: disagree.caller, criticModel: "m" });
  assert.equal(oDis.meta.liveRepairRequired, false);
  assert.equal(oDis.meta.agreementWithDeterministic, false);
});

// ---------------------------------------------------------------------------
// 6. Invalid critic output fails open and leaves modelPatch unchanged.
// ---------------------------------------------------------------------------
test("runLiveCritic fails open on invalid JSON without touching the patch", async () => {
  const input = inputFor(REQ_BROAD_REWRITE);
  const det = buildDeterministicPatchCriticReport(input);
  const m = mockCaller("the model refused to emit JSON");
  const outcome = await runLiveCritic({ enabled: true, input, deterministicReport: det, caller: m.caller, criticModel: "m" });
  assert.equal(outcome.meta.ran, true);
  assert.equal(outcome.meta.validReport, false);
  assert.equal(outcome.meta.failedOpen, true);
  assert.ok(outcome.meta.error && outcome.meta.error.length > 0);
  assert.equal(outcome.report, null);
  assert.equal(m.calls, 2); // one retry on invalid output
  // The patch is the runner's responsibility, but the input the critic saw is unchanged.
  assert.equal(input.firstPatch, REQ_BROAD_REWRITE);
});

test("runLiveCritic fails open immediately on a thrown invocation error (no retry)", async () => {
  const input = inputFor(REQ_BROAD_REWRITE);
  const det = buildDeterministicPatchCriticReport(input);
  const m = mockCaller("", { throws: true });
  const outcome = await runLiveCritic({ enabled: true, input, deterministicReport: det, caller: m.caller, criticModel: "m" });
  assert.equal(outcome.meta.failedOpen, true);
  assert.equal(outcome.meta.validReport, false);
  assert.equal(m.calls, 1); // a hard invocation failure is not retried
  assert.ok(outcome.meta.error!.includes("invocation failed"));
});

// ---------------------------------------------------------------------------
// 7. Critic artifacts are built when enabled (filenames + contents).
// ---------------------------------------------------------------------------
test("buildCriticArtifacts emits the expected files including _first_patch.diff", async () => {
  const input = inputFor(REQ_BROAD_REWRITE);
  const det = buildDeterministicPatchCriticReport(input);
  const m = mockCaller(validReportJson(true));
  const outcome = await runLiveCritic({ enabled: true, input, deterministicReport: det, caller: m.caller, criticModel: "m" });
  const artifacts = buildCriticArtifacts({ input, outcome });
  for (const name of [
    "_patch_critic_input.json",
    "_patch_critic_report.json",
    "_patch_critic.raw.txt",
    "_patch_critic.meta.json",
    "_first_patch.diff",
  ]) {
    assert.ok(name in artifacts, `missing artifact ${name}`);
  }
  // The first-patch artifact is byte-faithful to the original patch.
  assert.ok(artifacts["_first_patch.diff"]!.startsWith("diff --git a/requests/models.py"));
  // The meta artifact carries the run-meta projection.
  const meta = JSON.parse(artifacts["_patch_critic.meta.json"]!);
  assert.equal(meta.runMetaFields.vtracePatchCriticEnabled, true);
  assert.equal(meta.runMetaFields.vtracePatchCriticRepairRequired, true);
});

// ---------------------------------------------------------------------------
// 9. Missing critic metadata reads as unknown/null (run-meta projection on disabled).
// ---------------------------------------------------------------------------
test("liveCriticRunMetaFields on disabled meta reads as not-enabled with null repair", () => {
  const fields = liveCriticRunMetaFields(DISABLED_META);
  assert.equal(fields.vtracePatchCriticEnabled, false);
  assert.equal(fields.vtracePatchCriticRan, false);
  assert.equal(fields.vtracePatchCriticRepairRequired, null);
  assert.equal(fields.vtracePatchCriticAgreementWithDeterministic, null);
});

// ---------------------------------------------------------------------------
// 10. Unit tests never call a live model — sanity: a report type round-trips.
// ---------------------------------------------------------------------------
test("a parsed report is a usable PatchCriticReport (type round-trip, no live model)", () => {
  const res = parseCriticReport(validReportJson(false), "psf__requests-5414", "r", ["minimality_rewrite_risk"]);
  const report: PatchCriticReport | null = res.report;
  assert.ok(report !== null);
  assert.equal(report!.repair_required, false);
});
