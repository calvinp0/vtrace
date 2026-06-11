import assert from "node:assert/strict";
import { test } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { analyzePatchMinimality } from "../../src/capsule/patchMinimalityProbes";
import {
  ASTROPY_PROTOCOL_RUN_LABEL,
  buildReport,
  buildSummary,
  loadFinding,
  parseArgs,
  recommendedNextStep,
  renderJson,
  renderMarkdown,
  type RunFinding,
} from "./run_stage5_patch_minimality_probe_report";

// ---------------------------------------------------------------------------
// Synthetic patches (no live artifacts).
// ---------------------------------------------------------------------------

const ASTROPY_BROAD = [
  "diff --git a/astropy/units/format/cds.py b/astropy/units/format/cds.py",
  "--- a/astropy/units/format/cds.py",
  "+++ b/astropy/units/format/cds.py",
  "@@ -164,12 +164,8 @@ class CDS(Base):",
  "         def p_combined_units(p):",
  "             \"\"\"",
  "-            combined_units : product_of_units",
  "-                           | division_of_units",
  "-            \"\"\"",
  "-        def p_division_of_units(p):",
  "-            \"\"\"",
  "-            division_of_units : DIVISION unit_expression",
  "+            combined_units : combined_units DIVISION unit_expression",
  "+                           | unit_expression",
  "             \"\"\"",
  "diff --git a/astropy/units/format/cds_lextab.py b/astropy/units/format/cds_lextab.py",
  "deleted file mode 100644",
  "--- a/astropy/units/format/cds_lextab.py",
  "+++ /dev/null",
  "@@ -1,1 +0,0 @@",
  "-# generated",
  "diff --git a/astropy/units/format/cds_parsetab.py b/astropy/units/format/cds_parsetab.py",
  "deleted file mode 100644",
  "--- a/astropy/units/format/cds_parsetab.py",
  "+++ /dev/null",
  "@@ -1,1 +0,0 @@",
  "-# generated",
].join("\n");

const ORDINARY = [
  "diff --git a/requests/models.py b/requests/models.py",
  "--- a/requests/models.py",
  "+++ b/requests/models.py",
  "@@ -5,3 +5,3 @@ class PreparedRequest:",
  "-        host = a",
  "+        host = b",
].join("\n");

function findingFrom(runLabel: string, instanceId: string, resolved: boolean | null, patch: string): RunFinding {
  return {
    runLabel,
    instanceId,
    resolved,
    patchFilesChanged: patch.split("\n").filter((l) => l.startsWith("+++ b/")).map((l) => l.slice(6)),
    probe: analyzePatchMinimality(patch),
  };
}

function syntheticFindings(): RunFinding[] {
  return [
    findingFrom(ASTROPY_PROTOCOL_RUN_LABEL, "astropy__astropy-14369", false, ASTROPY_BROAD),
    findingFrom("eval-editguard-before-requests-5414", "psf__requests-5414", true, ORDINARY),
  ];
}

// ---------------------------------------------------------------------------
// 10. Report emits required Markdown sections.
// ---------------------------------------------------------------------------
test("markdown has all required sections", () => {
  const md = renderMarkdown(buildReport("t", syntheticFindings()));
  for (const heading of [
    "# Stage 5 patch minimality probe report",
    "## Summary",
    "## Runs analyzed",
    "## Generated-parser findings",
    "## Astropy protocol finding",
    "## Probe signals",
    "## Recommended next step",
    "## Non-claims",
  ]) {
    assert.ok(md.includes(heading), `missing section: ${heading}`);
  }
  // Required interpretation for the Astropy protocol run.
  assert.ok(md.includes("generated_parser_broad_rewrite"));
  assert.ok(md.includes("grammar_patch_minimality"));
  assert.ok(md.toLowerCase().includes("deletes generated parser table"));
  assert.ok(md.toLowerCase().includes("relocates grammar productions"));
  // Recommended next step wires into the live critic, observation-only.
  assert.ok(md.toLowerCase().includes("live critic"));
  assert.ok(md.toLowerCase().includes("observation-only"));
  assert.ok(md.toLowerCase().includes("do not auto-repair"));
});

// ---------------------------------------------------------------------------
// 11. Report emits required JSON fields.
// ---------------------------------------------------------------------------
test("json has the required shape and per-run fields", () => {
  const parsed = JSON.parse(renderJson(buildReport("t", syntheticFindings())));
  for (const key of ["generatedAt", "summary", "findings", "nonClaims"]) {
    assert.ok(key in parsed, `missing top-level key: ${key}`);
  }
  for (const key of ["runsAnalyzed", "runsRepairRequired", "runsHighRisk", "runsWithGeneratedParserFindings"]) {
    assert.ok(key in parsed.summary, `missing summary key: ${key}`);
  }
  const protocol = parsed.findings.find((f: RunFinding) => f.runLabel === ASTROPY_PROTOCOL_RUN_LABEL);
  for (const key of ["runLabel", "instanceId", "resolved", "patchFilesChanged", "probe"]) {
    assert.ok(key in protocol, `missing finding key: ${key}`);
  }
  for (const key of [
    "repairRequired",
    "defectClass",
    "risk",
    "confidence",
    "reasons",
    "signals",
    "affectedFiles",
    "generatedFilesDeleted",
    "grammarFunctionsChanged",
    "grammarFunctionsRemoved",
    "sourceGrammarFilesChanged",
    "broadRewriteDetected",
  ]) {
    assert.ok(key in protocol.probe, `missing probe key: ${key}`);
  }
  // Required non-claims are all present.
  for (const claim of [
    "This report does not re-run agents or Docker.",
    "This report does not modify patches.",
    "This report does not make repair automatic.",
    "This report does not prove the generated-parser probe generalizes to all parser systems.",
    "This report does not change Stage 5 policy accounting.",
  ]) {
    assert.ok(parsed.nonClaims.includes(claim), `missing non-claim: ${claim}`);
  }
});

// ---------------------------------------------------------------------------
// Summary math: the Astropy protocol run is high-risk + repairRequired; requests is silent.
// ---------------------------------------------------------------------------
test("summary counts high-risk / repair-required / parser findings", () => {
  const summary = buildSummary(syntheticFindings());
  assert.equal(summary.runsAnalyzed, 2);
  assert.equal(summary.runsHighRisk, 1);
  assert.equal(summary.runsRepairRequired, 1);
  assert.equal(summary.runsWithGeneratedParserFindings, 1);
});

test("recommendedNextStep wires the probe into the live critic, observation-only", () => {
  const step = recommendedNextStep().toLowerCase();
  assert.ok(step.includes("live critic"));
  assert.ok(step.includes("observation-only"));
  assert.ok(step.includes("do not auto-repair"));
  // Does not recommend another Astropy run / always-on repair / ranking changes.
  assert.ok(!/re-?run/.test(step));
});

// ---------------------------------------------------------------------------
// 9. Report reads existing Stage 5 JSONL patches without running agents/Docker.
// 12. No Docker/model/agent calls occur — loadFinding only reads a JSONL from disk.
// ---------------------------------------------------------------------------
test("loadFinding reads a swebench JSONL patch from disk with no agents/Docker", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "stage5-minimality-"));
  try {
    const vtraceDir = path.join(dir, "runs", "eval-fake-astropy-14369", "raw", "vtrace");
    await mkdir(vtraceDir, { recursive: true });
    const record = {
      instanceId: "astropy__astropy-14369",
      resolved: false,
      modelPatch: ASTROPY_BROAD,
    };
    await writeFile(path.join(vtraceDir, "swebench-2026-06-11.jsonl"), `${JSON.stringify(record)}\n`);

    const finding = await loadFinding(dir, "eval-fake-astropy-14369");
    assert.ok(finding);
    assert.equal(finding!.instanceId, "astropy__astropy-14369");
    assert.equal(finding!.resolved, false);
    assert.equal(finding!.probe.defectClass, "generated_parser_broad_rewrite");
    assert.equal(finding!.probe.repairRequired, true);
    assert.ok(finding!.probe.generatedFilesDeleted.length >= 2);

    // A run dir that does not exist returns null (skipped, not thrown).
    assert.equal(await loadFinding(dir, "no-such-run"), null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("parseArgs honors --results and --out-name with defaults", () => {
  assert.deepEqual(parseArgs([]), {
    resultsDir: "benchmarks/stage5_vexp_swe_bench_smoke/results",
    outName: "stage5_patch_minimality_probe_report",
  });
  assert.deepEqual(parseArgs(["--results", "r", "--out-name", "o"]), { resultsDir: "r", outName: "o" });
  assert.throws(() => parseArgs(["--bogus"]));
});
