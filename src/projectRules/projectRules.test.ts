import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";

import { listProjectRules } from "../db/repositories/projectRulesRepository";
import { persistObservation } from "../db/repositories/observationsRepository";
import { getLatestIndexRun } from "../db/repositories/indexRunsRepository";
import { listSymbolsForFile } from "../db/repositories/symbolsRepository";
import { openIndexerDatabase } from "../db/sqlite";
import { indexProject } from "../indexer/indexProject";
import { runPipelineOrchestrator } from "../runPipeline/runPipelineOrchestrator";
import { formatRunPipelineOrchestrationOutput } from "../runPipeline/formatRunPipelineOutput";
import { runCli } from "../cli";
import {
  ObservationKind,
  ObservationSource,
} from "../observations/types";
import { PASSIVE_CONSOLIDATION_TOOL_NAME } from "../observations/consolidation";
import {
  disableProjectRule,
  dismissProjectRule,
  generateProjectRuleCandidates,
  markProjectRulesStaleForRun,
  promoteProjectRule,
  selectRelevantProjectRules,
} from "./projectRules";
import { ProjectRuleStatus } from "./types";

test("repeated durable observations generate deterministic candidate rules without mutating evidence", async () => {
  await withProjectRuleFixture(async ({ repoRoot, db }) => {
    await indexProject({ repoRoot, db });
    const sourceRunId = getLatestIndexRun(db)?.id;

    const observations = [100, 200, 300].map((createdAtMs, index) => {
      return persistObservation(db, {
        repoRoot,
        kind: index === 0 ? ObservationKind.Decision : ObservationKind.Insight,
        source: ObservationSource.Manual,
        summary: `Service workflow convention ${index}`,
        body: "When changing service workflows, keep tests and docs in view.",
        queryText: "service workflow docs tests",
        sourceRunId,
        createdAtMs,
        linkedFilePaths: ["src/service.ts"],
      });
    });

    const result = generateProjectRuleCandidates(db, {
      repoRoot,
      nowMs: 1_000,
    });
    const second = generateProjectRuleCandidates(db, {
      repoRoot,
      nowMs: 2_000,
    });
    const rules = listProjectRules(db, { repoRoot });

    assert.equal(result.created.length, 1);
    assert.equal(second.created.length, 0);
    assert.equal(second.updated.length, 0);
    assert.equal(rules.length, 1);
    assert.equal(rules[0]!.status, ProjectRuleStatus.Candidate);
    assert.equal(rules[0]!.evidenceCount, 3);
    assert.deepEqual(rules[0]!.evidenceObservationIds, observations.map((observation) => observation.id).sort());
    assert.equal(rules[0]!.summary.includes("Repeated durable evidence"), true);
    assert.deepEqual(
      observations.map((observation) => observation.kind),
      [ObservationKind.Decision, ObservationKind.Insight, ObservationKind.Insight],
    );
  });
});

test("candidate threshold and raw passive ineligibility stay conservative", async () => {
  await withProjectRuleFixture(async ({ repoRoot, db }) => {
    await indexProject({ repoRoot, db });
    const sourceRunId = getLatestIndexRun(db)?.id;

    for (const createdAtMs of [100, 200]) {
      persistObservation(db, {
        repoRoot,
        kind: ObservationKind.Decision,
        source: ObservationSource.Manual,
        summary: "Below threshold service convention",
        body: "Two durable observations are not enough for a rule candidate.",
        sourceRunId,
        createdAtMs,
        linkedFilePaths: ["src/service.ts"],
      });
    }
    for (const createdAtMs of [300, 400, 500]) {
      persistObservation(db, {
        repoRoot,
        kind: ObservationKind.ToolCall,
        source: ObservationSource.McpAuto,
        toolName: "run_pipeline",
        summary: "Raw passive tool call",
        body: "tool=run_pipeline\nquery=service workflow",
        queryText: "service workflow",
        sourceRunId,
        createdAtMs,
        linkedFilePaths: ["src/models.ts"],
      });
    }

    const result = generateProjectRuleCandidates(db, {
      repoRoot,
      nowMs: 1_000,
    });

    assert.equal(result.created.length, 0);
    assert.equal(listProjectRules(db, { repoRoot }).length, 0);
  });
});

test("candidate generation dedupes and updates existing candidates with new matching evidence", async () => {
  await withProjectRuleFixture(async ({ repoRoot, db }) => {
    await indexProject({ repoRoot, db });
    const sourceRunId = getLatestIndexRun(db)?.id;

    for (const createdAtMs of [100, 200, 300]) {
      persistObservation(db, {
        repoRoot,
        kind: ObservationKind.Decision,
        source: ObservationSource.Manual,
        summary: `Service convention ${createdAtMs}`,
        body: "Keep service workflow changes coordinated.",
        sourceRunId,
        createdAtMs,
        linkedFilePaths: ["src/service.ts"],
      });
    }

    const first = generateProjectRuleCandidates(db, { repoRoot, nowMs: 1_000 });
    const ruleId = first.created[0]!.id;

    persistObservation(db, {
      repoRoot,
      kind: ObservationKind.Insight,
      source: ObservationSource.Manual,
      summary: "Another service convention",
      body: "The same service scope has one more durable evidence point.",
      sourceRunId,
      createdAtMs: 400,
      linkedFilePaths: ["src/service.ts"],
    });

    const second = generateProjectRuleCandidates(db, { repoRoot, nowMs: 2_000 });
    const rules = listProjectRules(db, { repoRoot });

    assert.equal(second.created.length, 0);
    assert.equal(second.updated.length, 1);
    assert.equal(rules.length, 1);
    assert.equal(rules[0]!.id, ruleId);
    assert.equal(rules[0]!.evidenceCount, 4);
    assert.equal(rules[0]!.updatedAtMs, 2_000);
  });
});

test("consolidated passive summaries and repeated anti-patterns can generate candidates", async () => {
  await withProjectRuleFixture(async ({ repoRoot, db }) => {
    await indexProject({ repoRoot, db });
    const sourceRunId = getLatestIndexRun(db)?.id;

    for (const createdAtMs of [100, 200, 300]) {
      persistObservation(db, {
        repoRoot,
        kind: ObservationKind.Insight,
        source: ObservationSource.McpAuto,
        toolName: PASSIVE_CONSOLIDATION_TOOL_NAME,
        summary: `Consolidated repeated context building ${createdAtMs}`,
        body: `consolidated=true\nsource_kind=tool_call\nsource_observation_count=3\nordinal=${createdAtMs}`,
        queryText: "service context workflow",
        sourceRunId,
        createdAtMs,
        linkedFilePaths: ["src/service.ts"],
      });
      persistObservation(db, {
        repoRoot,
        kind: ObservationKind.DeadEnd,
        source: ObservationSource.McpAuto,
        toolName: "detect_anti_patterns",
        summary: `Possible file thrashing ${createdAtMs}`,
        body: `type=anti_pattern\nanti_pattern=file_thrashing\nseverity=medium\nordinal=${createdAtMs}`,
        queryText: "file_thrashing src/models.ts",
        sourceRunId,
        createdAtMs: createdAtMs + 10,
        linkedFilePaths: ["src/models.ts"],
      });
    }

    const result = generateProjectRuleCandidates(db, { repoRoot, nowMs: 1_000 });
    const summaries = result.created.map((rule) => rule.summary).sort();

    assert.equal(result.created.length, 2);
    assert.equal(summaries.some((summary) => summary.includes("Repeated context-building activity")), true);
    assert.equal(summaries.some((summary) => summary.includes("Repeated file_thrashing observations")), true);
  });
});

test("manual promotion, dismiss, disable, and relevance selection keep candidates non-authoritative", async () => {
  await withProjectRuleFixture(async ({ repoRoot, db }) => {
    await indexProject({ repoRoot, db });
    const sourceRunId = getLatestIndexRun(db)?.id;

    seedDurableRuleEvidence(db, repoRoot, "src/service.ts", sourceRunId);
    const generated = generateProjectRuleCandidates(db, { repoRoot, nowMs: 1_000 });
    const candidate = generated.created[0]!;
    const beforePromotion = selectRelevantProjectRules(db, {
      repoRoot,
      query: "change src/service.ts service workflow",
      linkedFilePaths: ["src/service.ts"],
    });

    assert.equal(beforePromotion.active.length, 0);
    assert.equal(beforePromotion.candidates.length, 1);

    const active = promoteProjectRule(db, candidate.id, 2_000);
    const afterPromotion = selectRelevantProjectRules(db, {
      repoRoot,
      query: "change src/service.ts service workflow",
      linkedFilePaths: ["src/service.ts"],
    });
    const irrelevant = selectRelevantProjectRules(db, {
      repoRoot,
      query: "models only",
      linkedFilePaths: ["src/models.ts"],
    });
    const disabled = disableProjectRule(db, active.id, 3_000);

    assert.equal(active.status, ProjectRuleStatus.Active);
    assert.equal(afterPromotion.active[0]!.rule.id, active.id);
    assert.equal(irrelevant.active.length, 0);
    assert.equal(disabled.status, ProjectRuleStatus.Disabled);
    assert.equal(selectRelevantProjectRules(db, {
      repoRoot,
      query: "change src/service.ts service workflow",
      linkedFilePaths: ["src/service.ts"],
    }).active.length, 0);

    seedDurableRuleEvidence(db, repoRoot, "src/models.ts", sourceRunId, 500);
    const secondGenerated = generateProjectRuleCandidates(db, { repoRoot, nowMs: 4_000 });
    const secondCandidate = secondGenerated.created.find((rule) => rule.id !== candidate.id)!;
    const dismissed = dismissProjectRule(db, secondCandidate.id, 5_000);

    assert.equal(dismissed.status, ProjectRuleStatus.Dismissed);
    assert.equal(selectRelevantProjectRules(db, {
      repoRoot,
      query: "change src/models.ts model workflow",
      linkedFilePaths: ["src/models.ts"],
    }).candidates.length, 0);
  });
});

test("active rules are injected into formatted run_pipeline output with deterministic caps", async () => {
  await withProjectRuleFixture(async ({ repoRoot, db }) => {
    await indexProject({ repoRoot, db });
    const sourceRunId = getLatestIndexRun(db)?.id;

    for (const [index, filePath] of ["src/service.ts", "src/models.ts", "src/extra.ts", "src/fourth.ts"].entries()) {
      if (filePath.endsWith("extra.ts") || filePath.endsWith("fourth.ts")) {
        await writeFile(path.join(repoRoot, filePath), `export const value${index} = ${index};\n`);
      }
      seedDurableRuleEvidence(db, repoRoot, filePath, sourceRunId, 100 + index * 10);
    }

    const generated = generateProjectRuleCandidates(db, { repoRoot, nowMs: 1_000 });
    for (const rule of generated.created) {
      promoteProjectRule(db, rule.id, 2_000 + rule.id.charCodeAt(rule.id.length - 1));
    }

    const output = formatRunPipelineOrchestrationOutput(runPipelineOrchestrator(db, repoRoot, {
      query: "change src/service.ts service workflow",
      includeMemory: true,
      intent: "modify",
    }));

    assert.equal(output.rules.active.length <= 3, true);
    assert.equal(output.rules.active[0]!.status, ProjectRuleStatus.Active);
    assert.equal(output.rules.active.some((rule) => rule.scope.files.includes("src/service.ts")), true);
    assert.equal(output.rules.candidates.length, 0);
    assert.equal(output.diagnostics.rules.activeIncluded, true);
  });
});

test("rules linked to changed code become stale and stale active rules are not injected", async () => {
  await withProjectRuleFixture(async ({ repoRoot, db }) => {
    await indexProject({ repoRoot, db });
    const sourceRunId = getLatestIndexRun(db)?.id;

    seedDurableRuleEvidence(db, repoRoot, "src/service.ts", sourceRunId);
    const generated = generateProjectRuleCandidates(db, { repoRoot, nowMs: 1_000 });
    const active = promoteProjectRule(db, generated.created[0]!.id, 2_000);

    await writeServiceFile(repoRoot, "loadUser");
    await indexProject({ repoRoot, db });
    const latestRunId = getLatestIndexRun(db)!.id;
    const stale = markProjectRulesStaleForRun(db, {
      repoRoot,
      runId: latestRunId,
      nowMs: 3_000,
    });
    const selected = selectRelevantProjectRules(db, {
      repoRoot,
      query: "change src/service.ts service workflow",
      linkedFilePaths: ["src/service.ts"],
    });

    assert.equal(stale.length, 1);
    assert.equal(stale[0]!.id, active.id);
    assert.equal(stale[0]!.status, ProjectRuleStatus.Stale);
    assert.equal(stale[0]!.staleMetadata?.reasons.some((reason) => reason.kind === "file_modified"), true);
    assert.equal(selected.active.length, 0);
  });
});

test("rules command lists, generates, and promotes inspectable rules", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "vexb-project-rules-cli-"));
  const repoRoot = path.join(root, "repo");
  const dbPath = path.join(root, "rules.sqlite");
  const db = openIndexerDatabase(dbPath);
  let dbClosed = false;

  try {
    await mkdir(path.join(repoRoot, "src"), { recursive: true });
    await writeModelFile(repoRoot);
    await writeServiceFile(repoRoot, "readUser");
    await indexProject({ repoRoot, db });
    seedDurableRuleEvidence(db, repoRoot, "src/service.ts", getLatestIndexRun(db)?.id);
    db.close();
    dbClosed = true;

    const generated = await runCli(["rules", "generate", repoRoot], { dbPath });
    const generatedOutput = JSON.parse(generated.stdout);
    const ruleId = generatedOutput.created[0].id;
    const listed = await runCli(["rules", "list", repoRoot], { dbPath });
    const promoted = await runCli(["rules", "promote", repoRoot, ruleId], { dbPath });
    const promotedOutput = JSON.parse(promoted.stdout);

    assert.equal(generated.exitCode, 0);
    assert.equal(listed.exitCode, 0);
    assert.equal(JSON.parse(listed.stdout).rules[0].status, ProjectRuleStatus.Candidate);
    assert.equal(promoted.exitCode, 0);
    assert.equal(promotedOutput.rule.id, ruleId);
    assert.equal(promotedOutput.rule.status, ProjectRuleStatus.Active);
  } finally {
    if (!dbClosed) {
      db.close();
    }
    await rm(root, { recursive: true, force: true });
  }
});

function seedDurableRuleEvidence(
  db: ReturnType<typeof openIndexerDatabase>,
  repoRoot: string,
  filePath: string,
  sourceRunId: number | undefined,
  baseCreatedAtMs = 100,
): void {
  const symbol = listSymbolsForFile(db, filePath)[0];

  for (const [index, createdAtMs] of [baseCreatedAtMs, baseCreatedAtMs + 1, baseCreatedAtMs + 2].entries()) {
    persistObservation(db, {
      repoRoot,
      kind: ObservationKind.Decision,
      source: ObservationSource.Manual,
      summary: `Rule evidence ${filePath} ${index}`,
      body: `Repeated durable convention evidence for ${filePath}.`,
      queryText: `${filePath} workflow`,
      sourceRunId,
      createdAtMs,
      linkedFilePaths: [filePath],
      linkedSymbolIds: symbol === undefined ? [] : [symbol.id],
    });
  }
}

async function withProjectRuleFixture(
  run: (input: { repoRoot: string; db: ReturnType<typeof openIndexerDatabase> }) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "vexb-project-rules-"));
  const repoRoot = path.join(root, "repo");
  const db = openIndexerDatabase();

  try {
    await mkdir(path.join(repoRoot, "src"), { recursive: true });
    await writeModelFile(repoRoot);
    await writeServiceFile(repoRoot, "readUser");
    await run({ repoRoot, db });
  } finally {
    db.close();
    await rm(root, { recursive: true, force: true });
  }
}

async function writeModelFile(repoRoot: string): Promise<void> {
  await writeFile(
    path.join(repoRoot, "src", "models.ts"),
    [
      "export interface User {",
      "  id: string;",
      "}",
      "",
    ].join("\n"),
  );
}

async function writeServiceFile(repoRoot: string, functionName: string): Promise<void> {
  await writeFile(
    path.join(repoRoot, "src", "service.ts"),
    [
      "import type { User } from \"./models\";",
      "",
      `export function ${functionName}(id: string): User {`,
      "  return { id };",
      "}",
      "",
    ].join("\n"),
  );
}
