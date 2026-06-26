import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createSql, migrate } from "../src/db.js";
import type { Sql } from "postgres";

const here = dirname(fileURLToPath(import.meta.url));
export const MIGRATIONS_DIR = join(here, "..", "migrations");

export interface PgHandle { container: StartedPostgreSqlContainer; sql: Sql; url: string; stop: () => Promise<void>; }

export async function startPg(): Promise<PgHandle> {
  const container = await new PostgreSqlContainer("postgres:16-alpine").start();
  const url = container.getConnectionUri();
  const sql = createSql(url);
  await migrate(sql, MIGRATIONS_DIR);
  return { container, sql, url, stop: async () => { await sql.end({ timeout: 5 }); await container.stop(); } };
}

export async function truncateAll(sql: Sql): Promise<void> {
  await sql`TRUNCATE event_payloads, usage_events RESTART IDENTITY CASCADE`;
}
