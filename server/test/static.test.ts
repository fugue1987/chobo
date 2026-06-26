import { describe, it, expect, beforeAll, afterAll } from "vitest";
import Fastify from "fastify";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerStatic } from "../src/static.js";

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "chobo-web-"));
  writeFileSync(join(dir, "index.html"), "<!doctype html><title>chobo</title><div id=root></div>");
  mkdirSync(join(dir, "assets"));
  writeFileSync(join(dir, "assets", "app.js"), "console.log('hi')");
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function app() {
  const a = Fastify();
  a.get("/v1/ping", async () => ({ pong: true }));   // 代表 API 路由
  registerStatic(a, dir);
  return a;
}

describe("registerStatic", () => {
  it("serves index.html at /", async () => {
    const r = await app().inject({ method: "GET", url: "/" });
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain("id=root");
  });
  it("serves a built asset", async () => {
    const r = await app().inject({ method: "GET", url: "/assets/app.js" });
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain("hi");
  });
  it("SPA fallback: unknown GET → index.html", async () => {
    const r = await app().inject({ method: "GET", url: "/audit" });
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain("id=root");
    expect(r.headers["content-type"]).toContain("text/html");
  });
  it("does NOT swallow /v1 API routes", async () => {
    const r = await app().inject({ method: "GET", url: "/v1/ping" });
    expect(r.statusCode).toBe(200);
    expect(JSON.parse(r.body)).toEqual({ pong: true });
  });
  it("unknown /v1 path → 404 JSON, not index", async () => {
    const r = await app().inject({ method: "GET", url: "/v1/nope" });
    expect(r.statusCode).toBe(404);
    expect(r.headers["content-type"]).toContain("application/json");
  });
  it("POST to unknown route → 404 JSON, not SPA", async () => {
    const r = await app().inject({ method: "POST", url: "/audit" });
    expect(r.statusCode).toBe(404);
    expect(r.headers["content-type"]).toContain("application/json");
  });
});
