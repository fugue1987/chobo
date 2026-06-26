import { resolveConfig, type ChoboConfigInput, type ChoboConfig } from "./config.js";
import { Transport, type TransportStats } from "./transport.js";
import type { ChoboEvent } from "./event.js";

interface RuntimeState {
  transport: Transport | null;
  config: ChoboConfig | null;
}

// Hang the singleton off globalThis so the ESM and CJS builds share one instance
// (dual-package hazard mitigation — see docs/research/2026-06-24-node-sdk-grounding.md §4).
const KEY = Symbol.for("chobo.runtime.v1");
function state(): RuntimeState {
  const g = globalThis as unknown as Record<symbol, RuntimeState | undefined>;
  if (!g[KEY]) g[KEY] = { transport: null, config: null };
  return g[KEY] as RuntimeState;
}

export function init(input: ChoboConfigInput): ChoboConfig {
  const s = state();
  if (s.transport) void s.transport.shutdown();
  const cfg = resolveConfig(input);
  s.config = cfg;
  s.transport = new Transport(cfg);
  return cfg;
}

export function emit(event: ChoboEvent): void {
  state().transport?.enqueue(event);
}

export function flush(): Promise<void> {
  return state().transport?.flush() ?? Promise.resolve();
}

export async function shutdown(): Promise<void> {
  const s = state();
  await (s.transport?.shutdown() ?? Promise.resolve());
  s.transport = null;
  s.config = null;
}

export function getStats(): Partial<TransportStats> {
  const t = state().transport;
  return t ? { ...t.stats } : {};
}

export function getConfig(): ChoboConfig | null {
  return state().config;
}

/** Test helper: tear down the active transport. */
export function reset(): Promise<void> {
  return shutdown();
}
