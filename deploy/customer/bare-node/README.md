# chobo CRM —— 裸 Node 交付包（无 Docker）

把这个 `.tar.gz` 解压,**解压出来的目录就是交付件本身**:填一个库地址 + 一个密钥,跑 `./start.sh` 就起来了。
不需要 Docker,不会连任何外部地址,数据全进**你自己的 Postgres**。

> 它做的事:低侵入地记录每一次大模型调用(谁 / 何时 / 什么模型 / 多少 token / 花了多少钱),
> 算好价、去重,落进你的库。你可以直接 SQL 查,也可以开自带看板看。

---

## 0. 前置(唯一两个要求)

1. **Node.js ≥ 20**(裸 Node 部署的唯一运行时依赖;`node -v` 确认)。
2. **一个你自己的 Postgres**,以及一个**空库**(下面第 1 步建)。

> 包里已含全部生产依赖(`server/node_modules`,纯 JS、跨平台),**无需联网 `npm install`**。

---

## 1. 解压后的目录

```
chobo-crm/
├── start.sh                 # 启动器(自动按解压位置设好内部路径)
├── chobo-crm.env.example    # 配置样例 → 复制成 chobo-crm.env 填两项
├── README.md                # 本文件
├── price-seed.json          # 价目表种子(版本 2026-06-26a)
├── server/                  # CRM 本体(已编译,非源码)
│   ├── dist/                #   node server/dist/server.js
│   ├── migrations/          #   启动时自动建表/迁移
│   └── node_modules/        #   生产依赖(纯 JS,跨平台)
├── contracts/               # 事件 JSON 契约(校验用)
└── web/                     # 看板静态产物(可选;不想要可不管)
```

---

## 2. 上手(4 步)

### 1) 建一个空库(你自己的 Postgres)
不用建表,CRM 启动会自动建表 + 灌价目表:
```sql
CREATE DATABASE chobo;
CREATE USER chobo WITH PASSWORD '改成强密码';
GRANT ALL PRIVILEGES ON DATABASE chobo TO chobo;
```

### 2) 填配置
```bash
cp chobo-crm.env.example chobo-crm.env
# 编辑 chobo-crm.env,填:
#   CHOBO_DATABASE_URL  → 指向上一步的库
#   CHOBO_INGEST_SECRET → 自定一串强随机串(下一步业务服务要用同一串)
```

### 3) 启动
```bash
./start.sh
# 看到日志 "chobo CRM up"（priceVersion=2026-06-26a, seedInserted=true）即就绪。
# 已自动建表 + 灌价目。默认监听 0.0.0.0:8787。
```
- 看板:浏览器开 `http://<本机IP>:8787/`。
- 想后台常驻 → 见下「保持常驻」。

### 4) 把业务服务接上来
在用了 chobo SDK 的业务服务(node-ai-proxy / python-lesson-parser / 任意接入方服务)的 `.env` 里加:
```bash
CHOBO_INGEST_URL=http://<CRM所在主机IP>:8787/v1/events
CHOBO_INGEST_SECRET=<与 chobo-crm.env 里【完全相同】>
CHOBO_SPOOL_DIR=./.chobo-spool
```
重启业务服务。**完。** 之后每次大模型调用都会**异步**落账到这台 CRM(永不阻塞业务)。

- 业务服务与 CRM 同机 → 用宿主 IP 或 `127.0.0.1`(若 CRM 绑了 0.0.0.0/本机)。
- 业务服务在容器里、CRM 在宿主 → 用 `host.docker.internal:8787`。

---

## 3. 你的数据在哪(直接查库)

不开看板也行。所有账目在一张表 **`usage_events`**(一行 = 一次大模型调用,已算好价)。关键列:

| 列 | 含义 |
|----|------|
| `account` / `user_id` / `org_id` / `project` | 归因维度(谁,含从属)。**这就是网关看不到、本产品补上的 per-终端用户归因** |
| `service` / `provider` / `operation` | 哪个服务 / 计价来源 / 操作类型(chat、image…) |
| `request_model` / `response_model` | 模型 |
| `input_tokens` / `output_tokens` / `cached_tokens` / `reasoning_tokens` / `total_tokens` | 用量 |
| `total_cost`(+ `input_cost`/`output_cost`/`cache_cost`) | **算好的成本**;明细见 `cost_breakdown`(jsonb) |
| `currency` | 币种(如 `CNY`/`USD`)。**永不跨币种相加** |
| `price_table_version` | 用了哪版价目(可审计) |
| `status` / `start_time` / `created_at` | 状态 / 调用时刻 / 入库时刻 |

**示例:按终端用户出账(分币种,绝不跨币种求和):**
```sql
SELECT account, user_id, currency,
       count(*)         AS calls,
       sum(total_cost)  AS cost
FROM usage_events
WHERE total_cost IS NOT NULL          -- 已计价的
GROUP BY account, user_id, currency
ORDER BY cost DESC;
```

> 原始请求/响应载荷(若开启留存)在 `event_payloads`;价目表在 `price_table`。

---

## 4. 降级保证(为什么零风险)

- 业务服务**不配 `CHOBO_INGEST_URL`** → SDK 全程 no-op,接 chobo 前后**字节等同**。
- SDK **响应返回后才异步上报**,永不阻塞/拖慢真实模型调用;**这台 CRM 挂了也只丢计量,不影响业务**。
- **幂等**:每事件带 `event_id`,CRM 去重 → 重投不重复计费。

---

## 5. 安全(生产建议)

- 默认监听 `0.0.0.0:8787`。看板本身**无登录页**(读侧鉴权设计上交给前置反代)。生产二选一:
  1. **前置 nginx + basic-auth**:`/` 加 basic-auth,仅 `POST /v1/events` 豁免(靠 `x-chobo-secret`);
     并把 `CHOBO_HOST=127.0.0.1` 只在本机监听,由 nginx 反代。
  2. **防火墙**只放通业务服务来源 IP 到 8787。
- ingest 的唯一闸门是 `CHOBO_INGEST_SECRET`(`x-chobo-secret` 头)→ 用强随机串、按客户隔离。

---

## 6. 保持常驻

`start.sh` 是前台进程。生产挑一种守护方式:

**systemd**(`/etc/systemd/system/chobo-crm.service`):
```ini
[Unit]
Description=chobo CRM
After=network.target

[Service]
WorkingDirectory=/opt/chobo-crm
ExecStart=/opt/chobo-crm/start.sh
Restart=always
User=chobo

[Install]
WantedBy=multi-user.target
```
```bash
sudo systemctl enable --now chobo-crm
sudo journalctl -u chobo-crm -f      # 看日志
```

**pm2**(若已用 Node 生态):
```bash
pm2 start ./start.sh --name chobo-crm
```

---

## 7. 升级

把新版 `.tar.gz` 解压覆盖(或解到新目录),重启服务即可:
- **迁移**幂等自动跑;**算价/看板**逻辑随包更新。
- **价目表**:启动时做**版本增量同步** —— 新包的 price-seed 若带库里还没有的新版本,自动插入
  (不覆盖任何已有版本/你的人工调价),立即生效。**换包 = 自动带上新价**,不用手动 SQL。
- **唯一可能的一次性人工**:若某模型的事件在**补价之前**就已落库(当时成本算 NULL),跑一次
  `CHOBO_DATABASE_URL=... CHOBO_PRICE_SEED=./price-seed.json node server/dist/reprice-cli.js` 回填。

---

## 8. 故障排查

| 现象 | 多半是 |
|------|--------|
| `找不到 node` / 启动即退 | Node 版本 < 20,或 PATH 里没有 node |
| 启动报 `CHOBO_DATABASE_URL is required` | 没填库地址,或 `chobo-crm.env` 没改名/没在同目录 |
| 连不上库 | 库地址/账号/防火墙;CRM 与库要网络可达 |
| 看板能开但没数据 | 业务服务的 `CHOBO_INGEST_URL` / `CHOBO_INGEST_SECRET` 没配或 secret 不一致;或还没产生调用 |
| 端口被占 | 改 `CHOBO_PORT` |

日志里有明确报错(不会静默吞错)。把启动日志贴给我们即可定位。
