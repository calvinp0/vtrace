// @ts-nocheck
import {
  EdgeType,
  Language,
  SymbolKind,
  type EdgeRecord,
  type SymbolId,
  type SymbolRecord,
} from "./types";

type StringEnum = Record<string, string>;

function isEnumValue<TEnum extends StringEnum>(
  enumType: TEnum,
  value: unknown,
): value is TEnum[keyof TEnum] {
  return typeof value === "string" && Object.values(enumType).includes(value);
}

function parseEnumValue<TEnum extends StringEnum>(
  enumType: TEnum,
  enumName: string,
  value: unknown,
): TEnum[keyof TEnum] {
  if (isEnumValue(enumType, value)) {
    return value;
  }

  throw new Error(`Invalid ${enumName}: ${String(value)}`);
}

export function isLanguage(value: unknown): value is Language {
  return isEnumValue(Language, value);
}

export function parseLanguage(value: unknown): Language {
  return parseEnumValue(Language, "Language", value);
}

export function isSymbolKind(value: unknown): value is SymbolKind {
  return isEnumValue(SymbolKind, value);
}

export function parseSymbolKind(value: unknown): SymbolKind {
  return parseEnumValue(SymbolKind, "SymbolKind", value);
}

export function isEdgeType(value: unknown): value is EdgeType {
  return isEnumValue(EdgeType, value);
}

export function parseEdgeType(value: unknown): EdgeType {
  return parseEnumValue(EdgeType, "EdgeType", value);
}

export function assertValidEdgeReferences(
  edges: readonly EdgeRecord[],
  symbolsOrIds: ReadonlySet<SymbolId> | readonly SymbolRecord[],
): void {
  const symbolIds = Array.isArray(symbolsOrIds)
    ? new Set(symbolsOrIds.map((symbol) => symbol.id))
    : symbolsOrIds;

  for (const edge of edges) {
    parseEdgeType(edge.edgeType);

    if (!symbolIds.has(edge.srcSymbolId)) {
      throw new Error(`Edge source symbol does not exist: ${edge.srcSymbolId}`);
    }

    if (!symbolIds.has(edge.dstSymbolId)) {
      throw new Error(`Edge destination symbol does not exist: ${edge.dstSymbolId}`);
    }
  }
}
