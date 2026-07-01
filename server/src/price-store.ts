import type { PriceTable } from "./types.js";

export interface PriceStore {
  current: () => PriceTable;          // 传给 buildApp;ingest 每请求读一次
  refreshNow: () => Promise<boolean>; // 从库重读并原子热替换;返回"是否变化"
  start: (intervalMs: number) => void;
  stop: () => void;
}

export interface PriceStoreLogger {
  info: (obj: unknown, msg: string) => void;
  warn: (obj: unknown, msg: string) => void;
}
const consoleLogger: PriceStoreLogger = {
  info: (o, m) => console.log(m, o),
  warn: (o, m) => console.warn(m, o),
};

// 变更签名:版本 + 行数。仅用于"要不要打日志",赋值是无条件的。
const sig = (t: PriceTable): string => `${t.version}::${t.rows.length}`;

/**
 * 持有当前价目表的可变引用,并可定时从 `load()` 重读做原子热替换。
 * - 崩溃安全:load 抛错 → 保留上一版、warn、不抛、下拍重试。
 * - 防清空:load 返回空表(version==="")而当前有版本 → 判异常,保留上一版。
 * - 原子:单次赋值热替换;ingest 每请求 `current()` 读到的永远是某个完整快照。
 */
export function createPriceStore(
  load: () => Promise<PriceTable>,
  initial: PriceTable,
  log: PriceStoreLogger = consoleLogger,
): PriceStore {
  let table = initial;
  let timer: NodeJS.Timeout | null = null;

  async function refreshNow(): Promise<boolean> {
    let next: PriceTable;
    try {
      next = await load();
    } catch (err) {
      log.warn({ err }, "chobo: price refresh failed, keeping last-good");
      return false;
    }
    if (next.version === "" && table.version !== "") {
      log.warn({ current: table.version }, "chobo: price refresh returned empty table, keeping last-good");
      return false;
    }
    const changed = sig(next) !== sig(table);
    const from = table.version;
    table = next; // 单次赋值热替换
    if (changed) log.info({ from, to: table.version, rows: table.rows.length }, "chobo: price table reloaded");
    return changed;
  }

  return {
    current: () => table,
    refreshNow,
    start(intervalMs: number): void {
      if (timer) return;
      timer = setInterval(() => void refreshNow(), intervalMs);
      timer.unref();
    },
    stop(): void {
      if (timer) { clearInterval(timer); timer = null; }
    },
  };
}
