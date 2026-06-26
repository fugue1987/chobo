# CRM 部署 Runbook

**目标主机:** `203.0.113.10` · **CRM 容器:** `chobo-crm` · **端口:** `8787`
**看板域名:** `chobo.example.com` (nginx 反代 + basic-auth)

> 按顺序执行，每步完成后再进下一步。

---

## Step 1 (一次性) — 建 chobo 数据库与用户

在本地 repo 根，先编辑 `deploy/chobo-init-db.sql`，将其中的 `CHANGE_ME_STRONG_PASSWORD` 替换为强密码，**记住该密码**供 Step 2 使用。然后在生产主机上执行：

```bash
# 在生产主机 root@203.0.113.10 上执行
docker exec -i postgres18 psql -U pgadmin -d default_db < chobo-init-db.sql
```

> 此命令只需运行一次。若数据库/用户已存在，脚本会安全地跳过（`IF NOT EXISTS`）。

---

## Step 2 — 在主机上创建密钥环境文件

`chobo.prod.env` 是含数据库密码和 ingest secret 的敏感文件，**绝对不能提交到 git，只存于主机**。

在生产主机上创建 `/opt/chobo/chobo.prod.env`：

```bash
# 在生产主机上执行
mkdir -p /opt/chobo
cat > /opt/chobo/chobo.prod.env <<'EOF'
CHOBO_DATABASE_URL=postgres://chobo:<Step-1-中设置的密码>@postgres18:5432/chobo
CHOBO_INGEST_SECRET=<见下方生成命令>
EOF
```

生成 ingest secret（在主机上执行，将输出值填入上方文件）：

```bash
openssl rand -hex 32
```

> **重要:** `CHOBO_INGEST_SECRET` 的值必须与 five-elements 的 `server.prod.env` 中 `CHOBO_INGEST_SECRET` 完全一致（见 Step 5）。请妥善保存这个值。

---

## Step 3 — 本地构建 + 推送 + 启动容器

在本地 repo 根（Windows Git Bash 或 WSL）执行：

```bash
bash deploy/ship-crm.sh
```

该脚本自动完成以下操作：
1. `docker build -f ci/Dockerfile -t chobo-crm:latest .` — 本地构建镜像
2. `docker save ... | gzip` — 打包镜像
3. `scp` — 上传镜像压缩包和 `docker-compose.crm.yml` 到 `/opt/chobo/`
4. 远端 `docker load` — 加载镜像
5. `docker compose up -d --force-recreate` — 启动/重启容器
6. 健康检查 `curl http://127.0.0.1:8787/healthz`（最多重试 3 次，间隔 3/6/9 秒）

脚本最后输出 `health OK` 则部署成功；若输出 `!! health 失败` 则自动打印最后 50 行日志供排查。

> 若主机上缺少 `/opt/chobo/chobo.prod.env`，脚本会拒绝启动并提示，保护现有容器不被覆盖。

---

## Step 4 — 激活看板子域名 (nginx + basic-auth)

以下操作在**生产主机**上执行：

### 4a. 创建 basic-auth 用户

```bash
# 安装 apache2-utils（若未装）
apt-get install -y apache2-utils

# 创建密码文件（-c 表示新建；后续添加用户去掉 -c）
htpasswd -c /etc/nginx/.htpasswd.chobo <username>
```

### 4b. 安装 nginx vhost 配置

将 repo 中的 `deploy/nginx.chobo.conf` 复制到主机（可通过 scp 或粘贴）：

```bash
# 从本地执行 scp（或在主机上手动粘贴文件内容）
scp deploy/nginx.chobo.conf root@203.0.113.10:/etc/nginx/sites-available/chobo.example.com
```

在主机上启用并重载：

```bash
ln -sf /etc/nginx/sites-available/chobo.example.com /etc/nginx/sites-enabled/
nginx -t && systemctl reload nginx
```

### 4c. 配置 DNS

在域名服务商控制台，为 `chobo.example.com` 添加 A 记录，指向 `203.0.113.10`。DNS 生效后，访问 `https://chobo.example.com`（basic-auth 弹框）即可打开看板。

> **不等 DNS 的替代方案:** 本地 SSH 隧道
> ```bash
> ssh -L 8787:127.0.0.1:8787 root@203.0.113.10
> # 然后本地浏览器打开 http://localhost:8787
> ```

---

## Step 5 — 修正 five-elements 环境变量并重新部署

five-elements 当前 prod env 的 `CHOBO_INGEST_URL` 指向 `127.0.0.1`（CRM 未部署时的占位），需更新为容器网络内部地址，并填入与 Step 2 相同的 `CHOBO_INGEST_SECRET`。

在**生产主机**上编辑 `/opt/five-elements/server.prod.env`，确保以下三行正确：

```bash
CHOBO_INGEST_URL=http://chobo-crm:8787/v1/events
CHOBO_INGEST_SECRET=<Step-2 中生成的相同值>
CHOBO_SPOOL_DIR=/app/.chobo-spool
```

然后在**本地** five-elements repo 根执行重新部署（使用 five-elements 自己的 ship 脚本）：

```bash
bash deploy/ship.sh
```

> **Spool 自动回放:** five-elements 在 CRM 未上线期间积攒的事件已 spool 到 `/app/.chobo-spool`。容器重启后，SDK 检测到 CRM 可达，会自动重投这些事件，完成历史数据的回填计费，无需人工干预。

---

## Step 6 — 验收

打开看板确认真实流量已归因：

```
https://chobo.example.com
```

（或通过 SSH 隧道 `http://localhost:8787`）

预期状态检查：
- **doubao 文本调用**已出现并有价格（按 `price_table` 中配置的单价）
- **gpt-image-2 调用**出现但 `cost` 为 `NULL`（价格待 fugue 录入后执行 `/v1/reprice`）
- 流量按 account（接入方）+ identity（doubao worker / gpt-image worker）正确归因，无 `identity_source=missing` 告警

---

## 附: 密钥文件说明

| 文件 | 存放位置 | 是否提交 git |
|------|----------|------------|
| `chobo.prod.env` | 仅主机 `/opt/chobo/chobo.prod.env` | **严禁** |
| `server.prod.env` | 仅主机 `/opt/five-elements/server.prod.env` | **严禁** |
| `chobo-init-db.sql` | repo `deploy/` 目录，密码替换后**不提交修改** | 模板可提交，改密码后不 commit |

---

## 运维须知 — 价目升级现在是「换镜像即自动」

**价目表是 CRM 进程级缓存:** `server.ts` 启动时 `loadPriceTable()` 加载一次(取库里**最大 version**),`ingest` 用缓存闭包计价、运行中不重查库(reprice 是独立进程、会重查)。

**升级价目的正路(零手工 SQL):** 改 [`price-seed.json`](../price-seed.json) 的 `version` + 加新行 → 重打镜像 → `docker compose up -d --force-recreate`。boot 时 `syncPriceSeed` 做**版本增量同步**:库里没有该新 version 就整版插入(**不碰旧版本、不覆盖任何人工调价**),`loadPriceTable` 随即取到新 max version。**换镜像 = 重启 = 自动带上新价**,不必手动 `INSERT`、不必单独 `restart`。

```bash
docker compose up -d --force-recreate            # 重发=重启,boot 自动 syncPriceSeed + loadPriceTable
docker logs chobo-crm --tail 30 | grep "CRM up"  # 确认 priceVersion / seedInserted=true
docker exec chobo-crm npm run reprice            # 仅当补价晚于流量:回填此前算 NULL 的事件
```

> `syncPriceSeed`(`server.ts`)按 version 增量同步,Plan 7 当时「先起 CRM、后灌新价 → 进程看不到新价」的坑已不会再发生(boot 自动引入新版本)。
> 唯一还需手动 `docker restart` 的情形:你**绕过版本机制、直接 `UPDATE` 运行中库的价行**(不推荐 —— 正路是 bump `version` 让它进审计);那时进程仍用旧缓存,须重启重载。
