/**
 * Compile the tree-sitter grammar packages that ship sources only (M202 §43).
 *
 * Most grammar packages carry a prebuilt binary for this platform and need
 * nothing. Three (Dart, Clojure, SQL) publish `src/parser.c` and a Node-API
 * binding but no prebuild, so `node-gyp rebuild` runs once here, at install
 * time, and the loader finds `build/Release/*.node` afterwards. Nothing is
 * downloaded at runtime; a grammar that fails to build is reported and left
 * unregistered (the family will not count), never guessed around.
 *
 *   bun scripts/build_tree_sitter_grammars.ts        (also the package postinstall)
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);

const COMPILED_GRAMMARS = [
  "tree-sitter-dart-orchard",
  "tree-sitter-clojure-orchard",
  "@derekstride/tree-sitter-sql",
] as const;

function hasNativeArtifact(dir: string): boolean {
  return existsSync(dir) && readdirSync(dir).some((name) => name.endsWith(".node"));
}

let failures = 0;
for (const moduleName of COMPILED_GRAMMARS) {
  let packageDir: string;
  try {
    packageDir = path.dirname(require.resolve(`${moduleName}/package.json`));
  } catch {
    console.log(`skip     ${moduleName}: not installed`);
    continue;
  }
  const prebuilt = path.join(packageDir, "prebuilds", `${process.platform}-${process.arch}`);
  const built = path.join(packageDir, "build", "Release");
  if (hasNativeArtifact(prebuilt) || hasNativeArtifact(built)) {
    console.log(`present  ${moduleName}`);
    continue;
  }
  try {
    execFileSync("node-gyp", ["rebuild"], { cwd: packageDir, stdio: ["ignore", "ignore", "pipe"] });
    console.log(`built    ${moduleName} -> ${built}`);
  } catch (error) {
    failures += 1;
    console.log(`FAILED   ${moduleName}: ${String((error as { stderr?: Buffer }).stderr ?? error).slice(0, 400)}`);
  }
}
if (failures > 0) {
  console.log(`${failures} grammar(s) did not build; those families stay unregistered until they do.`);
}
