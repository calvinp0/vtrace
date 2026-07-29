import path from "node:path";

import type { EmbeddedPathClue } from "../capsule/sweQueryShaping";
import { GENERIC_TOKEN_STOPLIST } from "../capsule/sweQueryShaping";
import { tokenize } from "./hybridScoring";

export type PathClueMatchType =
  | "exact_path"
  | "exact_filename"
  | "directory_prefix"
  | "component_sequence"
  | "weak_basename";

export interface PathClueMatch {
  clue: string;
  normalizedClue: string;
  matchType: PathClueMatchType;
  score: number;
  subtreeMatch: boolean;
  filenameMatch: boolean;
}

export interface PathRelevanceProfile {
  counters: Record<string, number>;
}

interface PreparedPathClue {
  clue: EmbeddedPathClue;
  normalized: string;
  components: string[];
}

interface PreparedFilePath {
  normalized: string;
  components: string[];
  basename: string;
}

export interface PathRelevanceContext {
  taskTokens: ReadonlySet<string>;
  clues: readonly PreparedPathClue[];
  files: Map<string, PreparedFilePath>;
  affinities: Map<string, number>;
  profile?: PathRelevanceProfile;
}

export function createPathRelevanceContext(
  task: string,
  clues: readonly EmbeddedPathClue[],
  profile?: PathRelevanceProfile,
): PathRelevanceContext {
  return {
    taskTokens: new Set(tokenize(task)),
    clues: clues.map((clue) => {
      const normalized = normalize(clue.normalized);
      return { clue, normalized, components: components(normalized) };
    }),
    files: new Map(),
    affinities: new Map(),
    ...(profile === undefined ? {} : { profile }),
  };
}

export function matchPathClues(filePath: string, clues: readonly EmbeddedPathClue[]): PathClueMatch[] {
  return matchPathCluesWithContext(filePath, createPathRelevanceContext("", clues));
}

export function matchPathCluesWithContext(
  filePath: string,
  context: PathRelevanceContext,
): PathClueMatch[] {
  const prepared = preparedFilePath(filePath, context);
  const matches: PathClueMatch[] = [];
  for (const preparedClue of context.clues) {
    increment(context.profile, "path_clue_comparisons");
    const { clue, normalized: normalizedClue, components: clueComponents } = preparedClue;
    let matchType: PathClueMatchType | undefined;
    let score = 0;
    if (prepared.normalized === normalizedClue) {
      matchType = "exact_path"; score = 1;
    } else if (!normalizedClue.includes("/") && prepared.basename === normalizedClue) {
      matchType = "exact_filename"; score = 0.95;
    } else if (prepared.normalized.startsWith(`${normalizedClue}/`)) {
      matchType = "directory_prefix"; score = 0.9;
    } else if (containsSequence(prepared.components, clueComponents, context.profile)) {
      matchType = "component_sequence"; score = 0.75;
    } else if (
      clueComponents.length === 1
      && clueComponents[0]!.length >= 5
      && prepared.basename.split(/[._-]+/u).includes(clueComponents[0]!)
    ) {
      matchType = "weak_basename"; score = 0.25;
    }
    if (matchType !== undefined) {
      matches.push({
        clue: clue.raw,
        normalizedClue,
        matchType,
        score,
        subtreeMatch: matchType === "directory_prefix" || matchType === "component_sequence",
        filenameMatch: matchType === "exact_filename" || matchType === "exact_path",
      });
    }
  }
  return matches.sort((a, b) => b.score - a.score || a.normalizedClue.localeCompare(b.normalizedClue));
}

export function pathObjectiveAffinity(filePath: string, task: string): number {
  return pathObjectiveAffinityWithContext(filePath, createPathRelevanceContext(task, []));
}

export function pathObjectiveAffinityWithContext(
  filePath: string,
  context: PathRelevanceContext,
): number {
  const cached = context.affinities.get(filePath);
  if (cached !== undefined) return cached;
  const pathTokens = new Set(tokenize(filePath.replace(/[/.\\-]+/gu, " ")));
  let distinctive = 0;
  for (const token of pathTokens) {
    if (
      token.length >= 4
      && context.taskTokens.has(token)
      && !GENERIC_TOKEN_STOPLIST.has(token)
      && !["python", "client", "tests", "test"].includes(token)
    ) distinctive += 1;
  }
  const affinity = Math.min(0.5, distinctive * 0.15);
  context.affinities.set(filePath, affinity);
  increment(context.profile, "path_objective_affinities_computed");
  return affinity;
}

function normalize(value: string): string {
  return value.replace(/\\/g, "/").replace(/^\.\//u, "").replace(/\/+$/u, "").toLowerCase();
}

function components(value: string): string[] {
  return value.split("/").filter(Boolean);
}

function preparedFilePath(filePath: string, context: PathRelevanceContext): PreparedFilePath {
  const cached = context.files.get(filePath);
  if (cached !== undefined) return cached;
  const normalized = normalize(filePath);
  const prepared = {
    normalized,
    components: components(normalized),
    basename: path.posix.basename(normalized),
  };
  context.files.set(filePath, prepared);
  increment(context.profile, "files_path_scored");
  return prepared;
}

function containsSequence(
  haystack: readonly string[],
  needle: readonly string[],
  profile?: PathRelevanceProfile,
): boolean {
  if (needle.length === 0 || needle.length > haystack.length) return false;
  for (let start = 0; start <= haystack.length - needle.length; start += 1) {
    let matches = true;
    for (let offset = 0; offset < needle.length; offset += 1) {
      increment(profile, "path_component_comparisons");
      if (haystack[start + offset] !== needle[offset]) {
        matches = false;
        break;
      }
    }
    if (matches) return true;
  }
  return false;
}

function increment(profile: PathRelevanceProfile | undefined, name: string): void {
  if (profile !== undefined) {
    profile.counters[name] = (profile.counters[name] ?? 0) + 1;
  }
}
