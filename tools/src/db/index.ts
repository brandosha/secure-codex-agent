import fs from "fs";
import path from "path";

import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";

import * as schema from "./schema";

const DB_DIRECTORY = path.resolve(import.meta.dirname, "../../data");
const DB_PATH = path.join(DB_DIRECTORY, "agent-events.sqlite");
const MIGRATIONS_DIRECTORY = path.resolve(import.meta.dirname, "../../drizzle");

fs.mkdirSync(DB_DIRECTORY, { recursive: true });

const sqlite = new Database(DB_PATH);
export const db = drizzle(sqlite, { schema });
migrate(db, { migrationsFolder: MIGRATIONS_DIRECTORY });

export { DB_PATH, MIGRATIONS_DIRECTORY, sqlite };
