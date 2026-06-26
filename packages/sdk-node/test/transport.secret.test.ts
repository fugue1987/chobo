import { describe, it, expect } from "vitest";
import { Transport } from "../src/transport.js";
import { cfg, ev } from "./helpers.js";

/** 用 fetchImpl 注入桩,捕获 SDK 真正发出的请求头。 */
function capturingFetch() {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const impl = (async (url: string, init: { headers: Record<string, string> }) => {
    calls.push({ url: String(url), headers: init.headers });
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return { calls, impl };
}

describe("transport ingestSecret -> x-chobo-secret header", () => {
  it("sends the secret header when configured", async () => {
    const { calls, impl } = capturingFetch();
    const t = new Transport(cfg("http://x/v1/events", { ingestSecret: "s3cret", fetchImpl: impl }));
    t.enqueue(ev(0));
    await t.flush();
    await t.shutdown();
    expect(calls.length).toBe(1);
    expect(calls[0].headers["x-chobo-secret"]).toBe("s3cret");
  });

  it("omits the secret header when not configured", async () => {
    const { calls, impl } = capturingFetch();
    const t = new Transport(cfg("http://x/v1/events", { fetchImpl: impl }));
    t.enqueue(ev(0));
    await t.flush();
    await t.shutdown();
    expect(calls.length).toBe(1);
    expect("x-chobo-secret" in calls[0].headers).toBe(false);
  });
});
