import { describe, it, expect } from "vitest";
import {
  openaiChatUsage, openaiStreamChunkUsage, geminiUsage, geminiStreamChunkUsage, imageUsage,
} from "../src/extractors.js";

describe("openaiChatUsage (buffered)", () => {
  it("reads usage from an OpenAI-compatible response", () => {
    const resp = {
      model: "MiniMax-M2.5",
      choices: [{ finish_reason: "stop", message: { content: "hi" } }],
      usage: {
        prompt_tokens: 1234, completion_tokens: 567, total_tokens: 1801,
        prompt_tokens_details: { cached_tokens: 100 },
        completion_tokens_details: { reasoning_tokens: 42 },
      },
    };
    const out = openaiChatUsage(resp);
    expect(out.input_tokens).toBe(1234);
    expect(out.output_tokens).toBe(567);
    expect(out.total_tokens).toBe(1801);
    expect(out.cached_tokens).toBe(100);
    expect(out.reasoning_tokens).toBe(42);
    expect(out.response_model).toBe("MiniMax-M2.5");
    expect(out.finish_reason).toBe("stop");
    expect(out.usage_source).toBe("measured");
  });

  it("reports none when usage absent", () => {
    expect(openaiChatUsage({ model: "m", choices: [] }).usage_source).toBe("none");
  });
});

describe("openaiStreamChunkUsage (streaming)", () => {
  it("returns null for a normal delta chunk", () => {
    expect(openaiStreamChunkUsage({ choices: [{ delta: { content: "hi" } }] })).toBeNull();
  });

  it("returns usage on the final empty-choices usage chunk", () => {
    const chunk = { model: "m", choices: [], usage: { prompt_tokens: 6, completion_tokens: 10, total_tokens: 16 } };
    const out = openaiStreamChunkUsage(chunk);
    expect(out).not.toBeNull();
    expect(out!.input_tokens).toBe(6);
    expect(out!.output_tokens).toBe(10);
    expect(out!.usage_source).toBe("measured");
  });

  it("returns null when choices empty but no usage", () => {
    expect(openaiStreamChunkUsage({ choices: [] })).toBeNull();
  });
});

describe("geminiUsage", () => {
  it("reads usageMetadata field names verbatim", () => {
    const resp = {
      modelVersion: "gemini-2.5-pro",
      usageMetadata: {
        promptTokenCount: 100, candidatesTokenCount: 20, totalTokenCount: 130,
        cachedContentTokenCount: 8, thoughtsTokenCount: 10,
      },
    };
    const out = geminiUsage(resp);
    expect(out.input_tokens).toBe(100);
    expect(out.output_tokens).toBe(20);
    expect(out.total_tokens).toBe(130);
    expect(out.cached_tokens).toBe(8);
    expect(out.reasoning_tokens).toBe(10);
    expect(out.usage_source).toBe("measured");
  });

  it("reports none when usageMetadata absent", () => {
    expect(geminiUsage({ text: "hi" }).usage_source).toBe("none");
  });
});

describe("geminiStreamChunkUsage", () => {
  it("returns usage when chunk has usageMetadata, else null", () => {
    expect(geminiStreamChunkUsage({ text: "partial" })).toBeNull();
    const out = geminiStreamChunkUsage({ usageMetadata: { promptTokenCount: 5, totalTokenCount: 9 } });
    expect(out!.input_tokens).toBe(5);
    expect(out!.total_tokens).toBe(9);
  });
});

describe("imageUsage", () => {
  it("counts data entries", () => {
    expect(imageUsage({ data: [{ url: "a" }, { url: "b" }] }).image_count).toBe(2);
  });
  it("honors explicit count", () => {
    expect(imageUsage({ data: [] }, { count: 4 }).image_count).toBe(4);
  });
});
