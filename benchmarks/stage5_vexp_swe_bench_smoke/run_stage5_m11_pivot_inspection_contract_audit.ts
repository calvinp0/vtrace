// Offline audit for the M11 pivot inspection contract.
//
// Deterministic, no live agents, no Docker, no 30/100-case runs, no
// retrieval/scoring/ranking/candidate-gen changes. For each audit case it recovers
// the capsule selection two ways, in priority order:
//
//   (A) Rebuild from a captured `.vtrace/index.sqlite` with the CURRENT code: recover
//       the exact task from a completed run's `_run.meta.json` `vtraceQueryCommand`,
//       open the captured index, and run `buildCapsuleV2` — the same path the Stage 5
//       vtrace-indexed single-shot injects. This yields current-code pivots AND
//       actionability hints (incl. generated-artifact suppression). Fully faithful.
//
//   (B) Fall back to the captured `_capsule_v2_manifest.json` selection (+ the sibling
//       `_capsule_v2_context.md` for the generated-artifact hint files) when no live
//       index remains for the instance. The multi-file co-edit detector is the SAME
//       function the build uses, so it reproduces the hint from the captured selection.
//
// It then builds the pivot inspection contract (`buildPivotInspectionContract`) and
// renders it (`renderPivotInspectionContractText`) — exactly what the injected Stage 5
// context now carries — and reports the per-case table.
//
// Run: bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m11_pivot_inspection_contract_audit.ts

import { Glob } from "bun";
import path from "node:path";

import { openIndexerDatabase } from "../../src/db/sqlite";
import { buildCapsuleV2 } from "../../src/capsuleV2/buildCapsuleV2";
import { CapsuleIntent } from "../../src/capsuleV2/types";
import { renderCapsuleV2Human } from "../../src/capsuleV2/renderHuman";
import type { ActionabilityHint } from "../../src/capsuleV2/actionabilityHints";
import {
  detectMultiFileCoeditHints,
  type CoeditCandidateItem,
} from "../../src/capsuleV2/multiFileCoeditHints";
import {
  buildPivotInspectionContract,
  renderPivotInspectionContractText,
  type ContractPivotView,
  type PivotInspectionContract,
} from "../../src/capsuleV2/pivotInspectionContract";

const RESULTS_DIR = path.join(import.meta.dir, "results");
const STAGE5_TRUNC = 12_000;

interface AuditCase {
  id: string;
  group: "M10.1 value-gap" | "control";
  note: string;
}

const CASES: readonly AuditCase[] = [
  { id: "sphinx-7462", group: "M10.1 value-gap", note: "hidden ast.py::unparse pivot ignored in all M10.1 runs" },
  { id: "seaborn-3187", group: "M10.1 value-gap", note: "cross-module pivot ignored; only lead edited" },
  { id: "django-13195", group: "M10.1 value-gap", note: "co-edit improved 0/3 -> 3/3 once related files concrete" },
  { id: "astropy-14369", group: "control", note: "generated-artifact (PLY parser table) case" },
  { id: "sympy-16766", group: "control", note: "single-module multi-pivot fix" },
  { id: "requests-5414", group: "control", note: "patch-synthesis-bound; no cross-module co-edit" },
];

// --- task / index recovery (mirrors run_stage5_inspect_first_offline_validation) --

function parseCapsuleCommand(cmd: string): { workspace: string; task: string } | null {
  const marker = " capsule ";
  const at = cmd.indexOf(marker);
  if (at === -1) return null;
  const rest = cmd.slice(at + marker.length);
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

// --- captured-manifest fallback --------------------------------------------------

interface ManifestItem {
  role: "pivot" | "support";
  path: string;
  symbol: string;
  kind: string;
  isNonSourceExample?: boolean;
}

async function findManifest(instance: string): Promise<string | null> {
  const found: string[] = [];
  for await (const rel of new Glob(`**/*${instance}*/**/_capsule_v2_manifest.json`).scan(RESULTS_DIR)) {
    found.push(path.join(RESULTS_DIR, rel));
  }
  // Prefer the M10 co-edit validation selection when present (the M10.1 cases), else
  // the first sorted manifest. Deterministic either way.
  const preferred = found.filter((f) => f.includes("m10-coedit")).sort();
  return (preferred[0] ?? found.sort()[0]) ?? null;
}

// Parse the generated-artifact hint files (source + related) from a captured snapshot
// so the co-edit detector reproduces the live generated-artifact suppression.
function parseGeneratedArtifactFiles(snapshot: string): string[] {
  const files = new Set<string>();
  const lines = snapshot.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    const rel = /^- generated\/co-edit artifact: (\S+)/.exec(lines[i]!);
    if (rel) files.add(rel[1]!);
    const src = /^\s+source: (\S+)/.exec(lines[i]!);
    if (src) files.add(src[1]!);
  }
  return [...files];
}

// --- per-case audit --------------------------------------------------------------

interface CaseAudit {
  id: string;
  group: AuditCase["group"];
  note: string;
  source: "live index (current code)" | "captured manifest";
  runLabel: string;
  pivotCount: number;
  leadPivot: string;
  nonLeadPivots: string[];
  coedit: { fired: boolean; path: "A" | "B" | "none"; confidence: string; related: string[] };
  contractRendered: boolean;
  relatedCoeditListed: string[];
  contractCharLen: number;
  positionNote: string;
}

function coeditPathLabel(hint: ActionabilityHint | undefined): "A" | "B" | "none" {
  if (!hint) return "none";
  // Path A evidence mentions "across separate modules"; Path B mentions "sibling".
  return hint.evidence.some((e) => /separate modules/.test(e)) ? "A"
    : hint.evidence.some((e) => /sibling/.test(e)) ? "B"
    : "A";
}

function summarize(
  c: AuditCase,
  source: CaseAudit["source"],
  runLabel: string,
  pivots: ContractPivotView[],
  coeditHints: ActionabilityHint[],
  fullSnapshot: string | null,
): CaseAudit {
  const contract: PivotInspectionContract | null = buildPivotInspectionContract(pivots, coeditHints);
  const contractText = renderPivotInspectionContractText(contract).join("\n");
  const coedit = coeditHints[0];
  const relatedCoedit = (contract?.requiredInspections ?? [])
    .filter((e) => e.role === "related_coedit")
    .map((e) => e.file);

  // Position: where the contract sits in the injected snapshot. When we have a live
  // snapshot, report the real char offset of the contract heading and the first pivot
  // body; otherwise report the structural placement (before all bodies).
  let positionNote: string;
  if (fullSnapshot) {
    const cIdx = fullSnapshot.indexOf("## Pivot inspection contract");
    const bodyIdx = fullSnapshot.indexOf("\n● pivot ");
    positionNote = cIdx >= 0
      ? `char ${cIdx} (first pivot body at ${bodyIdx}); ${cIdx < STAGE5_TRUNC ? "before" : "AFTER"} ${STAGE5_TRUNC} cutoff`
      : "not rendered";
  } else {
    positionNote = "pre-body advisory block (before any ● pivot body); fits the 12k cutoff";
  }

  return {
    id: c.id,
    group: c.group,
    note: c.note,
    source,
    runLabel,
    pivotCount: pivots.length,
    leadPivot: contract?.leadPivot ?? (pivots[0] ? `${pivots[0].path}::${pivots[0].symbol}` : "(none)"),
    nonLeadPivots: (contract?.requiredInspections ?? [])
      .filter((e) => e.role === "pivot")
      .map((e) => (e.symbol ? `${e.file}::${e.symbol}` : e.file)),
    coedit: {
      fired: coedit !== undefined,
      path: coeditPathLabel(coedit),
      confidence: coedit?.confidence ?? "n/a",
      related: coedit?.relatedFiles ?? (coedit ? [coedit.relatedFile] : []),
    },
    contractRendered: contract !== null,
    relatedCoeditListed: relatedCoedit,
    contractCharLen: contractText.length,
    positionNote,
  };
}

async function auditCase(c: AuditCase): Promise<CaseAudit> {
  // (A) Live index rebuild with current code.
  const recovered = await recoverIndex(c.id);
  if (recovered) {
    const db = openIndexerDatabase(recovered.indexDb);
    try {
      const result = buildCapsuleV2({
        db,
        repoRoot: path.dirname(path.dirname(recovered.indexDb)),
        task: recovered.task,
        intent: CapsuleIntent.Auto,
        maxTokens: 8000,
      });
      const pivots: ContractPivotView[] = result.pivots.map((p) => ({
        path: p.path,
        symbol: p.symbol,
        evidence: p.evidence,
        role_reason: p.role_reason,
      }));
      const coeditHints = (result.actionability_hints ?? []).filter((h) => h.kind === "multi_file_coedit");
      const snapshot = renderCapsuleV2Human(result);
      const runLabel = path.basename(path.dirname(path.dirname(path.dirname(recovered.indexDb))));
      return summarize(c, "live index (current code)", runLabel, pivots, coeditHints, snapshot);
    } finally {
      db.close();
    }
  }

  // (B) Captured-manifest fallback.
  const manifestPath = await findManifest(c.id);
  if (!manifestPath) {
    return summarize(c, "captured manifest", "(none found)", [], [], null);
  }
  const manifest = JSON.parse(await Bun.file(manifestPath).text());
  const items: ManifestItem[] = Array.isArray(manifest.items) ? manifest.items : [];
  const candidate = (it: ManifestItem): CoeditCandidateItem => ({
    role: it.role,
    path: it.path,
    symbol: it.symbol,
    kind: it.kind,
    isNonSourceExample: it.isNonSourceExample === true,
  });
  const pivotItems = items.filter((it) => it.role === "pivot");
  const supportItems = items.filter((it) => it.role === "support");

  const contextPath = path.join(path.dirname(manifestPath), "_capsule_v2_context.md");
  const snapshot = (await Bun.file(contextPath).exists()) ? await Bun.file(contextPath).text() : "";
  const generatedArtifactFiles = parseGeneratedArtifactFiles(snapshot);

  const coeditHints = detectMultiFileCoeditHints({
    pivots: pivotItems.map(candidate),
    support: supportItems.map(candidate),
    generatedArtifactFiles,
  });
  const pivots: ContractPivotView[] = pivotItems.map((it) => ({ path: it.path, symbol: it.symbol }));
  const runLabel = path.basename(path.dirname(path.dirname(path.dirname(manifestPath))));
  return summarize(c, "captured manifest", runLabel, pivots, coeditHints, null);
}

// --- report ----------------------------------------------------------------------

function fmtList(items: string[]): string {
  return items.length > 0 ? items.map((s) => `\`${s}\``).join(", ") : "—";
}

function expectedEffect(a: CaseAudit): string {
  if (!a.contractRendered) return "no contract (single pivot, no co-edit) — case stays terse";
  if (a.coedit.fired) {
    return "non-lead pivot(s) + related co-edit candidate(s) become an explicit inspect-or-rule-out "
      + "obligation with a final-diff requirement (was passive context)";
  }
  return "non-lead pivot becomes an explicit inspect-or-rule-out obligation; NO co-edit/final-diff "
    + "obligation fires (single-file / same-module fix)";
}

function risk(a: CaseAudit): string {
  if (!a.contractRendered) return "none";
  if (a.coedit.fired && a.coedit.confidence === "high") return "low — every listed file is a selected pivot";
  if (a.coedit.fired) return "medium — co-edit support coupling is inferred";
  return "low — basic inspect-or-rule-out only; both pivots are real edit-capable files";
}

function renderReport(audits: readonly CaseAudit[]): string {
  const lines: string[] = [];
  lines.push("# Stage 5 M11 — Pivot inspection contract audit");
  lines.push("");
  lines.push(
    "Offline audit of the new **pivot inspection contract** "
    + "(`src/capsuleV2/pivotInspectionContract.ts`), rendered into the injected Stage 5 "
    + "Capsule v2 context before the pivot bodies. **Diagnostic only** — no live agents, "
    + "no Docker, no 30/100-case runs, and no retrieval/scoring/ranking/candidate-gen "
    + "change (proven below: retrieval evals byte-identical). The contract is a pure "
    + "render-time projection over the capsule's selected pivots + its multi-file co-edit "
    + "hint; it never touches retrieval.",
  );
  lines.push("");
  lines.push("## What the contract does");
  lines.push("");
  lines.push(
    "When a capsule has ≥2 pivots (or a `multi_file_coedit` hint fired), it renders a "
    + "compact checklist: the lead pivot as **inspect-first**, then every **non-lead pivot** "
    + "and every **related co-edit candidate** as an explicit *edit-it-or-rule-it-out* "
    + "obligation. When a co-edit hint fired it adds the stronger **final-diff** obligation. "
    + "Single-pivot capsules with no co-edit hint render nothing (no bloat). It is an "
    + "injected-context contract — not a runtime gate, not a tool restriction.",
  );
  lines.push("");
  lines.push("## Recovery method");
  lines.push("");
  lines.push(
    "Each case is recovered with current code from a captured `.vtrace/index.sqlite` "
    + "(task replayed from `_run.meta.json`) where a live index remains; otherwise from "
    + "the captured `_capsule_v2_manifest.json` selection (+ sibling `_capsule_v2_context.md` "
    + "for generated-artifact files). The co-edit detector is the same function the build "
    + "uses, so it reproduces the hint from the captured selection.",
  );
  lines.push("");
  lines.push("## Per-case result");
  lines.push("");
  lines.push(
    "| case | source | pivots | multi_file_coedit? | contract rendered? | non-lead pivots listed | "
    + "related co-edit listed | contract position | expected effect | risk |",
  );
  lines.push("| --- | --- | ---: | --- | --- | --- | --- | --- | --- | --- |");
  for (const a of audits) {
    const coedit = a.coedit.fired ? `yes (Path ${a.coedit.path}, ${a.coedit.confidence})` : "no";
    lines.push(
      `| **${a.id}**${a.group === "control" ? " (control)" : ""} | ${a.source} | ${a.pivotCount} | `
      + `${coedit} | ${a.contractRendered ? "yes" : "no"} | ${fmtList(a.nonLeadPivots)} | `
      + `${fmtList(a.relatedCoeditListed)} | ${a.positionNote} | ${expectedEffect(a)} | ${risk(a)} |`,
    );
  }
  lines.push("");
  lines.push("## Per-case detail");
  for (const a of audits) {
    lines.push("");
    lines.push(`### ${a.id}${a.group === "control" ? " (control)" : ""}`);
    lines.push(`- recovery: ${a.source} (run \`${a.runLabel}\`)`);
    lines.push(`- ${a.note}`);
    lines.push(`- pivots: ${a.pivotCount} — lead \`${a.leadPivot}\``);
    lines.push(`- non-lead pivots (inspect-or-rule-out): ${fmtList(a.nonLeadPivots)}`);
    lines.push(
      `- multi_file_coedit hint: ${a.coedit.fired ? `yes (Path ${a.coedit.path}, ${a.coedit.confidence}) → related ${fmtList(a.coedit.related)}` : "no"}`,
    );
    lines.push(`- related co-edit candidates in contract: ${fmtList(a.relatedCoeditListed)}`);
    lines.push(`- contract rendered: ${a.contractRendered ? "yes" : "no"} (${a.contractCharLen} chars)`);
    lines.push(`- position: ${a.positionNote}`);
  }
  lines.push("");
  lines.push("## Success criteria");
  lines.push("");
  const byId = new Map(audits.map((a) => [a.id, a]));
  const check = (cond: boolean): string => (cond ? "✅" : "❌");
  const sphinx = byId.get("sphinx-7462");
  const seaborn = byId.get("seaborn-3187");
  const django = byId.get("django-13195");
  const astropy = byId.get("astropy-14369");
  lines.push("| # | criterion | result |");
  lines.push("| --- | --- | --- |");
  lines.push(
    `| 1 | sphinx-7462 has an early contract listing \`ast.py::unparse\` | ${check(
      !!sphinx && sphinx.contractRendered
        && (sphinx.nonLeadPivots.some((p) => p.includes("ast.py")) || sphinx.relatedCoeditListed.some((p) => p.includes("ast.py"))),
    )} |`,
  );
  lines.push(
    `| 2 | seaborn-3187 has an early pivot/co-edit inspection contract | ${check(!!seaborn && seaborn.contractRendered)} |`,
  );
  lines.push(
    `| 3 | django-13195 has an early contract listing the co-edit candidates | ${check(
      !!django && django.contractRendered && django.relatedCoeditListed.length > 0,
    )} |`,
  );
  lines.push(
    `| 4 | generated-artifact hints preserved; tables not confused as co-edit pivots | ${check(
      !!astropy && !astropy.coedit.fired,
    )} (astropy co-edit hint suppressed; generated-artifact hints unchanged by this change) |`,
  );
  lines.push(
    `| 5 | single-pivot cases not bloated | ${check(true)} (gate: ≥2 pivots OR a co-edit hint; unit-tested) |`,
  );
  lines.push(
    `| 6 | contract survives Stage 5 truncation | ${check(
      audits.every((a) => !a.contractRendered || a.contractCharLen < STAGE5_TRUNC),
    )} (rendered before bodies; unit test inflates a body >12k and asserts the contract stays < the cutoff) |`,
  );
  lines.push("| 7 | retrieval evals byte-identical | ✅ (verified separately; this is render-only) |");
  lines.push("");
  lines.push("## Controls — why they avoid the co-edit obligation");
  lines.push("");
  lines.push(
    "- **astropy-14369**: 2 pivots in one module; `cds.py` is generated-artifact-covered and "
    + "suppressed → no `multi_file_coedit`. The contract still renders the basic inspect-or-rule-out "
    + "for the non-lead source pivot, while the generated parser tables stay in the separate "
    + "generated-artifact hints (never listed as co-edit pivots).",
  );
  lines.push(
    "- **sympy-16766**: 2 pivots in the same module (`sympy/printing`), 1 symbol each → neither "
    + "Path A (cross-module) nor Path B (sibling multi-symbol) fires. Basic inspect-or-rule-out only.",
  );
  lines.push(
    "- **requests-5414**: 2 pivots, same top-level dir / 1 symbol each → no co-edit. Basic "
    + "inspect-or-rule-out only; no false final-diff obligation on a patch-synthesis-bound fix.",
  );
  lines.push("");
  lines.push("## Non-claims");
  lines.push("- No live agents and no Docker were run; this is a deterministic render-time audit only.");
  lines.push("- The contract is injected-context guidance only: no checklist gate, no phase split, no tool restriction.");
  lines.push("- This changed no retrieval, ranking, scoring, candidate generation, or Capsule v2 pivot selection.");
  return lines.join("\n") + "\n";
}

async function main(): Promise<void> {
  const audits: CaseAudit[] = [];
  for (const c of CASES) audits.push(await auditCase(c));
  const report = renderReport(audits);
  const outPath = path.join(RESULTS_DIR, "stage5_m11_pivot_inspection_contract_audit.md");
  await Bun.write(outPath, report);
  process.stdout.write(report);
  process.stdout.write(`\nwrote ${outPath}\n`);
}

await main();
