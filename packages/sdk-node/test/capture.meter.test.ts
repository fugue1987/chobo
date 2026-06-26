import { describe, it, expect, afterEach } from "vitest";
import * as chobo from "../src/runtime.js";
import { runWithIdentity } from "../src/identity.js";
import { meter } from "../src/capture.js";
import { openaiChatUsage } from "../src/extractors.js";
import { ingestStub, type IngestStub } from "./stub.js";
import { spoolDir } from "./helpers.js";

const resp = () => ({
  model: "MiniMax-M2.5", choices: [{ finish_reason: "stop" }],
  usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
});

describe("meter (buffered)", () => {
  let stub: IngestStub;
  afterEach(async () => { await chobo.reset(); await stub?.stop(); });

  it("captures a success without altering the return value", async () => {
    stub = await ingestStub();
    chobo.init({ ingestUrl: stub.url, service: "node-ai-proxy", flushIntervalMs: 30000, spoolDir: spoolDir() });
    const out = await runWithIdentity({ user_id: "t-1", org_id: "s-9", project: "ggb" }, () =>
      meter(
        { operation: "chat", provider: "minimax", requestModel: "MiniMax-M2.5", extract: openaiChatUsage },
        async () => resp(),
      ),
    );
    expect(out).toEqual(resp());
    await chobo.flush();
    expect(stub.received.length).toBe(1);
    const e: any = stub.received[0];
    expect(e.status).toBe("success");
    expect(e.input_tokens).toBe(10);
    expect(e.request_model).toBe("MiniMax-M2.5");
    expect(e.user_id).toBe("t-1");
    expect(e.project).toBe("ggb");
  });

  it("records failure and re-throws the original error", async () => {
    stub = await ingestStub();
    chobo.init({ ingestUrl: stub.url, service: "s", flushIntervalMs: 30000, spoolDir: spoolDir() });
    await expect(
      meter({ operation: "chat", provider: "minimax", requestModel: "m" }, async () => {
        throw new TypeError("boom");
      }),
    ).rejects.toThrow("boom");
    await chobo.flush();
    const e: any = stub.received[0];
    expect(e.status).toBe("failure");
    expect(e.error_type).toBe("TypeError");
    expect(e.usage_source).toBe("none");
  });

  it("marks missing identity when none set", async () => {
    stub = await ingestStub();
    chobo.init({ ingestUrl: stub.url, service: "s", flushIntervalMs: 30000, spoolDir: spoolDir() });
    await meter(
      { operation: "chat", provider: "p", requestModel: "m", extract: openaiChatUsage },
      async () => resp(),
    );
    await chobo.flush();
    expect((stub.received[0] as any).identity_source).toBe("missing");
  });
});
