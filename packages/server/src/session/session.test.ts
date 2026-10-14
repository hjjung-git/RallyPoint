import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { DashboardEvent, Plan } from "@rallypoint/shared";
import { rawPlan } from "../planner/plan-fixture.js";
import { LlmError } from "../runner/llm.js";
import type { ToolCall } from "../runner/llm.js";
import { ScriptedClient, propose, reply } from "../runner/scripted-client.js";
import type { ScriptedStep } from "../runner/scripted-client.js";
import type { Scenario } from "../scenario/scenario.js";
import { runProject } from "./session.js";
import type { Interaction, IssueInfo, PlanDecision, RunProjectOptions } from "./session.js";

const scenario: Scenario = {
  title: "t",
  goal: "Build a small site",
  constraints: "",
  doneCriteria: "",
};

function plan(withReviewer: boolean): Record<string, any> {
  const raw = rawPlan();
  if (!withReviewer) {
    raw.units = raw.units.filter((u: any) => u.kind !== "reviewer");
  }
  return raw;
}

function submit(input: unknown): ToolCall {
  return { name: "submit_plan", input };
}

const writeTypes: ScriptedStep = reply([propose([{ path: "src/shared/types.ts", content: "export type A = 1;\n" }])]);
const writePage: ScriptedStep = reply([propose([{ path: "src/web/page.ts", content: "export {};\n" }])]);

function verdict(value: "approve" | "reject", findings: string[] = []): ScriptedStep {
  return reply([
    { name: "submit_review", input: { verdict: value, summary: value, findings } },
  ]);
}

const polishCard = {
  id: "c3", title: "Polish", description: "Polish the page", unitKind: "builder", areaId: "web",
  scope: { read: ["src/"], write: ["src/web/"] }, dependsOn: ["c2"], doneCriteria: "polished", iteration: 7,
};
const nextCards = (...cards: unknown[]): ScriptedStep => reply([{ name: "submit_cards", input: { cards } }], 40, 20);
const writePolish: ScriptedStep = reply([propose([{ path: "src/web/polish.ts", content: "export {};\n" }])]);
const firstIteration = (): ScriptedStep[] => [
  reply([submit(plan(true))], 100, 50), writeTypes, verdict("approve"), writePage, verdict("approve"),
];

// 질문에 대한 답을 미리 정해 두는 가짜 사용자
class ScriptedUser implements Interaction {
  readonly planReviews: Plan[] = [];
  readonly issues: IssueInfo[] = [];
  readonly asked: string[][] = [];

  constructor(
    private readonly script: {
      answers?: string[];
      plans?: PlanDecision[];
      issues?: ("retry" | "stop")[];
    } = {},
  ) {}

  async answerQuestions(questions: string[]): Promise<string[]> {
    this.asked.push(questions);
    return this.script.answers ?? [];
  }

  async reviewPlan(p: Plan): Promise<PlanDecision> {
    this.planReviews.push(p);
    return this.script.plans?.shift() ?? { action: "approve" };
  }

  async resolveIssue(issue: IssueInfo): Promise<"retry" | "stop"> {
    this.issues.push(issue);
    return this.script.issues?.shift() ?? "retry";
  }
}

describe("runProject", () => {
  let dir: string;
  let workDir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "rp-session-"));
    workDir = join(dir, "work");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  function start(
    steps: ScriptedStep[],
    user: Interaction,
    onEvent?: (event: DashboardEvent) => void,
    extra: Partial<RunProjectOptions> = {},
  ) {
    const client = new ScriptedClient(steps);
    const promise = runProject({
      scenario,
      client,
      workspaceDir: workDir,
      interaction: user,
      onEvent,
      plannerOptions: { sleep: async () => {} },
      runOptions: { sleep: async () => {} },
      ...extra,
    });
    return { client, promise };
  }

  it("goes from scenario to finished files, with reviews and combined usage", async () => {
    const user = new ScriptedUser();
    const { client, promise } = start(
      [reply([submit(plan(true))], 100, 50), writeTypes, verdict("approve"), writePage, verdict("approve")],
      user,
    );
    const result = await promise;

    assert.equal(result.outcome, "finished");
    assert.equal(result.totalCalls, 5);
    assert.deepEqual(result.usage, { inputTokens: 140, outputTokens: 70 });
    assert.equal(result.report?.iterations.length, 1);
    assert.equal(result.report?.iterations[0]?.cards.every((c) => c.status === "done"), true);
    assert.equal(await readFile(join(workDir, "src", "shared", "types.ts"), "utf8"), "export type A = 1;\n");
    assert.equal(await readFile(join(workDir, "src", "web", "page.ts"), "utf8"), "export {};\n");
    assert.ok(client.requests[0]?.prompt.includes("Build a small site"));
  });

  it("adds a model-written retrospective when asked, counting its call", async () => {
    const retro = reply(
      [{ name: "submit_retrospective", input: { summary: "ok", wentWell: ["a"], problems: [], nextSteps: ["b"] } }],
      20,
      10,
    );
    const { client, promise } = start(
      [reply([submit(plan(true))], 100, 50), writeTypes, verdict("approve"), writePage, verdict("approve"), retro],
      new ScriptedUser(),
      undefined,
      { retrospective: true },
    );
    const result = await promise;

    assert.equal(result.outcome, "finished");
    assert.equal(result.retrospective?.summary, "ok");
    assert.equal(result.totalCalls, 6);
    assert.deepEqual(result.usage, { inputTokens: 160, outputTokens: 80 });
    assert.ok(client.requests[5]?.prompt.includes("Build a small site"));
  });

  it("keeps the result when the retrospective fails", async () => {
    const { promise } = start(
      [reply([submit(plan(true))], 100, 50), writeTypes, verdict("approve"), writePage, verdict("approve"), reply([])],
      new ScriptedUser(),
      undefined,
      { retrospective: true },
    );
    const result = await promise;

    assert.equal(result.outcome, "finished");
    assert.equal(result.retrospective, null);
    assert.equal(result.report?.iterations.length, 1);
  });

  it("does not ask for a retrospective by default", async () => {
    const { client, promise } = start(
      [reply([submit(plan(true))], 100, 50), writeTypes, verdict("approve"), writePage, verdict("approve")],
      new ScriptedUser(),
    );
    const result = await promise;
    assert.equal(result.retrospective, null);
    assert.equal(client.requests.length, 5);
  });

  it("plans and runs a second iteration when the user approves the new cards", async () => {
    const user = new ScriptedUser();
    const { client, promise } = start(
      [...firstIteration(), nextCards(polishCard), writePolish, verdict("approve")],
      user,
      undefined,
      { maxIterations: 2 },
    );
    const result = await promise;

    assert.equal(result.outcome, "finished");
    assert.equal(await readFile(join(workDir, "src", "web", "polish.ts"), "utf8"), "export {};\n");
    assert.equal(user.planReviews.length, 2);
    assert.equal(user.planReviews[1]?.cards.length, 3);
    assert.equal(result.totalCalls, 8);
    assert.deepEqual(result.report?.iterations.map((r) => r.iteration), [1, 2]);
    assert.ok(client.requests[5]?.prompt.includes("The next iteration number is 2"));
    assert.equal(result.plan?.cards.length, 3);
  });

  it("stops after the first iteration when the planner says the goal is met", async () => {
    const user = new ScriptedUser();
    const { promise } = start(
      [...firstIteration(), reply([{ name: "finish_project", input: { reason: "met" } }])],
      user,
      undefined,
      { maxIterations: 3 },
    );
    const result = await promise;
    assert.equal(result.outcome, "finished");
    assert.equal(result.message, null);
    assert.equal(user.planReviews.length, 1);
    assert.equal(result.totalCalls, 6);
  });

  it("does not run new cards when the user declines them, and replans on a revision request", async () => {
    const declined = new ScriptedUser({ plans: [{ action: "approve" }, { action: "cancel" }] });
    const first = await start([...firstIteration(), nextCards(polishCard)], declined, undefined, { maxIterations: 2 }).promise;
    assert.equal(first.outcome, "finished");
    assert.ok(first.message?.includes("not approved"));
    assert.equal(first.report?.iterations.length, 1);

    const revised = new ScriptedUser({
      plans: [{ action: "approve" }, { action: "revise", feedback: "rename it" }, { action: "approve" }],
    });
    const { client, promise } = start(
      [...firstIteration(), nextCards(polishCard), nextCards({ ...polishCard, title: "Renamed" }), writePolish, verdict("approve")],
      revised,
      undefined,
      { maxIterations: 2, workspaceDir: join(dir, "work2") },
    );
    const second = await promise;
    assert.equal(second.outcome, "finished");
    assert.ok(client.requests[6]?.prompt.includes("rename it"));
    assert.equal(second.plan?.cards.find((c) => c.id === "c3")?.title, "Renamed");
  });

  it("keeps the finished result when the next iteration cannot be planned", async () => {
    const { promise } = start(
      [...firstIteration(), new LlmError("bad key", false)],
      new ScriptedUser(),
      undefined,
      { maxIterations: 2 },
    );
    const result = await promise;
    assert.equal(result.outcome, "finished");
    assert.ok(result.message?.includes("not planned"));
  });

  it("rejects a maxIterations that is not a positive integer", async () => {
    const { promise } = start([reply([submit(plan(true))])], new ScriptedUser(), undefined, { maxIterations: 0 });
    await assert.rejects(promise, /maxIterations/);
  });

  it("finishes without reviews when the plan has no reviewer", async () => {
    const user = new ScriptedUser();
    const { promise } = start([reply([submit(plan(false))]), writeTypes, writePage], user);
    const result = await promise;
    assert.equal(result.outcome, "finished");
    assert.equal(result.totalCalls, 3);
  });

  it("asks the user's answers into the plan request", async () => {
    const user = new ScriptedUser({ answers: ["TypeScript"] });
    const { client, promise } = start(
      [
        reply([{ name: "ask_user", input: { questions: ["Language?", "Style?"] } }]),
        reply([submit(plan(false))]),
        writeTypes,
        writePage,
      ],
      user,
    );
    const result = await promise;

    assert.equal(result.outcome, "finished");
    assert.deepEqual(user.asked, [["Language?", "Style?"]]);
    const prompt = client.requests[1]?.prompt ?? "";
    assert.ok(prompt.includes("A: TypeScript"));
    assert.ok(prompt.includes("A: (no answer)"));
  });

  it("revises the plan until the user approves it", async () => {
    const user = new ScriptedUser({
      plans: [{ action: "revise", feedback: "Add dark mode" }, { action: "approve" }],
    });
    const { client, promise } = start(
      [reply([submit(plan(false))]), reply([submit(plan(false))]), writeTypes, writePage],
      user,
    );
    const result = await promise;

    assert.equal(result.outcome, "finished");
    assert.equal(user.planReviews.length, 2);
    assert.ok(client.requests[1]?.prompt.includes("Add dark mode"));
  });

  it("keeps earlier answers when the plan is revised", async () => {
    const user = new ScriptedUser({
      answers: ["TypeScript"],
      plans: [{ action: "revise", feedback: "Smaller" }, { action: "approve" }],
    });
    const { client, promise } = start(
      [
        reply([{ name: "ask_user", input: { questions: ["Language?"] } }]),
        reply([submit(plan(false))]),
        reply([submit(plan(false))]),
        writeTypes,
        writePage,
      ],
      user,
    );
    await promise;
    assert.ok(client.requests[2]?.prompt.includes("A: TypeScript"));
    assert.ok(client.requests[2]?.prompt.includes("Smaller"));
  });

  it("stops at cancel without running any card or writing files", async () => {
    const user = new ScriptedUser({ plans: [{ action: "cancel" }] });
    const { client, promise } = start([reply([submit(plan(false))])], user);
    const result = await promise;

    assert.equal(result.outcome, "cancelled");
    assert.ok(result.plan);
    assert.equal(client.requests.length, 1);
  });

  it("reports planning_failed with the reason", async () => {
    const { promise } = start([new LlmError("invalid api key", false)], new ScriptedUser());
    const result = await promise;
    assert.equal(result.outcome, "planning_failed");
    assert.equal(result.plan, null);
    assert.match(result.message ?? "", /invalid api key/);
  });

  it("refuses a non-empty work folder before calling the model", async () => {
    await writeFile(join(dir, "occupied.txt"), "x", "utf8");
    const client = new ScriptedClient([]);
    await assert.rejects(
      runProject({
        scenario,
        client,
        workspaceDir: dir,
        interaction: new ScriptedUser(),
      }),
      /must be empty/,
    );
    assert.equal(client.requests.length, 0);
  });

  it("asks the user about a blocked card and retries it", async () => {
    const user = new ScriptedUser({ issues: ["retry"] });
    const { promise } = start(
      [
        reply([submit(plan(false))]),
        reply([{ name: "report_blocked", input: { reason: "unclear types" } }]),
        writeTypes,
        writePage,
      ],
      user,
    );
    const result = await promise;

    assert.equal(result.outcome, "finished");
    assert.equal(user.issues.length, 1);
    assert.equal(user.issues[0]?.cardId, "c1");
    assert.equal(user.issues[0]?.kind, "blocked");
    assert.equal(user.issues[0]?.message, "unclear types");
  });

  it("ends as stopped when the user stops at a problem", async () => {
    const user = new ScriptedUser({ issues: ["stop"] });
    const { promise } = start(
      [reply([submit(plan(false))]), reply([{ name: "report_blocked", input: { reason: "stuck" } }])],
      user,
    );
    const result = await promise;
    assert.equal(result.outcome, "stopped");
    assert.match(result.message ?? "", /c1/);
  });

  it("runs a card again after the reviewer rejects it", async () => {
    const user = new ScriptedUser();
    const { client, promise } = start(
      [
        reply([submit(plan(true))]),
        writeTypes,
        verdict("reject", ["use a union type"]),
        reply([propose([{ path: "src/shared/types.ts", content: "export type A = 2;\n" }])]),
        verdict("approve"),
        writePage,
        verdict("approve"),
      ],
      user,
    );
    const result = await promise;

    assert.equal(result.outcome, "finished");
    assert.equal(await readFile(join(workDir, "src", "shared", "types.ts"), "utf8"), "export type A = 2;\n");
    assert.ok(client.requests[3]?.prompt.includes("- use a union type"));
  });

  it("tells the observer about each stage in order", async () => {
    const calls: string[] = [];
    const user = new ScriptedUser({
      plans: [{ action: "revise", feedback: "again" }, { action: "approve" }],
    });
    const client = new ScriptedClient([
      reply([submit(plan(false))]),
      reply([submit(plan(false))]),
      writeTypes,
      writePage,
    ]);
    const result = await runProject({
      scenario,
      client,
      workspaceDir: workDir,
      interaction: user,
      plannerOptions: { sleep: async () => {} },
      runOptions: { sleep: async () => {} },
      observer: {
        onPhase: (phase) => calls.push(`phase:${phase}`),
        onPlan: () => calls.push("plan"),
        onBoardReady: () => calls.push("board"),
        onEnd: (r) => calls.push(`end:${r.outcome}`),
        onFail: () => calls.push("fail"),
      },
    });

    assert.equal(result.outcome, "finished");
    assert.deepEqual(calls, [
      "phase:planning",
      "plan",
      "phase:planning",
      "plan",
      "phase:running",
      "board",
      "end:finished",
    ]);
  });

  it("passes board events to the caller", async () => {
    const events: DashboardEvent[] = [];
    const { promise } = start(
      [reply([submit(plan(false))]), writeTypes, writePage],
      new ScriptedUser(),
      (event) => events.push(event),
    );
    await promise;
    assert.ok(events.some((e) => e.type === "card_moved" && e.to === "done"));
    assert.ok(events.some((e) => e.type === "usage_updated"));
  });
});
