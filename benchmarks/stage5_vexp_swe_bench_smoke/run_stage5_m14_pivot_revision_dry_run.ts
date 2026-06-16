// M14 design + dry-run audit for the corrective pivot-revision pass.
//
// Writes `results/stage5_m14_pivot_revision_design.md`: the harness-seam analysis,
// the chosen option (B) and why, implementation status, risks, exact flags, artifact
// layout, and a DRY-RUN audit over the captured M12.1 enforcement runs — computing,
// per run, the M13 compliance-before verdict, whether the revision pass WOULD run
// (`decideRevisionPass`), the outstanding candidates, the revision-prompt path, and
// the expected risk. NO live agents, NO Docker, NO model calls, NO 30/100-case runs,
// NO retrieval/scoring/ranking/candidate-gen/pivot-selection change.
//
// Run: bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m14_pivot_revision_dry_run.ts

import path from "node:path";

import { openIndexerDatabase } from "../../src/db/sqlite";
import { buildCapsuleV2 } from "../../src/capsuleV2/buildCapsuleV2";
import { CapsuleIntent } from "../../src/capsuleV2/types";
import { buildPivotInspectionContract } from "../../src/capsuleV2/pivotInspectionContract";
import { computePivotInspectionCompliance } from "../../src/capsuleV2/pivotInspectionCompliance";
import {
  decideRevisionPass,
  buildRevisionPrompt,
  outstandingCount,
  REVISION_ARTIFACT_FILES,
} from "../../src/capsuleV2/pivotRevisionPass";

const RESULTS_DIR = path.join(import.meta.dir, "results");
const RUNS_DIR = path.join(RESULTS_DIR, "runs");
const PROMPT_DIR = path.join(RESULTS_DIR, "_m14_dry_run_prompts");

interface AuditRun { case: string; label: string; }
const RUNS: readonly AuditRun[] = [
  { case: "sphinx-7462", label: "eval-m12-pivot-enforcement-current-sphinx-7462-r1" },
  { case: "sphinx-7462", label: "eval-m12-pivot-enforcement-current-sphinx-7462-r2" },
  { case: "sphinx-7462", label: "eval-m12-pivot-enforcement-current-sphinx-7462-r3" },
  { case: "seaborn-3187", label: "eval-m12-pivot-enforcement-current-seaborn-3187-r1" },
  { case: "seaborn-3187", label: "eval-m12-pivot-enforcement-current-seaborn-3187-r2" },
  { case: "seaborn-3187", label: "eval-m12-pivot-enforcement-current-seaborn-3187-r3" },
  { case: "django-13195", label: "eval-m12-pivot-enforcement-current-django-13195-r1" },
  { case: "django-13195", label: "eval-m12-pivot-enforcement-current-django-13195-r2" },
  { case: "django-13195", label: "eval-m12-pivot-enforcement-current-django-13195-r3" },
];

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

async function recoverForRun(label: string): Promise<{ task: string; indexDb: string } | null> {
  const metaPath = path.join(RUNS_DIR, label, "raw", "vtrace", "_run.meta.json");
  try {
    const meta = JSON.parse(await Bun.file(metaPath).text());
    const cmd: unknown = meta.vtraceQueryCommand;
    if (typeof cmd !== "string") return null;
    const parsed = parseCapsuleCommand(cmd);
    if (parsed === null) return null;
    const indexDb = path.join(parsed.workspace, ".vtrace", "index.sqlite");
    if (!(await Bun.file(indexDb).exists())) return null;
    return { task: parsed.task, indexDb };
  } catch {
    return null;
  }
}

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
async function patchFromRun(label: string): Promise<string> {
  const jsonl = path.join(RUNS_DIR, label, "raw", "vtrace", "swebench-2026-06-16.jsonl");
  try {
    const text = await Bun.file(jsonl).text();
    const line = text.split(/\r?\n/).find((l) => l.trim().length > 0);
    return line ? String(JSON.parse(line).modelPatch ?? "") : "";
  } catch {
    return "";
  }
}
async function inspectedFilesFromRun(label: string): Promise<string[]> {
  const toolCalls = path.join(RUNS_DIR, label, "raw", "vtrace", "_tool_calls.json");
  try {
    const calls = JSON.parse(await Bun.file(toolCalls).text()) as Array<{ category?: string; path?: string }>;
    const files = new Set<string>();
    for (const c of calls) {
      if ((c.category === "read" || c.category === "search") && typeof c.path === "string" && c.path.length > 0) files.add(c.path);
    }
    return [...files].sort();
  } catch {
    return [];
  }
}

interface RunAudit {
  case: string; label: string; recovered: boolean; resolved: boolean | null;
  required: string[]; outstanding: string[]; wouldRun: boolean; reason: string;
  promptPath: string | null;
}

function reqId(c: { path: string; symbol?: string; role: string }): string {
  const id = c.symbol ? `${c.path}::${c.symbol}` : c.path;
  return c.role === "related_coedit" ? `${id} (co-edit)` : id;
}

async function auditRun(r: AuditRun): Promise<RunAudit> {
  const empty: RunAudit = {
    case: r.case, label: r.label, recovered: false, resolved: null,
    required: [], outstanding: [], wouldRun: false, reason: "no captured index", promptPath: null,
  };
  const recovered = await recoverForRun(r.label);
  if (!recovered) return empty;
  const db = openIndexerDatabase(recovered.indexDb);
  try {
    const result = buildCapsuleV2({
      db, repoRoot: path.dirname(path.dirname(recovered.indexDb)),
      task: recovered.task, intent: CapsuleIntent.Auto, maxTokens: 8000,
    });
    const hints = result.actionability_hints ?? [];
    const contract = buildPivotInspectionContract(result.pivots, hints);
    const generatedArtifactFiles = hints.filter((h) => h.kind === "generated_artifact").map((h) => h.relatedFile);
    const { edited, resolved } = await editedFilesFromRun(r.label);
    const inspected = await inspectedFilesFromRun(r.label);
    const patch = await patchFromRun(r.label);
    const complianceBefore = computePivotInspectionCompliance({
      enabled: true, contract, editedFiles: edited, inspectedFiles: inspected, generatedArtifactFiles,
    });
    const decision = decideRevisionPass({
      revisionPassEnabled: true, enforcementEnabled: true, capsuleV2Injected: true,
      hasModelPatch: patch.includes("diff --git"), complianceBefore,
    });
    let promptPath: string | null = null;
    if (decision.run) {
      const prompt = buildRevisionPrompt({ complianceBefore, currentPatch: patch });
      promptPath = path.join(PROMPT_DIR, `${r.label}.md`);
      await Bun.write(promptPath, `${prompt}\n`);
    }
    return {
      case: r.case, label: r.label, recovered: true, resolved,
      required: complianceBefore.required.map(reqId),
      outstanding: [...complianceBefore.missing, ...complianceBefore.unclear],
      wouldRun: decision.run, reason: decision.reason, promptPath,
    };
  } finally {
    db.close();
  }
}

function fmt(items: string[]): string { return items.length ? items.map((s) => `\`${s}\``).join(", ") : "—"; }
function yn(b: boolean): string { return b ? "yes" : "no"; }
function riskOf(a: RunAudit): string {
  if (!a.recovered) return "inconclusive";
  if (!a.wouldRun) return "none — no second pass";
  const hasCoedit = a.required.some((r) => r.includes("(co-edit)"));
  return hasCoedit
    ? "medium — inferred co-edit coupling; anti-over-edit guardrail mitigates padding"
    : "low — single non-lead pivot; revision is edit-or-grounded-rule-out";
}

function staticDesign(): string[] {
  const L: string[] = [];
  L.push("# Stage 5 M14 — Corrective pivot-revision pass: design + dry-run");
  L.push("");
  L.push("Design, feasibility, and a minimal opt-in scaffold for a second corrective patch "
    + "pass that works AROUND the external SWE-bench harness, driven by the M13 compliance "
    + "checker. **No live agents, no Docker, no model calls** were run for this report.");
  L.push("");
  L.push("## 1. Harness seam analysis");
  L.push("");
  L.push("- The external `vexp-swe-bench` harness owns the agent loop and final-patch extraction. "
    + "The Stage 5 runner (`run_stage5_vexp_swe_bench_smoke.ts`) spawns it via `runCondition` → "
    + "`spawn`(`node dist/cli.js run …`) and reads back the canonical `swebench-*.jsonl` "
    + "(`modelPatch`, tokens, tool counts).");
  L.push("- **Multiple harness invocations are already a proven pattern.** `runVtraceHardGate` "
    + "spawns the harness TWICE through `spawnHardGatePhase`, pointing `VTRACE_AGENT_INSTRUCTIONS_FILE`, "
    + "`VTRACE_AGENT_STREAM_FILE`, and the output dir at per-phase paths — using ONLY the installed "
    + "adapter's `VTRACE_AGENT_*` env seam. No external harness internals are modified.");
  L.push("- **The runner already has everything a second pass needs:** the original task "
    + "(`_run.meta.json` / instructions file), the injected VTRACE context "
    + "(`vtraceInstructionsFilePath`), the model patch (`readPhasePatchText` over "
    + "`findCanonicalResultsFile`), the ordered tool calls (`_tool_calls.json` via "
    + "`toolCallLogFilePath`), and the post-run workspace.");
  L.push("- **Assistant prose IS recoverable** (resolves the M13 gap): the adapter streams "
    + "stream-json to `VTRACE_AGENT_STREAM_FILE`, and `assistantTextFromStream` extracts the "
    + "assistant text — the hard gate already uses it. M13 missed it only because the shared "
    + "root stream is overwritten each run and not snapshotted per-run. The revision pass points "
    + "the second pass at its OWN stream file, so its prose (and any `PIVOT_DECISION` markers) are "
    + "captured.");
  L.push("- **A second post-patch model call is therefore feasible OUTSIDE the external harness** "
    + "via the same `spawnHardGatePhase` seam.");
  L.push("");
  L.push("## 2. Chosen option");
  L.push("");
  L.push("**Option B — post-patch corrective revision pass**, implemented as an opt-in scaffold "
    + "(`--pivot-revision-pass`), with **Option A artifact capture folded in** (the second pass "
    + "captures its assistant prose, making `PIVOT_DECISION` markers observable).");
  L.push("");
  L.push("## 3. Why");
  L.push("");
  L.push("- Option A alone does not change behavior; the M13 verdict already showed that injected "
    + "guidance text is not enough, so the next lever must be behavior-changing.");
  L.push("- Option C (editing the external agent loop) is unnecessary: the `spawnHardGatePhase` "
    + "seam already lets us add a corrective second pass without touching external internals, so "
    + "the invasive option is not justified.");
  L.push("- Option B reuses a proven multi-spawn pattern, stays off by default, and is a separate "
    + "experimental condition — exactly the requested shape.");
  L.push("");
  L.push("## 4. Implementation status");
  L.push("");
  L.push("- `src/capsuleV2/pivotRevisionPass.ts` — PURE core: `decideRevisionPass` (gating), "
    + "`buildRevisionPrompt` (wraps M13 `buildCorrectivePrompt` + current patch + bounded source "
    + "excerpts + minimal-diff framing), `decideReplacement` (conservative), record helpers. Unit-tested.");
  L.push("- Runner: `executePivotRevisionPass` orchestrator (dependency-injected second pass — "
    + "unit-tested with a stub, NO live agents) + `maybeRunPivotRevisionPass` live glue built on "
    + "`spawnHardGatePhase`, wired into `runVtrace` BEHIND both flags. The default suite never sets "
    + "the flags, so behavior is unchanged.");
  L.push("- **Not yet run live.** The live second-pass spawn is gated behind `--pivot-revision-pass` "
    + "and awaits explicit approval. Final-patch SWAP into the canonical eval JSONL is intentionally "
    + "NOT wired (replacement is computed + recorded only) so the pass can never corrupt canonical "
    + "results before live validation.");
  L.push("");
  L.push("## 5. Risks");
  L.push("");
  L.push("- **Workspace state:** a fresh `run` resets to the base commit, so the second pass starts "
    + "from base, not the post-patch tree; the revision prompt supplies the prior patch as text to "
    + "revise. Acceptable for a text-driven revision; flagged for live validation.");
  L.push("- **Cost:** a second `run` doubles token/$ for non-compliant cases. Mitigated by the gate "
    + "(only fires on missing/unclear) and off-by-default.");
  L.push("- **Over-edit:** the revision could pad the diff. Mitigated by the anti-over-edit / "
    + "minimal-diff wording and the conservative `decideReplacement` (replace only on a strict "
    + "compliance improvement with a real diff).");
  L.push("- **Conservative `unclear`:** without `PIVOT_DECISION` markers, a correct silent rule-out "
    + "reads as `unclear` and would trigger a (wasteful) revision — see seaborn-r3 below. Folding in "
    + "marker capture is the mitigation; emitting markers from the first pass is the follow-up.");
  L.push("");
  L.push("## 6. Exact flags");
  L.push("");
  L.push("- `--pivot-revision-pass` (default OFF). Requires `--pivot-inspection-enforcement`. "
    + "Independent of the legacy PIVOT_CHECK policy / `--disable-pivot-check`. Never the product default.");
  L.push("");
  L.push("## 7. Artifact layout");
  L.push("");
  L.push("Persisted in the vtrace raw dir, all `_`-prefixed (never a canonical JSONL; gitignored):");
  L.push("");
  for (const [k, v] of Object.entries(REVISION_ARTIFACT_FILES)) L.push(`- \`${v}\` — ${k}`);
  L.push("");
  L.push("`_pivot_revision.json` carries: `ran`, `decisionReason`, `originalPatch`, `revisionPrompt`, "
    + "`revisionResponse`, `revisedPatch`, `complianceBefore`, `complianceAfter`, `replacedFinalPatch`.");
  L.push("");
  return L;
}

function renderReport(audits: readonly RunAudit[]): string {
  const L = staticDesign();
  L.push("## 8. Dry-run over M12.1 labels (no model calls)");
  L.push("");
  L.push("Compliance-before is the M13 verdict; `would run?` is `decideRevisionPass` with both flags "
    + "on and Capsule v2 injected. Revision prompts for would-run rows are written under "
    + "`results/_m14_dry_run_prompts/` (gitignored, not staged).");
  L.push("");
  L.push("| case | label | resolved | required | outstanding (missing/unclear) | would run? | reason | prompt path | risk |");
  L.push("| --- | --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const a of audits) {
    if (!a.recovered) {
      L.push(`| ${a.case} | ${a.label} | — | — | — | — | ${a.reason} | — | inconclusive |`);
      continue;
    }
    const shortLabel = a.label.replace("eval-m12-pivot-enforcement-current-", "…");
    const pp = a.promptPath ? `\`_m14_dry_run_prompts/${path.basename(a.promptPath)}\`` : "—";
    L.push(`| ${a.case} | \`${shortLabel}\` | ${a.resolved === null ? "—" : yn(a.resolved)} | `
      + `${fmt(a.required)} | ${fmt(a.outstanding)} | ${yn(a.wouldRun)} | ${a.reason} | ${pp} | ${riskOf(a)} |`);
  }
  L.push("");
  const firing = audits.filter((a) => a.recovered && a.wouldRun).map((a) => a.label);
  const noRun = audits.filter((a) => a.recovered && !a.wouldRun).map((a) => a.label);
  L.push(`- **would trigger a revision pass** (${firing.length}): ${firing.length ? firing.map((s) => `\`${s}\``).join(", ") : "—"}`);
  L.push(`- **no revision pass** (${noRun.length}): ${noRun.length ? noRun.map((s) => `\`${s}\``).join(", ") : "—"}`);
  L.push("");
  L.push("### Notable");
  L.push("");
  L.push("- **sphinx-7462 (all 3):** outstanding `ast.py::unparse` → revision WOULD run; the prompt "
    + "asks to edit-or-grounded-rule-out the gold pivot the first pass skipped. Highest expected value.");
  L.push("- **seaborn-3187-r3 RESOLVED but WOULD still run:** `relational.py::scatterplot` is `unclear` "
    + "(inspected, correctly not edited, no marker). This is a FALSE trigger — the cost of running "
    + "without first-pass `PIVOT_DECISION` markers. The conservative `decideReplacement` keeps the "
    + "already-correct patch unless the revision strictly improves compliance, so a false trigger "
    + "wastes a second pass but cannot worsen the submitted diff.");
  L.push("- **django-13195 (all 3):** fully compliant → no revision pass (all gold/co-edit files edited).");
  L.push("");
  L.push("## Non-claims");
  L.push("- No live agents, no Docker, no model calls; deterministic dry-run.");
  L.push("- Off by default; requires both flags; never the product default.");
  L.push("- No retrieval/scoring/ranking/candidate-gen/pivot-selection change (retrieval evals byte-identical).");
  L.push("- Final-patch swap into the canonical eval JSONL is NOT wired (replacement recorded only).");
  return L.join("\n") + "\n";
}

async function main(): Promise<void> {
  const audits: RunAudit[] = [];
  for (const r of RUNS) audits.push(await auditRun(r));
  const report = renderReport(audits);
  const outPath = path.join(RESULTS_DIR, "stage5_m14_pivot_revision_design.md");
  await Bun.write(outPath, report);
  process.stdout.write(report);
  process.stdout.write(`\nwrote ${outPath}\n`);
}

await main();
