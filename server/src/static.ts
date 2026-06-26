import { readFileSync } from "node:fs";
import { join } from "node:path";
import fastifyStatic from "@fastify/static";
import type { FastifyInstance } from "fastify";

/**
 * 同源托管已打包的看板:web/dist 下的静态资源 + SPA 回退。
 * - 真实文件(/assets/*, /favicon 等)由 @fastify/static 直发。
 * - 未命中的 GET 且非 /v1 → 回 index.html(供前端 in-app 路由 / 刷新)。
 * - /v1 未命中 → 404 JSON(不污染 API 语义)。
 * 仅当 webDir 存在 index.html 时由 app.ts 调用;无产物则不挂,CRM 退回纯 API。
 */
export function registerStatic(app: FastifyInstance, webDir: string): void {
  const indexHtml = readFileSync(join(webDir, "index.html"), "utf8");
  // wildcard:false — 启动时枚举产物文件逐一注册(SPA 产物固定);
  // 若改成 wildcard:true 会注册全局通配路由,令下面的 setNotFoundHandler SPA 回退失效
  app.register(fastifyStatic, { root: webDir, prefix: "/", wildcard: false });
  app.setNotFoundHandler((req, reply) => {
    if (req.method === "GET" && !/^\/v1(\/|$|\?)/.test(req.url)) {
      reply.type("text/html").send(indexHtml);
      return;
    }
    reply.code(404).send({ error: "not found" });
  });
}
