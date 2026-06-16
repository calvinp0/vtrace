// Offline audit for the M13 structured pivot-inspection COMPLIANCE checker.
//
// Deterministic, no live agents, no Docker, no 30/100-case runs, no
// retrieval/scoring/ranking/candidate-gen change. It audits the ALREADY-captured
// M12.1 enforcement runs (eval-m12-pivot-enforcement-current-*). For each run it:
//   1. rebuilds the capsule with CURRENT code from that run's captured
//      `.vtrace/index.sqlite` (task replayed from `_run.meta.json`), giving the same
//      pivot inspection contract + actionability hints the runner used,
//   2. reads the run's final patch (`modelPatch`) → files edited,
//   3. reads the run's ordered tool-call telemetry (`_tool_calls.json`) → files
//      inspected,
//   4. computes the pivot inspection compliance verdict
//      (`computePivotInspectionCompliance`) and the corrective-prompt content
//      (`buildCorrectivePrompt`).
//
// It reports, per run: required candidates, edited / ruled-out / missing / unclear,
// whether a corrective prompt would fire, the expected corrective-prompt content, and
// the risk. This is Option B (finalize-time static check): the checker produces a
// verdict + the corrective-prompt text but does NOT send a live corrective turn — the
// external SWE-bench harness owns the turn loop and final-patch extraction.
//
// IMPORTANT: model prose is NOT captured in these run artifacts, so an explicit
// source-grounded rule-out cannot be observed; an inspected-but-not-edited candidate
// is reported `unclear` (conservative), and a never-inspected one `missing`.
//
// Run: bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m13_pivot_loop_audit.ts

import { Glob } from "bun";
import path from "node:path";

import { openIndexerDatabase } from "../../src/db/sqlite";
import { buildCapsuleV2 } from "../../src/capsuleV2/buildCapsuleV2";
import { CapsuleIntent } from "../../src/capsuleV2/types";
import { buildPivotInspectionContract } from "../../src/capsuleV2/pivotInspectionContract";
import {
  computePivotInspectionCompliance,
  buildCorrectivePrompt,
  parsePivotDecisionMarkers,
  type PivotInspectionCompliance,
} from "../../src/capsuleV2/pivotInspectionCompliance";

const RESULTS_DIR = path.join(import.meta.dir, "results");
const RUNS_DIR = path.join(RESULTS_DIR, "runs");

interface AuditRun { case: string; label: string; note: string; }

// The M12.1 enforcement runs (off-default mode was ON for these). Three cases × r1..r3.
const RUNS: readonly AuditRun[] = [
  { case: "sphinx-7462", label: "eval-m12-pivot-enforcement-current-sphinx-7462-r1", note: "reads gold ast.py, edits only python.py" },
  { case: "sphinx-7462", label: "eval-m12-pivot-enforcement-current-sphinx-7462-r2", note: "reads gold ast.py, edits only python.py" },
  { case: "sphinx-7462", label: "eval-m12-pivot-enforcement-current-sphinx-7462-r3", note: "never inspects ast.py, edits only python.py" },
  { case: "seaborn-3187", label: "eval-m12-pivot-enforcement-current-seaborn-3187-r1", note: "edits scales.py + utils.py" },
  { case: "seaborn-3187", label: "eval-m12-pivot-enforcement-current-seaborn-3187-r2", note: "under-edits: scales.py only" },
  { case: "seaborn-3187", label: "eval-m12-pivot-enforcement-current-seaborn-3187-r3", note: "resolved: scales.py + utils.py" },
  { case: "django-13195", label: "eval-m12-pivot-enforcement-current-django-13195-r1", note: "edits response.py + middleware.py + cookie.py" },
  { case: "django-13195", label: "eval-m12-pivot-enforcement-current-django-13195-r2", note: "edits response.py + middleware.py + cookie.py" },
  { case: "django-13195", label: "eval-m12-pivot-enforcement-current-django-13195-r3", note: "edits response.py + middleware.py + cookie.py" },
];

// Extract {workspace, task} from a captured `vtrace … capsule <ws> <task…>` command.
function parseCapsuleCommand(cmd: string): { workspace: string; task: string } | null {
  const at = cmd.indexOf(" capsule ");
  if (at === -1) return null;
  const rest = cmd.slice(at + " capsule ".length);
  const flagAt = rest.search(/\s--(intent|budget|capsule-engine|capsule-intent|mode|json)\b/);
  const head = (flagAt === -1 ? rest : rest.slice(0, flagAt)).trim();
  const firstNl = head.indexOf("\n");
  const firstSpace = head.indexOf(" ");
  const cut = [firstNl, firstSpace].filter((n) => n >= 0).sort((a, b) => a - b)[0];
  if (cut === undefined) return null;
  return { workspace: head.slice(0, cut).trim(), task: head.slice(cut).trim() };
}

async function anyIndexFor(instance: string): Promise<string | null> {
  const found: string[] = [];
  for await (const rel of new Glob(`**/*${instance}*/.vtrace/index.sqlite`).scan(RESULTS_DIR)) {
    found.push(path.join(RESULTS_DIR, rel));
  }
  found.sort();
  return found[0] ?? null;
}

// Recover the task + index for a specific run from that run's own `_run.meta.json`.
async function recoverForRun(
  label: string,
): Promise<{ task: string; indexDb: string } | null> {
  const metaPath = path.join(RUNS_DIR, label, "raw", "vtrace", "_run.meta.json");
  try {
    const meta = JSON.parse(await Bun.file(metaPath).text());
    const cmd: unknown = meta.vtraceQueryCommand;
    if (typeof cmd !== "string") return null;
    const parsed = parseCapsuleCommand(cmd);
    if (parsed === null) return null;
    const fromCmd = path.join(parsed.workspace, ".vtrace", "index.sqlite");
    const instance = String(meta.instances?.[0] ?? label);
    const indexDb = (await Bun.file(fromCmd).exists()) ? fromCmd : await anyIndexFor(instance);
    if (indexDb === null) return null;
    return { task: parsed.task, indexDb };
  } catch {
    return null;
  }
}

// Files edited by the final patch, repo-relative, from the swebench results jsonl.
async function editedFilesFromRun(label: string): Promise<{ edited: string[]; resolved: boolean | null }> {
  const jsonl = path.join(RUNS_DIR, label, "raw", "vtrace", "swebench-2026-06-16.jsonl");
  try {
    const text = await Bun.file(jsonl).text();
    const line = text.split(/\r?\n/).find((l) => l.trim().length > 0);
    if (!line) return { edited: [], resolved: null };
    const row = JSON.parse(line);
    const patch = String(row.modelPatch ?? "");
    const edited = [...new Set([...patch.matchAll(/diff --git a\/(\S+) b\//g)].map((m) => m[1]!))].sort();
    return { edited, resolved: typeof row.resolved === "boolean" ? row.resolved : null };
  } catch {
    return { edited: [], resolved: null };
  }
}

// Files inspected (read/searched) by the agent, from ordered tool-call telemetry.
async function inspectedFilesFromRun(label: string): Promise<string[]> {
  const toolCalls = path.join(RUNS_DIR, label, "raw", "vtrace", "_tool_calls.json");
  try {
    const calls = JSON.parse(await Bun.file(toolCalls).text()) as Array<{ category?: string; path?: string }>;
    const files = new Set<string>();
    for (const c of calls) {
      if ((c.category === "read" || c.category === "search") && typeof c.path === "string" && c.path.length > 0) {
        files.add(c.path);
      }
    }
    return [...files].sort();
  } catch {
    return [];
  }
}

// Parse machine-readable PIVOT_DECISION markers from any captured model text. M12.1
// runs capture no model prose, so this is empty for them; kept so a future
// marker-emitting run drives `ruledOut`.
async function decisionsFromRun(label: string) {
  const stdout = path.join(RUNS_DIR, label, "raw", "vtrace", "_run.stdout.txt");
  try {
    return parsePivotDecisionMarkers(await Bun.file(stdout).text());
  } catch {
    return [];
  }
}

interface RunAudit {
  case: string;
  label: string;
  note: string;
  recovered: boolean;
  resolved: boolean | null;
  required: string[];
  edited: string[];
  ruledOut: string[];
  missing: string[];
  unclear: string[];
  wouldFire: boolean;
  correctivePrompt: string | null;
  compliance: PivotInspectionCompliance | null;
}

function reqId(c: { path: string; symbol?: string; role: string }): string {
  const id = c.symbol ? `${c.path}::${c.symbol}` : c.path;
  return c.role === "related_coedit" ? `${id} (co-edit)` : id;
}

async function auditRun(r: AuditRun): Promise<RunAudit> {
  const empty: RunAudit = {
    case: r.case, label: r.label, note: r.note, recovered: false, resolved: null,
    required: [], edited: [], ruledOut: [], missing: [], unclear: [],
    wouldFire: false, correctivePrompt: null, compliance: null,
  };
  const recovered = await recoverForRun(r.label);
  if (!recovered) return empty;

  const db = openIndexerDatabase(recovered.indexDb);
  try {
    const result = buildCapsuleV2({
      db,
      repoRoot: path.dirname(path.dirname(recovered.indexDb)),
      task: recovered.task,
      intent: CapsuleIntent.Auto,
      maxTokens: 8000,
    });
    const hints = result.actionability_hints ?? [];
    const contract = buildPivotInspectionContract(result.pivots, hints);
    const generatedArtifactFiles = hints
      .filter((h) => h.kind === "generated_artifact")
      .map((h) => h.relatedFile);

    const { edited: editedFiles, resolved } = await editedFilesFromRun(r.label);
    const inspectedFiles = await inspectedFilesFromRun(r.label);
    const decisions = await decisionsFromRun(r.label);

    const compliance = computePivotInspectionCompliance({
      enabled: true,
      contract,
      editedFiles,
      inspectedFiles,
      generatedArtifactFiles,
      decisions,
    });
    const correctivePrompt = buildCorrectivePrompt(compliance);

    return {
      case: r.case, label: r.label, note: r.note, recovered: true, resolved,
      required: compliance.required.map(reqId),
      edited: compliance.edited,
      ruledOut: compliance.ruledOut,
      missing: compliance.missing,
      unclear: compliance.unclear,
      wouldFire: compliance.correctivePromptSent,
      correctivePrompt,
      compliance,
    };
  } finally {
    db.close();
  }
}

function fmt(items: string[]): string {
  return items.length > 0 ? items.map((s) => `\`${s}\``).join(", ") : "—";
}
function yn(b: boolean): string { return b ? "yes" : "no"; }

function riskOf(a: RunAudit): string {
  if (!a.recovered) return "inconclusive";
  if (a.missing.length > 0) return "HIGH — a required pivot was never inspected (true skip)";
  if (a.unclear.length > 0) {
    return "medium — inspected but no source-grounded rule-out marker captured (prose not persisted)";
  }
  return "none — every required candidate edited or grounded-ruled-out";
}

function expectedPromptSummary(a: RunAudit): string {
  if (!a.recovered) return "—";
  if (!a.wouldFire) return "no prompt (fully compliant)";
  const outstanding = [...a.missing, ...a.unclear];
  return `lists ${outstanding.length} outstanding: ${fmt(outstanding)} (inspect/edit-or-rule-out; minimal diff; cite source)`;
}

function renderReport(audits: readonly RunAudit[]): string {
  const L: string[] = [];
  L.push("# Stage 5 M13 — Pivot-inspection compliance audit (Option B)");
  L.push("");
  L.push(
    "Offline audit of the M13 structured pivot-inspection compliance checker "
    + "(`computePivotInspectionCompliance` in `src/capsuleV2/pivotInspectionCompliance.ts`). "
    + "**Diagnostic only** — no live agents, no Docker, no 30/100-case runs, no "
    + "retrieval/scoring/ranking/candidate-gen/pivot-selection change (retrieval evals "
    + "byte-identical). It audits the ALREADY-captured M12.1 enforcement runs.",
  );
  L.push("");
  L.push(
    "**Implementation: Option B (finalize-time static check).** The checker produces a "
    + "deterministic verdict AND the corrective-prompt text, but does NOT send a live "
    + "corrective turn: the external SWE-bench harness owns the turn loop and final-patch "
    + "extraction, so Option A (mid-run re-prompt) would require modifying that external "
    + "harness — too invasive. Option C's machine-readable `PIVOT_DECISION` parser is "
    + "included so a future marker-emitting run can drive `ruledOut`; the off-by-default "
    + "enforcement block is unchanged, so these captured runs carry no markers.",
  );
  L.push("");
  L.push(
    "**Conservative classification.** Model prose is NOT persisted in the run artifacts "
    + "(only the final patch + ordered tool calls + the manifest). So an explicit "
    + "source-grounded rule-out can only be observed via a `PIVOT_DECISION` marker. With "
    + "no marker: a candidate whose file is in the patch is `edited`; one that was "
    + "inspected but not edited is `unclear` (cannot confirm a grounded rule-out); one "
    + "never inspected and never edited is `missing`. `unclear` and `missing` both fire "
    + "the corrective prompt.",
  );
  L.push("");
  L.push(
    "Compliance is measured on pivot HANDLING, not task resolution — a run can resolve "
    + "while leaving a non-gold non-lead pivot `unclear`, and can be fully compliant while "
    + "still unresolved.",
  );
  L.push("");
  L.push("## Per-run result");
  L.push("");
  L.push(
    "| case | run | resolved | required | edited | ruled-out | missing | unclear | "
    + "corrective fires? | risk |",
  );
  L.push("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const a of audits) {
    if (!a.recovered) {
      L.push(`| ${a.case} | ${a.label} | — | n/a (no captured index) | — | — | — | — | — | inconclusive |`);
      continue;
    }
    L.push(
      `| ${a.case} | \`…${a.label.replace("eval-m12-pivot-enforcement-current-", "")}\` | `
      + `${a.resolved === null ? "—" : yn(a.resolved)} | ${fmt(a.required)} | ${fmt(a.edited)} | `
      + `${fmt(a.ruledOut)} | ${fmt(a.missing)} | ${fmt(a.unclear)} | ${yn(a.wouldFire)} | ${riskOf(a)} |`,
    );
  }
  L.push("");
  L.push("## Per-run corrective-prompt content");
  for (const a of audits) {
    L.push("");
    L.push(`### ${a.label}`);
    if (!a.recovered) { L.push("- inconclusive: no captured index/task recoverable"); continue; }
    L.push(`- ${a.note}`);
    L.push(`- required: ${fmt(a.required)}`);
    L.push(`- expected corrective prompt: ${expectedPromptSummary(a)}`);
    if (a.correctivePrompt) {
      L.push("");
      L.push("```text");
      L.push(a.correctivePrompt);
      L.push("```");
    }
  }
  L.push("");
  L.push("## Which labels would trigger a corrective prompt");
  const firing = audits.filter((a) => a.recovered && a.wouldFire).map((a) => a.label);
  const compliant = audits.filter((a) => a.recovered && !a.wouldFire).map((a) => a.label);
  L.push("");
  L.push(`- **would fire** (${firing.length}): ${firing.length ? firing.map((s) => `\`${s}\``).join(", ") : "—"}`);
  L.push(`- **compliant, no prompt** (${compliant.length}): ${compliant.length ? compliant.map((s) => `\`${s}\``).join(", ") : "—"}`);
  L.push("");
  L.push("## Findings vs M13 expectations");
  L.push("");
  const byCase = (c: string) => audits.filter((a) => a.case === c && a.recovered);
  const sphinx = byCase("sphinx-7462");
  const seaborn = byCase("seaborn-3187");
  const django = byCase("django-13195");
  const ck = (b: boolean) => (b ? "✅" : "❌");
  L.push("| case | expectation | result |");
  L.push("| --- | --- | --- |");
  L.push(
    `| sphinx-7462 | gold \`ast.py\` is edited nowhere → all runs fire a corrective prompt | `
    + `${ck(sphinx.length > 0 && sphinx.every((a) => a.edited.every((e) => !e.includes("ast.py")) && a.wouldFire))} |`,
  );
  L.push(
    `| sphinx-7462 | runs that read \`ast.py\` mark it \`unclear\`; the run that never reads it marks it \`missing\` | `
    + `${ck(sphinx.some((a) => a.unclear.some((u) => u.includes("ast.py"))) && sphinx.some((a) => a.missing.some((m) => m.includes("ast.py"))))} |`,
  );
  L.push(
    `| seaborn-3187 | under-edited run leaves a non-lead pivot outstanding (fires) | `
    + `${ck(seaborn.some((a) => a.wouldFire))} |`,
  );
  L.push(
    `| django-13195 | all gold/co-edit files edited → fully compliant, no prompt | `
    + `${ck(django.length > 0 && django.every((a) => !a.wouldFire))} |`,
  );
  L.push("");
  L.push("## Notable divergence");
  L.push("");
  L.push(
    "seaborn-3187-r3 RESOLVED yet the checker reports its non-lead pivot "
    + "`seaborn/relational.py::scatterplot` as `unclear` (the gold fix is "
    + "`scales.py` + `utils.py`; `relational.py` is a surfaced non-lead pivot the agent "
    + "inspected and correctly did not edit). Under the conservative model this is "
    + "`unclear`, not compliant, because no source-grounded rule-out is observable in the "
    + "captured artifacts. This is the expected cost of Option B without marker emission: "
    + "it cannot distinguish a correct silent rule-out from an oversight. The fix is "
    + "Option C marker emission (parser already shipped), which would let r3 record a "
    + "grounded `RULED_OUT` for `relational.py` and become fully compliant — the next "
    + "implementation step, gated behind the same opt-in flag.");
  L.push("");
  L.push("## Non-claims");
  L.push("- No live agents and no Docker were run; this is a deterministic post-hoc audit.");
  L.push("- The checker is Option B: it computes a verdict + corrective-prompt text; it does NOT re-prompt a live agent.");
  L.push("- Model prose is not persisted, so source-grounded rule-outs are not observable here; `unclear` is the conservative verdict for inspected-but-not-edited pivots.");
  L.push("- Off by default (`--pivot-inspection-enforcement` opt-in); the legacy PIVOT_CHECK policy and `--disable-pivot-check` are untouched.");
  L.push("- No retrieval/scoring/ranking/candidate-gen/pivot-selection change.");
  return L.join("\n") + "\n";
}

async function main(): Promise<void> {
  const audits: RunAudit[] = [];
  for (const r of RUNS) audits.push(await auditRun(r));
  const report = renderReport(audits);
  const outPath = path.join(RESULTS_DIR, "stage5_m13_pivot_loop_audit.md");
  await Bun.write(outPath, report);
  process.stdout.write(report);
  process.stdout.write(`\nwrote ${outPath}\n`);
}

await main();
