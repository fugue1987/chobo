import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { Ajv } from "ajv";
import { buildEvent } from "../src/event.js";
import type { Identity } from "../src/identity.js";

const schema = JSON.parse(
  readFileSync(new URL("../../../contracts/event.schema.json", import.meta.url), "utf8"),
);
const ajv = new Ajv({ allErrors: true, validateSchema: false });
const validate = ajv.compile(schema);

const IDENTITY: Identity = {
  user_id: "t-1", org_id: "s-9", project: "ggb", identity_source: "header",
};

describe("buildEvent", () => {
  it("produces a contract-valid success event", () => {
    const ev = buildEvent({
      service: "node-ai-proxy", provider: "minimax", operation: "chat",
      request_model: "MiniMax-M2.5", identity: IDENTITY, start_ms: 1000, end_ms: 3333,
      usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15,
        response_model: "MiniMax-M2.5", finish_reason: "stop", usage_source: "measured" },
    });
    expect(validate(ev)).toBe(true);
    expect(ev.latency_ms).toBe(2333);
    expect(ev.user_id).toBe("t-1");
    expect(ev.usage_source).toBe("measured");
    expect(ev.status).toBe("success");
    expect(ev.sdk_lang).toBe("node");
    expect(ev.event_id.length).toBeGreaterThan(0);
  });

  it("generates unique event_ids", () => {
    const a = buildEvent({ service: "s", provider: "p", operation: "chat",
      request_model: "m", identity: IDENTITY, start_ms: 1, end_ms: 2 });
    const b = buildEvent({ service: "s", provider: "p", operation: "chat",
      request_model: "m", identity: IDENTITY, start_ms: 1, end_ms: 2 });
    expect(a.event_id).not.toBe(b.event_id);
  });

  it("failure event defaults usage_source to none", () => {
    const ev = buildEvent({ service: "s", provider: "p", operation: "chat",
      request_model: "m", identity: IDENTITY, start_ms: 1, end_ms: 2,
      status: "failure", error_type: "AbortError" });
    expect(validate(ev)).toBe(true);
    expect(ev.status).toBe("failure");
    expect(ev.error_type).toBe("AbortError");
    expect(ev.usage_source).toBe("none");
    expect(ev.input_tokens).toBeNull();
  });

  it("marks missing identity", () => {
    const bare: Identity = { user_id: null, org_id: null, project: null, identity_source: "missing" };
    const ev = buildEvent({ service: "s", provider: "p", operation: "chat",
      request_model: "m", identity: bare, start_ms: 1, end_ms: 2 });
    expect(ev.identity_source).toBe("missing");
  });
});

describe("account", () => {
  it("stamps account from input and stays contract-valid", () => {
    const ev = buildEvent({
      service: "s", provider: "p", operation: "chat", request_model: "m",
      identity: IDENTITY, start_ms: 0, end_ms: 1, account: "acme",
    });
    expect(ev.account).toBe("acme");
    expect(validate(ev)).toBe(true);
  });
  it("defaults account to null when omitted", () => {
    const ev = buildEvent({
      service: "s", provider: "p", operation: "chat", request_model: "m",
      identity: IDENTITY, start_ms: 0, end_ms: 1,
    });
    expect(ev.account).toBeNull();
    expect(validate(ev)).toBe(true);
  });
});

describe("gpt-image-2 per-modality token fields", () => {
  it("threads input_text_tokens and input_image_tokens through buildEvent", () => {
    const ev = buildEvent({
      service: "s", provider: "newapi", operation: "image", request_model: "gpt-image-2",
      identity: IDENTITY, start_ms: 0, end_ms: 1,
      usage: {
        input_text_tokens: 37, input_image_tokens: 323,
        output_tokens: 272, image_count: 1, usage_source: "measured",
      },
    });
    expect(ev.input_text_tokens).toBe(37);
    expect(ev.input_image_tokens).toBe(323);
    expect(ev.image_count).toBe(1);
    expect(ev.output_tokens).toBe(272);
  });

  it("defaults input_text_tokens and input_image_tokens to null when usage omitted", () => {
    const ev = buildEvent({
      service: "s", provider: "newapi", operation: "image", request_model: "gpt-image-2",
      identity: IDENTITY, start_ms: 0, end_ms: 1,
    });
    expect(ev.input_text_tokens).toBeNull();
    expect(ev.input_image_tokens).toBeNull();
  });
});
