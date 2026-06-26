#!/usr/bin/env bash
# chobo CRM 启动器（裸 Node，无 Docker）。
# 解压后：cp chobo-crm.env.example chobo-crm.env → 填库地址+secret → ./start.sh
#
# 本脚本自带「按解压位置」推导的默认路径（price-seed / web / migrations / contracts），
# 所以包挪到任何目录都能跑，无需改路径。只有 CHOBO_DATABASE_URL / CHOBO_INGEST_SECRET 必填。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="${CHOBO_ENV_FILE:-$ROOT/chobo-crm.env}"

# 读取 chobo-crm.env（KEY=VALUE，逐行原样取值，不做 shell eval；容忍 Windows CRLF）。
if [ -f "$ENV_FILE" ]; then
  while IFS='=' read -r key val; do
    key="${key%$'\r'}"; val="${val%$'\r'}"
    case "$key" in ''|'#'*) continue ;; esac
    export "$key=$val"
  done < "$ENV_FILE"
fi

# 包内相对资源 → 绝对路径默认值（env 里显式设了就用 env 的）。
export CHOBO_PRICE_SEED="${CHOBO_PRICE_SEED:-$ROOT/price-seed.json}"
export CHOBO_WEB_DIR="${CHOBO_WEB_DIR:-$ROOT/web}"

if [ -z "${CHOBO_DATABASE_URL:-}" ]; then
  echo "✗ 未设置 CHOBO_DATABASE_URL。请在 $ENV_FILE 里填好你自己的 Postgres 连接串。" >&2
  exit 1
fi

NODE_BIN="${NODE_BIN:-node}"
if ! command -v "$NODE_BIN" >/dev/null 2>&1; then
  echo "✗ 找不到 node。本服务需要 Node.js ≥ 20（裸 Node 部署的唯一前置）。" >&2
  exit 1
fi

exec "$NODE_BIN" "$ROOT/server/dist/server.js"
