import type { FastifyRequest, FastifyReply } from "fastify";
type PreHandler = (req: FastifyRequest, reply: FastifyReply) => Promise<void>;

/** secret 为 null → 返回 undefined(开放,不挂 hook)。 */
export function secretGuard(secret: string | null): PreHandler | undefined {
  if (!secret) return undefined;
  return async (req, reply) => {
    if (req.headers["x-chobo-secret"] !== secret) { await reply.code(401).send({ error: "unauthorized" }); return; }
  };
}
