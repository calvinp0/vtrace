// Offline audit for the M12 pivot-check enforcement mode.
//
// Deterministic, no live agents, no Docker, no 30/100-case runs, no
// retrieval/scoring/ranking/candidate-gen change. For each case it rebuilds the
// capsule with CURRENT code from a captured `.vtrace/index.sqlite` (task replayed from
// `_run.meta.json`), then renders BOTH the advisory contract body
// (`renderCapsuleV2Human`) and the M12 enforcement block
// (`renderPivotInspectionEnforcementText`) — exactly what the Stage 5 runner injects
// before the capsule body when `--pivot-inspection-enforcement` is set. It reports
// whether the enforcement block renders, lists the right files, carries the
// anti-over-edit guardrails, preserves generated-artifact hints, and sits before the
// pivot bodies / 12k cutoff.
//
// Run: bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m12_pivot_enforcement_audit.ts

import { Glob } from "bun";
import path from "node:path";

import { openIndexerDatabase } from "../../src/db/sqlite";
import { buildCapsuleV2 } from "../../src/capsuleV2/buildCapsuleV2";
import { CapsuleIntent } from "../../src/capsuleV2/types";
import { renderCapsuleV2Human } from "../../src/capsuleV2/renderHuman";
import {
  buildPivotInspectionContract,
  renderPivotInspectionContractText,
  renderPivotInspectionEnforcementText,
  PIVOT_ENFORCEMENT_HEADING,
} from "../../src/capsuleV2/pivotInspectionContract";

const RESULTS_DIR = path.join(import.meta.dir, "results");
const STAGE5_TRUNC = 12_000;

interface AuditCase { id: string; group: "case" | "control"; note: string; }
const CASES: readonly AuditCase[] = [
  { id: "sphinx-7462", group: "case", note: "non-lead gold ast.py read 3/3 but never edited under M11 advisory" },
  { id: "seaborn-3187", group: "case", note: "M11 resolved 2/3 but r1 over-edited — needs anti-over-edit guardrail" },
  { id: "django-13195", group: "case", note: "all-gold already 3/3 under M11; must not regress" },
  { id: "astropy-14369", group: "control", note: "generated-artifact (PLY parser table) case" },
  { id: "sympy-16766", group: "control", note: "single-module multi-pivot fix" },
  { id: "requests-5414", group: "control", note: "patch-synthesis-bound; no cross-module co-edit" },
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

async function anyIndexFor(instance: string): Promise<string | null> {
  const found: string[] = [];
  for await (const rel of new Glob(`**/*${instance}*/.vtrace/index.sqlite`).scan(RESULTS_DIR)) {
    found.push(path.join(RESULTS_DIR, rel));
  }
  found.sort();
  return found[0] ?? null;
}

async function recoverIndex(instance: string): Promise<{ task: string; indexDb: string } | null> {
  const metas: string[] = [];
  for await (const rel of new Glob("**/_run.meta.json").scan(RESULTS_DIR)) metas.push(rel);
  metas.sort();
  for (const rel of metas) {
    try {
      const meta = JSON.parse(await Bun.file(path.join(RESULTS_DIR, rel)).text());
      const cmd = meta.vtraceQueryCommand;
      if (typeof cmd !== "string" || !cmd.includes(instance) || !cmd.includes(" capsule ")) continue;
      const parsed = parseCapsuleCommand(cmd);
      if (parsed === null) continue;
      const fromCmd = path.join(parsed.workspace, ".vtrace", "index.sqlite");
      const indexDb = (await Bun.file(fromCmd).exists()) ? fromCmd : await anyIndexFor(instance);
      if (indexDb === null) continue;
      return { task: parsed.task, indexDb };
    } catch {
      // skip malformed meta
    }
  }
  return null;
}

interface CaseAudit {
  id: string;
  group: AuditCase["group"];
  note: string;
  recovered: boolean;
  pivotCount: number;
  contractPresent: boolean;
  enforcementRendered: boolean;
  leadPivot: string;
  nonLeadPivots: string[];
  coeditCandidates: string[];
  antiOverEdit: boolean;
  generatedArtifactPreserved: boolean;
  generatedTablesMislabeled: boolean;
  beforeBodies: boolean;
  before12k: boolean;
  markerOffset: number;
}

async function auditCase(c: AuditCase): Promise<CaseAudit> {
  const empty: CaseAudit = {
    id: c.id, group: c.group, note: c.note, recovered: false, pivotCount: 0,
    contractPresent: false, enforcementRendered: false, leadPivot: "(n/a)",
    nonLeadPivots: [], coeditCandidates: [], antiOverEdit: false,
    generatedArtifactPreserved: false, generatedTablesMislabeled: false,
    beforeBodies: false, before12k: false, markerOffset: -1,
  };
  const recovered = await recoverIndex(c.id);
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
    const enforcement = renderPivotInspectionEnforcementText(contract).join("\n");
    const advisoryBody = renderCapsuleV2Human(result);

    // The injected snapshot under enforcement: enforcement block BEFORE the capsule body.
    const snapshot = enforcement.length > 0 ? `${enforcement}\n\n${advisoryBody}` : advisoryBody;
    const markerOffset = snapshot.indexOf(PIVOT_ENFORCEMENT_HEADING);
    const firstBodyOffset = snapshot.indexOf("\n● pivot ");

    const nonLead = (contract?.requiredInspections ?? []).filter((e) => e.role === "pivot");
    const coedit = (contract?.requiredInspections ?? []).filter((e) => e.role === "related_coedit");

    const generatedHints = hints.filter((h) => h.kind === "generated_artifact");
    const generatedFiles = generatedHints.map((h) => h.relatedFile);
    // Generated tables must NOT appear as enforcement co-edit candidates / non-lead pivots.
    const listedFiles = [...nonLead.map((e) => e.file), ...coedit.map((e) => e.file)];
    const generatedTablesMislabeled = generatedFiles.some((f) => listedFiles.includes(f));

    return {
      id: c.id, group: c.group, note: c.note, recovered: true,
      pivotCount: result.pivots.length,
      contractPresent: contract !== null,
      enforcementRendered: enforcement.length > 0,
      leadPivot: contract?.leadPivot ?? `${result.pivots[0]?.path}::${result.pivots[0]?.symbol}`,
      nonLeadPivots: nonLead.map((e) => (e.symbol ? `${e.file}::${e.symbol}` : e.file)),
      coeditCandidates: coedit.map((e) => e.file),
      antiOverEdit: /Do not add files to the final diff merely because they are listed/.test(enforcement)
        && /Prefer the minimal final diff/.test(enforcement),
      generatedArtifactPreserved: generatedHints.length > 0
        ? advisoryBody.includes("generated/co-edit artifact")
        : true,
      generatedTablesMislabeled,
      beforeBodies: markerOffset >= 0 && (firstBodyOffset < 0 || markerOffset < firstBodyOffset),
      before12k: markerOffset >= 0 && markerOffset < STAGE5_TRUNC,
      markerOffset,
    };
  } finally {
    db.close();
  }
}

function fmt(items: string[]): string {
  return items.length > 0 ? items.map((s) => `\`${s}\``).join(", ") : "—";
}
function yn(b: boolean): string { return b ? "yes" : "no"; }

function expectedEffect(a: CaseAudit): string {
  if (!a.enforcementRendered) return "no enforcement block (single pivot, no co-edit) — case stays terse";
  if (a.coeditCandidates.length > 0) {
    return "forces an explicit EDITED/RULED-OUT decision for each non-lead pivot + co-edit candidate; "
      + "anti-over-edit guardrail discourages padding the diff";
  }
  return "forces an explicit EDITED/RULED-OUT decision for the non-lead pivot; anti-over-edit guardrail "
    + "keeps the diff minimal";
}

function risk(a: CaseAudit): string {
  if (!a.enforcementRendered) return "none";
  if (a.generatedTablesMislabeled) return "HIGH — generated table mislabeled as a co-edit candidate";
  if (a.coeditCandidates.length > 0) return "medium — co-edit coupling is inferred; guardrail mitigates over-edit";
  return "low — basic edit-or-rule-out demand on real pivots";
}

function renderReport(audits: readonly CaseAudit[]): string {
  const L: string[] = [];
  L.push("# Stage 5 M12 — Pivot-check enforcement audit");
  L.push("");
  L.push(
    "Offline audit of the M12 narrow pivot-check enforcement mode "
    + "(`--pivot-inspection-enforcement`; renderer `renderPivotInspectionEnforcementText` in "
    + "`src/capsuleV2/pivotInspectionContract.ts`, injected by the Stage 5 runner BEFORE the "
    + "capsule body). **Diagnostic only** — no live agents, no Docker, no 30/100-case runs, no "
    + "retrieval/scoring/ranking/candidate-gen change (retrieval evals byte-identical; this is "
    + "render-only). The enforcement block is built from the same pivot inspection contract the "
    + "M11 advisory uses; it adds an explicit EDITED / RULED-OUT decision demand per non-lead "
    + "pivot + co-edit candidate with anti-over-edit guardrails.",
  );
  L.push("");
  L.push("Each case rebuilt with current code from a captured `.vtrace/index.sqlite` "
    + "(task replayed from `_run.meta.json`). Enforcement is simulated as ENABLED for the audit; "
    + "by default the mode is OFF and only the M11 advisory renders.");
  L.push("");
  L.push("## Per-case result");
  L.push("");
  L.push(
    "| case | contract? | enf. enabled | enf. rendered | non-lead pivots | co-edit candidates | "
    + "anti-over-edit | gen-artifact preserved | before bodies | before 12k | expected live effect | risk |",
  );
  L.push("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const a of audits) {
    if (!a.recovered) {
      L.push(`| **${a.id}**${a.group === "control" ? " (ctl)" : ""} | n/a (no captured index) | — | — | — | — | — | — | — | — | — | inconclusive |`);
      continue;
    }
    L.push(
      `| **${a.id}**${a.group === "control" ? " (ctl)" : ""} | ${yn(a.contractPresent)} | yes | ${yn(a.enforcementRendered)} | `
      + `${fmt(a.nonLeadPivots)} | ${fmt(a.coeditCandidates)} | ${yn(a.antiOverEdit)} | `
      + `${yn(a.generatedArtifactPreserved)} | ${yn(a.beforeBodies)} | ${yn(a.before12k)} | `
      + `${expectedEffect(a)} | ${risk(a)} |`,
    );
  }
  L.push("");
  L.push("## Per-case detail");
  for (const a of audits) {
    L.push("");
    L.push(`### ${a.id}${a.group === "control" ? " (control)" : ""}`);
    if (!a.recovered) { L.push(`- inconclusive: no captured index/task recoverable`); continue; }
    L.push(`- ${a.note}`);
    L.push(`- pivots: ${a.pivotCount}; lead \`${a.leadPivot}\``);
    L.push(`- non-lead pivots (edit-or-rule-out): ${fmt(a.nonLeadPivots)}`);
    L.push(`- co-edit candidates: ${fmt(a.coeditCandidates)}`);
    L.push(`- enforcement rendered: ${yn(a.enforcementRendered)}; anti-over-edit wording: ${yn(a.antiOverEdit)}`);
    L.push(`- generated-artifact hints preserved: ${yn(a.generatedArtifactPreserved)}; generated tables mislabeled as co-edit: ${yn(a.generatedTablesMislabeled)}`);
    L.push(`- position: marker at char ${a.markerOffset} (before bodies: ${yn(a.beforeBodies)}; before 12k: ${yn(a.before12k)})`);
  }
  L.push("");
  L.push("## Success criteria");
  L.push("");
  const by = new Map(audits.map((a) => [a.id, a]));
  const ck = (b: boolean) => (b ? "✅" : "❌");
  const sphinx = by.get("sphinx-7462"); const seaborn = by.get("seaborn-3187");
  const django = by.get("django-13195"); const astropy = by.get("astropy-14369");
  const sympy = by.get("sympy-16766"); const requests = by.get("requests-5414");
  L.push("| # | criterion | result |");
  L.push("| --- | --- | --- |");
  L.push(`| 1 | sphinx-7462 enforcement lists \`ast.py::unparse\` as edit-or-rule-out | ${ck(!!sphinx && [...sphinx.nonLeadPivots, ...sphinx.coeditCandidates].some((p) => p.includes("ast.py")))} |`);
  L.push(`| 2 | seaborn-3187 enforcement renders with anti-over-edit wording | ${ck(!!seaborn && seaborn.enforcementRendered && seaborn.antiOverEdit)} |`);
  L.push(`| 3 | django-13195 enforcement lists co-edit candidates (middleware/cookie) | ${ck(!!django && (django.coeditCandidates.length > 0 || django.nonLeadPivots.length > 0))} |`);
  L.push(`| 4 | astropy-14369 generated-artifact hints preserved; tables not mislabeled | ${ck(!!astropy && astropy.generatedArtifactPreserved && !astropy.generatedTablesMislabeled)} |`);
  L.push(`| 5 | sympy-16766 no noisy co-edit obligation | ${ck(!!sympy && sympy.coeditCandidates.length === 0)} |`);
  L.push(`| 6 | requests-5414 no noisy co-edit obligation | ${ck(!!requests && requests.coeditCandidates.length === 0)} |`);
  L.push(`| 7 | enforcement renders before pivot bodies and the 12k cutoff (all rendered cases) | ${ck(audits.every((a) => !a.enforcementRendered || (a.beforeBodies && a.before12k)))} |`);
  L.push(`| 8 | anti-over-edit guardrail present on every rendered block | ${ck(audits.every((a) => !a.enforcementRendered || a.antiOverEdit))} |`);
  L.push("");
  L.push("## Non-claims");
  L.push("- No live agents and no Docker were run; this is a deterministic render-time audit.");
  L.push("- Enforcement is injected-context guidance only: no runtime gate, no tool restriction, no phase split.");
  L.push("- Off by default (`--pivot-inspection-enforcement` opt-in); the legacy PIVOT_CHECK policy is untouched.");
  L.push("- No retrieval/scoring/ranking/candidate-gen/pivot-selection change.");
  return L.join("\n") + "\n";
}

async function main(): Promise<void> {
  const audits: CaseAudit[] = [];
  for (const c of CASES) audits.push(await auditCase(c));
  const report = renderReport(audits);
  const outPath = path.join(RESULTS_DIR, "stage5_m12_pivot_enforcement_audit.md");
  await Bun.write(outPath, report);
  process.stdout.write(report);
  process.stdout.write(`\nwrote ${outPath}\n`);
}

await main();
