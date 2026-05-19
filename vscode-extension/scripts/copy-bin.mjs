#!/usr/bin/env node
// Copies the repo-root bin/vtrace launcher into the extension folder so that a
// packaged VSIX includes the bundled launcher. Safe to run repeatedly.

import { copyFile, mkdir, stat, chmod } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION_DIR = path.resolve(HERE, "..");
const REPO_ROOT = path.resolve(EXTENSION_DIR, "..");
const SOURCE = path.join(REPO_ROOT, "bin", "vtrace");
const TARGET_DIR = path.join(EXTENSION_DIR, "bin");
const TARGET = path.join(TARGET_DIR, "vtrace");

async function main() {
  try {
    await stat(SOURCE);
  } catch {
    console.error(`[copy-bin] Expected launcher at ${SOURCE}. Skipping copy.`);
    return;
  }

  await mkdir(TARGET_DIR, { recursive: true });
  await copyFile(SOURCE, TARGET);
  await chmod(TARGET, 0o755);
  console.log(`[copy-bin] Copied ${SOURCE} -> ${TARGET}`);
}

await main();
