/**
 * M196A Part B — corpus materiality (M197 gate B0).
 *
 * B0 asks whether any workload VTRACE actually holds has enough repository
 * reading in it for compressing that reading to matter. M196 answered it for one
 * corpus (M194) and inferred the rest. This measures every preserved trajectory
 * VTRACE owns, under the accounting M196 froze, and lets the corpora disagree.
 *
 *   B0  median repository-evidence tokens over successful arms >= 20,000
 *       OR repository evidence >= 25% of total model-facing tokens
 *
 * Two things this deliberately does NOT do: it never inspects what VTRACE would
 * have retrieved for a task before deciding whether the task's corpus qualifies
 * (§34), and it never widens the numerator past Read/Grep/Glob RESULT bytes to
 * make a corpus look larger (§17, §21).
 *
 *   bun benchmarks/stage5_vexp_swe_bench_smoke/run_stage5_m196a_materiality.ts
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const RESULTS = path.join(import.meta.dir, "results");
const RUNS = path.join(RESULTS, "runs");
const M194_RUNS = path.join(RESULTS, "m194", "runs");

/** M196's frozen consumption tokenizer, reproduced exactly so the M194 negative
 *  control lands on M196's published numbers rather than near them. */
const tok = (chars: number) => Math.floor(chars / 4);
const sorted = (v: number[]) => v.slice().sort((a, b) => a - b);
const median = (v: number[]) => (v.length === 0 ? 0 : sorted(v)[Math.floor(v.length / 2)]!);
const pctl = (v: number[], p: number) => (v.length === 0 ? 0 : sorted(v)[Math.min(v.length - 1, Math.floor(v.length * p))]!);

/** The tool schema cost the model pays on every VTRACE-treated arm, from M196. */
const TOOL_SCHEMA_TOKENS = 5521;

const EVIDENCE_TOOLS = new Set(["Read", "Grep", "Glob"]);

export const B0_MEDIAN_EVIDENCE_TOKENS = 20000;
export const B0_EVIDENCE_SHARE = 0.25;

export interface ArmAccounting {
  armId: string;
  corpus: string;
  repository: string | null;
  task: string | null;
  treated: boolean | null;
  resolved: boolean | null;
  readTokens: number;
  searchTokens: number;
  repositoryEvidenceTokens: number;
  /** Distinct model-facing content reconstructed from the transcript: every
   *  assistant output and every user/tool_result payload, counted once. The
   *  agent loop re-sends history each turn; counting that repetition would
   *  inflate the denominator and make the 25% arm trivially easy to fail. */
  reconstructedModelFacingTokens: number;
  /** THE denominator for B0's percentage arm. Provider-reported and
   *  cache-corrected: summed over every assistant message,
   *  `input + cache_creation + output`. `cache_read` is excluded because it is
   *  exactly the re-sent prompt material §22 forbids counting. Unlike the
   *  reconstruction above it includes the system prompt and the task prompt,
   *  which are model-facing bytes the prereg's §2 whole-response rule counts. */
  providerDistinctTokens: number | null;
  filesRead: number;
  /** Deduplicated evidence: the same file read twice is one file's worth of
   *  burden to a compiler, so this is the realism diagnostic of §25. */
  dedupedEvidenceTokens: number;
  toolCalls: number;
  truncatedCaptures: number;
}

/** Walk a Claude Code / agent-stream JSONL and account one arm. */
export function accountStream(lines: Iterable<string>): Omit<ArmAccounting,
  "armId" | "corpus" | "repository" | "task" | "treated" | "resolved"> {
  const toolName = new Map<string, string>();
  const toolTarget = new Map<string, string>();
  const filesRead = new Set<string>();
  const dedupe = new Map<string, number>();
  let readChars = 0, searchChars = 0, modelFacingChars = 0, toolCalls = 0, truncated = 0;
  let provider: number | null = null;

  for (const line of lines) {
    if (line.trim() === "") continue;
    let record: any;
    try { record = JSON.parse(line); } catch { continue; }

    // Summed per assistant message so the two transcript layouts (Claude Code
    // config projects, Stage 5 agent streams) are accounted identically; the
    // stream's aggregate `result.usage` is deliberately not used, to avoid
    // double counting one layout and not the other.
    const usage = record.message?.usage;
    if (usage !== undefined && usage !== null) {
      provider = (provider ?? 0) + (usage.input_tokens ?? 0)
        + (usage.cache_creation_input_tokens ?? 0) + (usage.output_tokens ?? 0);
    }
    const content = record.message?.content;
    if (!Array.isArray(content)) {
      if (typeof content === "string") modelFacingChars += content.length;
      continue;
    }
    for (const block of content) {
      if (block?.type === "text") { modelFacingChars += String(block.text ?? "").length; continue; }
      if (block?.type === "thinking") { modelFacingChars += String(block.thinking ?? "").length; continue; }
      if (block?.type === "tool_use") {
        toolCalls += 1;
        toolName.set(block.id, block.name);
        const target = block.input?.file_path ?? block.input?.pattern ?? block.input?.path ?? "";
        toolTarget.set(block.id, `${block.name}:${target}`);
        modelFacingChars += JSON.stringify(block.input ?? {}).length;
        if (block.name === "Read" && block.input?.file_path) filesRead.add(block.input.file_path);
        continue;
      }
      if (block?.type === "tool_result") {
        const raw = block.content;
        const text = typeof raw === "string" ? raw
          : Array.isArray(raw) ? raw.map((x: any) => x?.text ?? "").join("") : "";
        modelFacingChars += text.length;
        const name = toolName.get(block.tool_use_id);
        if (name === undefined || !EVIDENCE_TOOLS.has(name)) continue;
        if (name === "Read") readChars += text.length; else searchChars += text.length;
        // A capture that stopped at a round 8192 is the M170 truncation, and it
        // makes this arm's evidence a LOWER bound, not a measurement.
        if (text.length === 8192) truncated += 1;
        const key = toolTarget.get(block.tool_use_id) ?? String(block.tool_use_id);
        dedupe.set(key, Math.max(dedupe.get(key) ?? 0, text.length));
      }
    }
  }
  return {
    readTokens: tok(readChars),
    searchTokens: tok(searchChars),
    repositoryEvidenceTokens: tok(readChars + searchChars),
    reconstructedModelFacingTokens: tok(modelFacingChars) + TOOL_SCHEMA_TOKENS,
    providerDistinctTokens: provider,
    filesRead: filesRead.size,
    dedupedEvidenceTokens: tok([...dedupe.values()].reduce((a, b) => a + b, 0)),
    toolCalls,
    truncatedCaptures: truncated,
  };
}

function* fileLines(file: string): Generator<string> {
  for (const line of readFileSync(file, "utf8").split("\n")) yield line;
}

// ------------------------------------------------------------------- B0 verdicts
function share(arm: ArmAccounting, denominator: "reconstructed" | "provider"): number | null {
  const d = denominator === "reconstructed" ? arm.reconstructedModelFacingTokens : arm.providerDistinctTokens;
  if (d === null || d <= 0) return null;
  return arm.repositoryEvidenceTokens / d;
}

export function evaluate(label: string, group: ArmAccounting[], note: string) {
  // B0 is defined over SUCCESSFUL arms. Where resolution was never evaluated the
  // arm cannot enter the successful set — that is a gap in the corpus, reported
  // as one, not quietly backfilled with all arms.
  const successful = group.filter((a) => a.resolved === true);
  const basis = successful.length > 0 ? successful : [];
  const evidence = basis.map((a) => a.repositoryEvidenceTokens);
  const shares = basis.map((a) => share(a, "reconstructed")).filter((s): s is number => s !== null);
  const providerShares = basis.map((a) => share(a, "provider")).filter((s): s is number => s !== null);
  // B0's share arm is judged on the provider denominator. The reconstruction
  // omits the system and task prompts, so it is an UPPER bound on the share and
  // passing on it alone would be an accounting artefact, not materiality.
  const medianEvidence = median(evidence);
  const medianShare = median(shares);
  const medianProviderShare = median(providerShares);
  const b0MedianArm = medianEvidence >= B0_MEDIAN_EVIDENCE_TOKENS;
  const b0ShareArm = providerShares.length > 0 && medianProviderShare >= B0_EVIDENCE_SHARE;
  const b0ShareArmReconstructedOnly = medianShare >= B0_EVIDENCE_SHARE && !b0ShareArm;
  const measurable = basis.length > 0 && providerShares.length > 0;
  return {
    corpus: label, note,
    arms: group.length,
    successfulArms: successful.length,
    unevaluatedArms: group.filter((a) => a.resolved === null).length,
    treatedArms: group.filter((a) => a.treated === true).length,
    untreatedArms: group.filter((a) => a.treated === false).length,
    unknownTreatmentArms: group.filter((a) => a.treated === null).length,
    repositories: [...new Set(group.map((a) => a.repository).filter(Boolean))].sort(),
    repositoryCount: new Set(group.map((a) => a.repository).filter(Boolean)).size,
    tasks: new Set(group.map((a) => a.task)).size,
    medianRepositoryEvidenceTokens: medianEvidence,
    p90RepositoryEvidenceTokens: pctl(evidence, 0.9),
    maxRepositoryEvidenceTokens: evidence.length === 0 ? 0 : Math.max(...evidence),
    medianDedupedEvidenceTokens: median(basis.map((a) => a.dedupedEvidenceTokens)),
    medianShareReconstructed: +medianShare.toFixed(4),
    p90ShareReconstructed: +pctl(shares, 0.9).toFixed(4),
    medianShareProvider: +medianProviderShare.toFixed(4),
    medianFilesRead: median(basis.map((a) => a.filesRead)),
    truncatedCaptureArms: basis.filter((a) => a.truncatedCaptures > 0).length,
    armsWithProviderAccounting: providerShares.length,
    b0MedianArm, b0ShareArm, b0ShareArmReconstructedOnly,
    b0: !measurable ? "B0_NOT_MEASURABLE" : (b0MedianArm || b0ShareArm)
      ? "TRACK_B_CORPUS_MATERIAL" : "TRACK_B_CORPUS_INADEQUATE",
  };
}

if (import.meta.main) {
  // ------------------------------------------------------------ M194 (the control)
  const arms: ArmAccounting[] = [];
  const m194Ledger = path.join(RESULTS, "stage5_m194_acquisition_ledger.jsonl");
  const m194Resolved = new Map<string, boolean>();
  const m194Treated = new Map<string, boolean>();
  if (existsSync(m194Ledger)) {
    for (const line of readFileSync(m194Ledger, "utf8").split("\n")) {
      if (line.trim() === "") continue;
      const d = JSON.parse(line);
      if (d.resolved !== null && d.resolved !== undefined) m194Resolved.set(d.armId, Boolean(d.resolved));
      const arm = String(d.arm ?? d.armId ?? "");
      m194Treated.set(d.armId, !/baseline/i.test(arm) && (d.treated === true || /vtrace/i.test(arm)));
    }
  }
  if (existsSync(M194_RUNS)) {
    for (const run of readdirSync(M194_RUNS).sort()) {
      const dir = path.join(M194_RUNS, run);
      const cfg = readdirSync(dir).find((d) => d.startsWith("claude-config-"));
      if (cfg === undefined) continue;
      const projects = path.join(dir, cfg, "projects", "-testbed");
      if (!existsSync(projects)) continue;
      const all: string[] = [];
      for (const jf of readdirSync(projects).filter((f) => f.endsWith(".jsonl"))) {
        all.push(...readFileSync(path.join(projects, jf), "utf8").split("\n"));
      }
      arms.push({
        armId: run, corpus: "M194",
        repository: run.split("__")[0]?.replace(/^[a-z0-9]+_/, "") ?? null,
        task: run, treated: m194Treated.get(run) ?? null, resolved: m194Resolved.get(run) ?? null,
        ...accountStream(all),
      });
    }
  }

  // --------------------------------------------------- Stage 5 labelled run corpora
  /** The milestone that produced a run, taken from its label. Corpora are grouped
   *  by milestone because that is the unit an M197 Track B would have to freeze. */
  function corpusOf(label: string): string {
    const m = /^(m\d+[a-z]*)/.exec(label);
    return m === null ? "other" : m[1]!.toUpperCase();
  }
  /** SWE-bench instance repository, e.g. `django__django-11740` -> `django`. */
  function repositoryOf(label: string): string | null {
    const m = /(astropy|django|sympy|matplotlib|scikit-learn|pytest-dev|sphinx-doc|psf|pylint-dev|pydata|mwaskom|pallets|requests|seaborn|xarray)/.exec(label);
    return m === null ? null : m[1]!;
  }

  if (existsSync(RUNS)) {
    for (const label of readdirSync(RUNS).sort()) {
      const raw = path.join(RUNS, label, "raw");
      if (!existsSync(raw)) continue;
      for (const arm of readdirSync(raw)) {
        const armDir = path.join(raw, arm);
        let streams: string[];
        try { streams = readdirSync(armDir).filter((f) => f.startsWith("_agent_stream") && f.endsWith(".jsonl")); }
        catch { continue; }
        // First pass only. A revision pass is a second look at the same task and
        // is not the normal consumption Track B would have to displace.
        const first = streams.find((f) => f.includes("first_pass")) ?? streams.find((f) => f === "_agent_stream.jsonl");
        if (first === undefined) continue;

        let treated: boolean | null = null;
        const metaPath = path.join(armDir, "_run.meta.json");
        if (existsSync(metaPath)) {
          try {
            const meta = JSON.parse(readFileSync(metaPath, "utf8"));
            treated = meta.vtraceContextInjected ?? (arm !== "baseline" ? null : false);
          } catch { /* leave unknown */ }
        }
        if (treated === null) treated = arm === "baseline" || /baseline/i.test(label) ? false : null;

        let resolved: boolean | null = null;
        const swebench = readdirSync(armDir).find((f) => f.startsWith("swebench-") && f.endsWith(".jsonl"));
        if (swebench !== undefined) {
          for (const line of readFileSync(path.join(armDir, swebench), "utf8").split("\n")) {
            if (line.trim() === "") continue;
            try { const d = JSON.parse(line); if (d.resolved !== undefined) resolved = Boolean(d.resolved); } catch { /* ignore */ }
          }
        }

        arms.push({
          armId: `${label}::${arm}`, corpus: corpusOf(label), repository: repositoryOf(label),
          task: label, treated, resolved,
          ...accountStream(fileLines(path.join(armDir, first))),
        });
      }
    }
  }

  // ------------------------------------------------------------------- B0 verdicts

  const byCorpus = new Map<string, ArmAccounting[]>();
  for (const a of arms) {
    const list = byCorpus.get(a.corpus) ?? [];
    list.push(a); byCorpus.set(a.corpus, list);
  }

  const corpusReports = [...byCorpus.entries()]
    .sort((a, b) => b[1].length - a[1].length)
    .map(([label, group]) => evaluate(label, group, "all arms in the milestone corpus"));

  // The primary materiality question is about UNTREATED strong-agent behaviour
  // (§19): what a normal agent reads when nothing has narrowed its search.
  const untreated = arms.filter((a) => a.treated === false);
  const untreatedReport = evaluate("ALL-UNTREATED", untreated,
    "every untreated arm VTRACE holds, pooled — the primary §19 materiality corpus");
  const allReport = evaluate("ALL-ARMS", arms, "every arm, treated and untreated, pooled");

  const anyMaterial = [...corpusReports, untreatedReport, allReport]
    .some((r) => r.b0 === "TRACK_B_CORPUS_MATERIAL");

  const out = {
    milestone: "M196A",
    instrument: "run_stage5_m196a_materiality.ts",
    gate: "M197 B0 — median repository-evidence tokens >= 20000 OR >= 25% of total model-facing tokens, over SUCCESSFUL arms",
    accounting: {
      numerator: "Read + Grep + Glob tool_result bytes, floor(chars/4) — M196's frozen authority",
      denominatorReconstructed: "distinct model-facing content (assistant text/thinking, tool inputs, tool results) + 5521 tool-schema tokens",
      denominatorProvider: "input_tokens + cache_creation_input_tokens + output_tokens; cache_read excluded per prereg §22",
      excluded: "model reasoning is counted in the DENOMINATOR only; task prompt, system prompt and tool schemas are never evidence",
    },
    totalArmsAccounted: arms.length,
    m194NegativeControl: corpusReports.find((r) => r.corpus === "M194") ?? null,
    primaryUntreatedCorpus: untreatedReport,
    allArmsPooled: allReport,
    perCorpus: corpusReports,
    verdict: anyMaterial ? "M197_MATERIAL_CORPUS_READY" : "M197_MATERIAL_CORPUS_NOT_READY",
  };
  writeFileSync(path.join(RESULTS, "stage5_m196a_materiality.json"), `${JSON.stringify(out, null, 2)}\n`);
  writeFileSync(path.join(RESULTS, "stage5_m196a_materiality_arms.jsonl"),
    `${arms.map((a) => JSON.stringify(a)).join("\n")}\n`);

  const row = (r: any) => `${String(r.corpus).padEnd(14)} arms=${String(r.arms).padStart(4)} ok=${String(r.successfulArms).padStart(4)} repos=${String(r.repositoryCount).padStart(2)}  medEvid=${String(r.medianRepositoryEvidenceTokens).padStart(6)} p90=${String(r.p90RepositoryEvidenceTokens).padStart(6)} max=${String(r.maxRepositoryEvidenceTokens).padStart(7)}  medShare=${String((r.medianShareReconstructed * 100).toFixed(1)).padStart(5)}%  ${r.b0}`;
  console.log(row(untreatedReport));
  console.log(row(allReport));
  console.log("");
  for (const r of corpusReports) console.log(row(r));
  console.log(`\ntotal arms accounted: ${arms.length}`);
  console.log(out.verdict);

}
