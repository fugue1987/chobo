import { describe, it, expect } from "vitest";
import { makeEventValidator } from "../src/validator.js";

const VALID = {
  event_id: "e1", identity_source: "header", start_time: 1750000000000,
  service: "python-lesson-parser", provider: "doubao", operation: "chat",
  request_model: "doubao-seed-2.0-pro", usage_source: "measured",
  status: "success", sdk_lang: "python", sdk_version: "0.1.0",
};

describe("makeEventValidator (Ajv2020 from contract)", () => {
  const validate = makeEventValidator();
  it("accepts a minimal valid event", () => { expect(validate(VALID)).toBe(true); });
  it("rejects a bad operation enum", () => {
    expect(validate({ ...VALID, operation: "translate" })).toBe(false);
    expect(validate.errors?.[0].instancePath).toBe("/operation");
  });
  it("rejects a missing required field", () => { const { event_id, ...rest } = VALID; expect(validate(rest)).toBe(false); });
  it("rejects unknown properties", () => { expect(validate({ ...VALID, surprise: 1 })).toBe(false); });

  // gpt-image-2 per-modality token fields
  it("accepts event with integer input_text_tokens and input_image_tokens", () => {
    expect(validate({ ...VALID, input_text_tokens: 37, input_image_tokens: 323 })).toBe(true);
  });
  it("accepts event with null input_text_tokens and input_image_tokens", () => {
    expect(validate({ ...VALID, input_text_tokens: null, input_image_tokens: null })).toBe(true);
  });
  it("accepts base event without input_text_tokens or input_image_tokens (fields not required)", () => {
    expect(validate(VALID)).toBe(true);
  });

  // identity_source='default' — AdopterA 粗粒度接入(无 per-user 身份,非错误 → 不报警)
  it("accepts identity_source 'default'", () => {
    expect(validate({ ...VALID, identity_source: "default" })).toBe(true);
  });
  it("rejects an unknown identity_source", () => {
    expect(validate({ ...VALID, identity_source: "nope" })).toBe(false);
    expect(validate.errors?.[0].instancePath).toBe("/identity_source");
  });
});
