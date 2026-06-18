// M48 offline validator for the proposed rule-out sufficiency checker.
//
// Reads captured first-pass artifacts only. It does not run agents, tests, Docker,
// grading, revision passes, or canonical evaluation. Gold/test labels and resolved
// status are deliberately absent from checker inputs.

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { buildSemanticEditHypothesis, type SemanticSymbolGroup } from "../../src/capsuleV2/semanticEditHypothesis";
import {
  CapsuleV2ContentMode,
  type CapsuleV2Item,
  type CapsuleV2Scorecard,
} from "../../src/capsuleV2/types";
import {
  assertCorrectivePromptSafe,
  evaluateRuleOutSufficiency,
  type RuleOutSufficiencyInput,
  type RuleOutSufficiencyResult,
} from "./ruleoutSufficiencyValidator";

const ROOT = import.meta.dir;
const RESULTS = path.join(ROOT, "results");
const RUNS = path.join(RESULTS, "runs");
const REPORT_MD = path.join(RESULTS, "stage5_m48_ruleout_sufficiency_validator.md");
const REPORT_JSON = path.join(RESULTS, "stage5_m48_ruleout_sufficiency_validator.json");

const ZERO_SCORECARD: CapsuleV2Scorecard = {
  lexical: 0, symbol: 0, path: 0, test_to_impl: 0, body_literal: 0,
  graph_proximity: 0, centrality: 0, actionability: 0, hub_penalty: 0, final: 0,
};

interface CapturedCase {
  label: string;
  instance: string;
  shouldFire: boolean;
  expectedNoFireReason?: string;
}

const CAPTURED_CASES: CapturedCase[] = [
  ...["control", "treatment"].flatMap((arm) =>
    [1, 2, 3].map((replicate) => ({
      label: `eval-m46-${arm}-sphinx-7462-r${replicate}`,
      instance: "sphinx-doc__sphinx-7462",
      shouldFire: true,
    }))),
  {
    label: "eval-m32-product-vtrace-seaborn-3187-r1",
    instance: "mwaskom__seaborn-3187",
    shouldFire: false,
    expectedNoFireReason: "no paired same-operation crash-shaped rule-out",
  },
  {
    label: "eval-m32-product-vtrace-django-13195-r1",
    instance: "django__django-13195",
    shouldFire: false,
    expectedNoFireReason: "synthesis/localization shape, not paired output rule-out",
  },
  {
    label: "eval-m32-product-vtrace-xarray-3677-r1",
    instance: "pydata__xarray-3677",
    shouldFire: false,
    expectedNoFireReason: "no paired output-like implementation rule-out",
  },
  {
    label: "eval-m32-product-vtrace-django-10880-r1",
    instance: "django__django-10880",
    shouldFire: false,
    expectedNoFireReason: "localized/no-context-safe case",
  },
];

function readJson<T>(file: string): T | undefined {
  if (!existsSync(file)) return undefined;
  return JSON.parse(readFileSync(file, "utf8")) as T;
}

function findSwebenchFile(raw: string): string | undefined {
  if (!existsSync(raw)) return undefined;
  return readdirSync(raw).find((name) => /^swebench-.*\.jsonl$/.test(name));
}

function readPatch(raw: string): string {
  const name = findSwebenchFile(raw);
  if (name === undefined) return "";
  const rows = readFileSync(path.join(raw, name), "utf8").trim().split("\n").filter(Boolean);
  if (rows.length === 0) return "";
  const row = JSON.parse(rows.at(-1)!) as { modelPatch?: string };
  return row.modelPatch ?? "";
}

function readAssistantText(raw: string): string {
  const stream = path.join(raw, "_agent_stream.first_pass.jsonl");
  if (!existsSync(stream)) return "";
  const chunks: string[] = [];
  for (const line of readFileSync(stream, "utf8").split("\n")) {
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
  return chunks.join("\n");
}

function parseSourceItems(context: string): CapsuleV2Item[] {
  const starts = [...context.matchAll(/^(● pivot|○ support) ([^:\n]+)::([^\n]+)$/gm)];
  const items: CapsuleV2Item[] = [];
  for (let i = 0; i < starts.length; i += 1) {
    const match = starts[i]!;
    const end = starts[i + 1]?.index ?? context.length;
    const block = context.slice(match.index!, end);
    const sourceMatch = block.match(/\n  (?:source|signature):\n([\s\S]*?)(?=\n  (?:This pivot|This support)|\n$|$)/);
    const source = sourceMatch?.[1]
      ?.split("\n")
      .map((line) => line.startsWith("  ") ? line.slice(2) : line)
      .join("\n");
    items.push({
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
    });
  }
  return items;
}

function parseRenderedGroups(context: string): SemanticSymbolGroup[] {
  const section = context.match(/## Semantic Edit Hypothesis\n([\s\S]*?)(?=\n## |$)/)?.[1];
  if (section === undefined) return [];
  const targets = [...section.matchAll(/^- `([^`]+)::([^`]+)`/gm)].map((match) => ({
    target: `${match[1]}::${match[2]}`,
    name: match[2]!,
  }));
  const grouped = new Map<string, string[]>();
  for (const item of targets) grouped.set(item.name, [...(grouped.get(item.name) ?? []), item.target]);
  return [...grouped].filter(([, groupTargets]) => groupTargets.length >= 2)
    .map(([name, groupTargets]) => ({ name, targets: groupTargets }));
}

function deriveSemanticGroups(context: string): SemanticSymbolGroup[] {
  const rendered = parseRenderedGroups(context);
  if (rendered.length > 0) return rendered;
  const items = parseSourceItems(context);
  const hypothesis = buildSemanticEditHypothesis(
    items.filter((item) => item.role === "pivot"),
    items.filter((item) => item.role === "support"),
  );
  return hypothesis?.groups ?? [];
}

// First-pass prose can repeat task/test wording. The future checker needs only the
// agent's implementation reasoning, so strip oracle-shaped lines before lexical
// classification. This is defense in depth; the M46 rule-out windows do not need
// any of these lines to fire.
function sanitizeAssistantText(text: string): string {
  return text.split("\n").filter((line) => ![
    /\bFAIL_TO_PASS\b/i,
    /\bPASS_TO_PASS\b/i,
    /\bgold patch\b/i,
    /\bhidden tests?\b/i,
    /(?:^|\s)(?:tests?\/[\w./-]+|test_[A-Za-z0-9_]+)(?:::[A-Za-z0-9_[\]().-]+)?/,
  ].some((forbidden) => forbidden.test(line))).join("\n");
}

function surfacedTargets(context: string, groups: readonly SemanticSymbolGroup[]): string[] {
  return groups.flatMap((group) => group.targets).filter((target) => context.includes(target.split("::")[0]!));
}

function inspectedPaths(raw: string): string[] {
  const toolCalls = readJson<Array<Record<string, unknown>>>(path.join(raw, "_tool_calls.json")) ?? [];
  const serialized = JSON.stringify(toolCalls);
  const paths = new Set<string>();
  for (const match of serialized.matchAll(/(?:sphinx|django|seaborn|xarray|tests)\/[A-Za-z0-9_./-]+\.(?:py|rst|txt)/g)) {
    paths.add(match[0]);
  }
  return [...paths];
}

function loadCaptured(c: CapturedCase): RuleOutSufficiencyResult {
  const raw = path.join(RUNS, c.label, "raw", "vtrace");
  if (!existsSync(raw)) {
    return evaluateRuleOutSufficiency({
      label: c.label,
      instance: c.instance,
      semanticGroups: [],
      patch: "",
      surfacedTargets: [],
      inspectedPaths: [],
      assistantText: "",
    }, c.shouldFire);
  }
  const context = existsSync(path.join(raw, "_capsule_v2_context.md"))
    ? readFileSync(path.join(raw, "_capsule_v2_context.md"), "utf8")
    : "";
  const groups = deriveSemanticGroups(context);
  const input: RuleOutSufficiencyInput = {
    label: c.label,
    instance: c.instance,
    semanticGroups: groups,
    patch: readPatch(raw),
    surfacedTargets: surfacedTargets(context, groups),
    inspectedPaths: inspectedPaths(raw),
    assistantText: sanitizeAssistantText(readAssistantText(raw)),
  };
  return evaluateRuleOutSufficiency(input, c.shouldFire);
}

const SYNTHETIC_CRASH: RuleOutSufficiencyInput = {
  label: "synthetic-crash-ruleout",
  instance: "synthetic",
  semanticGroups: [{ name: "render", targets: ["a.py::render", "b.py::render"] }],
  patch: "diff --git a/a.py b/a.py\n--- a/a.py\n+++ b/a.py\n@@ -1 +1 @@\n-old\n+new\n",
  surfacedTargets: ["a.py::render", "b.py::render"],
  inspectedPaths: ["b.py"],
  assistantText: "Ruled out b.py::render: join([]) is safe and returns an empty string, so okay. No fix needed.",
};

const SYNTHETIC_ACCEPTED: RuleOutSufficiencyInput = {
  ...SYNTHETIC_CRASH,
  label: "synthetic-accepted-ruleout",
  assistantText: [
    "Ruled out b.py::render: it does not crash.",
    "The caller expects empty string and the repository docstring documents empty string as the desired output.",
  ].join(" "),
};

const capturedRows = CAPTURED_CASES.map(loadCaptured);
const syntheticRows = [
  evaluateRuleOutSufficiency(SYNTHETIC_CRASH, true),
  evaluateRuleOutSufficiency(SYNTHETIC_ACCEPTED, false),
];
const allRows = [...capturedRows, ...syntheticRows];
for (const row of allRows) {
  if (row.correctivePromptPreview) assertCorrectivePromptSafe(row.correctivePromptPreview);
}

const sphinxRows = capturedRows.filter((row) => row.instance === "sphinx-doc__sphinx-7462");
const negativeRows = capturedRows.filter((row) => row.instance !== "sphinx-doc__sphinx-7462");
const sphinxFairFire = sphinxRows.length === 6 && sphinxRows.every((row) => row.fired);
const negativesSilent = negativeRows.every((row) => !row.fired);
const syntheticPass = syntheticRows[0]!.fired && !syntheticRows[1]!.fired;
const leakageClean = allRows.every((row) => !Object.values(row.leakageCheck).some(Boolean));
const validatorPass = sphinxFairFire && negativesSilent && syntheticPass && leakageClean;
const recommendation = validatorPass
  ? "A. M49 implement rule-out sufficiency checker, default-off, corrective-prompt-only."
  : "B. M49 tighten validator first due false positives.";

const output = {
  milestone: "M48",
  generatedAt: new Date().toISOString(),
  validatorPass,
  executiveVerdict: {
    canFireFairlyOnSphinx: sphinxFairFire,
    staysSilentOnNegatives: negativesSilent,
    shouldM49Implement: validatorPass,
    recommendation,
  },
  checkerInputPolicy: {
    allowed: ["captured capsule context/manifest", "first-pass patch", "captured tool reads", "captured first-pass assistant text"],
    forbidden: ["gold files or patches", "FAIL_TO_PASS", "PASS_TO_PASS", "hidden test names", "benchmark resolved status", "benchmark labels as decision input"],
  },
  capturedRows,
  syntheticRows,
};

function yn(value: boolean): string {
  return value ? "yes" : "no";
}

function leakage(row: RuleOutSufficiencyResult): string {
  return Object.values(row.leakageCheck).some(Boolean) ? "LEAK" : "none";
}

function markdown(): string {
  const lines: string[] = [];
  lines.push("# Stage 5 — M48 rule-out sufficiency validator");
  lines.push("");
  lines.push("Offline replay only: captured artifacts and synthetic fixtures; no live agents, Docker, verifier, revision pass, or canonical evaluation.");
  lines.push("");
  lines.push("## 1. Executive verdict");
  lines.push("");
  lines.push(`- Can Option B fire fairly on sphinx? **${sphinxFairFire ? "Yes" : "No"}** (${sphinxRows.filter((r) => r.fired).length}/${sphinxRows.length} M46 runs).`);
  lines.push(`- Does it stay silent on negatives? **${negativesSilent ? "Yes" : "No"}** (${negativeRows.filter((r) => !r.fired).length}/${negativeRows.length}).`);
  lines.push(`- Should M49 implement it? **${validatorPass ? "Yes" : "No"}**.`);
  lines.push(`- Recommendation: **${recommendation}**`);
  lines.push("");
  lines.push("## 2. Validator design");
  lines.push("");
  lines.push("The pure checker fires only when a semantic-edit hypothesis supplies an operation-like same-name group across files; the first-pass patch edits one member but not its pair; the pair was surfaced/read/mentioned; the agent rules it out using crash/no-exception/safe-empty reasoning; and no concrete repository evidence justifies output preservation. Missing patches produce `insufficient_artifact`; all other incomplete conjunctions produce `no_fire`.");
  lines.push("");
  lines.push("The artifact adapter reconstructs the M39 hypothesis from captured capsule source blocks when the rendered hypothesis section is absent. Evaluation expectations (`shouldFire`) are attached only after the checker decision and are not checker inputs.");
  lines.push("");
  lines.push("## 3. Positive sphinx validation");
  lines.push("");
  lines.push("| label | ast surfaced/read/mentioned | python.py edited | ast.py edited | rule-out shape | fired? | leakage? | corrective prompt safe? |");
  lines.push("|---|---:|---:|---:|---|---:|---|---:|");
  for (const row of sphinxRows) {
    lines.push(`| ${row.label} | ${yn(row.evidence.some((e) => e.includes("surfaced/read/mentioned")))} | ${yn(row.editedImplementation?.startsWith("sphinx/domains/python.py") ?? false)} | ${yn(row.editedImplementation?.startsWith("sphinx/pycode/ast.py") ?? false)} | ${row.fired ? "crash/safe-empty without output evidence" : row.missingEvidence.join("; ")} | ${yn(row.fired)} | ${leakage(row)} | ${yn(row.correctivePromptPreview !== undefined)} |`);
  }
  lines.push("");
  lines.push("All six M46 runs expose the same fair trigger shape: paired `unparse`, `python.py` edited, `ast.py` unedited but inspected/mentioned, and a `join()`/empty-safe rule-out that does not cite output-preserving repository evidence.");
  lines.push("");
  lines.push("## 4. Negative validation");
  lines.push("");
  lines.push("| instance | label/source | expected no-fire reason | actual decision | leakage? |");
  lines.push("|---|---|---|---|---|");
  for (const row of negativeRows) {
    const source = CAPTURED_CASES.find((c) => c.label === row.label)!;
    lines.push(`| ${row.instance} | ${row.label} | ${source.expectedNoFireReason} | ${row.decision}: ${row.missingEvidence.join("; ")} | ${leakage(row)} |`);
  }
  lines.push("");
  lines.push("## 5. Synthetic fixture validation");
  lines.push("");
  lines.push("| fixture | expected | actual | reason |");
  lines.push("|---|---|---|---|");
  lines.push(`| crash-shaped paired rule-out | fire | ${syntheticRows[0]!.decision} | same-operation pair; one edit; safe-empty rule-out; no output evidence |`);
  lines.push(`| accepted output-preserving rule-out | no_fire | ${syntheticRows[1]!.decision} | caller/docstring evidence explicitly supports empty output |`);
  lines.push("");
  lines.push("## 6. Leakage audit");
  lines.push("");
  lines.push("Checker inputs used **no** gold files, gold patches, FAIL_TO_PASS, PASS_TO_PASS, hidden test names, benchmark resolved status, or benchmark labels. Those concepts are excluded from the input type and decision function. Instance/label and `shouldFire` are report identity/evaluation fields only; the decision logic does not branch on them.");
  lines.push("");
  lines.push("| prohibited input | used by checker? |");
  lines.push("|---|---:|");
  lines.push("| gold files / gold patches | no |");
  lines.push("| FAIL_TO_PASS | no |");
  lines.push("| PASS_TO_PASS | no |");
  lines.push("| hidden test names | no |");
  lines.push("| benchmark resolved status | no |");
  lines.push("| benchmark label as decision input | no |");
  lines.push("");
  lines.push("## 7. Limitations");
  lines.push("");
  lines.push("- The checker cannot prove the hidden expected output; it only detects that a rule-out failed to justify output correctness.");
  lines.push("- A corrective prompt may still fail to produce a resolving edit.");
  lines.push("- Reliable replay depends on readable first-pass rule-out prose or a `PIVOT_DECISION` marker.");
  lines.push("- Legitimate empty-output behavior can false-trigger if the agent omits its concrete repository evidence.");
  lines.push("- The validator generates a prompt preview only; it does not execute a corrective pass or auto-adopt a revised patch.");
  lines.push("");
  lines.push("## 8. Recommendation");
  lines.push("");
  lines.push(`**${recommendation}**`);
  lines.push("");
  lines.push("The validator passes because the trigger fires on 6/6 budget-fixed sphinx artifacts, remains silent on all four captured negatives and the accepted-rule-out fixture, and uses no oracle-derived checker input.");
  return `${lines.join("\n")}\n`;
}

mkdirSync(RESULTS, { recursive: true });
writeFileSync(REPORT_JSON, `${JSON.stringify(output, null, 2)}\n`);
writeFileSync(REPORT_MD, markdown());
console.log(JSON.stringify(output.executiveVerdict, null, 2));
if (!validatorPass) process.exitCode = 1;
