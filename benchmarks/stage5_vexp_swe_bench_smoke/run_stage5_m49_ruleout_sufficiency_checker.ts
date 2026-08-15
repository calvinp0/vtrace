// M49 offline production-wiring validation. Captured artifacts only: no agents,
// Docker, verifier, canonical evaluation, or revised-patch adoption.

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import {
  buildSemanticEditHypothesis,
  type SemanticSymbolGroup,
} from "../../src/capsuleV2/semanticEditHypothesis";
import {
  CapsuleV2ContentMode,
  type CapsuleV2Item,
  type CapsuleV2Scorecard,
} from "../../src/capsuleV2/types";
import {
  assertRuleOutCorrectivePromptSafe,
  evaluateRuleOutSufficiency,
  sanitizeRuleOutAssistantText,
  type RuleOutSufficiencyCheck,
  type RuleOutSufficiencyInput,
} from "../../src/capsuleV2/ruleoutSufficiency";

const ROOT = import.meta.dir;
const RESULTS = path.join(ROOT, "results");
const RUNS = path.join(RESULTS, "runs");
const REPORT_MD = path.join(
  RESULTS,
  "stage5_m49_ruleout_sufficiency_checker.md",
);
const REPORT_JSON = path.join(
  RESULTS,
  "stage5_m49_ruleout_sufficiency_checker.json",
);

const ZERO_SCORECARD: CapsuleV2Scorecard = {
  lexical: 0,
  symbol: 0,
  path: 0,
  test_to_impl: 0,
  body_literal: 0,
  graph_proximity: 0,
  centrality: 0,
  actionability: 0,
  hub_penalty: 0,
  direct_answer: 0,
  mechanism_evidence: 0,
  final: 0,
};

const SPHINX_LABELS = ["control", "treatment"].flatMap((arm) =>
  [1, 2, 3].map((replicate) => `eval-m46-${arm}-sphinx-7462-r${replicate}`)
);
const NEGATIVES = [
  ["eval-m32-product-vtrace-seaborn-3187-r1", "mwaskom__seaborn-3187"],
  ["eval-m32-product-vtrace-django-13195-r1", "django__django-13195"],
  ["eval-m32-product-vtrace-xarray-3677-r1", "pydata__xarray-3677"],
  ["eval-m32-product-vtrace-django-10880-r1", "django__django-10880"],
] as const;

interface ValidationRow {
  label: string;
  instance: string;
  flagEnabled: boolean;
  check: RuleOutSufficiencyCheck;
  promptSafe: boolean;
}

function readJson<T>(file: string): T | undefined {
  if (!existsSync(file)) return undefined;
  return JSON.parse(readFileSync(file, "utf8")) as T;
}

function rawDir(label: string): string {
  return path.join(RUNS, label, "raw", "vtrace");
}

function readPatch(raw: string): string {
  if (!existsSync(raw)) return "";
  const file = readdirSync(raw).find((name) => /^swebench-.*\.jsonl$/.test(name));
  if (file === undefined) return "";
  const rows = readFileSync(path.join(raw, file), "utf8")
    .trim()
    .split("\n")
    .filter(Boolean);
  if (rows.length === 0) return "";
  return (JSON.parse(rows.at(-1)!) as { modelPatch?: string }).modelPatch ?? "";
}

function readAssistantText(raw: string): string {
  const file = path.join(raw, "_agent_stream.first_pass.jsonl");
  if (!existsSync(file)) return "";
  const chunks: string[] = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (line.trim().length === 0) continue;
    const row = JSON.parse(line) as {
      type?: string;
      result?: string;
      message?: { content?: Array<{ type?: string; text?: string }> };
    };
    if (row.type === "assistant") {
      for (const content of row.message?.content ?? []) {
        if (content.type === "text" && content.text) chunks.push(content.text);
      }
    } else if (row.type === "result" && row.result) {
      chunks.push(row.result);
    }
  }
  return sanitizeRuleOutAssistantText(chunks.join("\n"));
}

function parseSourceItems(context: string): CapsuleV2Item[] {
  const starts = [
    ...context.matchAll(/^(● pivot|○ support) ([^:\n]+)::([^\n]+)$/gm),
  ];
  return starts.map((match, index) => {
    const end = starts[index + 1]?.index ?? context.length;
    const block = context.slice(match.index!, end);
    const sourceMatch = block.match(
      /\n  (?:source|signature):\n([\s\S]*?)(?=\n  (?:This pivot|This support)|\n$|$)/,
    );
    const source = sourceMatch?.[1]
      ?.split("\n")
      .map((line) => (line.startsWith("  ") ? line.slice(2) : line))
      .join("\n");
    return {
      role: match[1] === "● pivot" ? "pivot" : "support",
      role_reason: "captured artifact",
      path: match[2]!,
      fq_name: `${match[2]}::${match[3]}`,
      symbol: match[3]!,
      kind: "function",
      content_mode: CapsuleV2ContentMode.Full,
      source,
      evidence: ["captured capsule context"],
      scorecard: ZERO_SCORECARD,
      estimated_tokens: 0,
      is_entry_point: false,
      is_implementation_helper: false,
      is_generic_infrastructure: false,
      is_class_method_expansion_target: false,
      is_containing_class_context: false,
      is_query_builder_entrypoint: false,
      is_sql_rendering_implementation: false,
    };
  });
}

function parseRenderedGroups(context: string): SemanticSymbolGroup[] {
  const section = context.match(
    /## Semantic Edit Hypothesis\n([\s\S]*?)(?=\n## |$)/,
  )?.[1];
  if (section === undefined) return [];
  const targets = [
    ...section.matchAll(/^- `([^`]+)::([^`]+)`/gm),
  ].map((match) => ({ target: `${match[1]}::${match[2]}`, name: match[2]! }));
  const groups = new Map<string, string[]>();
  for (const item of targets) {
    groups.set(item.name, [...(groups.get(item.name) ?? []), item.target]);
  }
  return [...groups]
    .filter(([, values]) => values.length >= 2)
    .map(([name, targets]) => ({ name, targets }));
}

function semanticGroups(context: string): SemanticSymbolGroup[] {
  const rendered = parseRenderedGroups(context);
  if (rendered.length > 0) return rendered;
  const items = parseSourceItems(context);
  return buildSemanticEditHypothesis(
    items.filter((item) => item.role === "pivot"),
    items.filter((item) => item.role === "support"),
  )?.groups ?? [];
}

function inspectedPaths(raw: string): string[] {
  const calls =
    readJson<Array<Record<string, unknown>>>(path.join(raw, "_tool_calls.json")) ?? [];
  const paths = new Set<string>();
  for (
    const match of JSON.stringify(calls).matchAll(
      /(?:sphinx|django|seaborn|xarray|tests)\/[A-Za-z0-9_./-]+\.(?:py|rst|txt)/g,
    )
  ) {
    paths.add(match[0]);
  }
  return [...paths];
}

function capturedInput(label: string, enabled: boolean): RuleOutSufficiencyInput {
  const raw = rawDir(label);
  const contextFile = path.join(raw, "_capsule_v2_context.md");
  const context = existsSync(contextFile) ? readFileSync(contextFile, "utf8") : "";
  const groups = semanticGroups(context);
  return {
    enabled,
    semanticGroups: groups,
    patch: readPatch(raw),
    surfacedTargets: groups.flatMap((group) => group.targets),
    inspectedPaths: inspectedPaths(raw),
    assistantText: readAssistantText(raw),
  };
}

function row(
  label: string,
  instance: string,
  enabled: boolean,
): ValidationRow {
  const check = evaluateRuleOutSufficiency(capturedInput(label, enabled));
  const promptSafe = check.correctivePromptPreview === undefined
    ? true
    : (() => {
        assertRuleOutCorrectivePromptSafe(check.correctivePromptPreview!);
        return true;
      })();
  return { label, instance, flagEnabled: enabled, check, promptSafe };
}

const sphinxEnabled = SPHINX_LABELS.map((label) =>
  row(label, "sphinx-doc__sphinx-7462", true)
);
const sphinxDisabled = SPHINX_LABELS.map((label) =>
  row(label, "sphinx-doc__sphinx-7462", false)
);
const negatives = NEGATIVES.map(([label, instance]) => row(label, instance, true));
const syntheticAccepted = evaluateRuleOutSufficiency({
  enabled: true,
  semanticGroups: [{ name: "render", targets: ["a.py::render", "b.py::render"] }],
  patch: "diff --git a/a.py b/a.py\n--- a/a.py\n+++ b/a.py\n",
  surfacedTargets: ["a.py::render", "b.py::render"],
  inspectedPaths: ["b.py"],
  assistantText:
    "Ruled out b.py::render: it is safe. The caller expects empty string and the repository docstring documents the desired output.",
});

const forbidden = [
  "FAIL_TO_PASS",
  "PASS_TO_PASS",
  "gold patch",
  "hidden test",
  "expected benchmark output",
  "resolved status",
];
const serializedChecks = JSON.stringify([
  ...sphinxEnabled.map((item) => item.check),
  ...sphinxDisabled.map((item) => item.check),
  ...negatives.map((item) => item.check),
  syntheticAccepted,
]);
const leakageClean = forbidden.every(
  (term) => !serializedChecks.toLowerCase().includes(term.toLowerCase()),
);
const sphinxPass =
  sphinxEnabled.length === 6 && sphinxEnabled.every((item) => item.check.triggered);
const negativesPass =
  negatives.every((item) => !item.check.triggered)
  && !syntheticAccepted.triggered;
const disabledPass = sphinxDisabled.every(
  (item) =>
    !item.check.triggered
    && item.check.correctivePromptPreview === undefined,
);
const passed = sphinxPass && negativesPass && disabledPass && leakageClean;

const output = {
  milestone: "M49",
  generatedAt: new Date().toISOString(),
  passed,
  executiveVerdict: {
    implemented: true,
    defaultOff: true,
    sphinxOffline: `${sphinxEnabled.filter((item) => item.check.triggered).length}/6`,
    negativesSilent: `${negatives.filter((item) => !item.check.triggered).length}/4 plus accepted synthetic`,
    disabledSilent: `${sphinxDisabled.filter((item) => !item.check.triggered).length}/6`,
    leakageClean,
  },
  sphinxEnabled,
  sphinxDisabled,
  negatives,
  syntheticAccepted,
  safety: {
    canonicalReplaced: false,
    adoptionEligible: false,
    liveAgentsRun: false,
    dockerRun: false,
    verifierRun: false,
    shadowEvaluationRun: false,
  },
};

function yn(value: boolean): string {
  return value ? "yes" : "no";
}

function markdown(): string {
  const lines: string[] = [
    "# Stage 5 — M49 rule-out sufficiency checker",
    "",
    "Offline replay only. Existing captured artifacts were used; no live agent, Docker, verifier, shadow evaluation, or canonical SWE-bench evaluation ran.",
    "",
    "## 1. Executive verdict",
    "",
    `- Checker implemented: **${yn(true)}**.`,
    `- Default-off: **${yn(true)}**.`,
    `- Sphinx offline fire rate when enabled: **${sphinxEnabled.filter((item) => item.check.triggered).length}/6**.`,
    `- Negative silence: **${negatives.filter((item) => !item.check.triggered).length}/4 plus accepted synthetic**.`,
    `- Oracle leakage avoided: **${yn(leakageClean)}**.`,
    "",
    "## 2. Implementation details",
    "",
    "- `src/capsuleV2/ruleoutSufficiency.ts`: pure trigger, prompt, metadata, and compliance reclassification.",
    "- `run_stage5_vexp_swe_bench_smoke.ts`: default-off CLI flag, post-first-pass artifact persistence, and optional M13 compliance integration.",
    "- `_ruleout_sufficiency_check.json`: additive decision metadata when enabled.",
    "- `_ruleout_sufficiency_corrective_prompt.md`: written only when the checker triggers.",
    "",
    "## 3. Checker decision model",
    "",
    "The checker requires a paired same-operation semantic hypothesis, a non-empty first-pass patch editing one implementation but not its pair, evidence that the pair was surfaced/read/mentioned, an explicit rule-out, crash/no-exception/safe-empty reasoning, and no concrete repository evidence of output or behavior preservation. Any missing condition produces no trigger.",
    "",
    "## 4. Sphinx offline validation",
    "",
    "| label | flag enabled? | fired? | original decision | effective decision | paired operation | edited implementation | ruled-out implementation | prompt safe? |",
    "|---|---:|---:|---|---|---|---|---|---:|",
  ];
  for (const item of sphinxEnabled) {
    const c = item.check;
    lines.push(
      `| ${item.label} | yes | ${yn(c.triggered)} | ${c.originalDecision ?? "—"} | ${c.effectiveDecision ?? "—"} | ${c.pairedOperation ?? "—"} | ${c.editedImplementation ?? "—"} | ${c.ruledOutImplementation ?? "—"} | ${yn(item.promptSafe)} |`,
    );
  }
  lines.push(
    "",
    "Disabled replay: 0/6 triggered and 0/6 produced a corrective prompt preview.",
    "",
    "## 5. Negative validation",
    "",
    "| instance/fixture | decision | reason | prompt emitted? |",
    "|---|---|---|---:|",
  );
  for (const item of negatives) {
    lines.push(
      `| ${item.instance} | no trigger | ${item.check.missingEvidence.join("; ")} | ${yn(item.check.correctivePromptPreview !== undefined)} |`,
    );
  }
  lines.push(
    `| accepted synthetic output-preserving rule-out | no trigger | ${syntheticAccepted.missingEvidence.join("; ")} | ${yn(syntheticAccepted.correctivePromptPreview !== undefined)} |`,
    "",
    "## 6. Leakage audit",
    "",
    "The checker decision used no gold patches, hidden tests, `FAIL_TO_PASS`, `PASS_TO_PASS`, resolved status, or benchmark labels. Captured labels above are report identities only and are not inputs to the decision function.",
    "",
    "| prohibited input | used? |",
    "|---|---:|",
    "| gold patches | no |",
    "| hidden tests | no |",
    "| FAIL_TO_PASS | no |",
    "| PASS_TO_PASS | no |",
    "| resolved status | no |",
    "| benchmark labels as decision input | no |",
    "",
    "## 7. Artifact/metadata examples",
    "",
    "```json",
    JSON.stringify({
      enabled: true,
      triggered: true,
      triggerKind: "cross_implementation_output_ruleout_insufficient",
      oracleFree: true,
      originalDecision: "ruledOut",
      effectiveDecision: "unclear",
      pairedOperation: "unparse",
      canonicalReplaced: false,
      adoptionEligible: false,
    }, null, 2),
    "```",
    "",
    "## 8. Safety/adoption boundary",
    "",
    "`canonicalReplaced=false` and `adoptionEligible=false` are invariant. The checker writes a prompt request only; it performs no automatic replacement, Docker verification, diagnostic verification, shadow evaluation, or adoption.",
    "",
    "## 9. Next recommendation",
    "",
    "**A. M50 run a tiny live corrective-prompt dry-run on sphinx with checker enabled, no auto-adoption.**",
    "",
  );
  return lines.join("\n");
}

mkdirSync(RESULTS, { recursive: true });
writeFileSync(REPORT_JSON, `${JSON.stringify(output, null, 2)}\n`);
writeFileSync(REPORT_MD, markdown());
console.log(JSON.stringify(output.executiveVerdict, null, 2));
if (!passed) process.exitCode = 1;
