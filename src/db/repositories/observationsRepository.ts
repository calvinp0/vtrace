import { createHash } from "node:crypto";
import type { Database } from "bun:sqlite";

import { normalizeFilePath } from "../../domain/types";
import { buildObservationSemanticKey } from "../../observations/provenance";
import { upsertSession } from "./sessionsRepository";
import { getSymbolById } from "./symbolsRepository";
import {
  ObservationOrigin,
  ObservationScope,
  type Observation,
  type ObservationFQNameLinkRecord,
  type ObservationFileLinkRecord,
  type ObservationKind,
  type ObservationProvenance,
  type ObservationRecord,
  type ObservationSource,
  type ObservationSymbolLinkRecord,
} from "../../observations/types";
interface ObservationRow {
  id: string;
  repo_root: string;
  session_id: string | null;
  kind: string;
  source: string;
  tool_name: string | null;
  query_text: string | null;
  intent: string | null;
  summary: string;
  body: string;
  source_run_id: number | null;
  dedupe_key: string | null;
  scope: string | null;
  origin: string | null;
  provenance_json: string | null;
  semantic_key: string | null;
  result_semantic_hash: string | null;
  supersedes_observation_id: string | null;
  created_at_ms: number;
}

interface ObservationFileLinkRow {
  observation_id: string;
  link_ordinal: number;
  file_path: string;
}

interface ObservationSymbolLinkRow {
  observation_id: string;
  link_ordinal: number;
  symbol_id: string;
  file_path: string;
  fq_name: string;
  symbol_kind: string;
}

interface ObservationFQNameLinkRow {
  observation_id: string;
  link_ordinal: number;
  fq_name: string;
}

export interface PersistObservationInput {
  repoRoot: string;
  sessionId?: string;
  sessionAgentKind?: string;
  kind: ObservationKind;
  source: ObservationSource;
  toolName?: string;
  queryText?: string;
  intent?: string;
  summary: string;
  body?: string;
  sourceRunId?: number;
  dedupeKey?: string;
  scope?: ObservationScope;
  origin?: ObservationOrigin;
  provenance?: ObservationProvenance;
  semanticKey?: string;
  resultSemanticHash?: string;
  supersedesObservationId?: string;
  // Observation identity is content-stable. This timestamp is stored as
  // metadata only and does not make otherwise equivalent observations unique.
  createdAtMs?: number;
  linkedFilePaths?: readonly string[];
  linkedSymbolIds?: readonly string[];
  linkedFqNames?: readonly string[];
}

export function persistObservation(
  db: Database,
  input: PersistObservationInput,
): Observation {
  if (input.summary.trim().length === 0) {
    throw new Error("Observation summary must not be empty");
  }

  const createdAtMs = input.createdAtMs ?? Date.now();
  const linkedFilePaths = normalizeLinkedFilePaths(input.linkedFilePaths ?? []);
  const linkedSymbols = resolveLinkedSymbols(db, input.linkedSymbolIds ?? []);
  const linkedFqNames = normalizeLinkedFqNames([
    ...(input.linkedFqNames ?? []),
    ...linkedSymbols.map((link) => link.fqName),
  ]);
  const scope = input.scope ?? (input.provenance === undefined
    ? undefined
    : input.toolName === undefined ? ObservationScope.Repository : ObservationScope.IndexState);
  const origin = input.origin ?? (input.provenance === undefined
    ? undefined
    : input.source === "mcp_auto" ? ObservationOrigin.AutomaticCapture : ObservationOrigin.Manual);
  const semanticKey = input.semanticKey ?? (scope === undefined || input.provenance === undefined
    ? undefined
    : buildObservationSemanticKey({ scope, provenance: input.provenance }));
  const resultSemanticHash = input.resultSemanticHash
    ?? input.provenance?.resultSemanticHash
    ?? undefined;
  // Observation identity is content-stable. createdAtMs is metadata only and
  // does not distinguish otherwise equivalent observations.
  const observationId = computeObservationId({
    ...input,
    scope,
    origin,
    semanticKey,
    resultSemanticHash,
    body: input.body ?? "",
    linkedFilePaths,
    linkedSymbols,
    linkedFqNames,
  });

  let persisted: Observation | undefined;

  const transaction = db.transaction(() => {
    if (input.sessionId !== undefined) {
      upsertSession(db, {
        sessionId: input.sessionId,
        repoRoot: input.repoRoot,
        activityAtMs: createdAtMs,
        agentKind: input.sessionAgentKind,
      });
    }

    if (input.dedupeKey !== undefined) {
      const existingByDedupeKey = getObservationByDedupeKey(db, input.dedupeKey);

      if (existingByDedupeKey !== undefined) {
        persisted = existingByDedupeKey;
        return;
      }
    }

    const existingById = getObservationById(db, observationId);

    if (existingById !== undefined) {
      persisted = existingById;
      return;
    }

    db.run(
      `
        INSERT INTO observations (
          id,
          repo_root,
          session_id,
          kind,
          source,
          tool_name,
          query_text,
          intent,
          summary,
          body,
          source_run_id,
          dedupe_key,
          scope,
          origin,
          provenance_json,
          semantic_key,
          result_semantic_hash,
          supersedes_observation_id,
          created_at_ms
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      [
        observationId,
        input.repoRoot,
        input.sessionId ?? null,
        input.kind,
        input.source,
        input.toolName ?? null,
        input.queryText ?? null,
        input.intent ?? null,
        input.summary.trim(),
        input.body ?? "",
        input.sourceRunId ?? null,
        input.dedupeKey ?? null,
        scope ?? null,
        origin ?? null,
        input.provenance === undefined ? null : stableStringify(input.provenance),
        semanticKey ?? null,
        resultSemanticHash ?? null,
        input.supersedesObservationId ?? null,
        createdAtMs,
      ],
    );

    for (const [index, filePath] of linkedFilePaths.entries()) {
      db.run(
        `
          INSERT INTO observation_file_links (
            observation_id,
            link_ordinal,
            file_path
          )
          VALUES (?, ?, ?)
        `,
        [observationId, index, filePath],
      );
    }

    for (const [index, link] of linkedSymbols.entries()) {
      db.run(
        `
          INSERT INTO observation_symbol_links (
            observation_id,
            link_ordinal,
            symbol_id,
            file_path,
            fq_name,
            symbol_kind
          )
          VALUES (?, ?, ?, ?, ?, ?)
        `,
        [observationId, index, link.symbolId, link.filePath, link.fqName, link.symbolKind],
      );
    }

    for (const [index, fqName] of linkedFqNames.entries()) {
      db.run(
        `
          INSERT INTO observation_fq_name_links (
            observation_id,
            link_ordinal,
            fq_name
          )
          VALUES (?, ?, ?)
        `,
        [observationId, index, fqName],
      );
    }

    persisted = getObservationById(db, observationId)!;
  });

  transaction();
  return persisted!;
}

export function getObservationById(
  db: Database,
  observationId: string,
): Observation | undefined {
  const row = db.query(`
    SELECT
      id,
      repo_root,
      session_id,
      kind,
      source,
      tool_name,
      query_text,
      intent,
      summary,
      body,
      source_run_id,
      dedupe_key,
      scope,
      origin,
      provenance_json,
      semantic_key,
      result_semantic_hash,
      supersedes_observation_id,
      created_at_ms
    FROM observations
    WHERE id = ?
  `).get(observationId) as ObservationRow | null;

  return row === null ? undefined : hydrateObservation(db, observationRowToRecord(row));
}

export function getObservationByDedupeKey(
  db: Database,
  dedupeKey: string,
): Observation | undefined {
  const row = db.query(`
    SELECT
      id,
      repo_root,
      session_id,
      kind,
      source,
      tool_name,
      query_text,
      intent,
      summary,
      body,
      source_run_id,
      dedupe_key,
      scope,
      origin,
      provenance_json,
      semantic_key,
      result_semantic_hash,
      supersedes_observation_id,
      created_at_ms
    FROM observations
    WHERE dedupe_key = ?
  `).get(dedupeKey) as ObservationRow | null;

  return row === null ? undefined : hydrateObservation(db, observationRowToRecord(row));
}

export function listObservations(db: Database): Observation[] {
  const rows = db.query(`
    SELECT
      id,
      repo_root,
      session_id,
      kind,
      source,
      tool_name,
      query_text,
      intent,
      summary,
      body,
      source_run_id,
      dedupe_key,
      scope,
      origin,
      provenance_json,
      semantic_key,
      result_semantic_hash,
      supersedes_observation_id,
      created_at_ms
    FROM observations
    ORDER BY created_at_ms DESC, id ASC
  `).all() as ObservationRow[];

  return rows.map((row) => hydrateObservation(db, observationRowToRecord(row)));
}

export function listObservationsForSession(
  db: Database,
  sessionId: string,
): Observation[] {
  const rows = db.query(`
    SELECT
      id,
      repo_root,
      session_id,
      kind,
      source,
      tool_name,
      query_text,
      intent,
      summary,
      body,
      source_run_id,
      dedupe_key,
      scope,
      origin,
      provenance_json,
      semantic_key,
      result_semantic_hash,
      supersedes_observation_id,
      created_at_ms
    FROM observations
    WHERE session_id = ?
    ORDER BY created_at_ms DESC, id ASC
  `).all(sessionId) as ObservationRow[];

  return rows.map((row) => hydrateObservation(db, observationRowToRecord(row)));
}

export function countObservations(db: Database): number {
  const row = db.query("SELECT COUNT(*) AS count FROM observations").get() as { count: number };
  return row.count;
}

export function deleteEphemeralToolCallObservationsForSession(
  db: Database,
  sessionId: string,
): number {
  const row = db.query(`
    SELECT COUNT(*) AS count
    FROM observations
    WHERE session_id = ?
      AND kind = 'tool_call'
      AND source = 'mcp_auto'
  `).get(sessionId) as { count: number };

  db.run(
    `
      DELETE FROM observations
      WHERE session_id = ?
        AND kind = 'tool_call'
        AND source = 'mcp_auto'
    `,
    [sessionId],
  );

  return row.count;
}

export function deleteObservationsByIds(
  db: Database,
  observationIds: readonly string[],
): number {
  const uniqueIds = [...new Set(observationIds)];

  if (uniqueIds.length === 0) {
    return 0;
  }

  const placeholders = uniqueIds.map(() => "?").join(", ");
  const row = db.query(`
    SELECT COUNT(*) AS count
    FROM observations
    WHERE id IN (${placeholders})
  `).get(...uniqueIds) as { count: number };

  db.run(
    `
      DELETE FROM observations
      WHERE id IN (${placeholders})
    `,
    uniqueIds,
  );

  return row.count;
}

function hydrateObservation(
  db: Database,
  observation: ObservationRecord,
): Observation {
  return {
    ...observation,
    linkedFilePaths: listObservationFileLinks(db, observation.id).map((link) => link.filePath),
    linkedSymbols: listObservationSymbolLinks(db, observation.id),
    linkedFqNames: listObservationFQNameLinks(db, observation.id).map((link) => link.fqName),
  };
}

function listObservationFileLinks(
  db: Database,
  observationId: string,
): ObservationFileLinkRecord[] {
  const rows = db.query(`
    SELECT
      observation_id,
      link_ordinal,
      file_path
    FROM observation_file_links
    WHERE observation_id = ?
    ORDER BY link_ordinal ASC
  `).all(observationId) as ObservationFileLinkRow[];

  return rows.map((row) => ({
    observationId: row.observation_id,
    linkOrdinal: row.link_ordinal,
    filePath: row.file_path,
  }));
}

function listObservationSymbolLinks(
  db: Database,
  observationId: string,
): ObservationSymbolLinkRecord[] {
  const rows = db.query(`
    SELECT
      observation_id,
      link_ordinal,
      symbol_id,
      file_path,
      fq_name,
      symbol_kind
    FROM observation_symbol_links
    WHERE observation_id = ?
    ORDER BY link_ordinal ASC
  `).all(observationId) as ObservationSymbolLinkRow[];

  return rows.map((row) => ({
    observationId: row.observation_id,
    linkOrdinal: row.link_ordinal,
    symbolId: row.symbol_id,
    filePath: row.file_path,
    fqName: row.fq_name,
    symbolKind: row.symbol_kind as ObservationSymbolLinkRecord["symbolKind"],
  }));
}

function listObservationFQNameLinks(
  db: Database,
  observationId: string,
): ObservationFQNameLinkRecord[] {
  const rows = db.query(`
    SELECT
      observation_id,
      link_ordinal,
      fq_name
    FROM observation_fq_name_links
    WHERE observation_id = ?
    ORDER BY link_ordinal ASC
  `).all(observationId) as ObservationFQNameLinkRow[];

  return rows.map((row) => ({
    observationId: row.observation_id,
    linkOrdinal: row.link_ordinal,
    fqName: row.fq_name,
  }));
}

function normalizeLinkedFilePaths(paths: readonly string[]): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];

  for (const candidate of paths) {
    const filePath = normalizeFilePath(candidate);

    if (seen.has(filePath)) {
      continue;
    }

    seen.add(filePath);
    normalized.push(filePath);
  }

  return normalized;
}

function resolveLinkedSymbols(
  db: Database,
  linkedSymbolIds: readonly string[],
): ObservationSymbolLinkRecord[] {
  const seen = new Set<string>();
  const resolved: ObservationSymbolLinkRecord[] = [];

  for (const symbolId of linkedSymbolIds) {
    if (seen.has(symbolId)) {
      continue;
    }

    seen.add(symbolId);
    const symbol = getSymbolById(db, symbolId);

    if (symbol === undefined) {
      throw new Error(`Symbol not found: ${symbolId}`);
    }

    resolved.push({
      observationId: "",
      linkOrdinal: resolved.length,
      symbolId: symbol.id,
      filePath: symbol.filePath,
      fqName: symbol.fqName,
      symbolKind: symbol.kind,
    });
  }

  return resolved;
}

function normalizeLinkedFqNames(fqNames: readonly string[]): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];

  for (const candidate of fqNames) {
    const fqName = candidate.trim();

    if (fqName.length === 0 || seen.has(fqName)) {
      continue;
    }

    seen.add(fqName);
    normalized.push(fqName);
  }

  return normalized;
}

function computeObservationId(input: {
  repoRoot: string;
  sessionId?: string;
  kind: ObservationKind;
  source: ObservationSource;
  toolName?: string;
  queryText?: string;
  intent?: string;
  summary: string;
  body: string;
  sourceRunId?: number;
  scope?: ObservationScope;
  origin?: ObservationOrigin;
  provenance?: ObservationProvenance;
  semanticKey?: string;
  resultSemanticHash?: string;
  supersedesObservationId?: string;
  linkedFilePaths: readonly string[];
  linkedSymbols: readonly ObservationSymbolLinkRecord[];
  linkedFqNames: readonly string[];
}): string {
  const hash = createHash("sha256");

  hash.update(input.repoRoot);
  hash.update("\0");
  hash.update(input.sessionId ?? "");
  hash.update("\0");
  hash.update(input.kind);
  hash.update("\0");
  hash.update(input.source);
  hash.update("\0");
  hash.update(input.toolName ?? "");
  hash.update("\0");
  hash.update(input.queryText ?? "");
  hash.update("\0");
  hash.update(input.intent ?? "");
  hash.update("\0");
  hash.update(input.summary.trim());
  hash.update("\0");
  hash.update(input.body);
  hash.update("\0");
  hash.update((input.sourceRunId ?? -1).toString(10));
  hash.update("\0");
  hash.update(input.scope ?? "");
  hash.update("\0");
  hash.update(input.origin ?? "");
  hash.update("\0");
  hash.update(input.semanticKey ?? "");
  hash.update("\0");
  hash.update(input.resultSemanticHash ?? "");

  for (const filePath of input.linkedFilePaths) {
    hash.update("\0");
    hash.update(filePath);
  }

  for (const link of input.linkedSymbols) {
    hash.update("\0");
    hash.update([
      link.symbolId,
      link.filePath,
      link.fqName,
      link.symbolKind,
    ].join("\0"));
  }

  for (const fqName of input.linkedFqNames) {
    hash.update("\0");
    hash.update(fqName);
  }

  return hash.digest("hex");
}

function observationRowToRecord(row: ObservationRow): ObservationRecord {
  return {
    id: row.id,
    repoRoot: row.repo_root,
    ...(row.session_id === null ? {} : { sessionId: row.session_id }),
    kind: row.kind as ObservationKind,
    source: row.source as ObservationSource,
    ...(row.tool_name === null ? {} : { toolName: row.tool_name }),
    ...(row.query_text === null ? {} : { queryText: row.query_text }),
    ...(row.intent === null ? {} : { intent: row.intent }),
    summary: row.summary,
    body: row.body,
    ...(row.source_run_id === null ? {} : { sourceRunId: row.source_run_id }),
    ...(row.dedupe_key === null ? {} : { dedupeKey: row.dedupe_key }),
    ...(row.scope === null ? {} : { scope: row.scope as ObservationScope }),
    ...(row.origin === null ? {} : { origin: row.origin as ObservationOrigin }),
    ...(row.provenance_json === null ? {} : { provenance: parseProvenance(row.provenance_json) }),
    ...(row.semantic_key === null ? {} : { semanticKey: row.semantic_key }),
    ...(row.result_semantic_hash === null ? {} : { resultSemanticHash: row.result_semantic_hash }),
    ...(row.supersedes_observation_id === null ? {} : { supersedesObservationId: row.supersedes_observation_id }),
    createdAtMs: row.created_at_ms,
  };
}

function parseProvenance(value: string): ObservationProvenance {
  return JSON.parse(value) as ObservationProvenance;
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => (
    `${JSON.stringify(key)}:${stableStringify(record[key])}`
  )).join(",")}}`;
}
