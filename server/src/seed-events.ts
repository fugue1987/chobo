import type { EventInput } from "./types.js";

// 确定性 PRNG(mulberry32)—— 禁用 Math.random,保证 seed 可复现
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const USERS = ["teacher-0420", "teacher-1187", "teacher-3302", "teacher-0091"];
const ORGS = ["school-hz-3", "school-sh-1", "school-bj-7"];
const PROJECTS = ["lesson-parse", "chat-tutor", "image-gen"];
// 含已定价(doubao)与未定价(example-gateway 三项待价)模型 —— 后者落 total_cost=NULL
const MODELS: Array<{ provider: string; model: string; operation: EventInput["operation"] }> = [
  { provider: "doubao", model: "doubao-seed-2.0-pro", operation: "chat" },
  { provider: "doubao", model: "doubao-seed-2.0-pro", operation: "chat" },
  { provider: "example-gateway", model: "gpt-5.5", operation: "chat" },
  { provider: "example-gateway", model: "gemini-3.5-flash", operation: "chat" },
  { provider: "example-gateway", model: "gpt-image-2", operation: "image" },
];

export interface SampleOpts { count: number; days: number; seed: number; nowMs?: number; }

export function buildSampleEvents(opts: SampleOpts): EventInput[] {
  const { count, days, seed, nowMs = 1_750_000_000_000 } = opts;
  const r = rng(seed);
  const pick = <T,>(xs: T[]): T => xs[Math.floor(r() * xs.length)];
  const out: EventInput[] = [];
  for (let i = 0; i < count; i++) {
    const m = pick(MODELS);
    const start = nowMs - Math.floor(r() * days * 86_400_000);
    const inTok = m.operation === "image" ? 0 : 200 + Math.floor(r() * 4000);
    const outTok = m.operation === "image" ? 0 : 50 + Math.floor(r() * 1500);
    const fail = r() < 0.012;
    const latency = 200 + Math.floor(r() * 1800);
    out.push({
      event_id: `seed-${seed}-${i}`,
      identity_source: "header",
      start_time: start,
      end_time: start + latency,
      latency_ms: latency,
      service: "node-ai-proxy",
      provider: m.provider,
      operation: m.operation,
      request_model: m.model,
      user_id: pick(USERS), org_id: pick(ORGS), project: pick(PROJECTS),
      input_tokens: inTok || null, output_tokens: outTok || null,
      total_tokens: (inTok + outTok) || null,
      image_count: m.operation === "image" ? 1 : null,
      usage_source: "measured",
      status: fail ? "failure" : "success",
      error_type: fail ? "upstream_timeout" : null,
      sdk_lang: "node", sdk_version: "0.1.0",
    });
  }
  return out;
}

/** 把仿真事件分批 POST 到运行中的 CRM /v1/events(走真 ingest+去重+算价)。 */
export async function seedEvents(baseUrl: string, events: EventInput[], secret?: string): Promise<{ accepted: number; duplicates: number; rejected: number }> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (secret) headers["x-chobo-secret"] = secret;
  const agg = { accepted: 0, duplicates: 0, rejected: 0 };
  for (let i = 0; i < events.length; i += 500) {
    const batch = events.slice(i, i + 500);
    const res = await fetch(`${baseUrl}/v1/events`, { method: "POST", headers, body: JSON.stringify({ events: batch }) });
    if (!res.ok) throw new Error(`seed POST failed: HTTP ${res.status} ${await res.text()}`);
    const r = (await res.json()) as { accepted: number; duplicates: number; rejected: number };
    agg.accepted += r.accepted; agg.duplicates += r.duplicates; agg.rejected += r.rejected;
  }
  return agg;
}
