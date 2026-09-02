/**
 * Grammar loading for the generic tree-sitter families (M202).
 *
 * Every grammar is a native addon inside an npm package, and packages differ in
 * how they hand it over: most ship a `prebuilds/<platform>-<arch>/` binary and a
 * `bindings/node/index.js` that loads it; scoped packages name that binary
 * `<scope>+<name>.node` while their Bun code path looks for `<name>.node`
 * (a packaging defect this loader routes around by requiring the file itself);
 * three packages ship sources only and are compiled at install time into
 * `build/Release/`. The loader does not care which — it asks the disk.
 *
 * Two properties are load-bearing:
 *
 *   - LAZY. Nothing is dlopen'ed until a file of that family is parsed, so
 *     building the registry costs a handful of `stat` calls, not thirty
 *     library loads (§44).
 *   - BOUNDED AND IMMUTABLE. A loaded language object is cached for the
 *     process lifetime, one per (package, export); there are at most as many as
 *     there are families (§45).
 */
import { existsSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

import type { GrammarSpec } from "./languageFamilies";

const require = createRequire(import.meta.url);

export interface GrammarArtifactStatus {
  readonly available: boolean;
  readonly packageDir: string | null;
  readonly artifactPath: string | null;
  readonly reason: string | null;
}

function packageDirOf(moduleName: string): string | null {
  try {
    return path.dirname(require.resolve(`${moduleName}/package.json`));
  } catch {
    return null;
  }
}

function nativeArtifactIn(dir: string): string | null {
  if (!existsSync(dir)) return null;
  const candidates = readdirSync(dir).filter((name) => name.endsWith(".node")).sort();
  return candidates.length === 0 ? null : path.join(dir, candidates[0]!);
}

/**
 * Whether the grammar's native binary exists for this platform. A registry
 * only registers a family whose artefact is present, so "registered" implies
 * "loadable" and a missing compile step surfaces as a missing family rather
 * than as a parse-time crash.
 */
export function grammarArtifactStatus(spec: GrammarSpec): GrammarArtifactStatus {
  const packageDir = packageDirOf(spec.module);
  if (packageDir === null) {
    return { available: false, packageDir: null, artifactPath: null, reason: `package ${spec.module} is not installed` };
  }
  const prebuilt = nativeArtifactIn(path.join(packageDir, "prebuilds", `${process.platform}-${process.arch}`));
  const compiled = nativeArtifactIn(path.join(packageDir, "build", "Release"));
  const artifactPath = prebuilt ?? compiled;
  if (artifactPath === null) {
    return {
      available: false, packageDir, artifactPath: null,
      reason: `no native binary for ${process.platform}-${process.arch} under ${spec.module} `
        + `(expected prebuilds/ or build/Release/; run scripts/build_tree_sitter_grammars.ts)`,
    };
  }
  return { available: true, packageDir, artifactPath, reason: null };
}

const loaded = new Map<string, unknown>();

function pickExport(moduleObject: unknown, exportName: string | undefined, moduleName: string): unknown {
  if (exportName === undefined) return moduleObject;
  const value = (moduleObject as Record<string, unknown> | null)?.[exportName];
  if (value === undefined || value === null) {
    throw new Error(`grammar package ${moduleName} has no export named ${exportName}`);
  }
  return value;
}

/**
 * Load the language object for `spec`, choosing the per-extension export where
 * the family declares one. Throws if the artefact is absent; callers that need
 * a soft answer ask `grammarArtifactStatus` first.
 */
export function loadGrammar(spec: GrammarSpec, filePath?: string): unknown {
  const extension = filePath === undefined ? "" : path.extname(filePath).toLowerCase();
  const exportName = spec.exportByExtension?.[extension] ?? spec.exportName;
  const key = `${spec.module}\0${exportName ?? ""}`;
  const cached = loaded.get(key);
  if (cached !== undefined) return cached;

  let language: unknown;
  try {
    language = pickExport(require(spec.module), exportName, spec.module);
  } catch (error) {
    // The package's own loader failed (typically the scoped-package filename
    // mismatch under Bun). Load the binary the status check found directly.
    const status = grammarArtifactStatus(spec);
    if (!status.available || status.artifactPath === null) {
      throw error;
    }
    language = pickExport(require(status.artifactPath), exportName, spec.module);
  }
  loaded.set(key, language);
  return language;
}

/** Test seam: how many distinct grammars this process has loaded so far. */
export function loadedGrammarCount(): number {
  return loaded.size;
}
