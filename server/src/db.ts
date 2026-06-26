import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import postgres, { type Sql } from "postgres";

const ADVISORY_LOCK_KEY = 0x63686f62; // "chob"

export function createSql(url: string): Sql {
  return postgres(url, { max: 10, onnotice: () => {} });
}

/** 应用 migrations/ 下未执行的 .sql:账本表 + 单事务/文件 + 顾问锁(多副本安全)。
 *
 * 实现要点:使用 sql.reserve() 固定单一连接,让顾问锁(session/connection 级)
 * 与所有迁移语句在**同一条连接**上执行,避免多副本并发迁移。
 * ReservedSql 在 postgres.js 3.x 运行时不暴露 .begin(),故用手动
 * BEGIN/COMMIT/ROLLBACK 包裹每个迁移文件。
 */
export async function migrate(sql: Sql, dir: string): Promise<string[]> {
  const reserved = await sql.reserve();
  try {
    await reserved`SELECT pg_advisory_lock(${ADVISORY_LOCK_KEY})`;
    await reserved`CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`;
    const applied = new Set(
      (await reserved<{ version: string }[]>`SELECT version FROM schema_migrations`).map((r) => r.version),
    );
    const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
    const ran: string[] = [];
    for (const file of files) {
      const version = file.replace(/\.sql$/, "");
      if (applied.has(version)) continue;
      const body = await readFile(join(dir, file), "utf8");
      await reserved`BEGIN`;
      try {
        await reserved.unsafe(body);
        await reserved`INSERT INTO schema_migrations (version) VALUES (${version})`;
        await reserved`COMMIT`;
      } catch (err) {
        await reserved`ROLLBACK`;
        throw err;
      }
      ran.push(version);
    }
    return ran;
  } finally {
    await reserved`SELECT pg_advisory_unlock(${ADVISORY_LOCK_KEY})`;
    reserved.release();
  }
}
