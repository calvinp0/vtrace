import { createHash } from "node:crypto";
import type { Database } from "bun:sqlite";

import {
  ProjectRuleConfidence,
  ProjectRuleStatus,
  type ProjectRuleCandidateGroup,
  type ProjectRuleEvidenceKind,
  type ProjectRuleRecord,
  type ProjectRuleScope,
  type ProjectRuleStaleMetadata,
} from "../../projectRules/types";

interface ProjectRuleRow {
  id: string;
  repo_root: string;
  status: string;
  signature: string;
  summary: string;
  scope_json: string;
  evidence_observation_ids_json: string;
  evidence_count: number;
  evidence_kinds_json: string;
  confidence: string;
  source_run_id: number | null;
  created_at_ms: number;
  updated_at_ms: number;
  promoted_at_ms: number | null;
  stale_metadata_json: string | null;
}

export interface UpsertProjectRuleCandidateInput extends ProjectRuleCandidateGroup {
  readonly repoRoot: string;
  readonly nowMs?: number;
}

export function upsertProjectRuleCandidate(
  db: Database,
  input: UpsertProjectRuleCandidateInput,
): { rule: ProjectRuleRecord; action: "created" | "updated" | "unchanged" } {
  const nowMs = input.nowMs ?? Date.now();
  const existing = getProjectRuleBySignature(db, input.repoRoot, input.signature);

  if (existing === undefined) {
    const ruleId = computeProjectRuleId(input.repoRoot, input.signature);
    db.run(
      `
        INSERT INTO project_rules (
          id,
          repo_root,
          status,
          signature,
          summary,
          scope_json,
          evidence_observation_ids_json,
          evidence_count,
          evidence_kinds_json,
          confidence,
          source_run_id,
          created_at_ms,
          updated_at_ms,
          promoted_at_ms,
          stale_metadata_json
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      [
        ruleId,
        input.repoRoot,
        ProjectRuleStatus.Candidate,
        input.signature,
        input.summary,
        stableStringify(input.scope),
        stableStringify(input.evidenceObservationIds),
        input.evidenceCount,
        stableStringify(input.evidenceKinds),
        input.confidence,
        input.sourceRunId ?? null,
        nowMs,
        nowMs,
        null,
        null,
      ],
    );
    return { rule: getProjectRuleById(db, ruleId)!, action: "created" };
  }

  if (existing.status !== ProjectRuleStatus.Candidate && existing.status !== ProjectRuleStatus.Active) {
    return { rule: existing, action: "unchanged" };
  }

  const mergedEvidenceIds = sortedUnique([
    ...existing.evidenceObservationIds,
    ...input.evidenceObservationIds,
  ]);
  const mergedEvidenceKinds = sortedUnique([
    ...existing.evidenceKinds,
    ...input.evidenceKinds,
  ]) as ProjectRuleEvidenceKind[];
  const mergedScope = mergeRuleScopes(existing.scope, input.scope);
  const evidenceChanged =
    mergedEvidenceIds.join("\0") !== existing.evidenceObservationIds.join("\0")
    || stableStringify(mergedScope) !== stableStringify(existing.scope)
    || mergedEvidenceKinds.join("\0") !== existing.evidenceKinds.join("\0")
    || input.summary !== existing.summary
    || input.confidence !== existing.confidence
    || (input.sourceRunId ?? null) !== (existing.sourceRunId ?? null);

  if (!evidenceChanged) {
    return { rule: existing, action: "unchanged" };
  }

  db.run(
    `
      UPDATE project_rules
      SET
        summary = ?,
        scope_json = ?,
        evidence_observation_ids_json = ?,
        evidence_count = ?,
        evidence_kinds_json = ?,
        confidence = ?,
        source_run_id = ?,
        updated_at_ms = ?
      WHERE id = ?
    `,
    [
      input.summary,
      stableStringify(mergedScope),
      stableStringify(mergedEvidenceIds),
      mergedEvidenceIds.length,
      stableStringify(mergedEvidenceKinds),
      input.confidence,
      input.sourceRunId ?? existing.sourceRunId ?? null,
      nowMs,
      existing.id,
    ],
  );

  return { rule: getProjectRuleById(db, existing.id)!, action: "updated" };
}

export function getProjectRuleById(
  db: Database,
  ruleId: string,
): ProjectRuleRecord | undefined {
  const row = db.query(`
    SELECT *
    FROM project_rules
    WHERE id = ?
  `).get(ruleId) as ProjectRuleRow | null;

  return row === null ? undefined : projectRuleRowToRecord(row);
}

export function getProjectRuleBySignature(
  db: Database,
  repoRoot: string,
  signature: string,
): ProjectRuleRecord | undefined {
  const row = db.query(`
    SELECT *
    FROM project_rules
    WHERE repo_root = ? AND signature = ?
  `).get(repoRoot, signature) as ProjectRuleRow | null;

  return row === null ? undefined : projectRuleRowToRecord(row);
}

export function listProjectRules(
  db: Database,
  input: {
    readonly repoRoot?: string;
    readonly statuses?: readonly ProjectRuleStatus[];
  } = {},
): ProjectRuleRecord[] {
  const clauses: string[] = [];
  const params: Array<string | number> = [];

  if (input.repoRoot !== undefined) {
    clauses.push("repo_root = ?");
    params.push(input.repoRoot);
  }

  if (input.statuses !== undefined && input.statuses.length > 0) {
    clauses.push(`status IN (${input.statuses.map(() => "?").join(", ")})`);
    params.push(...input.statuses);
  }

  const where = clauses.length === 0 ? "" : `WHERE ${clauses.join(" AND ")}`;
  const rows = db.query(`
    SELECT *
    FROM project_rules
    ${where}
    ORDER BY status ASC, updated_at_ms DESC, id ASC
  `).all(...params) as ProjectRuleRow[];

  return rows.map(projectRuleRowToRecord);
}

export function updateProjectRuleStatus(
  db: Database,
  input: {
    readonly ruleId: string;
    readonly status: ProjectRuleStatus;
    readonly nowMs?: number;
    readonly promotedAtMs?: number | null;
    readonly staleMetadata?: ProjectRuleStaleMetadata | null;
  },
): ProjectRuleRecord {
  const nowMs = input.nowMs ?? Date.now();
  const rule = getProjectRuleById(db, input.ruleId);

  if (rule === undefined) {
    throw new Error(`Project rule not found: ${input.ruleId}`);
  }

  db.run(
    `
      UPDATE project_rules
      SET
        status = ?,
        updated_at_ms = ?,
        promoted_at_ms = ?,
        stale_metadata_json = ?
      WHERE id = ?
    `,
    [
      input.status,
      nowMs,
      input.promotedAtMs === undefined ? rule.promotedAtMs ?? null : input.promotedAtMs,
      input.staleMetadata === undefined
        ? rule.staleMetadata === undefined ? null : stableStringify(rule.staleMetadata)
        : input.staleMetadata === null ? null : stableStringify(input.staleMetadata),
      input.ruleId,
    ],
  );

  return getProjectRuleById(db, input.ruleId)!;
}

export function computeProjectRuleId(repoRoot: string, signature: string): string {
  return `rule_${createHash("sha256")
    .update(repoRoot)
    .update("\0")
    .update(signature)
    .digest("hex")
    .slice(0, 16)}`;
}

function projectRuleRowToRecord(row: ProjectRuleRow): ProjectRuleRecord {
  return {
    id: row.id,
    repoRoot: row.repo_root,
    status: row.status as ProjectRuleStatus,
    signature: row.signature,
    summary: row.summary,
    scope: parseJson<ProjectRuleScope>(row.scope_json),
    evidenceObservationIds: parseJson<string[]>(row.evidence_observation_ids_json),
    evidenceCount: row.evidence_count,
    evidenceKinds: parseJson<ProjectRuleEvidenceKind[]>(row.evidence_kinds_json),
    confidence: row.confidence as ProjectRuleConfidence,
    ...(row.source_run_id === null ? {} : { sourceRunId: row.source_run_id }),
    createdAtMs: row.created_at_ms,
    updatedAtMs: row.updated_at_ms,
    ...(row.promoted_at_ms === null ? {} : { promotedAtMs: row.promoted_at_ms }),
    ...(row.stale_metadata_json === null
      ? {}
      : { staleMetadata: parseJson<ProjectRuleStaleMetadata>(row.stale_metadata_json) }),
  };
}

function mergeRuleScopes(left: ProjectRuleScope, right: ProjectRuleScope): ProjectRuleScope {
  return {
    files: sortedUnique([...left.files, ...right.files]),
    symbolFqns: sortedUnique([...left.symbolFqns, ...right.symbolFqns]),
    terms: sortedUnique([...left.terms, ...right.terms]),
    toolNames: sortedUnique([...left.toolNames, ...right.toolNames]),
    intents: sortedUnique([...left.intents, ...right.intents]),
    antiPatternTypes: sortedUnique([...left.antiPatternTypes, ...right.antiPatternTypes]),
  };
}

function parseJson<T>(value: string): T {
  return JSON.parse(value) as T;
}

function stableStringify(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortJson);
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, inner]) => [key, sortJson(inner)]),
    );
  }
  return value;
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values.filter((value) => value.length > 0))].sort((left, right) => left.localeCompare(right));
}
