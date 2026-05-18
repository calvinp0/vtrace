export const ProjectRuleStatus = Object.freeze({
  Candidate: "candidate",
  Active: "active",
  Dismissed: "dismissed",
  Stale: "stale",
  Disabled: "disabled",
});

export type ProjectRuleStatus =
  (typeof ProjectRuleStatus)[keyof typeof ProjectRuleStatus];

export const ProjectRuleConfidence = Object.freeze({
  Low: "low",
  Medium: "medium",
  High: "high",
});

export type ProjectRuleConfidence =
  (typeof ProjectRuleConfidence)[keyof typeof ProjectRuleConfidence];

export const ProjectRuleEvidenceKind = Object.freeze({
  DurableObservation: "durable_observation",
  ConsolidatedPassive: "consolidated_passive",
  AntiPattern: "anti_pattern",
});

export type ProjectRuleEvidenceKind =
  (typeof ProjectRuleEvidenceKind)[keyof typeof ProjectRuleEvidenceKind];

export interface ProjectRuleScope {
  readonly files: string[];
  readonly symbolFqns: string[];
  readonly terms: string[];
  readonly toolNames: string[];
  readonly intents: string[];
  readonly antiPatternTypes: string[];
}

export interface ProjectRuleStaleReason {
  readonly kind: "file_removed" | "file_modified" | "symbol_removed" | "symbol_modified";
  readonly detectedInRunId: number;
  readonly filePath?: string;
  readonly fqName?: string;
}

export interface ProjectRuleStaleMetadata {
  readonly staleAtMs: number;
  readonly detectedInRunId: number;
  readonly reasons: ProjectRuleStaleReason[];
}

export interface ProjectRuleRecord {
  readonly id: string;
  readonly repoRoot: string;
  readonly status: ProjectRuleStatus;
  readonly signature: string;
  readonly summary: string;
  readonly scope: ProjectRuleScope;
  readonly evidenceObservationIds: string[];
  readonly evidenceCount: number;
  readonly evidenceKinds: ProjectRuleEvidenceKind[];
  readonly confidence: ProjectRuleConfidence;
  readonly sourceRunId?: number;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
  readonly promotedAtMs?: number;
  readonly staleMetadata?: ProjectRuleStaleMetadata;
}

export interface ProjectRuleCandidateGroup {
  readonly signature: string;
  readonly summary: string;
  readonly scope: ProjectRuleScope;
  readonly evidenceObservationIds: string[];
  readonly evidenceKinds: ProjectRuleEvidenceKind[];
  readonly evidenceCount: number;
  readonly confidence: ProjectRuleConfidence;
  readonly sourceRunId?: number;
}

export interface GenerateProjectRuleCandidatesResult {
  readonly created: ProjectRuleRecord[];
  readonly updated: ProjectRuleRecord[];
  readonly skippedBelowThreshold: number;
}

export interface SelectedProjectRule {
  readonly rule: ProjectRuleRecord;
  readonly score: number;
  readonly reason: string;
}
