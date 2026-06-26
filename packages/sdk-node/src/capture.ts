import { emit, getConfig } from "./runtime.js";
import { getIdentity, type Identity } from "./identity.js";
import { buildEvent, nowMs, type Operation, type Usage } from "./event.js";
import type { ExtractedUsage } from "./extractors.js";

export interface MeterOptions {
  operation: Operation;
  provider: string;
  requestModel: string;
  extract?: (response: unknown) => ExtractedUsage;
  requestId?: string | null;
  parentId?: string | null;
}

function emitSuccess(opts: MeterOptions, identity: Identity, start: number, response: unknown): void {
  let usage: Usage = {};
  if (opts.extract) {
    try { usage = opts.extract(response) as Usage; }
    catch { usage = { usage_source: "none" }; }
  }
  emit(buildEvent({
    service: getConfig()?.service ?? "unknown",
    account: getConfig()?.account ?? null,
    provider: opts.provider, operation: opts.operation, request_model: opts.requestModel,
    identity, start_ms: start, end_ms: nowMs(), usage, status: "success",
    request_id: opts.requestId ?? null, parent_id: opts.parentId ?? null,
  }));
}

function emitFailure(opts: MeterOptions, identity: Identity, start: number, err: unknown): void {
  emit(buildEvent({
    service: getConfig()?.service ?? "unknown",
    account: getConfig()?.account ?? null,
    provider: opts.provider, operation: opts.operation, request_model: opts.requestModel,
    identity, start_ms: start, end_ms: nowMs(), status: "failure",
    error_type: err instanceof Error ? err.constructor.name : "Error",
    request_id: opts.requestId ?? null, parent_id: opts.parentId ?? null,
  }));
}

/** Wrap a buffered async call. Never alters the return value or the thrown error. */
export async function meter<T>(opts: MeterOptions, fn: () => Promise<T>): Promise<T> {
  const start = nowMs();
  const identity = getIdentity(); // snapshot at call time (inside the request context)
  let response: T;
  try {
    response = await fn();
  } catch (err) {
    emitFailure(opts, identity, start, err);
    throw err;
  }
  emitSuccess(opts, identity, start, response);
  return response;
}

export interface MeterStreamOptions extends MeterOptions {
  /** Per-chunk usage extractor: return usage when found (last-non-null wins), else null. */
  extractChunkUsage: (chunk: unknown) => ExtractedUsage | null;
}

/** Wrap a streaming response (async iterable): passthrough chunks, capture usage, emit on completion. */
export async function* meterStream<T>(
  opts: MeterStreamOptions,
  source: AsyncIterable<T>,
): AsyncGenerator<T> {
  const start = nowMs();
  const identity = getIdentity(); // snapshot at call time, before iteration drifts context
  let usage: ExtractedUsage | null = null;
  try {
    for await (const chunk of source) {
      let u: ExtractedUsage | null = null;
      try { u = opts.extractChunkUsage(chunk); }
      catch { u = null; } // a throwing extractor must never break the business stream
      if (u) usage = u; // last-non-null wins (Gemini) / final usage chunk (OpenAI)
      yield chunk; // passthrough — never alter the stream
    }
  } catch (err) {
    emitFailure(opts, identity, start, err);
    throw err;
  }
  // NOTE: emitted only on full stream completion. An early consumer break (e.g. client
  // disconnect mid-stream) emits no event — a known v1 limitation (revisited in Plan 5).
  emit(buildEvent({
    service: getConfig()?.service ?? "unknown",
    account: getConfig()?.account ?? null,
    provider: opts.provider, operation: opts.operation, request_model: opts.requestModel,
    identity, start_ms: start, end_ms: nowMs(),
    usage: (usage ?? { usage_source: "none" }) as Usage, status: "success",
    request_id: opts.requestId ?? null, parent_id: opts.parentId ?? null,
  }));
}

/** Manual span for imperative integrations (a hand-rolled SSE parse loop that can't be
 * expressed as an AsyncIterable). Snapshot identity at creation; feed usage via observe();
 * emit exactly once on done()/fail(). If neither is called (request throws before done),
 * no event is emitted — same v1 semantics as meterStream. */
export interface ManualSpan {
  observe(usage: ExtractedUsage | null): void;
  done(): void;
  fail(err: unknown): void;
}

export function meterManual(opts: MeterOptions): ManualSpan {
  const start = nowMs();
  const identity = getIdentity(); // snapshot at creation, inside the request context
  let usage: ExtractedUsage | null = null;
  let settled = false;
  const base = () => ({
    service: getConfig()?.service ?? "unknown",
    account: getConfig()?.account ?? null,
    provider: opts.provider, operation: opts.operation, request_model: opts.requestModel,
    identity, start_ms: start, end_ms: nowMs(),
    request_id: opts.requestId ?? null, parent_id: opts.parentId ?? null,
  });
  return {
    observe(u) { if (u) usage = u; }, // last-non-null wins (final usage chunk)
    done() {
      if (settled) return; settled = true;
      emit(buildEvent({ ...base(), usage: (usage ?? { usage_source: "none" }) as Usage, status: "success" }));
    },
    fail(err) {
      if (settled) return; settled = true;
      emit(buildEvent({ ...base(), status: "failure", error_type: err instanceof Error ? err.constructor.name : "Error" }));
    },
  };
}
