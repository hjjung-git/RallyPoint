import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Area, Card, Plan, ServerMessage, UnitSpec } from "@rallypoint/shared";
import { Board } from "../board/board.js";
import { DashboardHub } from "./hub.js";

const AREA: Area = { id: "main", name: "main", goal: "g", scope: { read: [], write: ["src/"] } };
const UNIT: UnitSpec = {
  id: "u1",
  kind: "builder",
  role: "Builds",
  scope: { read: [], write: ["src/"] },
  permission: "propose",
  reportFormat: "short",
  areaId: "main",
};
const CARD: Card = {
  id: "c1",
  title: "Card one",
  description: "d",
  unitKind: "builder",
  areaId: "main",
  scope: { read: [], write: ["src/"] },
  dependsOn: [],
  doneCriteria: "done",
  status: "todo",
  assignedUnitId: null,
  iteration: 1,
};
const PLAN: Plan = { areas: [AREA], sharedPaths: [], units: [UNIT], cards: [CARD], estimatedCalls: 2 };

function collect(hub: DashboardHub): ServerMessage[] {
  const messages: ServerMessage[] = [];
  hub.subscribe((m) => messages.push(m));
  return messages;
}

describe("DashboardHub snapshot", () => {
  it("starts empty and idle", () => {
    const snapshot = new DashboardHub({ scenarioTitle: "Demo" }).getSnapshot();
    assert.equal(snapshot.phase, "idle");
    assert.equal(snapshot.scenarioTitle, "Demo");
    assert.equal(snapshot.plan, null);
    assert.deepEqual(snapshot.cards, []);
    assert.equal(snapshot.result, null);
    assert.equal(snapshot.prompt, null);
  });

  it("follows the session through planning, running and the board", () => {
    const hub = new DashboardHub();
    hub.observer.onPhase?.("planning");
    assert.equal(hub.getSnapshot().phase, "planning");

    hub.observer.onPlan?.(PLAN);
    assert.equal(hub.getSnapshot().plan?.cards.length, 1);

    const board = new Board({ onEvent: hub.onEvent });
    board.registerAreas([AREA]);
    board.registerUnits([UNIT]);
    board.registerCards([CARD]);
    hub.observer.onPhase?.("running");
    hub.observer.onBoardReady?.(board);

    let snapshot = hub.getSnapshot();
    assert.equal(snapshot.phase, "running");
    assert.deepEqual(snapshot.cards.map((c) => c.status), ["todo"]);
    assert.equal(snapshot.unitStatuses.u1, "idle");

    board.assign("u1");
    snapshot = hub.getSnapshot();
    assert.deepEqual(snapshot.cards.map((c) => c.status), ["in_progress"]);
    assert.equal(snapshot.unitStatuses.u1, "working");
  });

  it("tracks pause, usage and open issues, and closes an issue when the card leaves blocked", () => {
    const hub = new DashboardHub();
    hub.onEvent({ type: "paused", reason: "card c1 stuck" });
    hub.onEvent({ type: "issue_raised", cardId: "c1", kind: "blocked", message: "stuck" });
    hub.onEvent({ type: "usage_updated", totalCalls: 3, inputTokens: 30, outputTokens: 9 });

    let snapshot = hub.getSnapshot();
    assert.equal(snapshot.paused, true);
    assert.equal(snapshot.pauseReason, "card c1 stuck");
    assert.deepEqual(snapshot.usage, { totalCalls: 3, inputTokens: 30, outputTokens: 9 });
    assert.deepEqual(snapshot.openIssues, [{ cardId: "c1", kind: "blocked", message: "stuck" }]);

    hub.onEvent({ type: "card_moved", cardId: "c1", from: "blocked", to: "todo" });
    hub.onEvent({ type: "resumed" });
    snapshot = hub.getSnapshot();
    assert.equal(snapshot.paused, false);
    assert.equal(snapshot.pauseReason, null);
    assert.deepEqual(snapshot.openIssues, []);
  });

  it("tracks which unit is reviewing which card until the verdict or a move", () => {
    const hub = new DashboardHub();
    hub.onEvent({ type: "review_started", cardId: "c1", unitId: "r1" });
    hub.onEvent({ type: "review_started", cardId: "c2", unitId: "r2" });
    assert.deepEqual(hub.getSnapshot().activeReviews, [
      { cardId: "c1", unitId: "r1" },
      { cardId: "c2", unitId: "r2" },
    ]);

    hub.onEvent({ type: "review_result", cardId: "c1", verdict: "approve", summary: "ok", findings: [] });
    assert.deepEqual(hub.getSnapshot().activeReviews, [{ cardId: "c2", unitId: "r2" }]);

    hub.onEvent({ type: "card_moved", cardId: "c2", from: "review", to: "blocked" });
    assert.deepEqual(hub.getSnapshot().activeReviews, []);
  });

  it("keeps only the latest log entries with increasing numbers", () => {
    const hub = new DashboardHub({ maxLog: 3, now: () => new Date("2026-10-14T00:00:00Z") });
    for (let i = 0; i < 5; i += 1) {
      hub.onEvent({ type: "usage_updated", totalCalls: i, inputTokens: 0, outputTokens: 0 });
    }
    const { log } = hub.getSnapshot();
    assert.deepEqual(log.map((e) => e.seq), [3, 4, 5]);
    assert.equal(log[0]?.at, "2026-10-14T00:00:00.000Z");
  });

  it("records the end result and its totals", () => {
    const hub = new DashboardHub();
    hub.observer.onEnd?.({
      outcome: "finished",
      plan: PLAN,
      message: null,
      totalCalls: 7,
      usage: { inputTokens: 70, outputTokens: 7 },
      report: { iterations: [{ iteration: 1, cards: [], reviewRejections: 0, conflicts: 0, issues: 0 }] },
      retrospective: { summary: "s", wentWell: [], problems: [], nextSteps: [] },
    });
    const snapshot = hub.getSnapshot();
    assert.equal(snapshot.phase, "ended");
    assert.equal(snapshot.result?.outcome, "finished");
    assert.equal(snapshot.result?.report?.iterations.length, 1);
    assert.equal(snapshot.result?.retrospective?.summary, "s");
    assert.deepEqual(snapshot.usage, { totalCalls: 7, inputTokens: 70, outputTokens: 7 });
  });

  it("records a failure that produced no result", () => {
    const hub = new DashboardHub();
    hub.observer.onFail?.("folder must be empty");
    const snapshot = hub.getSnapshot();
    assert.equal(snapshot.phase, "ended");
    assert.equal(snapshot.result?.outcome, "error");
    assert.equal(snapshot.result?.message, "folder must be empty");
  });
});

describe("DashboardHub subscriptions", () => {
  it("sends the event first and then the new snapshot, until unsubscribed", () => {
    const hub = new DashboardHub();
    const messages: ServerMessage[] = [];
    const unsubscribe = hub.subscribe((m) => messages.push(m));

    hub.onEvent({ type: "resumed" });
    assert.deepEqual(messages.map((m) => m.type), ["event", "snapshot"]);

    unsubscribe();
    hub.onEvent({ type: "resumed" });
    assert.equal(messages.length, 2);
  });
});

describe("DashboardHub prompts", () => {
  it("opens a prompt, shows it in the snapshot and resolves it with a valid reply", async () => {
    const hub = new DashboardHub();
    hub.observer.onPhase?.("planning");
    const messages = collect(hub);

    const asked = hub.ask({ kind: "questions", questions: ["Language?"] });
    let snapshot = hub.getSnapshot();
    assert.equal(snapshot.phase, "waiting_for_user");
    assert.equal(snapshot.prompt?.kind, "questions");
    const id = snapshot.prompt?.id ?? "";

    assert.deepEqual(hub.respond({ promptId: id, kind: "questions", answers: ["TypeScript"] }), { ok: true });
    assert.deepEqual(await asked, { promptId: id, kind: "questions", answers: ["TypeScript"] });

    snapshot = hub.getSnapshot();
    assert.equal(snapshot.prompt, null);
    assert.equal(snapshot.phase, "planning");
    assert.ok(messages.length >= 2);
  });

  it("gives each prompt its own id", async () => {
    const hub = new DashboardHub();
    const first = hub.ask({ kind: "issue", cardId: "c1", title: "t", issueKind: "blocked", message: "m" });
    const id1 = hub.getSnapshot().prompt?.id ?? "";
    hub.respond({ promptId: id1, kind: "issue", decision: "retry" });
    await first;
    hub.ask({ kind: "issue", cardId: "c1", title: "t", issueKind: "blocked", message: "m" });
    assert.notEqual(hub.getSnapshot().prompt?.id, id1);
  });

  it("refuses a second prompt while one is open", () => {
    const hub = new DashboardHub();
    hub.ask({ kind: "questions", questions: ["a"] });
    assert.throws(() => hub.ask({ kind: "questions", questions: ["b"] }), /already open/);
  });

  it("rejects replies when nothing is open or the prompt is stale", () => {
    const hub = new DashboardHub();
    const none = hub.respond({ promptId: "p1", kind: "issue", decision: "retry" });
    assert.deepEqual(none, { ok: false, status: 409, error: "No prompt is open." });

    hub.ask({ kind: "issue", cardId: "c1", title: "t", issueKind: "failed", message: "m" });
    const stale = hub.respond({ promptId: "p99", kind: "issue", decision: "retry" });
    assert.ok(!stale.ok && stale.status === 409);
    assert.notEqual(hub.getSnapshot().prompt, null);
  });

  it("rejects malformed replies and keeps the prompt open", () => {
    const hub = new DashboardHub();
    hub.ask({ kind: "questions", questions: ["a", "b"] });
    const id = hub.getSnapshot().prompt?.id ?? "";
    const bad: unknown[] = [
      "text",
      null,
      [],
      { promptId: id, kind: "issue", decision: "retry" },
      { promptId: id, kind: "questions", answers: "no" },
      { promptId: id, kind: "questions", answers: [1] },
      { promptId: id, kind: "questions", answers: ["a", "b", "c"] },
    ];
    for (const body of bad) {
      const result = hub.respond(body);
      assert.ok(!result.ok && result.status === 400, JSON.stringify(body));
    }
    assert.notEqual(hub.getSnapshot().prompt, null);
  });

  it("validates issue and plan decisions", async () => {
    const hub = new DashboardHub();
    hub.ask({ kind: "issue", cardId: "c1", title: "t", issueKind: "blocked", message: "m" });
    let id = hub.getSnapshot().prompt?.id ?? "";
    assert.ok(!hub.respond({ promptId: id, kind: "issue", decision: "maybe" }).ok);
    assert.ok(hub.respond({ promptId: id, kind: "issue", decision: "stop" }).ok);

    const asked = hub.ask({ kind: "plan_review", plan: PLAN });
    id = hub.getSnapshot().prompt?.id ?? "";
    for (const decision of [null, {}, { action: "revise" }, { action: "revise", feedback: "  " }, { action: "nope" }]) {
      assert.ok(!hub.respond({ promptId: id, kind: "plan_review", decision }).ok, JSON.stringify(decision));
    }
    assert.ok(hub.respond({ promptId: id, kind: "plan_review", decision: { action: "revise", feedback: "smaller" } }).ok);
    assert.deepEqual(await asked, {
      promptId: id,
      kind: "plan_review",
      decision: { action: "revise", feedback: "smaller" },
    });
  });

  it("keeps ended even while no prompt is open", () => {
    const hub = new DashboardHub();
    hub.observer.onFail?.("x");
    assert.equal(hub.getSnapshot().phase, "ended");
  });
});
