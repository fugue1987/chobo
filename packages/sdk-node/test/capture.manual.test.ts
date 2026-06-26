import { describe, it, expect, afterEach } from "vitest";
import * as chobo from "../src/runtime.js";
import { runWithIdentity } from "../src/identity.js";
import { meterManual } from "../src/capture.js";
import { openaiStreamChunkUsage } from "../src/extractors.js";
import { ingestStub, type IngestStub } from "./stub.js";
import { spoolDir } from "./helpers.js";

describe("meterManual (imperative span)", () => {
  let stub: IngestStub;
  afterEach(async () => { await chobo.reset(); await stub?.stop(); });

  it("captures the final usage chunk and emits success on done()", async () => {
    stub = await ingestStub();
    chobo.init({ ingestUrl: stub.url, service: "node-ai-proxy", account: "adopter-a", flushIntervalMs: 30000, spoolDir: spoolDir() });
    await runWithIdentity({ user_id: "default", project: "resource-chat", identity_source: "default" }, async () => {
      const span = meterManual({ operation: "chat", provider: "newapi", requestModel: "gpt-5.5" });
      // 内容块(无 usage)→ observe(null) 不改;末尾 usage 块(choices:[] + usage)→ 捕获
      span.observe(openaiStreamChunkUsage({ choices: [{ delta: { content: "hi" } }] }));
      span.observe(openaiStreamChunkUsage({ choices: [], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } }));
      span.done();
    });
    await chobo.flush();
    expect(stub.received.length).toBe(1);
    const e: any = stub.received[0];
    expect(e.status).toBe("success");
    expect(e.input_tokens).toBe(100);
    expect(e.output_tokens).toBe(20);
    expect(e.provider).toBe("newapi");
    expect(e.request_model).toBe("gpt-5.5");
    expect(e.account).toBe("adopter-a");
    expect(e.identity_source).toBe("default");
    expect(e.user_id).toBe("default");
    expect(e.project).toBe("resource-chat");
  });

  it("emits usage_source=none when no usage observed (honest, never fake 0)", async () => {
    stub = await ingestStub();
    chobo.init({ ingestUrl: stub.url, service: "s", flushIntervalMs: 30000, spoolDir: spoolDir() });
    const span = meterManual({ operation: "chat", provider: "newapi", requestModel: "gpt-5.5" });
    span.done();
    await chobo.flush();
    expect((stub.received[0] as any).usage_source).toBe("none");
  });

  it("emits failure on fail() and settles exactly once", async () => {
    stub = await ingestStub();
    chobo.init({ ingestUrl: stub.url, service: "s", flushIntervalMs: 30000, spoolDir: spoolDir() });
    const span = meterManual({ operation: "chat", provider: "newapi", requestModel: "gpt-5.5" });
    span.fail(new TypeError("boom"));
    span.done(); // already settled → no-op
    await chobo.flush();
    expect(stub.received.length).toBe(1);
    const e: any = stub.received[0];
    expect(e.status).toBe("failure");
    expect(e.error_type).toBe("TypeError");
  });
});
