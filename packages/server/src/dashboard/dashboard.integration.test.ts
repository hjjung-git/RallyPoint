import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { rawPlan } from "../planner/plan-fixture.js";
import { ScriptedClient, propose, reply } from "../runner/scripted-client.js";
import { runProject } from "../session/session.js";
import { DashboardHub } from "./hub.js";
import { DashboardInteraction } from "./interaction.js";
import { startDashboardServer } from "./server.js";

// 브라우저 역할: 서버에 접속해서 질문이 열릴 때마다 HTTP로 답한다.
function autoAnswer(url: string, hub: DashboardHub, answers: Record<string, unknown>): () => void {
  const seen = new Set<string>();
  return hub.subscribe((message) => {
    if (message.type !== "snapshot" || !message.snapshot.prompt) return;
    const prompt = message.snapshot.prompt;
    if (seen.has(prompt.id)) return;
    seen.add(prompt.id);
    const body = { promptId: prompt.id, kind: prompt.kind, ...((answers[prompt.kind] as object) ?? {}) };
    void fetch(`${url}/api/reply`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  });
}

describe("session with the dashboard", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "rp-dash-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("runs a whole project while a client answers over HTTP", async () => {
    const raw = rawPlan();
    raw.units = raw.units.filter((u: any) => u.kind !== "reviewer");
    const client = new ScriptedClient([
      reply([{ name: "ask_user", input: { questions: ["Language?"] } }]),
      reply([{ name: "submit_plan", input: raw }]),
      reply([propose([{ path: "src/shared/types.ts", content: "export type A = 1;\n" }])]),
      reply([propose([{ path: "src/web/page.ts", content: "export {};\n" }])]),
    ]);

    const hub = new DashboardHub({ scenarioTitle: "Demo" });
    const server = await startDashboardServer(hub, { port: 0 });
    const stop = autoAnswer(server.url, hub, {
      questions: { answers: ["TypeScript"] },
      plan_review: { decision: { action: "approve" } },
    });
    try {
      const result = await runProject({
        scenario: { title: "Demo", goal: "Build a site", constraints: "", doneCriteria: "" },
        client,
        workspaceDir: join(dir, "work"),
        interaction: new DashboardInteraction(hub),
        onEvent: hub.onEvent,
        observer: hub.observer,
        plannerOptions: { sleep: async () => {} },
        runOptions: { sleep: async () => {} },
      });

      assert.equal(result.outcome, "finished");
      const snapshot = (await (await fetch(`${server.url}/api/snapshot`)).json()) as ReturnType<
        DashboardHub["getSnapshot"]
      >;
      assert.equal(snapshot.phase, "ended");
      assert.equal(snapshot.result?.outcome, "finished");
      assert.deepEqual(snapshot.cards.map((c) => c.status), ["done", "done"]);
      assert.equal(snapshot.plan?.cards.length, 2);
      assert.equal(snapshot.prompt, null);
      assert.ok(snapshot.log.some((e) => e.event.type === "card_moved"));
      assert.ok(client.requests[2]?.prompt.includes("Card c1") || client.requests[2]?.prompt.includes("Card c2"));
      assert.ok(client.requests[1]?.prompt.includes("A: TypeScript"));
    } finally {
      stop();
      await server.close();
    }
  });

  it("shows a failure to the dashboard when the work folder is not empty", async () => {
    await writeFile(join(dir, "occupied.txt"), "x", "utf8");
    const hub = new DashboardHub();
    await assert.rejects(
      runProject({
        scenario: { title: null, goal: "g", constraints: "", doneCriteria: "" },
        client: new ScriptedClient([]),
        workspaceDir: dir,
        interaction: new DashboardInteraction(hub),
        observer: hub.observer,
      }),
      /must be empty/,
    );
    const snapshot = hub.getSnapshot();
    assert.equal(snapshot.phase, "ended");
    assert.equal(snapshot.result?.outcome, "error");
  });
});
