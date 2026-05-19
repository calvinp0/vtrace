import { createHash } from "node:crypto";
import type { Database } from "bun:sqlite";

import {
  listFileDiffsForRun,
  listSymbolDiffsForRun,
} from "../db/repositories/indexRunsRepository";
import { listObservations } from "../db/repositories/observationsRepository";
import {
  createActiveProjectRule as createActiveProjectRuleRecord,
  listProjectRules,
  updateProjectRuleStatus,
  upsertProjectRuleCandidate,
} from "../db/repositories/projectRulesRepository";
import { normalizeFilePath } from "../domain/types";
import { FileChangeType } from "../memory/types";
import { AntiPatternType } from "../observations/antiPatterns";
import { PASSIVE_CONSOLIDATION_TOOL_NAME } from "../observations/consolidation";
import {
  ObservationKind,
  ObservationSource,
  type Observation,
} from "../observations/types";
import {
  ProjectRuleConfidence,
  ProjectRuleEvidenceKind,
  ProjectRuleStatus,
  type GenerateProjectRuleCandidatesResult,
  type ProjectRuleCandidateGroup,
  type ProjectRuleRecord,
  type ProjectRuleScope,
  type ProjectRuleStaleMetadata,
  type ProjectRuleStaleReason,
  type SelectedProjectRule,
} from "./types";

export const DEFAULT_PROJECT_RULE_CANDIDATE_THRESHOLD = 3;
export const DEFAULT_ACTIVE_PROJECT_RULE_LIMIT = 3;
export const DEFAULT_CANDIDATE_PROJECT_RULE_PREVIEW_LIMIT = 3;

interface EvidenceItem {
  readonly observation: Observation;
  readonly evidenceKind: ProjectRuleEvidenceKind;
  readonly groupKind: "durable" | "consolidated_passive" | "anti_pattern";
  readonly antiPatternType?: string;
  readonly scopeKey: string;
  readonly scopeLabel: string;
  readonly scope: ProjectRuleScope;
}

export function createActiveProjectRule(
  db: Database,
  input: {
    readonly repoRoot: string;
    readonly summary: string;
    readonly files?: readonly string[];
    readonly symbolFqns?: readonly string[];
    readonly terms?: readonly string[];
    readonly toolNames?: readonly string[];
    readonly intents?: readonly string[];
    readonly antiPatternTypes?: readonly string[];
    readonly nowMs?: number;
  },
): ProjectRuleRecord {
  const summary = input.summary.trim();

  if (summary.length === 0) {
    throw new Error("summary is required");
  }

  const scope: ProjectRuleScope = {
    files: sortedUnique((input.files ?? []).map(normalizeFilePath)),
    symbolFqns: sortedUnique(input.symbolFqns ?? []),
    terms: sortedUnique([
      ...collectRuleTerms([summary]),
      ...(input.terms ?? []).flatMap((term) => collectRuleTerms([term])),
    ]),
    toolNames: sortedUnique(input.toolNames ?? []),
    intents: sortedUnique(input.intents ?? []),
    antiPatternTypes: sortedUnique(input.antiPatternTypes ?? []),
  };

  return createActiveProjectRuleRecord(db, {
    repoRoot: input.repoRoot,
    summary,
    scope,
    nowMs: input.nowMs,
  });
}

export function generateProjectRuleCandidates(
  db: Database,
  input: {
    readonly repoRoot: string;
    readonly threshold?: number;
    readonly nowMs?: number;
  },
): GenerateProjectRuleCandidatesResult {
  const threshold = input.threshold ?? DEFAULT_PROJECT_RULE_CANDIDATE_THRESHOLD;

  if (!Number.isInteger(threshold) || threshold < 2) {
    throw new Error("threshold must be an integer greater than or equal to 2");
  }

  const groups = buildProjectRuleCandidateGroups(
    listObservations(db).filter((observation) => observation.repoRoot === input.repoRoot),
    threshold,
  );
  const created: ProjectRuleRecord[] = [];
  const updated: ProjectRuleRecord[] = [];

  for (const group of groups) {
    const result = upsertProjectRuleCandidate(db, {
      ...group,
      repoRoot: input.repoRoot,
      nowMs: input.nowMs,
    });

    if (result.action === "created") {
      created.push(result.rule);
    } else if (result.action === "updated") {
      updated.push(result.rule);
    }
  }

  return {
    created,
    updated,
    skippedBelowThreshold: countBelowThresholdEligibleGroups(
      listObservations(db).filter((observation) => observation.repoRoot === input.repoRoot),
      threshold,
    ),
  };
}

export function buildProjectRuleCandidateGroups(
  observations: readonly Observation[],
  threshold: number = DEFAULT_PROJECT_RULE_CANDIDATE_THRESHOLD,
): ProjectRuleCandidateGroup[] {
  const grouped = new Map<string, EvidenceItem[]>();

  for (const observation of observations) {
    const evidence = toEvidenceItem(observation);

    if (evidence === undefined) {
      continue;
    }

    const existing = grouped.get(evidence.scopeKey) ?? [];
    existing.push(evidence);
    grouped.set(evidence.scopeKey, existing);
  }

  return [...grouped.values()]
    .filter((items) => items.length >= threshold)
    .map(buildCandidateGroup)
    .sort(compareCandidateGroups);
}

export function promoteProjectRule(
  db: Database,
  ruleId: string,
  nowMs = Date.now(),
): ProjectRuleRecord {
  const rule = requireProjectRule(db, ruleId);

  if (rule.status !== ProjectRuleStatus.Candidate) {
    throw new Error(`Only candidate rules can be promoted: ${ruleId}`);
  }

  return updateProjectRuleStatus(db, {
    ruleId,
    status: ProjectRuleStatus.Active,
    nowMs,
    promotedAtMs: nowMs,
    staleMetadata: null,
  });
}

export function dismissProjectRule(
  db: Database,
  ruleId: string,
  nowMs = Date.now(),
): ProjectRuleRecord {
  const rule = requireProjectRule(db, ruleId);

  if (rule.status !== ProjectRuleStatus.Candidate && rule.status !== ProjectRuleStatus.Stale) {
    throw new Error(`Only candidate or stale rules can be dismissed: ${ruleId}`);
  }

  return updateProjectRuleStatus(db, {
    ruleId,
    status: ProjectRuleStatus.Dismissed,
    nowMs,
  });
}

export function disableProjectRule(
  db: Database,
  ruleId: string,
  nowMs = Date.now(),
): ProjectRuleRecord {
  const rule = requireProjectRule(db, ruleId);

  if (rule.status !== ProjectRuleStatus.Active && rule.status !== ProjectRuleStatus.Stale) {
    throw new Error(`Only active or stale rules can be disabled: ${ruleId}`);
  }

  return updateProjectRuleStatus(db, {
    ruleId,
    status: ProjectRuleStatus.Disabled,
    nowMs,
  });
}

export function selectRelevantProjectRules(
  db: Database,
  input: {
    readonly repoRoot: string;
    readonly query: string;
    readonly linkedFilePaths?: readonly string[];
    readonly linkedFqNames?: readonly string[];
    readonly intent?: string;
    readonly maxActive?: number;
    readonly maxCandidates?: number;
  },
): {
  readonly active: SelectedProjectRule[];
  readonly candidates: SelectedProjectRule[];
  readonly activeTotal: number;
  readonly candidateTotal: number;
  readonly staleTotal: number;
  readonly disabledTotal: number;
  readonly dismissedTotal: number;
} {
  const activeRules = listProjectRules(db, {
    repoRoot: input.repoRoot,
    statuses: [ProjectRuleStatus.Active],
  });
  const candidateRules = listProjectRules(db, {
    repoRoot: input.repoRoot,
    statuses: [ProjectRuleStatus.Candidate],
  });
  const staleRules = listProjectRules(db, {
    repoRoot: input.repoRoot,
    statuses: [ProjectRuleStatus.Stale],
  });
  const disabledRules = listProjectRules(db, {
    repoRoot: input.repoRoot,
    statuses: [ProjectRuleStatus.Disabled],
  });
  const dismissedRules = listProjectRules(db, {
    repoRoot: input.repoRoot,
    statuses: [ProjectRuleStatus.Dismissed],
  });
  const active = activeRules
    .filter((rule) => rule.staleMetadata === undefined)
    .map((rule) => scoreProjectRule(rule, input))
    .filter((selection): selection is SelectedProjectRule => selection !== undefined)
    .sort(compareSelectedRules);
  const candidates = candidateRules
    .map((rule) => scoreProjectRule(rule, input))
    .filter((selection): selection is SelectedProjectRule => selection !== undefined)
    .sort(compareSelectedRules);

  return {
    active: active.slice(0, input.maxActive ?? DEFAULT_ACTIVE_PROJECT_RULE_LIMIT),
    candidates: candidates.slice(0, input.maxCandidates ?? DEFAULT_CANDIDATE_PROJECT_RULE_PREVIEW_LIMIT),
    activeTotal: activeRules.length,
    candidateTotal: candidateRules.length,
    staleTotal: staleRules.length,
    disabledTotal: disabledRules.length,
    dismissedTotal: dismissedRules.length,
  };
}

export function markProjectRulesStaleForRun(
  db: Database,
  input: {
    readonly repoRoot: string;
    readonly runId: number;
    readonly nowMs?: number;
  },
): ProjectRuleRecord[] {
  const fileDiffs = listFileDiffsForRun(db, input.runId) ?? [];
  const symbolDiffs = listSymbolDiffsForRun(db, input.runId) ?? [];
  const changedFileDiffs = fileDiffs.filter((diff) => diff.changeType !== FileChangeType.Unchanged);
  const changedSymbolDiffs = symbolDiffs.filter((diff) => diff.changeType !== FileChangeType.Unchanged);
  const staleRules: ProjectRuleRecord[] = [];

  if (changedFileDiffs.length === 0 && changedSymbolDiffs.length === 0) {
    return [];
  }

  const rules = listProjectRules(db, {
    repoRoot: input.repoRoot,
    statuses: [ProjectRuleStatus.Candidate, ProjectRuleStatus.Active],
  });

  for (const rule of rules) {
    const reasons = collectProjectRuleStaleReasons(rule, {
      runId: input.runId,
      fileDiffs: changedFileDiffs,
      symbolDiffs: changedSymbolDiffs,
    });

    if (reasons.length === 0) {
      continue;
    }

    const staleMetadata: ProjectRuleStaleMetadata = {
      staleAtMs: input.nowMs ?? Date.now(),
      detectedInRunId: input.runId,
      reasons,
    };

    staleRules.push(updateProjectRuleStatus(db, {
      ruleId: rule.id,
      status: ProjectRuleStatus.Stale,
      nowMs: staleMetadata.staleAtMs,
      staleMetadata,
    }));
  }

  return staleRules;
}

export function formatProjectRuleForOutput(rule: ProjectRuleRecord) {
  return {
    id: rule.id,
    status: rule.status,
    summary: rule.summary,
    scope: structuredClone(rule.scope),
    evidenceCount: rule.evidenceCount,
    evidenceObservationIds: [...rule.evidenceObservationIds],
    evidenceKinds: [...rule.evidenceKinds],
    confidence: rule.confidence,
    createdAtMs: rule.createdAtMs,
    updatedAtMs: rule.updatedAtMs,
    promotedAtMs: rule.promotedAtMs ?? null,
    sourceRunId: rule.sourceRunId ?? null,
    staleMetadata: rule.staleMetadata === undefined ? null : structuredClone(rule.staleMetadata),
  };
}

function toEvidenceItem(observation: Observation): EvidenceItem | undefined {
  if (isRawPassiveToolCall(observation)) {
    return undefined;
  }

  const antiPatternType = extractBodyValue(observation.body, "anti_pattern");

  if (
    observation.kind === ObservationKind.DeadEnd
    && observation.source === ObservationSource.McpAuto
    && antiPatternType !== undefined
  ) {
    return buildEvidenceItem(observation, {
      evidenceKind: ProjectRuleEvidenceKind.AntiPattern,
      groupKind: "anti_pattern",
      antiPatternType,
    });
  }

  if (
    observation.kind === ObservationKind.Insight
    && observation.source === ObservationSource.McpAuto
    && observation.toolName === PASSIVE_CONSOLIDATION_TOOL_NAME
    && extractBodyValue(observation.body, "consolidated") === "true"
  ) {
    return buildEvidenceItem(observation, {
      evidenceKind: ProjectRuleEvidenceKind.ConsolidatedPassive,
      groupKind: "consolidated_passive",
    });
  }

  if (
    observation.source === ObservationSource.Manual
    && (observation.kind === ObservationKind.Decision || observation.kind === ObservationKind.Insight)
  ) {
    return buildEvidenceItem(observation, {
      evidenceKind: ProjectRuleEvidenceKind.DurableObservation,
      groupKind: "durable",
    });
  }

  return undefined;
}

function buildEvidenceItem(
  observation: Observation,
  input: {
    evidenceKind: ProjectRuleEvidenceKind;
    groupKind: EvidenceItem["groupKind"];
    antiPatternType?: string;
  },
): EvidenceItem | undefined {
  const files = sortedUnique(observation.linkedFilePaths.map(normalizeFilePath));
  const symbolFqns = sortedUnique([
    ...observation.linkedFqNames,
    ...observation.linkedSymbols.map((link) => link.fqName),
  ]);
  const terms = collectRuleTerms([
    observation.summary,
    observation.body,
    observation.queryText ?? "",
    ...files,
    ...symbolFqns,
  ]);
  const toolNames = sortedUnique(observation.toolName === undefined ? [] : [observation.toolName]);
  const intents = sortedUnique(observation.intent === undefined ? [] : [observation.intent]);
  const antiPatternTypes = sortedUnique(input.antiPatternType === undefined ? [] : [input.antiPatternType]);
  const scope: ProjectRuleScope = {
    files,
    symbolFqns,
    terms,
    toolNames,
    intents,
    antiPatternTypes,
  };
  const scopeIdentity = resolvePrimaryScopeIdentity(scope);

  if (scopeIdentity === undefined) {
    return undefined;
  }

  const groupParts = [
    "project_rule_candidate",
    input.groupKind,
    input.antiPatternType ?? "",
    scopeIdentity.kind,
    scopeIdentity.value,
  ];

  return {
    observation,
    evidenceKind: input.evidenceKind,
    groupKind: input.groupKind,
    ...(input.antiPatternType === undefined ? {} : { antiPatternType: input.antiPatternType }),
    scopeKey: groupParts.join(":"),
    scopeLabel: scopeIdentity.value,
    scope,
  };
}

function buildCandidateGroup(items: readonly EvidenceItem[]): ProjectRuleCandidateGroup {
  const sortedItems = [...items].sort((left, right) => {
    return left.observation.createdAtMs - right.observation.createdAtMs
      || left.observation.id.localeCompare(right.observation.id);
  });
  const scope = mergeRuleScopes(sortedItems.map((item) => item.scope));
  const evidenceKinds = sortedUnique(sortedItems.map((item) => item.evidenceKind)) as ProjectRuleEvidenceKind[];
  const antiPatternTypes = sortedUnique(sortedItems.flatMap((item) => item.scope.antiPatternTypes));
  const groupKind = sortedItems[0]!.groupKind;
  const scopeKey = sortedItems[0]!.scopeKey;
  const scopeLabel = chooseScopeLabel(scope);
  const signature = computeProjectRuleSignature({
    groupKind,
    scopeKey,
    antiPatternTypes,
  });
  const sourceRunIds = sortedItems
    .map((item) => item.observation.sourceRunId)
    .filter((sourceRunId): sourceRunId is number => sourceRunId !== undefined)
    .sort((left, right) => left - right);

  return {
    signature,
    summary: formatCandidateSummary({
      groupKind,
      scopeLabel,
      antiPatternType: antiPatternTypes[0],
    }),
    scope,
    evidenceObservationIds: sortedItems.map((item) => item.observation.id).sort(),
    evidenceKinds,
    evidenceCount: sortedItems.length,
    confidence: sortedItems.length >= 5 ? ProjectRuleConfidence.High : ProjectRuleConfidence.Medium,
    ...(sourceRunIds.at(-1) === undefined ? {} : { sourceRunId: sourceRunIds.at(-1)! }),
  };
}

function formatCandidateSummary(input: {
  groupKind: EvidenceItem["groupKind"];
  scopeLabel: string;
  antiPatternType?: string;
}): string {
  if (input.groupKind === "anti_pattern") {
    return `Repeated ${input.antiPatternType ?? AntiPatternType.FileThrashing} observations occurred around ${input.scopeLabel}. Consider checking design assumptions before repeated edits in this area.`;
  }

  if (input.groupKind === "consolidated_passive") {
    return `Repeated context-building activity focused on ${input.scopeLabel}. Consider consulting prior memory before changing this area.`;
  }

  return `Repeated durable evidence is linked to ${input.scopeLabel}. When working in this area, check the supporting observations for recurring project conventions.`;
}

function scoreProjectRule(
  rule: ProjectRuleRecord,
  input: {
    readonly query: string;
    readonly linkedFilePaths?: readonly string[];
    readonly linkedFqNames?: readonly string[];
    readonly intent?: string;
  },
): SelectedProjectRule | undefined {
  const queryTerms = collectRuleTerms([input.query]);
  const linkedFilePaths = new Set((input.linkedFilePaths ?? []).map(normalizeFilePath));
  const linkedFqNames = new Set(input.linkedFqNames ?? []);
  const summaryTerms = collectRuleTerms([rule.summary]);
  const matchedReasons: string[] = [];
  let score = 0;

  const fileMatches = rule.scope.files.filter((filePath) => linkedFilePaths.has(filePath));
  if (fileMatches.length > 0) {
    score += 30 + fileMatches.length * 4;
    matchedReasons.push("matched linked file");
  }

  const prefixMatches = rule.scope.files.filter((ruleFilePath) => {
    return [...linkedFilePaths].some((linkedFilePath) => {
      return linkedFilePath.startsWith(`${ruleFilePath}/`) || ruleFilePath.startsWith(`${linkedFilePath}/`);
    });
  });
  if (prefixMatches.length > 0) {
    score += 12 + prefixMatches.length * 2;
    matchedReasons.push("matched path prefix");
  }

  const fqnMatches = rule.scope.symbolFqns.filter((fqName) => linkedFqNames.has(fqName));
  if (fqnMatches.length > 0) {
    score += 40 + fqnMatches.length * 5;
    matchedReasons.push("matched linked symbol");
  }

  const termMatches = rule.scope.terms.filter((term) => queryTerms.includes(term));
  const summaryTermMatches = summaryTerms.filter((term) => queryTerms.includes(term));
  const allTermMatches = sortedUnique([...termMatches, ...summaryTermMatches]);
  if (allTermMatches.length > 0) {
    score += Math.min(allTermMatches.length * 5, 20);
    matchedReasons.push("matched query term");
  }

  if (input.intent !== undefined && rule.scope.intents.includes(input.intent)) {
    score += 8;
    matchedReasons.push("matched intent");
  }

  if (score <= 0) {
    return undefined;
  }

  return {
    rule,
    score,
    reason: sortedUnique(matchedReasons).join(" and "),
  };
}

function collectProjectRuleStaleReasons(
  rule: ProjectRuleRecord,
  input: {
    readonly runId: number;
    readonly fileDiffs: NonNullable<ReturnType<typeof listFileDiffsForRun>>;
    readonly symbolDiffs: NonNullable<ReturnType<typeof listSymbolDiffsForRun>>;
  },
): ProjectRuleStaleReason[] {
  const reasonsByKey = new Map<string, ProjectRuleStaleReason>();

  for (const filePath of rule.scope.files) {
    const diff = input.fileDiffs.find((candidate) => candidate.filePath === filePath);

    if (diff?.changeType === FileChangeType.Removed) {
      reasonsByKey.set(`file_removed:${filePath}`, {
        kind: "file_removed",
        detectedInRunId: input.runId,
        filePath,
      });
    }
    if (diff?.changeType === FileChangeType.Modified) {
      reasonsByKey.set(`file_modified:${filePath}`, {
        kind: "file_modified",
        detectedInRunId: input.runId,
        filePath,
      });
    }
  }

  for (const fqName of rule.scope.symbolFqns) {
    for (const diff of input.symbolDiffs.filter((candidate) => candidate.fqName === fqName)) {
      if (diff.changeType === FileChangeType.Removed) {
        reasonsByKey.set(`symbol_removed:${diff.filePath}:${fqName}`, {
          kind: "symbol_removed",
          detectedInRunId: input.runId,
          filePath: diff.filePath,
          fqName,
        });
      }
      if (diff.changeType === FileChangeType.Modified) {
        reasonsByKey.set(`symbol_modified:${diff.filePath}:${fqName}`, {
          kind: "symbol_modified",
          detectedInRunId: input.runId,
          filePath: diff.filePath,
          fqName,
        });
      }
    }
  }

  return [...reasonsByKey.values()].sort((left, right) => {
    return left.detectedInRunId - right.detectedInRunId
      || left.kind.localeCompare(right.kind)
      || (left.filePath ?? "").localeCompare(right.filePath ?? "")
      || (left.fqName ?? "").localeCompare(right.fqName ?? "");
  });
}

function requireProjectRule(db: Database, ruleId: string): ProjectRuleRecord {
  const rule = listProjectRules(db).find((candidate) => candidate.id === ruleId);

  if (rule === undefined) {
    throw new Error(`Project rule not found: ${ruleId}`);
  }

  return rule;
}

function countBelowThresholdEligibleGroups(
  observations: readonly Observation[],
  threshold: number,
): number {
  const grouped = new Map<string, number>();

  for (const observation of observations) {
    const evidence = toEvidenceItem(observation);

    if (evidence === undefined) {
      continue;
    }

    grouped.set(evidence.scopeKey, (grouped.get(evidence.scopeKey) ?? 0) + 1);
  }

  return [...grouped.values()].filter((count) => count > 0 && count < threshold).length;
}

function isRawPassiveToolCall(observation: Observation): boolean {
  return observation.kind === ObservationKind.ToolCall
    && observation.source === ObservationSource.McpAuto;
}

function computeProjectRuleSignature(input: {
  readonly groupKind: EvidenceItem["groupKind"];
  readonly scopeKey: string;
  readonly antiPatternTypes: readonly string[];
}): string {
  const identity = [
    input.groupKind,
    input.antiPatternTypes.join(","),
    input.scopeKey,
  ].join("\0");

  return `${input.groupKind}:${createHash("sha256").update(identity).digest("hex").slice(0, 20)}`;
}

function resolvePrimaryScopeIdentity(scope: ProjectRuleScope): { kind: string; value: string } | undefined {
  if (scope.antiPatternTypes.length > 0 && scope.files.length > 0) {
    return { kind: "anti_file", value: `${scope.antiPatternTypes[0]}:${scope.files[0]}` };
  }
  if (scope.files.length > 0) {
    return { kind: "file", value: scope.files[0]! };
  }
  if (scope.symbolFqns.length > 0) {
    return { kind: "fqn", value: scope.symbolFqns[0]! };
  }
  if (scope.terms.length >= 3) {
    return { kind: "terms", value: scope.terms.slice(0, 3).join("+") };
  }
  return undefined;
}

function chooseScopeLabel(scope: ProjectRuleScope): string {
  if (scope.files.length === 1) {
    return scope.files[0]!;
  }
  if (scope.files.length > 1) {
    return scope.files.slice(0, 3).join(", ");
  }
  if (scope.symbolFqns.length > 0) {
    return scope.symbolFqns.slice(0, 2).join(", ");
  }
  return scope.terms.slice(0, 4).join(", ");
}

function mergeRuleScopes(scopes: readonly ProjectRuleScope[]): ProjectRuleScope {
  return {
    files: sortedUnique(scopes.flatMap((scope) => scope.files)).slice(0, 20),
    symbolFqns: sortedUnique(scopes.flatMap((scope) => scope.symbolFqns)).slice(0, 20),
    terms: sortedUnique(scopes.flatMap((scope) => scope.terms)).slice(0, 24),
    toolNames: sortedUnique(scopes.flatMap((scope) => scope.toolNames)).slice(0, 12),
    intents: sortedUnique(scopes.flatMap((scope) => scope.intents)).slice(0, 12),
    antiPatternTypes: sortedUnique(scopes.flatMap((scope) => scope.antiPatternTypes)).slice(0, 8),
  };
}

function collectRuleTerms(values: readonly string[]): string[] {
  const stopWords = new Set([
    "about",
    "after",
    "around",
    "before",
    "current",
    "from",
    "into",
    "should",
    "that",
    "the",
    "this",
    "through",
    "with",
  ]);

  return sortedUnique(
    values
      .join(" ")
      .replace(/\\/g, "/")
      .toLowerCase()
      .split(/[^a-z0-9_./:]+/u)
      .filter((term) => term.length > 2)
      .filter((term) => !stopWords.has(term)),
  ).slice(0, 24);
}

function extractBodyValue(body: string, key: string): string | undefined {
  for (const line of body.split(/\r?\n/u)) {
    const separatorIndex = line.indexOf("=");

    if (separatorIndex <= 0) {
      continue;
    }

    if (line.slice(0, separatorIndex).trim() !== key) {
      continue;
    }

    const value = line.slice(separatorIndex + 1).trim();
    return value.length === 0 ? undefined : value;
  }

  return undefined;
}

function compareCandidateGroups(
  left: ProjectRuleCandidateGroup,
  right: ProjectRuleCandidateGroup,
): number {
  return left.signature.localeCompare(right.signature);
}

function compareSelectedRules(
  left: SelectedProjectRule,
  right: SelectedProjectRule,
): number {
  return right.score - left.score
    || right.rule.evidenceCount - left.rule.evidenceCount
    || (right.rule.promotedAtMs ?? 0) - (left.rule.promotedAtMs ?? 0)
    || left.rule.id.localeCompare(right.rule.id);
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values.filter((value) => value.trim().length > 0).map((value) => value.trim()))]
    .sort((left, right) => left.localeCompare(right));
}
