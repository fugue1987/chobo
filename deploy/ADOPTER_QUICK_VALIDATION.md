# AdopterA → chobo.example.com 快速验证

目标:让 AdopterA(node-ai-proxy + python-lesson-parser)的真实流量打到**现有共享 CRM**
`chobo.example.com`,在看板上看到 `account=adopter-a` 的事件 —— 证明端到端通了即可。
(长期仍走 directive #4:给 AdopterA 起**独立** CRM;本文件只为「先看见数据」。)

---

## 1. 放开公网 ingest(nginx,一次性)

> **✅ 已完成(2026-06-26):** fugue 已在生产用 [`deploy/nginx.chobo.conf`](nginx.chobo.conf) 覆盖 vhost 并 reload。公网 ingest **`https://chobo.example.com/v1/events`** 已放开(POST 豁免 basic-auth、由 `x-chobo-secret` 守门),本会话实测 `GET https://chobo.example.com/` → **401**(读侧 basic-auth 在守、符合设计 ⇒ DNS→nginx→CRM 链路活)。下面是参考/复现步骤。

现有 vhost 把 basic-auth 加在整个 server 块上 → 外部接入方(AdopterA 不在容器内网,SDK 发
`x-chobo-secret` 而非 basic-auth)会被 401 挡住。改用分层鉴权:**仅 POST `/v1/events` 豁免
basic-auth**(由 CRM 的 `x-chobo-secret` 鉴权),GET 审计与看板仍走 basic-auth(共享 CRM 含
five-elements 真实 per-end-user 数据,读侧不可裸奔)。

在生产宿主上用本仓 [`deploy/nginx.chobo.conf`](nginx.chobo.conf) 覆盖当前 vhost,然后:

```bash
nginx -t && nginx -s reload        # 或 systemctl reload nginx
```

验证(应 401,因为缺 secret;但说明已路由到 CRM 而非被 basic-auth 拦):
```bash
curl -s -o /dev/null -w "%{http_code}\n" -X POST https://chobo.example.com/v1/events \
  -H 'content-type: application/json' -d '{"events":[]}'        # 期望 401(secret 不对)
```

> **安全注记:** 这一步把共享 CRM 的 POST ingest 暴露到公网,唯一闸门是 `x-chobo-secret`(与
> five-elements 共用同一 secret)。可接受用于验证;长期(#4)每客户独立 CRM + 独立 secret 更稳。

---

## 2. AdopterA 两服务 .env 加 chobo 段(固定一套,与 five-elements 一致)

**这套是固定的,加上即可。** 两个服务用同一组(URL/secret 相同):

```bash
# ── chobo 用量计量(可选,env 闸门;不配 CHOBO_INGEST_URL 则全程 no-op,服务字节等同) ──
CHOBO_INGEST_URL=https://chobo.example.com/v1/events
CHOBO_INGEST_SECRET=<与 five-elements / CRM 部署 runbook step-2 相同的 secret>
CHOBO_SPOOL_DIR=./.chobo-spool          # 容器内可用 /app/.chobo-spool
```

- `account=adopter-a`、`service`(node-ai-proxy / python-lesson-parser)、粗粒度 `user_id=default`
  都由 SDK 接入点写死,**无需在 .env 配**。
- 若 AdopterA **恰好**和 CRM 同在生产宿主的 `postgres18_default` docker 网,可改用内网
  `CHOBO_INGEST_URL=http://chobo-crm:8787/v1/events`(免 nginx 改动,免公网暴露)—— 更省。

重启两服务即生效(SDK 响应后异步上报,不阻塞业务)。

---

## 3. 在看板看数据

打开 `https://chobo.example.com`(basic-auth 登录)→ 顶部 `account` 过滤填 `adopter-a`
→ 应看到事件按终端…粗粒度 `default` 聚合,`provider`/`model`/`tokens` 正确。

跑一条 AdopterA 流程触发:
- **教案上传 / 目标生成(python 3 阶段)** → `doubao` chat 事件,**当前部署的 CRM 即可计价**
  (doubao 价已 seed)→ 看板出 ¥ 成本。**这条就是最干净的「通了」证据。**
- **资源中心 PRO/FLASH(node-ai-proxy)** → `gpt-5.5` / `gemini-3.5-flash` 事件会出现,
  **生产 CRM 现已是 `2026-06-26a`(2026-06-26 实测 boot log `priceVersion=2026-06-26a`)→ 这两个模型按 USD 计价**
  (只有早于补价就落库的旧事件才 NULL,跑一次 reprice 回填即可)。

---

## 4. 让 gpt-5.5 / gemini 也计价(合并后重发镜像即自动)

> **✅ 已完成(2026-06-26):** `feature/adopter-a-onboarding` 已合 master、`ship-crm.sh` 已重发镜像;
> 生产 CRM boot log 实测 `priceVersion=2026-06-26a`(`seedInserted:true`,6 行价 + 1 别名)
> ⇒ gpt-5.5 / gemini 已按 USD 计价。下面是原理说明(增量同步如何自动生效)。

新价目 `2026-06-26a`(加 `newapi/gpt-5.5` 5/30/cache0.5 USD、`newapi/gemini-3.5-flash`
1.5/9/cache0.15 + reasoning=9 USD)在本分支的 [`price-seed.json`](../price-seed.json)。

合并 `feature/adopter-a-onboarding` 后,[`deploy/ship-crm.sh`](ship-crm.sh) 重打镜像 →
`docker compose up -d --force-recreate`。**CRM boot 时 `syncPriceSeed` 见库里没有 `2026-06-26a`
→ 自动插入该版本**(版本增量同步:不碰已有的 `2026-06-25a` 行、不覆盖任何人工调价),
`loadPriceTable` 随即取到新 max version → 之后的 gpt-5.5/gemini 事件**自动按新价计**。
无需手动 `INSERT`、无需单独 `restart`(重发即重启)。

唯一可能的一次性人工:若 gpt-5.5/gemini 事件在**补价之前**就已落库(当时算 NULL),跑一次
`docker exec chobo-crm npm run reprice` 回填;补价在流量之前则零人工。

部署前已落库、无 token 拆分的旧 gpt-image-2 事件保持 NULL —— 诚实,不回填假值。
