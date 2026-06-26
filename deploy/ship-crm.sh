#!/usr/bin/env bash
# 一键更新生产 chobo CRM —— 本地跑这一个脚本即可,无需登录服务器敲命令。
#   build 镜像(含最新 price-seed.json + 看板) → 传到宿主 → load → compose up。
#   CRM boot 时自动:① migrate(建/迁表)② syncPriceSeed(库里没有的新价目版本自动插入,
#   不覆盖人工调价)→ 改价/加模型价 = 改 price-seed.json + 跑本脚本,零手工 SQL。
#   改了已落库事件的价、需回填历史 NULL 时:加 REPRICE=1(否则不动历史)。
#   用法:  bash deploy/ship-crm.sh            # 常规升级(代码/价目版本)
#          REPRICE=1 bash deploy/ship-crm.sh   # 升级 + 回填历史 NULL 事件
set -euo pipefail
HOST="${HOST:-203.0.113.10}"
SSH_TARGET="root@${HOST}"
REMOTE="${REMOTE_DIR:-/opt/chobo}"
export MSYS_NO_PATHCONV=1                 # Windows Git Bash 防路径转换
cd "$(dirname "$0")/.."                    # repo 根

echo "==> build chobo-crm:latest"
docker build -f ci/Dockerfile -t chobo-crm:latest .

echo "==> save + gzip"
docker save chobo-crm:latest | gzip > /tmp/chobo-crm.tar.gz

echo "==> scp 镜像 + compose"
ssh "$SSH_TARGET" "mkdir -p ${REMOTE}"
scp /tmp/chobo-crm.tar.gz "${SSH_TARGET}:${REMOTE}/"
scp deploy/docker-compose.crm.yml "${SSH_TARGET}:${REMOTE}/"

echo "==> remote load + up"
ssh "$SSH_TARGET" REMOTE="${REMOTE}" REPRICE="${REPRICE:-0}" bash -s <<'REMOTE_EOF'
set -euo pipefail
cd "${REMOTE}"
docker load < chobo-crm.tar.gz
if [ ! -f chobo.prod.env ]; then
  echo "!! 缺 chobo.prod.env(需含 CHOBO_DATABASE_URL=postgres://chobo:<pw>@postgres18:5432/chobo 与 CHOBO_INGEST_SECRET),中止"; exit 1
fi
docker compose -f docker-compose.crm.yml up -d --force-recreate   # boot 自动 migrate + syncPriceSeed
check_health() {
  for d in 3 6 9; do sleep "$d"
    if curl -fs http://127.0.0.1:8787/healthz >/dev/null; then echo "health OK"; return 0; fi
  done
  echo "!! health 失败"; docker compose -f docker-compose.crm.yml logs --tail=50; return 1
}
check_health
docker logs chobo-crm --tail 20 | grep "CRM up" || true     # 看 priceVersion / seedInserted
if [ "${REPRICE:-0}" = "1" ]; then
  echo "==> reprice 回填历史 NULL 事件"
  docker exec chobo-crm npm run reprice
fi
REMOTE_EOF
echo "==> done. 升级完成(价目随镜像 boot 自动同步)。看板激活见 deploy/CRM_DEPLOY_RUNBOOK.md"
