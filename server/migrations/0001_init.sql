-- 0001_init: chobo CRM 主 schema
CREATE TABLE IF NOT EXISTS usage_events (
  event_id            text PRIMARY KEY,
  request_id          text,
  parent_id           text,
  user_id             text,
  org_id              text,
  project             text,
  identity_source     text NOT NULL,
  start_time          timestamptz NOT NULL,
  end_time            timestamptz,
  latency_ms          integer,
  service             text NOT NULL,
  provider            text NOT NULL,
  operation           text NOT NULL,
  request_model       text NOT NULL,
  response_model      text,
  input_tokens        integer,
  output_tokens       integer,
  total_tokens        integer,
  cached_tokens       integer,
  reasoning_tokens    integer,
  image_count         integer,
  usage_source        text NOT NULL,
  input_cost          numeric(18,8),
  output_cost         numeric(18,8),
  cache_cost          numeric(18,8),
  total_cost          numeric(18,8),
  currency            text DEFAULT 'CNY',
  price_table_version text,
  status              text NOT NULL,
  error_type          text,
  finish_reason       text,
  sdk_lang            text,
  sdk_version         text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  -- 预留:new-api 对账后装件用(v1 不填)
  newapi_cost         numeric(18,8),
  cost_delta          numeric(18,8),
  recon_status        text
);

CREATE INDEX IF NOT EXISTS ix_usage_org_created     ON usage_events (org_id, created_at);
CREATE INDEX IF NOT EXISTS ix_usage_user_created    ON usage_events (user_id, created_at);
CREATE INDEX IF NOT EXISTS ix_usage_project_created ON usage_events (project, created_at);
CREATE INDEX IF NOT EXISTS ix_usage_model_created   ON usage_events (request_model, created_at);
CREATE INDEX IF NOT EXISTS ix_usage_request_id      ON usage_events (request_id);

CREATE TABLE IF NOT EXISTS event_payloads (
  event_id          text PRIMARY KEY REFERENCES usage_events(event_id),
  request_payload   jsonb,
  response_payload  jsonb,
  truncated         boolean DEFAULT false,
  redacted          boolean DEFAULT false,
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS price_table (
  version             text NOT NULL,
  provider            text NOT NULL,
  model               text NOT NULL,
  operation           text NOT NULL,
  input_tier_max      bigint NOT NULL DEFAULT 0,   -- 0 = 无分档/兜底(主键列不可 NULL)
  input_per_mtok      numeric(18,8),
  output_per_mtok     numeric(18,8),
  cache_read_per_mtok numeric(18,8),
  reasoning_per_mtok  numeric(18,8),
  per_image           numeric(18,8),
  currency            text DEFAULT 'CNY',
  PRIMARY KEY (version, provider, model, operation, input_tier_max)
);

-- 模型归一:把带版本/接入点 id 的 request_model 映射到价目规范名
CREATE TABLE IF NOT EXISTS model_aliases (
  provider  text NOT NULL,
  alias     text NOT NULL,
  canonical text NOT NULL,
  PRIMARY KEY (provider, alias)
);
