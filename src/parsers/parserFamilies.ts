/**
 * Registry introspection (M202 §25): which families are parser-backed RIGHT NOW,
 * derived from the registry an indexer would build and from the grammar
 * artefacts on disk — never from a maintained list.
 */
import type { Language } from "../domain/types";
import type { ParserRegistry } from "./LanguageParser";
import { LANGUAGE_FAMILIES, type FamilyTier, type LanguageFamilyDescriptor } from "./languageFamilies";
import { grammarArtifactStatus } from "./treeSitterGrammars";

export interface ParserFamilyDescription {
  readonly language: Language;
  readonly displayName: string;
  readonly vexpRow: string | null;
  readonly extensions: readonly string[];
  readonly tier: FamilyTier;
  readonly technology: string;
  readonly parser: LanguageFamilyDescriptor["parser"];
  readonly grammarModule: string | null;
  readonly grammarArtifact: "prebuilt" | "compiled" | null;
  /** Whether the grammar binary is present on this machine (structural families). */
  readonly artifactAvailable: boolean | null;
  readonly artifactReason: string | null;
  /** The decisive fact: a parser for this family is registered in `registry`. */
  readonly registered: boolean;
}

export function describeParserFamilies(registry: ParserRegistry): readonly ParserFamilyDescription[] {
  const registered = new Set(registry.registeredLanguages());
  return LANGUAGE_FAMILIES.map((family) => {
    const status = family.grammar === undefined || family.parser !== "structural"
      ? null
      : grammarArtifactStatus(family.grammar);
    return {
      language: family.language,
      displayName: family.displayName,
      vexpRow: family.vexpRow,
      extensions: family.extensions,
      tier: family.tier,
      technology: family.technology,
      parser: family.parser,
      grammarModule: family.grammar?.module ?? null,
      grammarArtifact: family.grammar?.artifact ?? null,
      artifactAvailable: status === null ? null : status.available,
      artifactReason: status === null ? null : status.reason,
      registered: registered.has(family.language),
    };
  });
}
