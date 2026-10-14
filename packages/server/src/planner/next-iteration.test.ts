import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Plan } from "@rallypoint/shared";
import { LlmError } from "../runner/llm.js";
import { ScriptedClient, reply } from "../runner/scripted-client.js";
import { rawPlan } from "./plan-fixture.js";
import { FINISH_PROJECT, SUBMIT_CARDS, buildNextIterationPrompt, planNextIteration } from "./next-iteration.js";
import type { NextIterationRequest } from "./next-iteration.js";
import { parsePlan } from "./plan-format.js";

function basePlan(): Plan {
  const parsed = parsePlan(rawPlan());
  assert.ok(parsed.ok);
  return parsed.plan;
}

const noSleep = { sleep: async () => {} };

function request(overrides: Partial<NextIterationRequest> = {}): NextIterationRequest {
  const plan = basePlan();
  return {
    goal: "Build a notes app",
    plan,
    cards: plan.cards.map((c) => ({ ...c, status: "done" as const })),
    iteration: 2,
    events: [],
    ...overrides,
  };
}

const newCard = (over: Record<string, unknown> = {}) => ({
  id: "c3", title: "Polish", description: "Polish page", unitKind: "builder", areaId: "web",
  scope: { read: ["src/"], write: ["src/web/"] }, dependsOn: ["c2"], doneCriteria: "polished", iteration: 1, ...over,
});

const submit = (cards: unknown[]) => reply([{ name: SUBMIT_CARDS, input: { cards } }], 30, 10);

describe("planNextIteration", () => {
  it("returns new cards and sets their iteration itself", async () => {
    const client = new ScriptedClient([submit([newCard()])]);
    const result = await planNextIteration(client, request(), noSleep);
    assert.equal(result.status, "cards");
    if (result.status !== "cards") return;
    assert.equal(result.cards[0]?.iteration, 2);
    assert.equal(result.cards[0]?.status, "todo");
    assert.deepEqual(result.usage, { inputTokens: 30, outputTokens: 10 });
  });

  it("accepts a decision that the goal is already met", async () => {
    const client = new ScriptedClient([reply([{ name: FINISH_PROJECT, input: { reason: "all done" } }])]);
    const result = await planNextIteration(client, request(), noSleep);
    assert.deepEqual([result.status, result.status === "done" ? result.reason : ""], ["done", "all done"]);
  });

  it("asks again with the reason when the cards break a rule, then succeeds", async () => {
    const client = new ScriptedClient([
      submit([newCard({ id: "c2" })]), // 이미 있는 id
      submit([newCard({ dependsOn: ["ghost"] })]), // 없는 카드에 의존
      submit([newCard()]),
    ]);
    const result = await planNextIteration(client, request(), noSleep);
    assert.equal(result.status, "cards");
    assert.equal(result.attempts, 3);
    assert.ok(client.requests[1]?.prompt.includes("Duplicate card id: c2"));
    assert.ok(client.requests[2]?.prompt.includes("unknown card: ghost"));
  });

  it("rejects too many or zero cards, and fails after the attempts run out", async () => {
    const many = Array.from({ length: 9 }, (_, i) => newCard({ id: `n${i}` }));
    const client = new ScriptedClient([submit(many), submit([]), submit(many)]);
    const result = await planNextIteration(client, request(), noSleep);
    assert.equal(result.status, "failed");
    assert.ok(result.status === "failed" && result.message.includes("between 1 and 8"));
  });

  it("retries a temporary error but gives up on a permanent one", async () => {
    const retried = await planNextIteration(
      new ScriptedClient([new LlmError("busy", true), submit([newCard()])]),
      request(),
      noSleep,
    );
    assert.equal(retried.status, "cards");
    const permanent = await planNextIteration(new ScriptedClient([new LlmError("bad key", false)]), request(), noSleep);
    assert.equal(permanent.status, "failed");
  });
});

describe("buildNextIterationPrompt", () => {
  it("lists existing cards, review findings and the user's requested changes", () => {
    const prompt = buildNextIterationPrompt(
      request({
        events: [{ type: "review_result", cardId: "c1", verdict: "reject", summary: "bad", findings: ["no export"] }],
        revision: { cards: [], feedback: "add tests" },
      }),
    );
    assert.ok(prompt.includes('c1 "Types" (iteration 1, done)'));
    assert.ok(prompt.includes("Review rejected card c1: bad no export"));
    assert.ok(prompt.includes("The next iteration number is 2"));
    assert.ok(prompt.includes("add tests"));
  });
});
