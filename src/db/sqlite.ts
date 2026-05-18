import { Database } from "bun:sqlite";

import { initializeSchema } from "./schema";

export function openIndexerDatabase(path = ":memory:"): Database {
  const db = new Database(path);
  db.run("PRAGMA foreign_keys = ON");
  initializeSchema(db);
  return db;
}
