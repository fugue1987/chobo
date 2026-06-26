import { randomUUID } from "node:crypto";
import type { Identity } from "./identity.js";

export const SDK_LANG = "node";
export const SDK_VERSION = "0.1.5";

export type Operation = "chat" | "image" | "video" | "embedding";
export type UsageSource = "measured" | "estimated" | "none";
export type Status = "success" | "failure";

export interface Usage {
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
  usage_source?: UsageSource;
}

export interface ChoboEvent {
  event_id: string;
  request_id: string | null;
  parent_id: string | null;
  user_id: string | null;
  org_id: string | null;
  project: string | null;
  account: string | null;
  identity_source: string;
  start_time: number;
  end_time: number | null;
  latency_ms: number | null;
  service: string;
  provider: string;
  operation: Operation;
  request_model: string;
  response_model: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  total_tokens: number | null;
  cached_tokens: number | null;
  reasoning_tokens: number | null;
  image_count: number | null;
  input_text_tokens: number | null;
  input_image_tokens: number | null;
  usage_source: UsageSource;
  status: Status;
  error_type: string | null;
  finish_reason: string | null;
  payload: Record<string, unknown> | null;
  sdk_lang: string;
  sdk_version: string;
}

export function nowMs(): number {
  return Date.now();
}

export interface BuildEventInput {
  service: string;
  account?: string | null;
  provider: string;
  operation: Operation;
  request_model: string;
  identity: Identity;
  start_ms: number;
  end_ms: number | null;
  usage?: Usage;
  status?: Status;
  error_type?: string | null;
  response_model?: string | null;
  finish_reason?: string | null;
  request_id?: string | null;
  parent_id?: string | null;
  payload?: Record<string, unknown> | null;
}

export function buildEvent(input: BuildEventInput): ChoboEvent {
  const u = input.usage ?? {};
  const status: Status = input.status ?? "success";
  const start = input.start_ms;
  const end = input.end_ms;
  const latency = end != null && start != null ? end - start : null;
  const defaultUsageSource: UsageSource = status === "failure" ? "none" : "measured";
  return {
    event_id: randomUUID(),
    request_id: input.request_id ?? null,
    parent_id: input.parent_id ?? null,
    user_id: input.identity.user_id ?? null,
    org_id: input.identity.org_id ?? null,
    project: input.identity.project ?? null,
    account: input.account ?? null,
    identity_source: input.identity.identity_source ?? "missing",
    start_time: start,
    end_time: end ?? null,
    latency_ms: latency,
    service: input.service,
    provider: input.provider,
    operation: input.operation,
    request_model: input.request_model,
    response_model: input.response_model ?? u.response_model ?? null,
    input_tokens: u.input_tokens ?? null,
    output_tokens: u.output_tokens ?? null,
    total_tokens: u.total_tokens ?? null,
    cached_tokens: u.cached_tokens ?? null,
    reasoning_tokens: u.reasoning_tokens ?? null,
    image_count: u.image_count ?? null,
    input_text_tokens: u.input_text_tokens ?? null,
    input_image_tokens: u.input_image_tokens ?? null,
    usage_source: u.usage_source ?? defaultUsageSource,
    status,
    error_type: input.error_type ?? null,
    finish_reason: input.finish_reason ?? u.finish_reason ?? null,
    payload: input.payload ?? null,
    sdk_lang: SDK_LANG,
    sdk_version: SDK_VERSION,
  };
}
