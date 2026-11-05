// TEST FIXTURE ONLY. A local HTTP server standing in for the 0G router so tests run without keys.
// Never imported from src/ or scripts/: the demo path always talks to the real router.

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export interface Captured {
  method: string;
  path: string;
  headers: IncomingMessage["headers"];
  body: unknown;
}

export type Handler = (req: Captured, res: ServerResponse) => void | Promise<void>;

export async function startFakeRouter(handler: Handler) {
  const requests: Captured[] = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const text = Buffer.concat(chunks).toString("utf8");
    let body: unknown = text;
    try {
      body = JSON.parse(text);
    } catch {
      /* keep text */
    }
    const cap: Captured = { method: req.method ?? "", path: req.url ?? "", headers: req.headers, body };
    requests.push(cap);
    await handler(cap, res);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    requests,
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}

export function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", ...headers });
  res.end(JSON.stringify(body));
}

export const TRACE = (requestId: string) => ({
  request_id: requestId,
  provider: "0xProviderFixture",
  provider_identity: "fixture",
  tee_verified: true,
  billing: { currency: "0g", input_cost: "1", output_cost: "2", total_cost: "3" },
});

export function chatBody(content: string, requestId = "req_chat_1") {
  return {
    id: "chatcmpl-fixture",
    object: "chat.completion",
    model: "glm-5.3",
    choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
    x_0g_trace: TRACE(requestId),
  };
}
