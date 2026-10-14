import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { ServerMessage } from "@rallypoint/shared";
import type { DashboardHub } from "./hub.js";
import { STATUS_PAGE } from "./page.js";

export const DEFAULT_PORT = 3001;
const MAX_BODY_BYTES = 1_000_000;
const HEARTBEAT_MS = 15_000;
// 같은 컴퓨터에서 열린 화면만 허용한다(개발용 화면 서버 포함).
const LOCAL_ORIGIN = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

export interface DashboardServerOptions {
  port?: number;
  // 기본은 이 컴퓨터에서만 접속할 수 있는 주소다. 인증이 없어서 바깥에 열지 않는다.
  host?: string;
}

export interface RunningDashboardServer {
  host: string;
  port: number;
  url: string;
  close(): Promise<void>;
}

// 대시보드 화면과 통신하는 HTTP 서버.
//   GET  /            간단한 상태 화면
//   GET  /api/snapshot 지금 전체 상태(JSON)
//   GET  /api/stream  변화를 실시간으로 보내는 연결(Server-Sent Events)
//   POST /api/reply   사용자의 답
export async function startDashboardServer(
  hub: DashboardHub,
  options: DashboardServerOptions = {},
): Promise<RunningDashboardServer> {
  const host = options.host ?? "127.0.0.1";
  const streams = new Set<ServerResponse>();

  const server: Server = createServer((req, res) => {
    handle(hub, streams, req, res).catch(() => {
      if (!res.headersSent) {
        sendJson(res, 500, { ok: false, error: "Internal error." });
      } else {
        res.end();
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? DEFAULT_PORT, host, () => {
      server.off("error", reject);
      resolve();
    });
  });

  const heartbeat = setInterval(() => {
    for (const stream of streams) {
      stream.write(": ping\n\n");
    }
  }, HEARTBEAT_MS);
  heartbeat.unref();

  const port = (server.address() as AddressInfo).port;
  return {
    host,
    port,
    url: `http://${host}:${port}`,
    close: () =>
      new Promise<void>((resolve) => {
        clearInterval(heartbeat);
        for (const stream of streams) {
          stream.end();
        }
        streams.clear();
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}

async function handle(
  hub: DashboardHub,
  streams: Set<ServerResponse>,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const origin = req.headers.origin;
  if (typeof origin === "string" && LOCAL_ORIGIN.test(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "content-type");
  }

  const path = (req.url ?? "/").split("?")[0];
  const method = req.method ?? "GET";

  if (method === "OPTIONS") {
    res.writeHead(204).end();
    return;
  }

  if (path === "/" && method === "GET") {
    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy":
        "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'",
    });
    res.end(STATUS_PAGE);
    return;
  }

  if (path === "/api/snapshot" && method === "GET") {
    sendJson(res, 200, hub.getSnapshot());
    return;
  }

  if (path === "/api/stream" && method === "GET") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    const write = (message: ServerMessage): void => {
      res.write(`data: ${JSON.stringify(message)}\n\n`);
    };
    write({ type: "snapshot", snapshot: hub.getSnapshot() });
    const unsubscribe = hub.subscribe(write);
    streams.add(res);
    req.on("close", () => {
      unsubscribe();
      streams.delete(res);
    });
    return;
  }

  if (path === "/api/reply") {
    if (method !== "POST") {
      sendJson(res, 405, { ok: false, error: "Use POST." });
      return;
    }
    const body = await readBody(req);
    if (body === "too_large") {
      sendJson(res, 413, { ok: false, error: "Body is too large." });
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      sendJson(res, 400, { ok: false, error: "Body must be valid JSON." });
      return;
    }
    const result = hub.respond(parsed);
    sendJson(res, result.ok ? 200 : result.status, result);
    return;
  }

  sendJson(res, 404, { ok: false, error: "Not found." });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<string | "too_large"> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > MAX_BODY_BYTES) {
      return "too_large";
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}
