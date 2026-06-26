/** Provider response -> usage-fields extractors. Field shapes verified in docs/research/2026-06-24-node-sdk-grounding.md. */

export interface ExtractedUsage {
  input_tokens?: number | null;
  output_tokens?: number | null;
  total_tokens?: number | null;
  cached_tokens?: number | null;
  reasoning_tokens?: number | null;
  image_count?: number | null;
  input_text_tokens?: number | null;
  input_image_tokens?: number | null;
  response_model?: string | null;
  finish_reason?: string | null;
  usage_source: "measured" | "none";
}

function get(obj: unknown, key: string): unknown {
  if (obj == null || typeof obj !== "object") return undefined;
  return (obj as Record<string, unknown>)[key];
}
function num(v: unknown): number | null {
  return typeof v === "number" ? v : null;
}
function str(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

/** OpenAI-compatible buffered chat completion (MiniMax / GLM / Doubao). */
export function openaiChatUsage(response: unknown): ExtractedUsage {
  const u = get(response, "usage");
  const ptd = get(u, "prompt_tokens_details");
  const ctd = get(u, "completion_tokens_details");
  const choices = get(response, "choices");
  const finish =
    Array.isArray(choices) && choices.length ? str(get(choices[0], "finish_reason")) : null;
  return {
    input_tokens: num(get(u, "prompt_tokens")),
    output_tokens: num(get(u, "completion_tokens")),
    total_tokens: num(get(u, "total_tokens")),
    cached_tokens: num(get(ptd, "cached_tokens")),
    reasoning_tokens: num(get(ctd, "reasoning_tokens")),
    response_model: str(get(response, "model")),
    finish_reason: finish,
    usage_source: u != null ? "measured" : "none",
  };
}

/**
 * OpenAI-compatible streaming: call per parsed chunk. Returns usage ONLY on the final
 * usage-bearing chunk (empty `choices` + `usage` present); otherwise null.
 */
export function openaiStreamChunkUsage(chunk: unknown): ExtractedUsage | null {
  const choices = get(chunk, "choices");
  const u = get(chunk, "usage");
  if (Array.isArray(choices) && choices.length === 0 && u != null) {
    const ptd = get(u, "prompt_tokens_details");
    const ctd = get(u, "completion_tokens_details");
    return {
      input_tokens: num(get(u, "prompt_tokens")),
      output_tokens: num(get(u, "completion_tokens")),
      total_tokens: num(get(u, "total_tokens")),
      cached_tokens: num(get(ptd, "cached_tokens")),
      reasoning_tokens: num(get(ctd, "reasoning_tokens")),
      response_model: str(get(chunk, "model")),
      finish_reason: null,
      usage_source: "measured",
    };
  }
  return null;
}

function geminiFromMeta(meta: unknown, modelHost: unknown): ExtractedUsage {
  return {
    input_tokens: num(get(meta, "promptTokenCount")),
    output_tokens: num(get(meta, "candidatesTokenCount")),
    total_tokens: num(get(meta, "totalTokenCount")),
    cached_tokens: num(get(meta, "cachedContentTokenCount")),
    reasoning_tokens: num(get(meta, "thoughtsTokenCount")),
    response_model: str(get(modelHost, "modelVersion")),
    finish_reason: null,
    usage_source: "measured",
  };
}

/** Gemini @google/genai buffered response.usageMetadata. */
export function geminiUsage(response: unknown): ExtractedUsage {
  const m = get(response, "usageMetadata");
  if (m == null) return { usage_source: "none" };
  return geminiFromMeta(m, response);
}

/** Gemini streaming chunk -> usage if present (caller keeps last-non-null). */
export function geminiStreamChunkUsage(chunk: unknown): ExtractedUsage | null {
  const m = get(chunk, "usageMetadata");
  if (m == null) return null;
  return geminiFromMeta(m, chunk);
}

/** Image generation: count `data` entries unless an explicit count is given. */
export function imageUsage(response: unknown, opts?: { count?: number }): ExtractedUsage {
  let n: number | null;
  if (opts?.count != null) n = opts.count;
  else {
    const data = get(response, "data");
    n = Array.isArray(data) ? data.length : null;
  }
  return { image_count: n, usage_source: n != null ? "measured" : "none" };
}
