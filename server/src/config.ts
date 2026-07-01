import type { PayloadMode, ServerConfig } from "./types.js";

const MODES: PayloadMode[] = ["off", "metadata", "truncated"];

export function resolveConfig(env: Record<string, string | undefined>): ServerConfig {
  const databaseUrl = env.CHOBO_DATABASE_URL;
  if (!databaseUrl) throw new Error("chobo: CHOBO_DATABASE_URL is required");
  const payloadMode = (env.CHOBO_PAYLOAD_MODE ?? "metadata") as PayloadMode;
  if (!MODES.includes(payloadMode)) throw new Error(`chobo: CHOBO_PAYLOAD_MODE must be one of ${MODES.join("|")}`);
  const secret = env.CHOBO_INGEST_SECRET?.trim();
  const port = Number(env.CHOBO_PORT ?? "8787");
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("chobo: CHOBO_PORT must be an integer 1–65535");
  const payloadMaxBytes = Number(env.CHOBO_PAYLOAD_MAX_BYTES ?? "8192");
  if (!Number.isInteger(payloadMaxBytes) || payloadMaxBytes < 0)
    throw new Error("chobo: CHOBO_PAYLOAD_MAX_BYTES must be a non-negative integer");
  const bodyLimit = Number(env.CHOBO_BODY_LIMIT ?? String(16 * 1024 * 1024));
  if (!Number.isInteger(bodyLimit) || bodyLimit < 1)
    throw new Error("chobo: CHOBO_BODY_LIMIT must be a positive integer");
  const priceRefreshSec = Number(env.CHOBO_PRICE_REFRESH_SEC ?? "60");
  if (!Number.isInteger(priceRefreshSec) || priceRefreshSec < 0)
    throw new Error("chobo: CHOBO_PRICE_REFRESH_SEC must be a non-negative integer");
  return {
    databaseUrl,
    host: env.CHOBO_HOST ?? "0.0.0.0",
    port,
    ingestSecret: secret ? secret : null,
    payloadMode,
    payloadMaxBytes,
    bodyLimit,
    priceSeedPath: env.CHOBO_PRICE_SEED ?? null,
    webDir: env.CHOBO_WEB_DIR ?? null,
    priceRefreshSec,
  };
}
