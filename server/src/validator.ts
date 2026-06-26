import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
// NodeNext 下必须用具名导入 — default import 解析为 namespace 无法 new
import { Ajv2020 } from "ajv/dist/2020.js";
import type { ValidateFunction } from "ajv";
// ajv-formats 在 NodeNext 下 default 被推断为 namespace 而非函数;通过 unknown 绕过
// event.schema.json 目前无 format 关键字,addFormats 是 no-op,但保留以便未来使用
import * as addFormatsNS from "ajv-formats";
type AjvFormatsPlugin = (ajv: InstanceType<typeof Ajv2020>) => InstanceType<typeof Ajv2020>;
const addFormats = (addFormatsNS as unknown as { default: AjvFormatsPlugin }).default;
import type { EventInput } from "./types.js";

const here = dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = join(here, "..", "..", "contracts", "event.schema.json"); // server/ 上一级

export const EVENT_SCHEMA = JSON.parse(readFileSync(SCHEMA_PATH, "utf8")) as Record<string, unknown>;
export const EVENT_SCHEMA_ID = EVENT_SCHEMA["$id"] as string;

export function makeAjv(): InstanceType<typeof Ajv2020> {
  const ajv = new Ajv2020({ allErrors: false, strict: false });
  addFormats(ajv);
  ajv.addSchema(EVENT_SCHEMA);     // 按 $id 注册一次;勿再 compile 同对象
  return ajv;
}

export function makeEventValidator(ajv: InstanceType<typeof Ajv2020> = makeAjv()): ValidateFunction<EventInput> {
  return ajv.getSchema<EventInput>(EVENT_SCHEMA_ID)!;
}

/** Fastify 信封 body schema:只校验 {events: 非空对象数组};逐事件深校验在 handler。 */
export function envelopeSchema(): Record<string, unknown> {
  return { type: "object", required: ["events"], additionalProperties: false,
    properties: { events: { type: "array", minItems: 1, items: { type: "object" } } } };
}
