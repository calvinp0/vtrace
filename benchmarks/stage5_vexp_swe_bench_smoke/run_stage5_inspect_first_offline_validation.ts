// Offline validation for the compact Capsule v2 injected context (inspect-first +
// reduced pivot-neighborhood rendering). Deterministic, no live agents, no Docker:
// it replays each of the four shaped product-v2 gate instances through the SAME
// Capsule v2 build the Stage 5 vtrace-indexed path uses, then compares the
// previously-shipped injected text (human + verbose neighborhood) against the new
// compact text (inspect-first + human + compact neighborhood).
//
// Task recovery: each instance's exact task is read from a completed run's
// `_run.meta.json` `vtraceQueryCommand` (the precise `capsule <workspace> <task>
// --intent ... --budget ...` string), so the build matches a real run's input.
// Intent is forced to `auto` and the budget to 8,000 to match the gate queries.
//
// Run: bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_inspect_first_offline_validation.ts

import { Glob } from "bun";
import path from "node:path";

import { openIndexerDatabase } from "../../src/db/sqlite";
import { buildCapsuleV2 } from "../../src/capsuleV2/buildCapsuleV2";
import { CapsuleIntent, type CapsuleV2Result } from "../../src/capsuleV2/types";
import { toCapsuleV2ProductResponse } from "../../src/capsuleV2/productAdapter";
import { renderCapsuleV2Human } from "../../src/capsuleV2/renderHuman";
import {
  buildPivotNeighborhoods,
  renderPivotNeighborhoodsText,
  type PivotNeighborhoodContext,
} from "../../src/runPipeline/pivotNeighborhood";
import { buildInspectFirst, renderInspectFirstText } from "../../src/runPipeline/inspectFirst";

const RESULTS_DIR = path.join(import.meta.dir, "results");
const INSTANCES = [
  "matplotlib__matplotlib-22719",
  "astropy__astropy-14369",
  "django__django-10880",
  "django__django-11095",
] as const;

const estTokens = (text: string): number => Math.ceil(text.length / 4);

// Reproduce the PREVIOUSLY-SHIPPED verbose neighborhood renderer (excerpt bodies
// inlined in code fences) so the "before" measurement is faithful even though the
// shipped renderer is now compact.
function renderVerbosePrevious(contexts: readonly PivotNeighborhoodContext[]): string {
  const enriched = contexts.filter((c) => c.excerpts.length > 0);
  if (enriched.length === 0) return "";
  const lines: string[] = [
    "## Pivot neighborhood (bounded nearby source)",
    "Symbol-window excerpts around the top pivot(s), labeled by structural relationship. These are nearby source windows, not exact edge-site lines.",
  ];
  for (const c of enriched) {
    lines.push("");
    lines.push(`### ${c.pivot.fqName ?? c.pivot.path}`);
    for (const e of c.excerpts) {
      const id = e.fqName ?? e.symbol ?? e.filePath;
      lines.push(`- ${e.reason}: ${id} (${e.filePath}:${e.startLine}-${e.endLine})${e.truncated ? " [truncated]" : ""}`);
      lines.push("```");
      lines.push(e.text);
      lines.push("```");
    }
  }
  return lines.join("\n");
}

// Parse `... capsule <workspace> <task...> --intent ...` into { workspace, task }.
function parseCapsuleCommand(cmd: string): { workspace: string; task: string } | null {
  const marker = " capsule ";
  const at = cmd.indexOf(marker);
  if (at === -1) return null;
  const rest = cmd.slice(at + marker.length);
  const flagAt = rest.search(/\s--(intent|budget|capsule-engine|capsule-intent|mode|json)\b/);
  const head = (flagAt === -1 ? rest : rest.slice(0, flagAt)).trim();
  const firstNl = head.indexOf("\n");
  const firstSpace = head.indexOf(" ");
  // The workspace path is the first whitespace-delimited token.
  const cut = [firstNl, firstSpace].filter((n) => n >= 0).sort((a, b) => a - b)[0];
  if (cut === undefined) return null;
  return { workspace: head.slice(0, cut).trim(), task: head.slice(cut).trim() };
}

async function recoverInput(instance: string): Promise<{ task: string; indexDb: string } | { error: string }> {
  const metas = await Array.fromAsync(new Glob("**/_run.meta.json").scan(RESULTS_DIR));
  for (const rel of metas) {
    try {
      const meta = JSON.parse(await Bun.file(path.join(RESULTS_DIR, rel)).text());
      const cmd = meta.vtraceQueryCommand;
      if (typeof cmd !== "string" || !cmd.includes(instance) || !cmd.includes(" capsule ")) continue;
      const parsed = parseCapsuleCommand(cmd);
      if (parsed === null) continue;
      // Prefer the command's own workspace index; else any index for this instance.
      const fromCmd = path.join(parsed.workspace, ".vtrace", "index.sqlite");
      const indexDb = (await Bun.file(fromCmd).exists()) ? fromCmd : await anyIndexFor(instance);
      if (indexDb === null) continue;
      return { task: parsed.task, indexDb };
    } catch {
      // skip malformed meta
    }
  }
  return { error: "no run meta with a recoverable capsule command + live index" };
}

async function anyIndexFor(instance: string): Promise<string | null> {
  const workspaces = path.join(RESULTS_DIR, "workspaces");
  for await (const rel of new Glob(`**/${instance}/.vtrace/index.sqlite`).scan(workspaces)) {
    return path.join(workspaces, rel);
  }
  return null;
}

interface CaseResult {
  instance: string;
  ok: boolean;
  note: string;
  inspectPresent: boolean;
  confidence: string;
  likelyFirst: string;
  related: string[];
  beforeTokens: number;
  afterTokens: number;
  verboseReduced: boolean;
  structuredPreserved: boolean;
}

async function runCase(instance: string): Promise<CaseResult> {
  const empty: CaseResult = {
    instance, ok: false, note: "", inspectPresent: false, confidence: "n/a",
    likelyFirst: "n/a", related: [], beforeTokens: 0, afterTokens: 0,
    verboseReduced: false, structuredPreserved: false,
  };

  const recovered = await recoverInput(instance);
  if ("error" in recovered) return { ...empty, note: recovered.error };

  const db = openIndexerDatabase(recovered.indexDb);
  try {
    const result: CapsuleV2Result = buildCapsuleV2({
      db,
      repoRoot: path.dirname(path.dirname(recovered.indexDb)),
      task: recovered.task,
      intent: CapsuleIntent.Auto,
      maxTokens: 8000,
    });
    const product = toCapsuleV2ProductResponse(result);
    const neighborhood = buildPivotNeighborhoods(db, path.dirname(path.dirname(recovered.indexDb)), product);

    const human = renderCapsuleV2Human(result).trim();
    const inspectText = renderInspectFirstText(buildInspectFirst(product, neighborhood));
    const compactNeighborhood = renderPivotNeighborhoodsText(neighborhood);
    const verboseNeighborhood = renderVerbosePrevious(neighborhood);

    const before = [human, verboseNeighborhood].map((p) => p.trim()).filter((p) => p.length > 0).join("\n\n");
    const after = [inspectText, human, compactNeighborhood].map((p) => p.trim()).filter((p) => p.length > 0).join("\n\n");

    const inspect = buildInspectFirst(product, neighborhood);
    const totalExcerpts = neighborhood.reduce((n, c) => n + c.excerpts.length, 0);
    const bodiesPresent = neighborhood.some((c) => c.excerpts.some((e) => e.text.length > 0));

    return {
      instance,
      ok: true,
      note: `task chars=${recovered.task.length}; pivots=${product.pivots.length}; support=${product.support.length}; excerpts=${totalExcerpts}`,
      inspectPresent: inspectText.length > 0,
      confidence: inspect?.confidence ?? "n/a",
      likelyFirst: inspect ? `${inspect.likelyFirst.path}${inspect.likelyFirst.symbol ? `::${inspect.likelyFirst.symbol}` : ""}` : "n/a",
      related: (inspect?.related ?? []).map((r) => `${r.path}${r.symbol ? `::${r.symbol}` : ""}${r.isSurface ? " (surface)" : ""}`),
      beforeTokens: estTokens(before),
      afterTokens: estTokens(after),
      verboseReduced: compactNeighborhood.length < verboseNeighborhood.length || verboseNeighborhood.length === 0,
      structuredPreserved: totalExcerpts === 0 ? true : bodiesPresent,
    };
  } finally {
    db.close();
  }
}

function renderReport(cases: readonly CaseResult[]): string {
  const lines: string[] = [
    "# Stage 5 — Compact Capsule v2 injected context: offline validation",
    "",
    "Deterministic offline replay (no live agents, no Docker). Each instance's exact",
    "task is recovered from a completed run's `_run.meta.json` `vtraceQueryCommand`",
    "and rebuilt through `buildCapsuleV2` (`--intent auto`, budget 8,000) — the same",
    "Capsule v2 the vtrace-indexed single-shot path injects. **before** = the",
    "previously-shipped injected text (human capsule + verbose neighborhood, excerpt",
    "bodies inlined). **after** = the new compact text (inspect-first guidance +",
    "human capsule + compact neighborhood reference list). Tokens are `ceil(chars/4)`",
    "estimates of the agent-facing text, not tokenizer truth.",
    "",
    "## Per-instance result",
    "",
    "| Instance | inspect-first | confidence | likely first | before tok | after tok | Δ tok | verbose reduced | structured kept |",
    "| --- | --- | --- | --- | ---: | ---: | ---: | --- | --- |",
  ];
  for (const c of cases) {
    if (!c.ok) {
      lines.push(`| ${c.instance} | n/a | n/a | n/a (${c.note}) | n/a | n/a | n/a | n/a | n/a |`);
      continue;
    }
    const delta = c.afterTokens - c.beforeTokens;
    lines.push(
      `| ${c.instance} | ${c.inspectPresent ? "yes" : "no"} | ${c.confidence} | ${c.likelyFirst} | `
      + `${c.beforeTokens} | ${c.afterTokens} | ${delta >= 0 ? "+" : ""}${delta} | `
      + `${c.verboseReduced ? "yes" : "no"} | ${c.structuredPreserved ? "yes" : "no"} |`,
    );
  }
  lines.push("");
  lines.push("## Per-instance detail");
  for (const c of cases) {
    lines.push("");
    lines.push(`### ${c.instance}`);
    if (!c.ok) {
      lines.push(`- insufficient-data: ${c.note}`);
      continue;
    }
    lines.push(`- ${c.note}`);
    lines.push(`- likely first file: ${c.likelyFirst} (confidence: ${c.confidence})`);
    lines.push(`- related context: ${c.related.length > 0 ? c.related.join("; ") : "(none)"}`);
    lines.push(`- injected tokens (est): ${c.beforeTokens} → ${c.afterTokens} (${c.afterTokens - c.beforeTokens >= 0 ? "+" : ""}${c.afterTokens - c.beforeTokens})`);
    lines.push(`- verbose pivot-neighborhood reduced: ${c.verboseReduced ? "yes" : "no"}`);
    lines.push(`- full structured pivotNeighborhood excerpt bodies retained: ${c.structuredPreserved ? "yes" : "no"}`);
  }
  lines.push("");
  lines.push("## Non-claims");
  lines.push("- No live agents and no Docker were run; this is a deterministic first-response measurement only.");
  lines.push("- Token figures are `chars/4` estimates of agent-facing text, not tokenizer truth or live-run totals.");
  lines.push("- This changed no retrieval, ranking, scoring, candidate generation, or the solve protocol; Capsule v2 stays opt-in.");
  lines.push("- The inspect-first block is guidance only (no checklist, no gate, no phase split, no tool restriction).");
  return lines.join("\n") + "\n";
}

async function main(): Promise<void> {
  const cases: CaseResult[] = [];
  for (const instance of INSTANCES) {
    cases.push(await runCase(instance));
  }
  const report = renderReport(cases);
  const outPath = path.join(RESULTS_DIR, "stage5_inspect_first_offline_validation.md");
  await Bun.write(outPath, report);
  process.stdout.write(report);
  process.stdout.write(`\nwrote ${outPath}\n`);
}

await main();
