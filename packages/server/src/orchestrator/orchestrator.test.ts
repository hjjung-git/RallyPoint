import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { Area, Card, DashboardEvent, UnitSpec } from "@rallypoint/shared";
import { Board } from "../board/board.js";
import { LlmError } from "../runner/llm.js";
import type { LlmResponse } from "../runner/llm.js";
import { ScriptedClient, propose, reply } from "../runner/scripted-client.js";
import type { ScriptedStep } from "../runner/scripted-client.js";
import { Workspace } from "../workspace/workspace.js";
import { Orchestrator } from "./orchestrator.js";

const AREA: Area = {
  id: "main",
  name: "main",
  goal: "everything",
  scope: { read: ["src/"], write: ["src/"] },
};

function builder(id: string): UnitSpec {
  return {
    id,
    kind: "builder",
    role: "Builds code",
    scope: { read: ["src/"], write: ["src/"] },
    permission: "propose",
    reportFormat: "short",
    areaId: "main",
  };
}

function reviewer(id: string): UnitSpec {
  return {
    id,
    kind: "reviewer",
    role: "Reviews code",
    scope: { read: ["src/"], write: [] },
    permission: "read",
    reportFormat: "short",
    areaId: null,
  };
}

function card(id: string, overrides: Partial<Card> = {}): Card {
  return {
    id,
    title: `card ${id}`,
    description: "do it",
    unitKind: "builder",
    areaId: "main",
    scope: { read: ["src/"], write: ["src/"] },
    dependsOn: [],
    doneCriteria: "done",
    status: "todo",
    assignedUnitId: null,
    iteration: 1,
    ...overrides,
  };
}

function file(path: string, content = "x") {
  return reply([propose([{ path, content }])]);
}

function verdict(value: "approve" | "reject", findings: string[] = []): LlmResponse {
  return reply([
    { name: "submit_review", input: { verdict: value, summary: `${value}d`, findings } },
  ]);
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("Orchestrator", () => {
  let dir: string;
  let workspace: Workspace;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "rp-orch-"));
    workspace = await Workspace.open(join(dir, "work"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  function setup(options: {
    areas?: Area[];
    units: UnitSpec[];
    cards: Card[];
    steps: ScriptedStep[];
    maxConcurrent?: number;
    maxConflictRetries?: number;
    maxReviewRejections?: number;
  }) {
    const events: DashboardEvent[] = [];
    const onEvent = (event: DashboardEvent) => events.push(event);
    const board = new Board({ maxConcurrent: options.maxConcurrent, onEvent });
    board.registerAreas(options.areas ?? [AREA]);
    board.registerUnits(options.units);
    board.registerCards(options.cards);
    const client = new ScriptedClient(options.steps);
    const orchestrator = new Orchestrator({
      board,
      workspace,
      client,
      units: options.units,
      onEvent,
      runOptions: { sleep: async () => {} },
      maxConflictRetries: options.maxConflictRetries,
      maxReviewRejections: options.maxReviewRejections,
    });
    return { board, events, client, orchestrator };
  }

  it("runs a card to done and writes its files", async () => {
    const { board, events, orchestrator } = setup({
      units: [builder("u1")],
      cards: [card("c1")],
      steps: [file("src/a.ts", "hello")],
    });
    const summary = await orchestrator.run();

    assert.equal(summary.outcome, "finished");
    assert.equal(board.getCard("c1")?.status, "done");
    assert.equal(workspace.read("src/a.ts").content, "hello");
    const moves = events.filter((e) => e.type === "card_moved");
    assert.deepEqual(
      moves.map((e) => (e.type === "card_moved" ? `${e.from}>${e.to}` : "")),
      ["todo>in_progress", "in_progress>done"],
    );
  });

  it("runs dependent cards in order and shows earlier work to later cards", async () => {
    const { board, client, orchestrator } = setup({
      units: [builder("u1")],
      cards: [card("c1"), card("c2", { dependsOn: ["c1"] })],
      steps: [file("src/a.ts", "first"), file("src/b.ts", "second")],
    });
    const summary = await orchestrator.run();

    assert.equal(summary.outcome, "finished");
    assert.equal(board.getCard("c2")?.status, "done");
    assert.ok(client.requests[1].prompt.includes('<file path="src/a.ts"'));
  });

  it("never runs more cards at once than the concurrency limit", async () => {
    let active = 0;
    let maxActive = 0;
    const slow = (path: string): ScriptedStep => async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await delay(10);
      active -= 1;
      return file(path);
    };
    const { board, orchestrator } = setup({
      units: [builder("u1"), builder("u2"), builder("u3")],
      cards: [card("c1"), card("c2"), card("c3")],
      steps: [slow("src/1.ts"), slow("src/2.ts"), slow("src/3.ts")],
      maxConcurrent: 2,
    });
    const summary = await orchestrator.run();

    assert.equal(summary.outcome, "finished");
    assert.equal(maxActive, 2);
    assert.ok(board.getCards().every((c) => c.status === "done"));
  });

  it("has a reviewer unit review changed cards and finishes when approved", async () => {
    const { board, events, client, orchestrator } = setup({
      units: [builder("u1"), reviewer("r1")],
      cards: [card("c1")],
      steps: [file("src/a.ts"), verdict("approve")],
    });
    const summary = await orchestrator.run();

    assert.equal(summary.outcome, "finished");
    assert.equal(board.getCard("c1")?.status, "done");
    assert.equal(summary.totalCalls, 2);
    assert.deepEqual(
      client.requests[1]?.tools.map((t) => t.name),
      ["submit_review", "report_blocked"],
    );
    assert.ok(client.requests[1]?.prompt.includes('<file path="src/a.ts"'));
    assert.ok(events.some((e) => e.type === "review_result" && e.verdict === "approve"));
    assert.ok(
      events.some((e) => e.type === "review_started" && e.cardId === "c1" && e.unitId === "r1"),
    );
    assert.ok(
      events.some((e) => e.type === "unit_status_changed" && e.unitId === "r1" && e.status === "working"),
    );
    assert.ok(
      events.some((e) => e.type === "unit_status_changed" && e.unitId === "r1" && e.status === "idle"),
    );
  });

  it("sends a rejected card back with the findings and reviews it again", async () => {
    const { board, client, orchestrator } = setup({
      units: [builder("u1"), reviewer("r1")],
      cards: [card("c1")],
      steps: [
        file("src/a.ts", "v1"),
        verdict("reject", ["add input validation", "name the function"]),
        file("src/a.ts", "v2"),
        verdict("approve"),
      ],
    });
    const summary = await orchestrator.run();

    assert.equal(summary.outcome, "finished");
    assert.equal(workspace.read("src/a.ts").content, "v2");
    assert.equal(board.getCard("c1")?.status, "done");
    const retryPrompt = client.requests[2]?.prompt ?? "";
    assert.ok(retryPrompt.includes("- add input validation"));
    assert.ok(retryPrompt.includes("- name the function"));
    // 승인된 뒤에는 지적이 남지 않는다.
    assert.ok(!(client.requests[0]?.prompt ?? "").includes("add input validation"));
  });

  it("counts reviews against the concurrency limit", async () => {
    let active = 0;
    let maxActive = 0;
    const slow = (response: LlmResponse): ScriptedStep => async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await delay(10);
      active -= 1;
      return response;
    };
    const { board, orchestrator } = setup({
      units: [builder("u1"), builder("u2"), reviewer("r1")],
      cards: [card("c1"), card("c2")],
      steps: [
        slow(file("src/a.ts")),
        slow(file("src/b.ts")),
        slow(verdict("approve")),
        slow(verdict("approve")),
      ],
      maxConcurrent: 1,
    });
    const summary = await orchestrator.run();

    assert.equal(summary.outcome, "finished");
    assert.equal(maxActive, 1);
    assert.ok(board.getCards().every((c) => c.status === "done"));
  });

  it("blocks the card and pauses when it is rejected too many times", async () => {
    const { board, events, orchestrator } = setup({
      units: [builder("u1"), reviewer("r1")],
      cards: [card("c1")],
      steps: [
        file("src/a.ts", "1"),
        verdict("reject", ["bad"]),
        file("src/a.ts", "2"),
        verdict("reject", ["still bad"]),
      ],
      maxReviewRejections: 1,
    });
    const summary = await orchestrator.run();

    assert.equal(summary.outcome, "paused");
    assert.equal(board.getCard("c1")?.status, "blocked");
    const issue = events.find((e) => e.type === "issue_raised");
    assert.ok(issue && issue.type === "issue_raised");
    assert.match(issue.message, /Rejected 2 times.*still bad/);
  });

  it("turns a failed review call into a blocked card and a user alert", async () => {
    const { board, events, orchestrator } = setup({
      units: [builder("u1"), reviewer("r1")],
      cards: [card("c1")],
      steps: [file("src/a.ts"), new LlmError("invalid api key", false)],
    });
    const summary = await orchestrator.run();

    assert.equal(summary.outcome, "paused");
    assert.equal(board.getCard("c1")?.status, "blocked");
    const issue = events.find((e) => e.type === "issue_raised");
    assert.ok(issue && issue.type === "issue_raised");
    assert.equal(issue.kind, "failed");
  });

  it("blocks the card when the reviewer says it cannot review", async () => {
    const { board, events, orchestrator } = setup({
      units: [builder("u1"), reviewer("r1")],
      cards: [card("c1")],
      steps: [
        file("src/a.ts"),
        reply([{ name: "report_blocked", input: { reason: "files unreadable" } }]),
      ],
    });
    await orchestrator.run();

    assert.equal(board.getCard("c1")?.status, "blocked");
    const issue = events.find((e) => e.type === "issue_raised");
    assert.ok(issue && issue.type === "issue_raised");
    assert.match(issue.message, /Review could not be done: files unreadable/);
  });

  it("skips review when no reviewer covers the card's area", async () => {
    const other: Area = { id: "other", name: "other", goal: "x", scope: { read: [], write: ["lib/"] } };
    const otherReviewer: UnitSpec = { ...reviewer("r1"), areaId: "other" };
    const { board, client, orchestrator } = setup({
      areas: [AREA, other],
      units: [builder("u1"), otherReviewer],
      cards: [card("c1")],
      steps: [file("src/a.ts")],
    });
    const summary = await orchestrator.run();

    assert.equal(summary.outcome, "finished");
    assert.equal(board.getCard("c1")?.status, "done");
    assert.equal(client.requests.length, 1);
  });

  it("has an area reviewer review only its own area's cards", async () => {
    const other: Area = { id: "other", name: "other", goal: "x", scope: { read: [], write: ["lib/"] } };
    const mainReviewer: UnitSpec = { ...reviewer("r1"), areaId: "main" };
    const otherBuilder: UnitSpec = {
      ...builder("u2"),
      areaId: "other",
      scope: { read: ["lib/"], write: ["lib/"] },
    };
    const { board, orchestrator } = setup({
      areas: [AREA, other],
      units: [builder("u1"), otherBuilder, mainReviewer],
      cards: [
        card("c1"),
        card("c2", { areaId: "other", scope: { read: [], write: ["lib/"] } }),
      ],
      steps: [file("src/a.ts"), file("lib/b.ts"), verdict("approve")],
    });
    const summary = await orchestrator.run();

    assert.equal(summary.outcome, "finished");
    assert.equal(board.getCard("c2")?.status, "done");
    assert.equal(summary.totalCalls, 3);
  });

  it("lets the user approve a card that is stuck in review", async () => {
    const { board, orchestrator } = setup({
      units: [builder("u1"), reviewer("r1")],
      cards: [card("c1")],
      steps: [file("src/a.ts")],
    });
    // 검토자 유닛이 모두 일하지 못하는 상황을 흉내 내려고 보드에서 직접 검토 상태로 만든다.
    board.assign("u1");
    board.move("c1", "review");
    orchestrator.approveReview("c1");
    assert.equal(board.getCard("c1")?.status, "done");
  });

  it("refuses approve or reject for a card that is not in review", async () => {
    const { orchestrator } = setup({
      units: [builder("u1")],
      cards: [card("c1")],
      steps: [],
    });
    assert.throws(() => orchestrator.approveReview("c1"), /not in review/);
    assert.throws(() => orchestrator.rejectReview("nope"), /not in review/);
  });

  it("retries a card after a conflict and reports it resolved", async () => {
    const waitForFirst: ScriptedStep = async () => {
      while (workspace.read("src/shared.ts").version === 0) {
        await delay(1);
      }
      return file("src/shared.ts", "two");
    };
    const { board, events, client, orchestrator } = setup({
      units: [builder("u1"), builder("u2")],
      cards: [card("c1"), card("c2")],
      steps: [file("src/shared.ts", "one"), waitForFirst, file("src/shared.ts", "two")],
    });
    const summary = await orchestrator.run();

    assert.equal(summary.outcome, "finished");
    assert.equal(workspace.read("src/shared.ts").content, "two");
    assert.equal(workspace.read("src/shared.ts").version, 2);
    assert.equal(board.getCard("c2")?.status, "done");
    assert.deepEqual(
      events.find((e) => e.type === "conflict_detected"),
      { type: "conflict_detected", path: "src/shared.ts", cardIds: ["c2", "c1"] },
    );
    assert.ok(
      events.some((e) => e.type === "conflict_resolved" && e.path === "src/shared.ts"),
    );
    // 다시 시도할 때는 먼저 끝난 카드의 내용을 보고 시작한다.
    assert.ok(client.requests[2].prompt.includes("one"));
  });

  it("blocks the card, alerts the user and pauses when conflicts repeat", async () => {
    const waitForFirst: ScriptedStep = async () => {
      while (workspace.read("src/shared.ts").version === 0) {
        await delay(1);
      }
      return file("src/shared.ts", "two");
    };
    const interfering: ScriptedStep = async () => {
      await workspace.applyChanges({
        cardId: "c9",
        changes: [{ path: "src/shared.ts", baseVersion: 1, content: "other" }],
        allowedWrite: ["src/"],
      });
      return file("src/shared.ts", "two");
    };
    const { board, events, orchestrator } = setup({
      units: [builder("u1"), builder("u2")],
      cards: [card("c1"), card("c2")],
      steps: [file("src/shared.ts", "one"), waitForFirst, interfering],
    });
    const summary = await orchestrator.run();

    assert.equal(summary.outcome, "paused");
    assert.equal(board.getCard("c2")?.status, "blocked");
    assert.ok(board.isPaused());
    const issue = events.find((e) => e.type === "issue_raised");
    assert.ok(issue && issue.type === "issue_raised");
    assert.equal(issue.cardId, "c2");
    assert.equal(issue.kind, "conflict");
  });

  it("blocks and pauses when the model reports it cannot do the card, while read-only units keep working", async () => {
    const readCard = card("r", { unitKind: "reviewer", scope: { read: ["src/"], write: [] } });
    const { board, events, orchestrator } = setup({
      units: [builder("u1"), reviewer("r1")],
      cards: [card("a"), readCard],
      steps: [
        reply([{ name: "report_blocked", input: { reason: "spec is contradictory" } }]),
        reply([{ name: "submit_report", input: { summary: "fine" } }]),
      ],
      maxConcurrent: 1,
    });
    const summary = await orchestrator.run();

    assert.equal(summary.outcome, "paused");
    assert.equal(board.getCard("a")?.status, "blocked");
    assert.equal(board.getCard("r")?.status, "done");
    const issue = events.find((e) => e.type === "issue_raised");
    assert.ok(issue && issue.type === "issue_raised");
    assert.equal(issue.kind, "blocked");
    assert.equal(issue.message, "spec is contradictory");
  });

  it("does not hand new cards to writing units while paused", async () => {
    const { board, client, orchestrator } = setup({
      units: [builder("u1")],
      cards: [card("a"), card("b")],
      steps: [reply([{ name: "report_blocked", input: { reason: "stuck" } }])],
      maxConcurrent: 1,
    });
    const summary = await orchestrator.run();

    assert.equal(summary.outcome, "paused");
    assert.equal(client.requests.length, 1);
    assert.equal(board.getCard("b")?.status, "todo");
  });

  it("turns a failed call into a blocked card and a user alert", async () => {
    const { board, events, orchestrator } = setup({
      units: [builder("u1")],
      cards: [card("c1")],
      steps: [new LlmError("invalid api key", false)],
    });
    const summary = await orchestrator.run();

    assert.equal(summary.outcome, "paused");
    assert.equal(board.getCard("c1")?.status, "blocked");
    const issue = events.find((e) => e.type === "issue_raised");
    assert.ok(issue && issue.type === "issue_raised");
    assert.equal(issue.kind, "failed");
  });

  it("does not leave a card in progress when something unexpected is thrown", async () => {
    const { board, orchestrator } = setup({
      units: [builder("u1")],
      cards: [card("c1")],
      steps: [
        async () => {
          throw new TypeError("bug");
        },
      ],
    });
    const summary = await orchestrator.run();

    assert.equal(summary.outcome, "paused");
    assert.equal(board.getCard("c1")?.status, "blocked");
    assert.equal(board.runningCount(), 0);
  });

  it("resumes after the user retries a blocked card", async () => {
    const { board, events, orchestrator } = setup({
      units: [builder("u1")],
      cards: [card("c1")],
      steps: [
        reply([{ name: "report_blocked", input: { reason: "need info" } }]),
        file("src/a.ts"),
      ],
    });
    await orchestrator.run();
    orchestrator.retryBlocked("c1");
    assert.equal(board.isPaused(), false);
    assert.ok(events.some((e) => e.type === "resumed"));

    const summary = await orchestrator.run();
    assert.equal(summary.outcome, "finished");
    assert.throws(() => orchestrator.retryBlocked("c1"), /not blocked/);
  });

  it("reports stalled when the remaining cards have no unit to run them", async () => {
    const { client, orchestrator } = setup({
      units: [builder("u1")],
      cards: [
        card("a", { unitKind: "integrator" }),
        card("b", { dependsOn: ["a"] }),
      ],
      steps: [],
    });
    const summary = await orchestrator.run();

    assert.equal(summary.outcome, "stalled");
    assert.equal(client.requests.length, 0);
  });

  it("adds up calls and tokens and publishes them as events", async () => {
    const { events, orchestrator } = setup({
      units: [builder("u1")],
      cards: [card("c1"), card("c2")],
      steps: [
        reply([propose([{ path: "src/a.ts", content: "x" }])], 100, 20),
        reply([propose([{ path: "src/b.ts", content: "y" }])], 50, 5),
      ],
    });
    const summary = await orchestrator.run();

    assert.equal(summary.totalCalls, 2);
    assert.deepEqual(summary.usage, { inputTokens: 150, outputTokens: 25 });
    const usageEvents = events.filter((e) => e.type === "usage_updated");
    assert.deepEqual(usageEvents[usageEvents.length - 1], {
      type: "usage_updated",
      totalCalls: 2,
      inputTokens: 150,
      outputTokens: 25,
    });
  });

  it("refuses to run twice at the same time", async () => {
    const { orchestrator } = setup({
      units: [builder("u1")],
      cards: [card("c1")],
      steps: [file("src/a.ts")],
    });
    const first = orchestrator.run();
    await assert.rejects(orchestrator.run(), /already running/);
    await first;
  });

  it("rejects duplicate unit ids", () => {
    const board = new Board();
    board.registerAreas([AREA]);
    assert.throws(
      () =>
        new Orchestrator({
          board,
          workspace,
          client: new ScriptedClient([]),
          units: [builder("u1"), builder("u1")],
        }),
      /Duplicate unit id/,
    );
  });
});
