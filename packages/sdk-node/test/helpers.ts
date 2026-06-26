import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, existsSync, readFileSync } from "node:fs";
import type { ChoboEvent } from "../src/event.js";
import type { ChoboConfig } from "../src/config.js";

export function ev(i: number): ChoboEvent {
  return {
    event_id: `e${i}`, request_id: null, parent_id: null,
    user_id: null, org_id: null, project: null, account: null, identity_source: "header",
    start_time: 1, end_time: 2, latency_ms: 1,
    service: "s", provider: "p", operation: "chat", request_model: "m", response_model: null,
    input_tokens: null, output_tokens: null, total_tokens: null, cached_tokens: null,
    reasoning_tokens: null, image_count: null,
    input_text_tokens: null, input_image_tokens: null, usage_source: "measured",
    status: "success", error_type: null, finish_reason: null, payload: null,
    sdk_lang: "node", sdk_version: "0.1.5",
  };
}

export function spoolDir(): string {
  return mkdtempSync(join(tmpdir(), "chobo-"));
}

export function readSpool(dir: string): ChoboEvent[] {
  const p = join(dir, `events-${process.pid}.jsonl`);
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as ChoboEvent);
}

/** Build a full ChoboConfig for tests; pass overrides (e.g. a known spoolDir). */
export function cfg(ingestUrl: string, over: Partial<ChoboConfig> = {}): ChoboConfig {
  return {
    ingestUrl, service: "s", bufferMax: 100, batchMax: 10, flushAt: 1000,
    flushIntervalMs: 30000, spoolDir: spoolDir(), maxSpoolBytes: 1e7, timeoutMs: 2000, ...over,
  };
}
