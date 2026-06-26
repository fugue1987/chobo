-- 0002_account: 多租户 account 维度(可空,区分哪个 app)
ALTER TABLE usage_events ADD COLUMN IF NOT EXISTS account text;
CREATE INDEX IF NOT EXISTS ix_usage_account_created ON usage_events (account, created_at);
