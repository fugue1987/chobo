import { describe, it, expect } from "vitest";
import Fastify from "fastify";
import { secretGuard } from "../src/auth.js";

// 镜像 app.ts 的新接线:guard 只挂在 ingest 路由上,stats 路由开放
function appWith(secret: string | null) {
  const app = Fastify();
  const guard = secretGuard(secret);
  app.post("/v1/events", { preHandler: guard }, async () => ({ ok: true }));
  app.get("/v1/stats/overview", async () => ({ open: true }));
  return app;
}

describe("ingest-scoped secretGuard", () => {
  it("open when no secret", async () => {
    const app = appWith(null);
    expect((await app.inject({ method: "POST", url: "/v1/events", payload: {} })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/v1/stats/overview" })).statusCode).toBe(200);
  });
  it("ingest 401 when secret set but header missing/wrong", async () => {
    const app = appWith("s3cret");
    expect((await app.inject({ method: "POST", url: "/v1/events", payload: {} })).statusCode).toBe(401);
    expect((await app.inject({ method: "POST", url: "/v1/events", headers: { "x-chobo-secret": "nope" }, payload: {} })).statusCode).toBe(401);
  });
  it("ingest 200 when header matches", async () => {
    const app = appWith("s3cret");
    expect((await app.inject({ method: "POST", url: "/v1/events", headers: { "x-chobo-secret": "s3cret" }, payload: {} })).statusCode).toBe(200);
  });
  it("stats stays OPEN even when secret set (no header)", async () => {
    const app = appWith("s3cret");
    expect((await app.inject({ method: "GET", url: "/v1/stats/overview" })).statusCode).toBe(200);
  });
});
