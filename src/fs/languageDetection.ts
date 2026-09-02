import path from "node:path";

import { Language } from "../domain/types";
import { EXTENSION_TO_LANGUAGE, isParserBackedFamily } from "../parsers/languageFamilies";

/**
 * File → language family. DERIVED from the family table (M202): an extension
 * belongs to exactly one family, case-insensitively, and there is no second
 * list to fall out of step with. A path with no mapped extension is unknown,
 * which the scanner treats as "not a source file".
 */
export function detectLanguage(filePath: string): Language | undefined {
  return EXTENSION_TO_LANGUAGE.get(path.extname(filePath).toLowerCase());
}

/** A file whose family the indexer parses through the registry. */
export function isIndexableSourceFile(filePath: string): boolean {
  const language = detectLanguage(filePath);
  return language !== undefined && isParserBackedFamily(language);
}

/**
 * Source-like files are discovered even when VTRACE has no parser capability
 * (TOML: document-indexed, not parsed). This lets indexing snapshot and
 * diagnose them without claiming support.
 */
export function isRecognizedSourceFile(filePath: string): boolean {
  return detectLanguage(filePath) !== undefined;
}

export function isAdvertisedIndexableLanguage(language: Language): boolean {
  return isParserBackedFamily(language);
}
