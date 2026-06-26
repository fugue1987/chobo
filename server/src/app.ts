import { existsSync } from "node:fs";
import { join } from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import type { Sql } from "postgres";
import { makeAjv, makeEventValidator } from "./validator.js";
import { registerIngest } from "./ingest.js";
import { registerStats } from "./stats.js";
import { secretGuard } from "./auth.js";
import { registerStatic } from "./static.js";
import type { PriceTable, ServerConfig } from "./types.js";

export interface AppDeps { sql: Sql; cfg: ServerConfig; priceTable: () => PriceTable; }

export function buildApp(deps: AppDeps): FastifyInstance {
  const { sql, cfg, priceTable } = deps;
  const app = Fastify({ logger: true, bodyLimit: cfg.bodyLimit });

  // 关键:用自建 Ajv2020 替换默认 draft-07 校验器(否则 2020-12 契约 boot 崩)
  const ajv = makeAjv();
  // Ajv ValidateFunction is structurally compatible with FastifyValidationResult:
  // both are callable (data: any) => boolean with optional .errors property.
  // Cast through unknown to avoid TS structural mismatch on the type-predicate signature.
  app.setValidatorCompiler(({ schema }) => ajv.compile(schema) as unknown as (data: unknown) => boolean);

  const guard = secretGuard(cfg.ingestSecret);
  // 不再 app.addHook("preHandler", guard) —— 收窄到只守 ingest 路由

  app.get("/healthz", async () => ({ ok: true }));
  registerIngest(app, { sql, validateEvent: makeEventValidator(ajv), priceTable, payloadMode: cfg.payloadMode, payloadMaxBytes: cfg.payloadMaxBytes, guard });
  registerStats(app, { sql });
  if (cfg.webDir && existsSync(join(cfg.webDir, "index.html"))) {
    registerStatic(app, cfg.webDir);
    app.log.info({ webDir: cfg.webDir }, "chobo: serving dashboard");
  }
  return app;
}
