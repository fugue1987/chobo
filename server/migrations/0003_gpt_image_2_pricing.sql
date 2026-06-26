-- 0003_gpt_image_2_pricing: gpt-image-2 token 计价
-- 价目表：图像 token 计价新增 text 输入费率列（复用 input_per_mtok=图像输入、output_per_mtok=图像输出）
ALTER TABLE price_table   ADD COLUMN IF NOT EXISTS text_input_per_mtok numeric(18,8);
-- 用量事件：逐模态输入 token 拆分 + 成本逐项明细
ALTER TABLE usage_events  ADD COLUMN IF NOT EXISTS input_text_tokens  integer;
ALTER TABLE usage_events  ADD COLUMN IF NOT EXISTS input_image_tokens integer;
ALTER TABLE usage_events  ADD COLUMN IF NOT EXISTS cost_breakdown     jsonb;
