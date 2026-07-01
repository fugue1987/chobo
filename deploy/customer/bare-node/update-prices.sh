#!/usr/bin/env bash
# chobo:新增/更新模型价格(运行中的 CRM 无需重启)。
# 用法:改好 price-seed.json 里的 version(并追加/修改价目行)后,跑 ./update-prices.sh
#   1) 把新版本【版本增量】写进你的库(幂等,绝不覆盖已有版本/人工调价);
#   2) 回填"补价之前就已落库、当时算 NULL"的历史事件(幂等,默认只碰 NULL 行);
# 运行中的 CRM 会在 ≤ CHOBO_PRICE_REFRESH_SEC 秒内自动拾取新价(默认 60s)。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="${CHOBO_ENV_FILE:-$ROOT/chobo-crm.env}"

if [ -f "$ENV_FILE" ]; then
  while IFS='=' read -r key val; do
    key="${key%$'\r'}"; val="${val%$'\r'}"
    case "$key" in ''|'#'*) continue ;; esac
    export "$key=$val"
  done < "$ENV_FILE"
fi
export CHOBO_PRICE_SEED="${CHOBO_PRICE_SEED:-$ROOT/price-seed.json}"

if [ -z "${CHOBO_DATABASE_URL:-}" ]; then
  echo "✗ 未设置 CHOBO_DATABASE_URL(在 $ENV_FILE 里填好你自己的 Postgres 连接串)。" >&2
  exit 1
fi
NODE_BIN="${NODE_BIN:-node}"
if ! command -v "$NODE_BIN" >/dev/null 2>&1; then
  echo "✗ 找不到 node。本工具需要 Node.js ≥ 20。" >&2
  exit 1
fi

echo "→ [1/2] 写入价目(版本增量,幂等)…"
"$NODE_BIN" "$ROOT/server/dist/seed-cli.js" "$CHOBO_PRICE_SEED"
echo "→ [2/2] 回填补价前的 NULL 事件(幂等)…"
"$NODE_BIN" "$ROOT/server/dist/reprice-cli.js"
echo "✅ 完成。运行中的 CRM 将在 ≤ CHOBO_PRICE_REFRESH_SEC 秒内自动生效(默认 60s),无需重启。"
