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

export function matchPathClues(filePath: string, clues: readonly EmbeddedPathClue[]): PathClueMatch[] {
  const normalizedPath = normalize(filePath);
  const fileComponents = components(normalizedPath);
  const basename = path.posix.basename(normalizedPath);
  const matches: PathClueMatch[] = [];
  for (const clue of clues) {
    const normalizedClue = normalize(clue.normalized);
    const clueComponents = components(normalizedClue);
    let matchType: PathClueMatchType | undefined;
    let score = 0;
    if (normalizedPath === normalizedClue) {
      matchType = "exact_path"; score = 1;
    } else if (!normalizedClue.includes("/") && basename === normalizedClue) {
      matchType = "exact_filename"; score = 0.95;
    } else if (normalizedPath.startsWith(`${normalizedClue}/`)) {
      matchType = "directory_prefix"; score = 0.9;
    } else if (containsSequence(fileComponents, clueComponents)) {
      matchType = "component_sequence"; score = 0.75;
    } else if (
      clueComponents.length === 1
      && clueComponents[0]!.length >= 5
      && basename.split(/[._-]+/u).includes(clueComponents[0]!)
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
  const taskTokens = new Set(tokenize(task));
  const pathTokens = new Set(tokenize(filePath.replace(/[/.\\-]+/gu, " ")));
  let distinctive = 0;
  for (const token of pathTokens) {
    if (
      token.length >= 4
      && taskTokens.has(token)
      && !GENERIC_TOKEN_STOPLIST.has(token)
      && !["python", "client", "tests", "test"].includes(token)
    ) distinctive += 1;
  }
  return Math.min(0.5, distinctive * 0.15);
}

function normalize(value: string): string {
  return value.replace(/\\/g, "/").replace(/^\.\//u, "").replace(/\/+$/u, "").toLowerCase();
}

function components(value: string): string[] {
  return value.split("/").filter(Boolean);
}

function containsSequence(haystack: readonly string[], needle: readonly string[]): boolean {
  if (needle.length === 0 || needle.length > haystack.length) return false;
  for (let start = 0; start <= haystack.length - needle.length; start += 1) {
    if (needle.every((component, offset) => haystack[start + offset] === component)) return true;
  }
  return false;
}
