import path from "node:path";

import { Language } from "../domain/types";

export type DocumentKind = "yaml" | "toml";

export const DOCUMENT_INDEX_VERSION = 1 as const;
export const MAX_DOCUMENT_BYTES = 256 * 1024;
export const MAX_DOCUMENT_CHUNKS = 32;
export const MAX_DOCUMENT_CHARS_PER_CHUNK = 4_096;

const SECRET_BASENAMES = new Set([
  "credentials", "credentials.json", "credentials.toml", "credentials.yml", "credentials.yaml",
  "secrets", "secrets.yml", "secrets.yaml", "secrets.toml", "id_rsa", "id_ed25519",
]);
const LOCKFILE_BASENAMES = new Set([
  "package-lock.json", "npm-shrinkwrap.json", "yarn.lock", "pnpm-lock.yaml",
  "bun.lock", "bun.lockb", "poetry.lock", "pdm.lock", "uv.lock", "cargo.lock",
]);
const SECRET_EXTENSIONS = new Set([".pem", ".key", ".p12", ".pfx", ".crt", ".cer"]);

export function documentKindForLanguage(language: Language): DocumentKind | undefined {
  if (language === Language.Yaml) return "yaml";
  if (language === Language.Toml) return "toml";
  return undefined;
}

export function isDocumentLanguage(language: Language): boolean {
  return documentKindForLanguage(language) !== undefined;
}

export function isSafeDocumentPath(filePath: string, language: Language): boolean {
  if (!isDocumentLanguage(language)) return true;
  const normalized = filePath.replace(/\\/g, "/").toLowerCase();
  const basename = path.posix.basename(normalized);
  if (basename === ".env" || basename.startsWith(".env.")) return false;
  if (SECRET_BASENAMES.has(basename) || LOCKFILE_BASENAMES.has(basename)) return false;
  if (SECRET_EXTENSIONS.has(path.posix.extname(basename))) return false;
  if (/(^|\/)(secrets?|credentials?|private[-_]?keys?)(\/|$)/u.test(normalized)) return false;
  if (/(^|[-_.])(lock|generated|vendor)([-_.]|$)/u.test(basename)) return false;
  return true;
}

export function isSafeDocumentContent(content: string, sizeBytes: number): boolean {
  return sizeBytes <= MAX_DOCUMENT_BYTES && !content.includes("\0");
}
