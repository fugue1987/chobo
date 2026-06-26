import { describe, it, expect, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { Ajv } from "ajv";
import * as chobo from "../src/index.js";
import { ingestStub, type IngestStub } from "./stub.js";
import { spoolDir } from "./helpers.js";

const schema = JSON.parse(
  readFileSync(new URL("../../../contracts/event.schema.json", import.meta.url), "utf8"),
);
const validate = new Ajv({ allErrors: true, validateSchema: false }).compile(schema);

async function* gen<T>(items: T[]): AsyncGenerator<T> {
  for (const it of items) { await Promise.resolve(); yield it; }
}

describe("e2e", () => {
  let stub: IngestStub;
  afterEach(async () => { await chobo.reset(); await stub?.stop(); });

  it("buffered + streaming both produce contract-valid events carrying identity", async () => {
    stub = await ingestStub();
    chobo.init({ ingestUrl: stub.url, service: "node-ai-proxy", flushIntervalMs: 30000, spoolDir: spoolDir() });

    await chobo.runWithIdentity(
      { user_id: "t-7", org_id: "s-3", project: "report-action-cards" },
      async () => {
        await chobo.meter(
          { operation: "chat", provider: "minimax", requestModel: "MiniMax-M2.5", extract: chobo.extractors.openaiChatUsage },
          async () => ({
            model: "MiniMax-M2.5", choices: [{ finish_reason: "stop" }],
            usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
          }),
        );
        const chunks = [
          { choices: [{ delta: { content: "hi" } }] },
          { model: "m", choices: [], usage: { prompt_tokens: 50, completion_tokens: 8, total_tokens: 58 } },
        ];
        for await (const _c of chobo.meterStream(
          { operation: "chat", provider: "minimax", requestModel: "m", extractChunkUsage: chobo.extractors.openaiStreamChunkUsage },
          gen(chunks),
        )) { /* drain */ }
      },
    );

    await chobo.flush();
    await chobo.shutdown();

    expect(stub.received.length).toBe(2);
    for (const e of stub.received as any[]) {
      expect(validate(e)).toBe(true);
      expect(e.user_id).toBe("t-7");
      expect(e.org_id).toBe("s-3");
    }
    const totals = (stub.received as any[]).map((e) => e.total_tokens).sort((a, b) => a - b);
    expect(totals).toEqual([58, 120]);
  });
});
