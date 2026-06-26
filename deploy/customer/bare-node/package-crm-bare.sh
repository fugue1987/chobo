#!/usr/bin/env bash
# 在 chobo 团队侧运行:打「裸 Node(无 Docker)」CRM 交付包。
# 产物 = dist/chobo-crm-bare-<版本>.tar.gz —— 接入方解压 → 填 env → ./start.sh(只需 Node≥20 + 自己的 Postgres)。
#
#   用法:  deploy/customer/bare-node/package-crm-bare.sh [版本号]
#   产物:  dist/chobo-crm-bare-<版本号>.tar.gz   (解压出 chobo-crm/ 目录,即交付件)
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
SRC_DIR="$REPO_ROOT/deploy/customer/bare-node"
cd "$REPO_ROOT"

VER="${1:-$(date +%Y%m%d)}"
PKG="chobo-crm-bare-${VER}"
STAGE="dist/${PKG}/chobo-crm"          # 解压后的根目录名固定为 chobo-crm/
REGISTRY="${NPM_REGISTRY:-https://registry.npmmirror.com}"

echo "→ [1/5] 构建 server (tsc)…"
( cd server && { [ -d node_modules ] || npm ci --registry="$REGISTRY"; } && npm run build )

echo "→ [2/5] 构建 web (vite)…"
( cd web && { [ -d node_modules ] || npm ci --registry="$REGISTRY"; } && npm run build )

echo "→ [3/5] 装生产依赖(--omit=dev,纯 JS、跨平台)…"
rm -rf "dist/${PKG}"
mkdir -p "$STAGE/server"
cp server/package.json server/package-lock.json "$STAGE/server/"
( cd "$STAGE/server" && npm ci --omit=dev --registry="$REGISTRY" && npm cache clean --force >/dev/null 2>&1 || true )

# 可移植性闸门:生产依赖里不应有原生 .node 二进制(否则跨平台会炸)。
if find "$STAGE/server/node_modules" -name '*.node' -print -quit | grep -q .; then
  echo "✗ 生产依赖含原生 .node 二进制,跨平台不安全,中止。" >&2
  find "$STAGE/server/node_modules" -name '*.node' >&2
  exit 1
fi

echo "→ [4/5] 组装包(两级布局:server/dist 同级 contracts/web/price-seed)…"
cp -r server/dist        "$STAGE/server/dist"
cp -r server/migrations  "$STAGE/server/migrations"
cp -r contracts          "$STAGE/contracts"
cp -r web/dist           "$STAGE/web"
cp price-seed.json       "$STAGE/price-seed.json"
cp "$SRC_DIR/start.sh"               "$STAGE/start.sh"
cp "$SRC_DIR/chobo-crm.env.example"  "$STAGE/chobo-crm.env.example"
cp "$SRC_DIR/README.md"              "$STAGE/README.md"
cp "$SRC_DIR/交付指南.md"            "$STAGE/交付指南.md"
chmod +x "$STAGE/start.sh"

echo "→ [5/5] 打包…"
( cd "dist/${PKG}" && tar czf "../${PKG}.tar.gz" chobo-crm )

echo ""
echo "✅ 交付件就绪:dist/${PKG}.tar.gz"
echo "   接入方侧:tar xzf ${PKG}.tar.gz && cd chobo-crm && cp chobo-crm.env.example chobo-crm.env && \$EDITOR chobo-crm.env && ./start.sh"
echo "   前置:Node≥20 + 一个空的 Postgres 库。无需 Docker、无需联网装依赖。"
