import { describe, it, expect } from "vitest";
import { resolveConfig } from "../src/config.js";

describe("resolveConfig", () => {
  it("requires CHOBO_DATABASE_URL", () => {
    expect(() => resolveConfig({})).toThrow(/CHOBO_DATABASE_URL/);
  });
  it("applies defaults", () => {
    const c = resolveConfig({ CHOBO_DATABASE_URL: "postgres://x" });
    expect(c.port).toBe(8787);
    expect(c.host).toBe("0.0.0.0");
    expect(c.ingestSecret).toBeNull();
    expect(c.payloadMode).toBe("metadata");
    expect(c.payloadMaxBytes).toBe(8192);
    expect(c.priceSeedPath).toBeNull();
  });
  it("parses overrides and rejects bad payload mode", () => {
    const c = resolveConfig({ CHOBO_DATABASE_URL: "postgres://x", CHOBO_PORT: "9000", CHOBO_INGEST_SECRET: "s", CHOBO_PAYLOAD_MODE: "truncated" });
    expect(c.port).toBe(9000);
    expect(c.ingestSecret).toBe("s");
    expect(c.payloadMode).toBe("truncated");
    expect(() => resolveConfig({ CHOBO_DATABASE_URL: "postgres://x", CHOBO_PAYLOAD_MODE: "bogus" })).toThrow(/CHOBO_PAYLOAD_MODE/);
  });
  it("rejects invalid CHOBO_PORT", () => {
    expect(() => resolveConfig({ CHOBO_DATABASE_URL: "postgres://x", CHOBO_PORT: "abc" })).toThrow(/CHOBO_PORT/);
    expect(() => resolveConfig({ CHOBO_DATABASE_URL: "postgres://x", CHOBO_PORT: "0" })).toThrow(/CHOBO_PORT/);
    expect(() => resolveConfig({ CHOBO_DATABASE_URL: "postgres://x", CHOBO_PORT: "65536" })).toThrow(/CHOBO_PORT/);
    expect(() => resolveConfig({ CHOBO_DATABASE_URL: "postgres://x", CHOBO_PORT: "3.14" })).toThrow(/CHOBO_PORT/);
  });
  it("rejects negative CHOBO_PAYLOAD_MAX_BYTES", () => {
    expect(() => resolveConfig({ CHOBO_DATABASE_URL: "postgres://x", CHOBO_PAYLOAD_MAX_BYTES: "-1" })).toThrow(/CHOBO_PAYLOAD_MAX_BYTES/);
    expect(() => resolveConfig({ CHOBO_DATABASE_URL: "postgres://x", CHOBO_PAYLOAD_MAX_BYTES: "abc" })).toThrow(/CHOBO_PAYLOAD_MAX_BYTES/);
  });
  it("bodyLimit defaults to 16 MiB and can be overridden", () => {
    const c = resolveConfig({ CHOBO_DATABASE_URL: "postgres://x" });
    expect(c.bodyLimit).toBe(16 * 1024 * 1024);
    const c2 = resolveConfig({ CHOBO_DATABASE_URL: "postgres://x", CHOBO_BODY_LIMIT: "4194304" });
    expect(c2.bodyLimit).toBe(4 * 1024 * 1024);
  });
  it("rejects invalid CHOBO_BODY_LIMIT", () => {
    expect(() => resolveConfig({ CHOBO_DATABASE_URL: "postgres://x", CHOBO_BODY_LIMIT: "0" })).toThrow(/CHOBO_BODY_LIMIT/);
    expect(() => resolveConfig({ CHOBO_DATABASE_URL: "postgres://x", CHOBO_BODY_LIMIT: "-1" })).toThrow(/CHOBO_BODY_LIMIT/);
    expect(() => resolveConfig({ CHOBO_DATABASE_URL: "postgres://x", CHOBO_BODY_LIMIT: "abc" })).toThrow(/CHOBO_BODY_LIMIT/);
  });
  it("webDir defaults to null, reads CHOBO_WEB_DIR", () => {
    expect(resolveConfig({ CHOBO_DATABASE_URL: "postgres://x" }).webDir).toBeNull();
    expect(resolveConfig({ CHOBO_DATABASE_URL: "postgres://x", CHOBO_WEB_DIR: "/srv/web" }).webDir).toBe("/srv/web");
  });
  it("priceRefreshSec defaults to 60, reads CHOBO_PRICE_REFRESH_SEC, 0 disables", () => {
    expect(resolveConfig({ CHOBO_DATABASE_URL: "postgres://x" }).priceRefreshSec).toBe(60);
    expect(resolveConfig({ CHOBO_DATABASE_URL: "postgres://x", CHOBO_PRICE_REFRESH_SEC: "0" }).priceRefreshSec).toBe(0);
    expect(resolveConfig({ CHOBO_DATABASE_URL: "postgres://x", CHOBO_PRICE_REFRESH_SEC: "15" }).priceRefreshSec).toBe(15);
  });
  it("rejects invalid CHOBO_PRICE_REFRESH_SEC", () => {
    expect(() => resolveConfig({ CHOBO_DATABASE_URL: "postgres://x", CHOBO_PRICE_REFRESH_SEC: "-1" })).toThrow(/CHOBO_PRICE_REFRESH_SEC/);
    expect(() => resolveConfig({ CHOBO_DATABASE_URL: "postgres://x", CHOBO_PRICE_REFRESH_SEC: "abc" })).toThrow(/CHOBO_PRICE_REFRESH_SEC/);
    expect(() => resolveConfig({ CHOBO_DATABASE_URL: "postgres://x", CHOBO_PRICE_REFRESH_SEC: "1.5" })).toThrow(/CHOBO_PRICE_REFRESH_SEC/);
  });
});
