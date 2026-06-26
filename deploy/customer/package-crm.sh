#!/usr/bin/env bash
# 在 chobo 团队侧运行(repo 根目录有 ci/Dockerfile):打 chobo-crm 镜像并导出为可交付 tar。
# 交付给接入方的整包 = 本 tar + deploy/customer/{docker-compose.yml, chobo-crm.env.example, README.md}。
#
#   用法:  deploy/customer/package-crm.sh [版本号]
#   产物:  dist/chobo-crm-<版本号>.tar.gz   (接入方侧:docker load < 该文件)
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

VER="${1:-$(date +%Y%m%d)}"
OUT="dist/chobo-crm-${VER}.tar.gz"

echo "→ 构建镜像 chobo-crm:latest (ci/Dockerfile,含 price-seed.json + 看板静态)…"
docker build -f ci/Dockerfile -t chobo-crm:latest .

mkdir -p dist
echo "→ 导出镜像 → ${OUT} …"
docker save chobo-crm:latest | gzip > "$OUT"

echo ""
echo "✅ 交付件就绪:${OUT}"
echo "   连同 deploy/customer/ 下的 compose + env 样例 + README 一起打包交给接入方即可。"
echo "   接入方侧:docker load < $(basename "$OUT")  &&  docker compose up -d"
