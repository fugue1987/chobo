import { describe, it, expect, afterEach } from "vitest";
import * as chobo from "../src/runtime.js";
import { runWithIdentity } from "../src/identity.js";
import { meterStream } from "../src/capture.js";
import { openaiStreamChunkUsage, geminiStreamChunkUsage } from "../src/extractors.js";
import { ingestStub, type IngestStub } from "./stub.js";
import { spoolDir } from "./helpers.js";

async function* gen<T>(items: T[]): AsyncGenerator<T> {
  for (const it of items) { await Promise.resolve(); yield it; }
}

describe("meterStream (streaming)", () => {
  let stub: IngestStub;
  afterEach(async () => { await chobo.reset(); await stub?.stop(); });

  it("passes chunks through and captures OpenAI final-chunk usage", async () => {
    stub = await ingestStub();
    chobo.init({ ingestUrl: stub.url, service: "node-ai-proxy", flushIntervalMs: 30000, spoolDir: spoolDir() });
    const chunks = [
      { choices: [{ delta: { content: "Hel" } }] },
      { choices: [{ delta: { content: "lo" } }] },
      { model: "m", choices: [], usage: { prompt_tokens: 6, completion_tokens: 10, total_tokens: 16 } },
    ];
    const seen: unknown[] = [];
    await runWithIdentity({ user_id: "t-7" }, async () => {
      for await (const c of meterStream(
        { operation: "chat", provider: "minimax", requestModel: "m", extractChunkUsage: openaiStreamChunkUsage },
        gen(chunks),
      )) {
        seen.push(c);
      }
    });
    expect(seen).toEqual(chunks); // passthrough preserved every chunk in order
    await chobo.flush();
    const e: any = stub.received[0];
    expect(e.input_tokens).toBe(6);
    expect(e.output_tokens).toBe(10);
    expect(e.user_id).toBe("t-7");
    expect(e.status).toBe("success");
  });

  it("captures Gemini usage with last-non-null wins", async () => {
    stub = await ingestStub();
    chobo.init({ ingestUrl: stub.url, service: "s", flushIntervalMs: 30000, spoolDir: spoolDir() });
    const chunks = [
      { text: "a", usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 1, totalTokenCount: 4 } },
      { text: "b", usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 7, totalTokenCount: 10 } },
    ];
    for await (const _c of meterStream(
      { operation: "chat", provider: "gemini", requestModel: "gemini-2.5-pro", extractChunkUsage: geminiStreamChunkUsage },
      gen(chunks),
    )) { /* drain */ }
    await chobo.flush();
    const e: any = stub.received[0];
    expect(e.total_tokens).toBe(10); // last non-null wins; never summed
    expect(e.output_tokens).toBe(7);
  });

  it("records failure if the stream throws", async () => {
    stub = await ingestStub();
    chobo.init({ ingestUrl: stub.url, service: "s", flushIntervalMs: 30000, spoolDir: spoolDir() });
    async function* boom(): AsyncGenerator<unknown> {
      yield { choices: [{ delta: { content: "x" } }] };
      throw new Error("stream broke");
    }
    await expect((async () => {
      for await (const _c of meterStream(
        { operation: "chat", provider: "p", requestModel: "m", extractChunkUsage: openaiStreamChunkUsage },
        boom(),
      )) { /* drain */ }
    })()).rejects.toThrow("stream broke");
    await chobo.flush();
    const e: any = stub.received[0];
    expect(e.status).toBe("failure");
    expect(e.error_type).toBe("Error");
  });
});
