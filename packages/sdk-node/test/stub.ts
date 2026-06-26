import http from "node:http";
import type { AddressInfo } from "node:net";

export interface IngestStub {
  url: string;
  received: unknown[];
  setStatus: (code: number) => void;
  requestCount: () => number;
  stop: () => Promise<void>;
}

/** A localhost HTTP server that records POSTed events. Mirrors the Python conftest stub. */
export async function ingestStub(): Promise<IngestStub> {
  const received: unknown[] = [];
  let status = 200;
  let requests = 0;
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c as Buffer));
    req.on("end", () => {
      requests++;
      if (status >= 200 && status < 300) {
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          if (Array.isArray(body.events)) received.push(...body.events);
        } catch {
          /* ignore malformed */
        }
      }
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify({ accepted: 0, duplicates: 0 }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}/v1/events`,
    received,
    setStatus: (code) => {
      status = code;
    },
    requestCount: () => requests,
    stop: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
