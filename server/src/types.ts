export type PayloadMode = "off" | "metadata" | "truncated";

export interface ServerConfig {
  databaseUrl: string;
  host: string;
  port: number;
  ingestSecret: string | null;   // null = 开放
  payloadMode: PayloadMode;
  payloadMaxBytes: number;
  bodyLimit: number;             // Fastify request body limit in bytes (default 16 MiB)
  priceSeedPath: string | null;
  webDir: string | null;        // 看板静态产物目录(web/dist);null=纯 API
}

export type Operation = "chat" | "image" | "video" | "embedding";
export type UsageSource = "measured" | "estimated" | "none";
export type IdentitySource = "header" | "jwt" | "missing";

export interface EventPayload { request?: unknown; response?: unknown; truncated?: boolean; redacted?: boolean; }

export interface EventInput {
  event_id: string;
  request_id?: string | null; parent_id?: string | null;
  user_id?: string | null; org_id?: string | null; project?: string | null; account?: string | null;
  identity_source: IdentitySource;
  start_time: number; end_time?: number | null; latency_ms?: number | null;
  service: string; provider: string; operation: Operation;
  request_model: string; response_model?: string | null;
  input_tokens?: number | null; output_tokens?: number | null; total_tokens?: number | null;
  cached_tokens?: number | null; reasoning_tokens?: number | null; image_count?: number | null;
  input_text_tokens?: number | null; input_image_tokens?: number | null;
  usage_source: UsageSource;
  status: "success" | "failure"; error_type?: string | null; finish_reason?: string | null;
  payload?: EventPayload | null;
  sdk_lang: "python" | "node"; sdk_version: string;
}

export interface PriceRow {
  version: string; provider: string; model: string; operation: string;
  input_tier_max: number;          // 0 = 无分档/兜底
  input_per_mtok: number | null; output_per_mtok: number | null;
  cache_read_per_mtok: number | null; reasoning_per_mtok: number | null;
  per_image: number | null; text_input_per_mtok: number | null; currency: string;
}
export interface PriceTable {
  version: string;
  rows: PriceRow[];
  aliases: Record<string, string>; // key `${provider}::${alias}` -> canonical model
}
export interface CostLine {
  component: "input" | "output" | "cache";
  modality: "text" | "image" | null;
  tokens: number;
  rate_per_mtok: string;
  cost: string;
}
export interface CostBreakdown {
  currency: string;
  price_table_version: string;
  lines: CostLine[];
}
export interface Cost {
  input_cost: number | null; output_cost: number | null; cache_cost: number | null;
  total_cost: number | null;       // null = 未找到价目(告警,不填 0)
  cost_breakdown: CostBreakdown | null;
  currency: string | null; price_table_version: string | null; priced: boolean;
}
