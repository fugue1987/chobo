export interface ChoboConfig {
  ingestUrl: string;
  service: string;
  ingestSecret?: string;
  account?: string;
  bufferMax: number;
  batchMax: number;
  flushAt: number;
  flushIntervalMs: number;
  spoolDir: string;
  maxSpoolBytes: number;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
}

export interface ChoboConfigInput {
  ingestUrl: string;
  service: string;
  ingestSecret?: string;
  account?: string;
  bufferMax?: number;
  batchMax?: number;
  flushAt?: number;
  flushIntervalMs?: number;
  spoolDir?: string;
  maxSpoolBytes?: number;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export function resolveConfig(input: ChoboConfigInput): ChoboConfig {
  return {
    ingestUrl: input.ingestUrl,
    service: input.service,
    ingestSecret: input.ingestSecret,
    account: input.account,
    bufferMax: input.bufferMax ?? 10000,
    batchMax: input.batchMax ?? 100,
    flushAt: input.flushAt ?? 20,
    flushIntervalMs: input.flushIntervalMs ?? 2000,
    spoolDir: input.spoolDir ?? "./.chobo-spool",
    maxSpoolBytes: input.maxSpoolBytes ?? 50 * 1024 * 1024,
    timeoutMs: input.timeoutMs ?? 5000,
    fetchImpl: input.fetchImpl,
  };
}
