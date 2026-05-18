import {
  isLoadedSymbolSource,
  type LoadSymbolSourceResult,
} from "./loadSymbolSource";
import type { SkeletonDetailLevel, SkeletonFileResult } from "../skeleton/getSkeleton";

export enum ExtractSymbolSourceStatus {
  Extracted = "extracted",
  SourceUnavailable = "source_unavailable",
  InvalidSpan = "invalid_span",
}

export interface ExtractedFullSymbolSource {
  status: ExtractSymbolSourceStatus;
  source?: string;
}

export interface ExtractedSymbolContentFields {
  source?: string;
  skeleton?: SkeletonFileResult;
  skeletonDetail?: SkeletonDetailLevel;
  signature?: string;
  summary?: string;
  stub?: string;
  sourceBacked?: boolean;
}

export function extractFullSymbolSource(
  result: LoadSymbolSourceResult,
): ExtractedFullSymbolSource {
  if (!isLoadedSymbolSource(result)) {
    return {
      status: ExtractSymbolSourceStatus.SourceUnavailable,
    };
  }

  const {
    fileBytes,
    symbol,
  } = result;

  if (
    symbol.startByte < 0
    || symbol.endByte < symbol.startByte
    || symbol.endByte > fileBytes.length
  ) {
    return {
      status: ExtractSymbolSourceStatus.InvalidSpan,
    };
  }

  const source = fileBytes.subarray(symbol.startByte, symbol.endByte).toString("utf8");

  if (source.length === 0) {
    return {
      status: ExtractSymbolSourceStatus.InvalidSpan,
    };
  }

  return {
    status: ExtractSymbolSourceStatus.Extracted,
    source,
  };
}

export function extractPivotSymbolContent(
  result: LoadSymbolSourceResult,
  fallbackLocalName: string,
): ExtractedSymbolContentFields {
  const source = extractFullSymbolSource(result);
  const stub = result.symbol?.localName ?? fallbackLocalName;

  return {
    ...(source.status === ExtractSymbolSourceStatus.Extracted
      ? { source: source.source, sourceBacked: true }
      : {}),
    ...(result.symbol?.signature === undefined ? {} : { signature: result.symbol.signature }),
    ...(result.symbol?.docstring === undefined ? {} : { summary: result.symbol.docstring }),
    stub,
  };
}

export function extractSupportSymbolContent(
  result: LoadSymbolSourceResult,
  fallbackLocalName: string,
): ExtractedSymbolContentFields {
  const stub = result.symbol?.localName ?? fallbackLocalName;

  return {
    ...(result.symbol?.signature === undefined ? {} : { signature: result.symbol.signature }),
    ...(result.symbol?.docstring === undefined ? {} : { summary: result.symbol.docstring }),
    stub,
  };
}
