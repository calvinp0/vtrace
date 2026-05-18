import path from "node:path";

import { Language } from "../domain/types";

const TYPESCRIPT_EXTENSIONS = new Set([".ts", ".tsx"]);
const JAVASCRIPT_EXTENSIONS = new Set([".js", ".jsx"]);
const PYTHON_EXTENSIONS = new Set([".py"]);
const CYTHON_EXTENSIONS = new Set([".pyx", ".pxd", ".pxi"]);

export function detectLanguage(filePath: string): Language | undefined {
  const extension = path.extname(filePath).toLowerCase();

  if (TYPESCRIPT_EXTENSIONS.has(extension)) {
    return Language.TypeScript;
  }

  if (JAVASCRIPT_EXTENSIONS.has(extension)) {
    return Language.JavaScript;
  }

  if (PYTHON_EXTENSIONS.has(extension)) {
    return Language.Python;
  }

  if (CYTHON_EXTENSIONS.has(extension)) {
    return Language.Cython;
  }

  return undefined;
}

export function isIndexableSourceFile(filePath: string): boolean {
  return detectLanguage(filePath) !== undefined;
}
