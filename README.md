# 帳簿 chobo

**LLM 用量计量与计费 SDK + CRM 看板。** 低侵入地"代理"每一次大模型调用,记下
**谁(含从属)/ 何时 / 何地 / 做了什么 / 代价多少**,让每一笔都可计费、可审计。

## 这是什么

chobo 解决一条**两级计费链**里第二级的空白:

- **Tier 1(运营方 → 接入方):** 谁用了多少 token / 多少钱 —— 现成的 LLM 网关(如 new-api)已能按 key 计费。
- **Tier 2(接入方 → 他们自己的终端用户):** 同一个 key 底下,**哪个老师、哪个学校**用了多少 —— 网关看不到 key 下的下级身份。chobo 补的就是这一层 **per-end-user 归因**。

名字取自日语「帳簿(ちょうぼ / chōbo)」—— 账簿。

## 形态

- **进程内 SDK 拦截**(Python + Node 同一套),不引入网关。
- SDK 在调用边界自测 `identity + tokens + model + request_id`,响应返回后**异步**把事件发给 CRM。
- **CRM 后端**去重 + 用自有价格表算价 + 落 Postgres;**看板**纯读。
- 对 provider / 是否有 new-api 不感知 —— 可泛化到任意接入方。

## 目录结构(monorepo,稳定后可拆成各自 repo)

```
chobo/
├── docs/specs/        # 设计文档
├── contracts/         # 共享事件 JSON 契约 + 价格表 schema(SDK 与 CRM 的唯一接口)
├── packages/
│   ├── sdk-python/    # Python SDK
│   └── sdk-node/      # Node SDK
├── server/            # CRM 后端(ingest + 算价 + 看板读 API)
└── web/               # 看板前端
```

## 状态

**两个 SDK(生产端)已交付并合并入 `master`。** v1 分 5 份计划:

- ✅ Plan 1 — 契约 + Python SDK(`packages/sdk-python`,35 测试)
- ✅ Plan 3 — Node SDK(`packages/sdk-node` = `@chobo/sdk`,双格式 ESM+CJS,43 测试)
- ✅ Plan 2 — CRM `server/`(`@chobo/server`,Fastify 5.8.5 + Ajv2020 + postgres.js,46 测试)
- ⏭ Plan 4 — 看板 `web/`(下一步) · Plan 5 接入 AdopterA + 真实端到端

设计见 [`docs/specs/2026-06-24-billing-sdk-design.md`](docs/specs/2026-06-24-billing-sdk-design.md);
实现计划见 `docs/superpowers/plans/`;开发日志见 `docs/dev-log.md`。
