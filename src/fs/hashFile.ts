import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

export async function hashFile(filePath: string): Promise<string> {
  const contents = await readFile(filePath);
  return createHash("sha256").update(contents).digest("hex");
}
