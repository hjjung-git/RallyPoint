import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Plan } from "@rallypoint/shared";
import { LlmError } from "../runner/llm.js";
import type { ToolCall } from "../runner/llm.js";
import { ScriptedClient, reply } from "../runner/scripted-client.js";
import { parsePlan } from "./plan-format.js";
import { rawPlan } from "./plan-fixture.js";
import { planProject } from "./planner.js";
import type { PlannerOptions } from "./planner.js";
import { validatePlan } from "./plan-validation.js";

function submit(input: unknown): ToolCall {
  return { name: "submit_plan", input };
}

function parsed(raw: unknown): Plan {
  const result = parsePlan(raw);
  assert.ok(result.ok, result.ok ? "" : result.message);
  return result.plan;
}

const noSleep: PlannerOptions = { sleep: async () => {} };

describe("parsePlan", () => {
  it("fills in execution state for cards", () => {
    const plan = parsed(rawPlan());
    assert.equal(plan.cards[0]?.status, "todo");
    assert.equal(plan.cards[0]?.assignedUnitId, null);
  });

  it("rejects a missing or wrongly typed field and says where", () => {
    const missing = rawPlan();
    delete missing.units;
    const a = parsePlan(missing);
    assert.ok(!a.ok && a.message.includes("units"));

    const wrong = rawPlan();
    wrong.cards[1].iteration = 0;
    const b = parsePlan(wrong);
    assert.ok(!b.ok && b.message.includes("cards[1].iteration"));
  });

  it("does not allow planner or scheduler as a unit kind", () => {
    const raw = rawPlan();
    raw.units[0].kind = "planner";
    const result = parsePlan(raw);
    assert.ok(!result.ok && result.message.includes("units[0].kind"));
  });

  it("requires areaId to be present as a string or null", () => {
    const raw = rawPlan();
    delete raw.units[2].areaId;
    assert.ok(!parsePlan(raw).ok);
  });

  it("rejects non-object input", () => {
    assert.ok(!parsePlan("text").ok);
    assert.ok(!parsePlan(null).ok);
  });
});

describe("verify paths", () => {
  it("reads verify and leaves it out when absent or empty", () => {
    const raw = rawPlan();
    raw.cards[0].verify = ["src/shared/types.test.js"];
    raw.cards[1].verify = [];
    const plan = parsed(raw);
    assert.deepEqual(plan.cards[0]?.verify, ["src/shared/types.test.js"]);
    assert.equal(plan.cards[1]?.verify, undefined);
    assert.equal("verify" in (plan.cards[1] ?? {}), false);
  });

  it("rejects a verify that is not a list of strings", () => {
    const raw = rawPlan();
    raw.cards[0].verify = "a.test.js";
    const result = parsePlan(raw);
    assert.ok(!result.ok && result.message.includes("verify"));
  });

  it("accepts a test file that some card can write", () => {
    const raw = rawPlan();
    raw.cards[1].verify = ["src/web/page.test.js"];
    assert.equal(validatePlan(parsed(raw)), null);
  });

  it("rejects verify paths that cannot be run or created", () => {
    for (const bad of ["src/web/page.test.ts", "src/web/", "../x.test.js"]) {
      const raw = rawPlan();
      raw.cards[1].verify = [bad];
      assert.match(validatePlan(parsed(raw)) ?? "", /invalid verify path/, bad);
    }
    const raw = rawPlan();
    raw.cards[1].verify = ["docs/page.test.js"];
    assert.match(validatePlan(parsed(raw)) ?? "", /no card in the plan can write/);
  });
});

describe("validatePlan", () => {
  it("accepts a sound plan", () => {
    assert.equal(validatePlan(parsed(rawPlan())), null);
  });

  it("rejects an area without a builder", () => {
    const raw = rawPlan();
    raw.units = raw.units.filter((u: any) => u.id !== "web-1");
    raw.cards = raw.cards.filter((c: any) => c.areaId !== "web");
    assert.match(validatePlan(parsed(raw)) ?? "", /Area "web" has no builder/);
  });

  it("reports board rule violations, such as a dependency cycle", () => {
    const raw = rawPlan();
    raw.cards[0].dependsOn = ["c2"];
    assert.match(validatePlan(parsed(raw)) ?? "", /cycle/i);
  });

  it("rejects a unit writing outside its area", () => {
    const raw = rawPlan();
    raw.units[0].scope.write = ["src/api/"];
    assert.match(validatePlan(parsed(raw)) ?? "", /outside its area/);
  });

  it("rejects overlapping areas outside the shared paths", () => {
    const raw = rawPlan();
    raw.sharedPaths = [];
    assert.match(validatePlan(parsed(raw)) ?? "", /overlap/);
  });

  it("rejects a card nobody can take", () => {
    const raw = rawPlan();
    raw.cards[0].unitKind = "integrator";
    raw.cards[0].areaId = null;
    assert.match(validatePlan(parsed(raw)) ?? "", /no unit that can take it/);
  });

  it("rejects a writing card that only read-only units can take", () => {
    const raw = rawPlan();
    raw.cards[0].unitKind = "reviewer";
    raw.cards[0].areaId = null;
    assert.match(validatePlan(parsed(raw)) ?? "", /read-only/);
  });

  it("rejects a reviewer that can write, and a read-only unit with a write scope", () => {
    const a = rawPlan();
    a.units[2].permission = "propose";
    assert.match(validatePlan(parsed(a)) ?? "", /reviewer/);

    const b = rawPlan();
    b.units[2].scope.write = ["src/web/"];
    assert.match(validatePlan(parsed(b)) ?? "", /read-only/);
  });

  it("rejects a builder that cannot propose", () => {
    const raw = rawPlan();
    raw.units[0].permission = "read";
    assert.match(validatePlan(parsed(raw)) ?? "", /builder/);
  });

  it("rejects too small an estimate and an empty plan", () => {
    const raw = rawPlan();
    raw.estimatedCalls = 1;
    assert.match(validatePlan(parsed(raw)) ?? "", /estimatedCalls/);

    const empty = rawPlan();
    empty.cards = [];
    assert.match(validatePlan(parsed(empty)) ?? "", /at least one card/);
  });
});

describe("planProject", () => {
  it("tells the model to write in the language of the goal", async () => {
    const client = new ScriptedClient([reply([submit(rawPlan())])]);
    await planProject(client, { goal: "할 일 앱을 만든다" }, noSleep);
    assert.ok(client.requests[0]?.system.includes("same language as the user's goal"));
  });

  it("returns a valid plan and offers both tools on the first call", async () => {
    const client = new ScriptedClient([reply([submit(rawPlan())], 200, 100)]);
    const result = await planProject(client, { goal: "Build a notes app" }, noSleep);

    assert.equal(result.status, "plan");
    if (result.status !== "plan") return;
    assert.equal(result.plan.cards.length, 2);
    assert.deepEqual(result.usage, { inputTokens: 200, outputTokens: 100 });
    assert.deepEqual(client.requests[0]?.tools.map((t) => t.name), ["submit_plan", "ask_user"]);
    assert.ok(client.requests[0]?.prompt.includes("Build a notes app"));
  });

  it("returns questions when the model asks, and the next round cannot ask again", async () => {
    const client = new ScriptedClient([
      reply([{ name: "ask_user", input: { questions: ["Which language?"] } }]),
      reply([submit(rawPlan())]),
    ]);
    const first = await planProject(client, { goal: "Build something" }, noSleep);
    assert.equal(first.status, "questions");
    if (first.status !== "questions") return;
    assert.deepEqual(first.questions, ["Which language?"]);

    const second = await planProject(
      client,
      { goal: "Build something", answers: [{ question: "Which language?", answer: "TypeScript" }] },
      noSleep,
    );
    assert.equal(second.status, "plan");
    assert.deepEqual(client.requests[1]?.tools.map((t) => t.name), ["submit_plan"]);
    assert.ok(client.requests[1]?.prompt.includes("TypeScript"));
  });

  it("rejects ask_user when it is not allowed and asks again", async () => {
    const client = new ScriptedClient([
      reply([{ name: "ask_user", input: { questions: ["More?"] } }]),
      reply([submit(rawPlan())]),
    ]);
    const result = await planProject(
      client,
      { goal: "g", answers: [{ question: "q", answer: "a" }] },
      noSleep,
    );
    assert.equal(result.status, "plan");
    assert.equal(result.attempts, 2);
    assert.ok(client.requests[1]?.prompt.includes("not available now"));
  });

  it("rejects bad question lists", async () => {
    const tooMany = { questions: ["1", "2", "3", "4", "5", "6"] };
    const client = new ScriptedClient([
      reply([{ name: "ask_user", input: tooMany }]),
      reply([{ name: "ask_user", input: { questions: [] } }]),
      reply([{ name: "ask_user", input: { questions: ["ok?"] } }]),
    ]);
    const result = await planProject(client, { goal: "g" }, noSleep);
    assert.equal(result.status, "questions");
    assert.equal(result.attempts, 3);
  });

  it("shows the previous plan and the feedback on revision, without ask_user", async () => {
    const previous = parsed(rawPlan());
    const client = new ScriptedClient([reply([submit(rawPlan())])]);
    const result = await planProject(
      client,
      { goal: "g", revision: { plan: previous, feedback: "Add a settings page" } },
      noSleep,
    );
    assert.equal(result.status, "plan");
    const request = client.requests[0];
    assert.deepEqual(request?.tools.map((t) => t.name), ["submit_plan"]);
    assert.ok(request?.prompt.includes("Add a settings page"));
    assert.ok(request?.prompt.includes('"id": "c1"'));
    assert.ok(!request?.prompt.includes("assignedUnitId"));
  });

  it("retries with the reason when the plan breaks a rule, then succeeds", async () => {
    const broken = rawPlan();
    broken.cards[0].dependsOn = ["c2"];
    const client = new ScriptedClient([reply([submit(broken)]), reply([submit(rawPlan())])]);
    const result = await planProject(client, { goal: "g" }, noSleep);

    assert.equal(result.status, "plan");
    assert.equal(result.attempts, 2);
    assert.ok(client.requests[1]?.prompt.includes("previous answer was rejected"));
    assert.match(client.requests[1]?.prompt ?? "", /cycle/i);
  });

  it("fails with invalid_plan when the plan keeps breaking rules", async () => {
    const broken = rawPlan();
    broken.cards[0].dependsOn = ["c2"];
    const client = new ScriptedClient([1, 2, 3, 4].map(() => reply([submit(broken)])));
    const result = await planProject(client, { goal: "g" }, noSleep);
    assert.equal(result.status, "failed");
    if (result.status !== "failed") return;
    assert.equal(result.failure, "invalid_plan");
    assert.equal(result.attempts, 4);
  });

  it("fails with invalid_output when the shape keeps being wrong", async () => {
    const client = new ScriptedClient([1, 2].map(() => reply([submit({ areas: "no" })])));
    const result = await planProject(client, { goal: "g" }, { ...noSleep, maxAttempts: 2 });
    assert.equal(result.status, "failed");
    if (result.status !== "failed") return;
    assert.equal(result.failure, "invalid_output");
  });

  it("treats no tool call and several tool calls as invalid", async () => {
    const client = new ScriptedClient([
      reply([]),
      reply([submit(rawPlan()), submit(rawPlan())]),
      reply([submit(rawPlan())]),
    ]);
    const result = await planProject(client, { goal: "g" }, noSleep);
    assert.equal(result.status, "plan");
    assert.equal(result.attempts, 3);
  });

  it("retries retryable call errors and gives up on permanent ones", async () => {
    const waits: number[] = [];
    const retrying = new ScriptedClient([new LlmError("busy", true), reply([submit(rawPlan())])]);
    const ok = await planProject(retrying, { goal: "g" }, { sleep: async (ms) => void waits.push(ms) });
    assert.equal(ok.status, "plan");
    assert.deepEqual(waits, [1000]);

    const permanent = new ScriptedClient([new LlmError("invalid api key", false)]);
    const failed = await planProject(permanent, { goal: "g" }, noSleep);
    assert.equal(failed.status, "failed");
    if (failed.status !== "failed") return;
    assert.equal(failed.failure, "llm_error");
    assert.equal(failed.attempts, 1);
  });

  it("fails without retrying when the plan is cut off", async () => {
    const client = new ScriptedClient([
      { toolCalls: [], stopReason: "max_tokens", usage: { inputTokens: 5, outputTokens: 16000 } },
    ]);
    const result = await planProject(client, { goal: "g" }, noSleep);
    assert.equal(result.status, "failed");
    if (result.status !== "failed") return;
    assert.equal(result.failure, "truncated");
    assert.equal(client.requests.length, 1);
  });

  it("adds up usage over attempts", async () => {
    const client = new ScriptedClient([reply([], 10, 1), reply([submit(rawPlan())], 20, 2)]);
    const result = await planProject(client, { goal: "g" }, noSleep);
    assert.equal(result.status, "plan");
    assert.deepEqual(result.usage, { inputTokens: 30, outputTokens: 3 });
  });
});
