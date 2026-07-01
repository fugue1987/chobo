# chobo CRM —— 接入方 turnkey 部署包

把这一套交给接入方,**交出去就不用我们操心**:他们自备 postgres,跑一条 compose,
改一下业务服务的 env、重启,就接好了。没有 chobo CRM 时业务**字节等同、零影响**(SDK env 闸门)。

> 交付整包 = `chobo-crm-<ver>.tar.gz`(镜像)+ 本目录的 `docker-compose.yml` +
> `chobo-crm.env.example` + 本 README。镜像由 chobo 团队用 [`package-crm.sh`](package-crm.sh) 产出。

---

## 接入方侧 —— 4 步

### 1) 准备 postgres(接入方自己的)
建一个空库即可,**不用建表**(CRM 启动会自动建表 + 灌价目表):
```sql
CREATE DATABASE chobo;
-- 给一个能连该库的账号
```

### 2) 载入 CRM 镜像
```bash
docker load < chobo-crm-<ver>.tar.gz
```

### 3) 配置 + 起 CRM
```bash
cp chobo-crm.env.example chobo-crm.env
# 编辑 chobo-crm.env:填 CHOBO_DATABASE_URL(指向第 1 步的库)+ CHOBO_INGEST_SECRET(自定强随机串)
docker compose up -d
docker compose logs -f chobo-crm        # 看到 "chobo CRM up" 即就绪(已自动建表 + 灌价)
```
看板:浏览器开 `http://<本机 IP>:8787/`。

> **零外部依赖试用**:不想自己装 postgres,用 `docker-compose.all-in-one.yml`(连库一起拉起)。

### 4) 把业务服务接上 CRM
在接入方业务服务(node-ai-proxy / python-lesson-parser / 任意用了 chobo SDK 的服务)的 `.env` 加:
```bash
CHOBO_INGEST_URL=http://<CRM 所在主机 IP>:8787/v1/events
CHOBO_INGEST_SECRET=<与 chobo-crm.env 里 *完全相同*>
CHOBO_SPOOL_DIR=./.chobo-spool
```
重启业务服务。**完。** 之后每次大模型调用都会异步落账到这台 CRM,看板实时可见。

- 业务服务与 CRM 同机、CRM 用本 compose 暴露了 8787 → 用宿主 IP 即可互通。
- 业务服务也在 docker 里 → 用 `host.docker.internal:8787`(或把两者放同一 docker 网,
  用容器名 `chobo-crm:8787`)。

---

## 降级保证(为什么零风险)
- **不配 `CHOBO_INGEST_URL`** → SDK 全程 no-op,业务服务和接入 chobo 之前**字节等同**。
- SDK **响应返回后才异步上报**,永不阻塞/拖慢真实模型调用;CRM 挂了也只是丢计量,不影响业务。
- 这意味着接入方可以先只装 SDK(已 vendored 进其服务)、暂不部署 CRM —— 完全无感;
  等我们把这台 CRM 交付、他改 env 重启,计量就活了。

---

## 安全(生产建议)
- 默认 compose 把 8787 暴露到 `0.0.0.0`。看板本身**无登录页**(读侧鉴权设计上交给前置反代)。
  生产请二选一:
  1. 前置 nginx + basic-auth(可借 [`../nginx.chobo.conf`](../nginx.chobo.conf) 模式:`/` 加 basic-auth,
     仅 `POST /v1/events` 豁免、靠 `x-chobo-secret`),并把 compose 端口改绑 `127.0.0.1:8787`;
  2. 或防火墙只放通业务服务来源 IP。
- ingest 唯一闸门是 `CHOBO_INGEST_SECRET`(`x-chobo-secret` 头)→ 用强随机串、按客户隔离。

---

## 升级(几乎零人工)
重新 `docker load` 新镜像 → `docker compose up -d --force-recreate`。一次搞定:
- **迁移**幂等自动跑;**算价 / 看板**逻辑随镜像更新。
- **价目表**:boot 时 `syncPriceSeed` 做**版本增量同步** —— 镜像里 price-seed 若带库里还没有的
  新版本,自动插入(不覆盖任何已有版本/人工调价),`loadPriceTable` 立即取到新 max version。
  **所以「换镜像 = 自动带上新价」,不用手动 SQL、不用单独 restart。**
- **唯一可能的一次性人工**:若某模型的事件在**补价之前**就已落库(当时算 NULL),跑一次容器内
  `npm run reprice` 回填即可;补价在流量之前则零人工。

## 新增模型价格(不重启)

镜像已含 `seed-cli` / `reprice-cli`。**注意:`price-seed.json` 是构建期烤进镜像的(`ci/Dockerfile`
的 `COPY price-seed.json /app/price-seed.json`),本 compose 并未把它挂载出来 —— 直接改 host 上的文件
不会被容器读到。** 两种方式:

- **热更新(不重启,推荐):** 在 host 改好 `price-seed.json`(bump `version` + 追加价目行),复制进容器再写库:
  ```bash
  docker cp price-seed.json chobo-crm:/app/price-seed.json
  docker exec chobo-crm node dist/seed-cli.js /app/price-seed.json   # 版本增量写库
  docker exec chobo-crm node dist/reprice-cli.js                     # 回填补价前的 NULL
  ```
  运行中的容器会在 ≤ `CHOBO_PRICE_REFRESH_SEC` 秒内自动拾取新价(默认 60s;设 0 则需重启容器)。

- **或重建镜像:** 改好 `price-seed.json` 后 `docker compose up -d --build`(重新烤入新 seed,boot 自动
  引入新版本),再 `docker exec chobo-crm node dist/reprice-cli.js` 回填补价前的 NULL。
  > 用 all-in-one 部署时加 `-f docker-compose.all-in-one.yml`。

> 想让 host 的 `price-seed.json` 改动直接被读到,可给 `chobo-crm` 服务加一行挂载:
> `volumes: [ "./price-seed.json:/app/price-seed.json:ro" ]`,之后只需 `docker exec ... seed-cli.js`
> + `reprice-cli.js`,免 `docker cp`。默认包未挂载,故上面两法开箱即用。
