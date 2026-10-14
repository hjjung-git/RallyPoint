import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { DashboardSnapshot, ServerMessage } from "@rallypoint/shared";
import { DashboardHub } from "./hub.js";
import { startDashboardServer } from "./server.js";
import type { RunningDashboardServer } from "./server.js";

// 연결을 열어 두고 메시지가 올 때마다 모아 두는 도우미
async function openStream(url: string) {
  const controller = new AbortController();
  const response = await fetch(`${url}/api/stream`, { signal: controller.signal });
  const reader = (response.body as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const messages: ServerMessage[] = [];

  async function next(): Promise<ServerMessage> {
    for (;;) {
      const end = buffer.indexOf("\n\n");
      if (end >= 0) {
        const chunk = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const line = chunk.split("\n").find((l) => l.startsWith("data: "));
        if (line) {
          const message = JSON.parse(line.slice(6)) as ServerMessage;
          messages.push(message);
          return message;
        }
        continue;
      }
      const { value, done } = await reader.read();
      if (done) {
        throw new Error("stream ended");
      }
      buffer += decoder.decode(value, { stream: true });
    }
  }

  return { response, reader, next, abort: () => controller.abort() };
}

async function post(url: string, body: unknown, raw = false) {
  const response = await fetch(`${url}/api/reply`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: raw ? (body as string) : JSON.stringify(body),
  });
  return { status: response.status, json: (await response.json()) as Record<string, unknown> };
}

describe("dashboard server", () => {
  let hub: DashboardHub;
  let server: RunningDashboardServer;

  beforeEach(async () => {
    hub = new DashboardHub({ scenarioTitle: "Demo" });
    server = await startDashboardServer(hub, { port: 0 });
  });

  afterEach(async () => {
    await server.close();
  });

  it("listens only on the local address", () => {
    assert.equal(server.host, "127.0.0.1");
    assert.ok(server.port > 0);
    assert.equal(server.url, `http://127.0.0.1:${server.port}`);
  });

  it("serves the current snapshot as JSON", async () => {
    const response = await fetch(`${server.url}/api/snapshot`);
    assert.equal(response.status, 200);
    const snapshot = (await response.json()) as DashboardSnapshot;
    assert.equal(snapshot.scenarioTitle, "Demo");
    assert.equal(snapshot.phase, "idle");
  });

  it("serves the status page with a restrictive content policy", async () => {
    const response = await fetch(`${server.url}/`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /text\/html/);
    assert.match(response.headers.get("content-security-policy") ?? "", /default-src 'self'/);
    const html = await response.text();
    assert.ok(html.includes("RallyPoint"));
    assert.ok(html.includes("/api/stream"));
    // 서버에서 온 글을 HTML로 해석하는 코드는 쓰지 않는다.
    assert.ok(!html.includes("innerHTML"));
  });

  it("streams a snapshot first and then events and updated snapshots", async () => {
    const stream = await openStream(server.url);
    try {
      assert.match(stream.response.headers.get("content-type") ?? "", /text\/event-stream/);
      const first = await stream.next();
      assert.equal(first.type, "snapshot");

      hub.onEvent({ type: "paused", reason: "stuck" });
      const second = await stream.next();
      assert.equal(second.type, "event");
      const third = await stream.next();
      assert.ok(third.type === "snapshot" && third.snapshot.paused === true);
    } finally {
      stream.abort();
    }
  });

  it("stops sending to a client that disconnected", async () => {
    const stream = await openStream(server.url);
    await stream.next();
    stream.abort();
    // 연결이 끊긴 뒤에도 허브가 오류 없이 계속 동작한다.
    await new Promise((resolve) => setTimeout(resolve, 20));
    hub.onEvent({ type: "resumed" });
    hub.onEvent({ type: "resumed" });
    assert.equal(hub.getSnapshot().log.length, 2);
  });

  it("passes a valid reply to the open prompt", async () => {
    const asked = hub.ask({ kind: "issue", cardId: "c1", title: "t", issueKind: "blocked", message: "m" });
    const id = hub.getSnapshot().prompt?.id ?? "";
    const result = await post(server.url, { promptId: id, kind: "issue", decision: "retry" });

    assert.equal(result.status, 200);
    assert.deepEqual(result.json, { ok: true });
    assert.deepEqual(await asked, { promptId: id, kind: "issue", decision: "retry" });
  });

  it("rejects bad replies with the right status", async () => {
    const none = await post(server.url, { promptId: "p1", kind: "issue", decision: "retry" });
    assert.equal(none.status, 409);

    hub.ask({ kind: "issue", cardId: "c1", title: "t", issueKind: "blocked", message: "m" });
    const id = hub.getSnapshot().prompt?.id ?? "";
    const invalid = await post(server.url, { promptId: id, kind: "issue", decision: "maybe" });
    assert.equal(invalid.status, 400);
    assert.equal(invalid.json.ok, false);

    const notJson = await post(server.url, "not json", true);
    assert.equal(notJson.status, 400);

    const stale = await post(server.url, { promptId: "p99", kind: "issue", decision: "retry" });
    assert.equal(stale.status, 409);
    assert.notEqual(hub.getSnapshot().prompt, null);
  });

  it("rejects a body that is too large", async () => {
    const big = JSON.stringify({ promptId: "p1", pad: "x".repeat(1_100_000) });
    const result = await post(server.url, big, true);
    assert.equal(result.status, 413);
  });

  it("answers wrong methods and unknown paths", async () => {
    assert.equal((await fetch(`${server.url}/api/reply`)).status, 405);
    assert.equal((await fetch(`${server.url}/nope`)).status, 404);
    assert.equal((await fetch(`${server.url}/api/snapshot`, { method: "POST" })).status, 404);
  });

  it("allows only local origins for cross-origin use", async () => {
    const local = await fetch(`${server.url}/api/snapshot`, { headers: { Origin: "http://localhost:5173" } });
    assert.equal(local.headers.get("access-control-allow-origin"), "http://localhost:5173");

    const evil = await fetch(`${server.url}/api/snapshot`, { headers: { Origin: "https://evil.example" } });
    assert.equal(evil.headers.get("access-control-allow-origin"), null);

    const spoof = await fetch(`${server.url}/api/snapshot`, { headers: { Origin: "http://localhost.evil.example" } });
    assert.equal(spoof.headers.get("access-control-allow-origin"), null);

    const preflight = await fetch(`${server.url}/api/reply`, {
      method: "OPTIONS",
      headers: { Origin: "http://127.0.0.1:5173" },
    });
    assert.equal(preflight.status, 204);
    assert.match(preflight.headers.get("access-control-allow-methods") ?? "", /POST/);
  });

  it("ends open streams when the server closes", async () => {
    const stream = await openStream(server.url);
    await stream.next();
    await server.close();
    const { done } = await stream.reader.read();
    assert.equal(done, true);
    // afterEach에서 다시 닫아도 오류가 없어야 한다.
  });
});
