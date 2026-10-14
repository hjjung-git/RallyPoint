import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { Card, UnitSpec } from "@rallypoint/shared";
import { Workspace } from "../workspace/workspace.js";
import { LlmError } from "./llm.js";
import type { LlmClient, LlmRequest, LlmResponse, ToolCall } from "./llm.js";
import { runCard } from "./runner.js";
import type { RunOptions } from "./runner.js";
import { toolsFor } from "./tools.js";

type Step = LlmResponse | LlmError | ((request: LlmRequest) => Promise<LlmResponse | LlmError>);

// 미리 정해 둔 답을 차례로 돌려주는 가짜 클라이언트
class ScriptedClient implements LlmClient {
  readonly requests: LlmRequest[] = [];
  private readonly steps: Step[];

  constructor(steps: Step[]) {
    this.steps = [...steps];
  }

  async complete(request: LlmRequest): Promise<LlmResponse> {
    this.requests.push(request);
    const step = this.steps.shift();
    if (step === undefined) {
      throw new Error("ScriptedClient ran out of steps");
    }
    const result = typeof step === "function" ? await step(request) : step;
    if (result instanceof LlmError) {
      throw result;
    }
    return result;
  }
}

function reply(calls: ToolCall[], inputTokens = 10, outputTokens = 5): LlmResponse {
  return { toolCalls: calls, stopReason: "tool_use", usage: { inputTokens, outputTokens } };
}

function propose(
  files: { path: string; content: string }[],
  summary = "done",
): ToolCall {
  return { name: "propose_changes", input: { summary, changes: files } };
}

function unit(overrides: Partial<UnitSpec> = {}): UnitSpec {
  return {
    id: "u1",
    kind: "builder",
    role: "Builds the app",
    scope: { read: ["src/"], write: ["src/"] },
    permission: "propose",
    reportFormat: "One short paragraph",
    areaId: null,
    ...overrides,
  };
}

function card(overrides: Partial<Card> = {}): Card {
  return {
    id: "c1",
    title: "Write the app",
    description: "Create src/app.ts",
    unitKind: "builder",
    areaId: null,
    scope: { read: ["src/"], write: ["src/"] },
    dependsOn: [],
    doneCriteria: "src/app.ts exists",
    status: "in_progress",
    assignedUnitId: "u1",
    iteration: 1,
    ...overrides,
  };
}

const noSleep: RunOptions = { sleep: async () => {} };

describe("runCard", () => {
  let dir: string;
  let workspace: Workspace;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "rp-runner-"));
    workspace = await Workspace.open(join(dir, "work"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("applies proposed changes and reports versions and usage", async () => {
    const client = new ScriptedClient([
      reply([propose([{ path: "src/app.ts", content: "export {};\n" }])], 100, 20),
    ]);
    const result = await runCard(client, workspace, unit(), card(), noSleep);

    assert.equal(result.status, "completed");
    if (result.status !== "completed") return;
    assert.deepEqual(result.versions, { "src/app.ts": 1 });
    assert.deepEqual(result.usage, { inputTokens: 100, outputTokens: 20 });
    assert.equal(result.attempts, 1);
    assert.equal(await readFile(join(workspace.getRoot(), "src", "app.ts"), "utf8"), "export {};\n");
  });

  it("shows existing files with their versions and uses them as base versions", async () => {
    await workspace.applyChanges({
      cardId: "c0",
      changes: [{ path: "src/app.ts", baseVersion: 0, content: "v1" }],
      allowedWrite: ["src/"],
    });
    const client = new ScriptedClient([
      reply([propose([{ path: "src/app.ts", content: "v2" }])]),
    ]);
    const result = await runCard(client, workspace, unit(), card(), noSleep);

    assert.equal(result.status, "completed");
    if (result.status !== "completed") return;
    assert.deepEqual(result.versions, { "src/app.ts": 2 });
    const prompt = client.requests[0].prompt;
    assert.ok(prompt.includes('<file path="src/app.ts" version="1">'));
    assert.ok(prompt.includes("v1"));
  });

  it("does not show files outside the card scope", async () => {
    await workspace.applyChanges({
      cardId: "c0",
      changes: [{ path: "docs/secret.md", baseVersion: 0, content: "hidden" }],
      allowedWrite: ["docs/"],
    });
    const client = new ScriptedClient([
      reply([propose([{ path: "src/app.ts", content: "x" }])]),
    ]);
    await runCard(client, workspace, unit(), card(), noSleep);
    assert.ok(!client.requests[0].prompt.includes("hidden"));
  });

  it("reports a conflict when another card changed the file during the call", async () => {
    await workspace.applyChanges({
      cardId: "c0",
      changes: [{ path: "src/app.ts", baseVersion: 0, content: "v1" }],
      allowedWrite: ["src/"],
    });
    const client = new ScriptedClient([
      async () => {
        // 모델이 답하는 동안 다른 카드가 같은 파일을 고친 상황
        await workspace.applyChanges({
          cardId: "c9",
          changes: [{ path: "src/app.ts", baseVersion: 1, content: "other" }],
          allowedWrite: ["src/"],
        });
        return reply([propose([{ path: "src/app.ts", content: "mine" }])]);
      },
    ]);
    const result = await runCard(client, workspace, unit(), card(), noSleep);

    assert.equal(result.status, "conflict");
    if (result.status !== "conflict") return;
    assert.equal(result.path, "src/app.ts");
    assert.equal(result.currentVersion, 2);
    assert.equal(result.lastCardId, "c9");
    assert.equal(workspace.read("src/app.ts").content, "other");
  });

  it("treats a new file created meanwhile as a conflict", async () => {
    const client = new ScriptedClient([
      async () => {
        await workspace.applyChanges({
          cardId: "c9",
          changes: [{ path: "src/new.ts", baseVersion: 0, content: "other" }],
          allowedWrite: ["src/"],
        });
        return reply([propose([{ path: "src/new.ts", content: "mine" }])]);
      },
    ]);
    const result = await runCard(client, workspace, unit(), card(), noSleep);
    assert.equal(result.status, "conflict");
  });

  it("rejects writes outside the card's write scope and writes nothing", async () => {
    const client = new ScriptedClient([
      reply([
        propose([
          { path: "src/ok.ts", content: "ok" },
          { path: "docs/bad.md", content: "bad" },
        ]),
      ]),
    ]);
    const result = await runCard(client, workspace, unit(), card(), noSleep);

    assert.equal(result.status, "failed");
    if (result.status !== "failed") return;
    assert.equal(result.failure, "apply_rejected");
    assert.deepEqual(workspace.list(), []);
  });

  it("limits writes to what the unit's own scope also allows", async () => {
    const client = new ScriptedClient([
      reply([propose([{ path: "docs/a.md", content: "a" }])]),
    ]);
    const wideCard = card({ scope: { read: [], write: ["src/", "docs/"] } });
    const result = await runCard(client, workspace, unit(), wideCard, noSleep);

    assert.equal(result.status, "failed");
    if (result.status !== "failed") return;
    assert.equal(result.failure, "apply_rejected");
    assert.deepEqual(workspace.list(), []);
  });

  it("fails on an invalid path without retrying", async () => {
    const client = new ScriptedClient([
      reply([propose([{ path: "../evil.ts", content: "x" }])]),
    ]);
    const result = await runCard(client, workspace, unit(), card(), noSleep);
    assert.equal(result.status, "failed");
    assert.equal(client.requests.length, 1);
  });

  it("gives read-only units only report tools and no write scope", async () => {
    const client = new ScriptedClient([
      reply([{ name: "submit_report", input: { summary: "looks fine" } }]),
    ]);
    const reviewer = unit({ kind: "reviewer", permission: "read" });
    const result = await runCard(client, workspace, reviewer, card(), noSleep);

    assert.equal(result.status, "completed");
    if (result.status !== "completed") return;
    assert.equal(result.summary, "looks fine");
    assert.deepEqual(result.versions, {});
    const names = client.requests[0].tools.map((tool) => tool.name);
    assert.deepEqual(names, ["submit_report", "report_blocked"]);
    assert.ok(client.requests[0].prompt.includes("Files you may write: (none)"));
  });

  it("gives propose units the change tools", async () => {
    assert.deepEqual(
      toolsFor("propose").map((tool) => tool.name),
      ["propose_changes", "report_blocked"],
    );
  });

  it("retries when a read-only unit calls a tool it does not have", async () => {
    const client = new ScriptedClient([
      reply([propose([{ path: "src/a.ts", content: "x" }])]),
      reply([{ name: "submit_report", input: { summary: "ok" } }]),
    ]);
    const reviewer = unit({ kind: "reviewer", permission: "read" });
    const result = await runCard(client, workspace, reviewer, card(), noSleep);

    assert.equal(result.status, "completed");
    assert.equal(result.attempts, 2);
    assert.ok(client.requests[1].prompt.includes("previous answer was rejected"));
    assert.deepEqual(workspace.list(), []);
  });

  it("returns blocked when the model says the card cannot be done", async () => {
    const client = new ScriptedClient([
      reply([{ name: "report_blocked", input: { reason: "spec contradicts itself" } }]),
    ]);
    const result = await runCard(client, workspace, unit(), card(), noSleep);
    assert.equal(result.status, "blocked");
    if (result.status !== "blocked") return;
    assert.equal(result.reason, "spec contradicts itself");
  });

  it("retries retryable call errors with growing waits, then succeeds", async () => {
    const waits: number[] = [];
    const client = new ScriptedClient([
      new LlmError("overloaded", true),
      new LlmError("rate limited", true),
      reply([propose([{ path: "src/a.ts", content: "x" }])]),
    ]);
    const result = await runCard(client, workspace, unit(), card(), {
      sleep: async (ms) => {
        waits.push(ms);
      },
    });
    assert.equal(result.status, "completed");
    assert.equal(result.attempts, 3);
    assert.deepEqual(waits, [1000, 2000]);
  });

  it("gives up after the maximum attempts", async () => {
    const client = new ScriptedClient([
      new LlmError("down", true),
      new LlmError("down", true),
      new LlmError("down", true),
    ]);
    const result = await runCard(client, workspace, unit(), card(), noSleep);
    assert.equal(result.status, "failed");
    if (result.status !== "failed") return;
    assert.equal(result.failure, "llm_error");
    assert.equal(result.attempts, 3);
  });

  it("does not retry a non-retryable call error", async () => {
    const client = new ScriptedClient([new LlmError("invalid api key", false)]);
    const result = await runCard(client, workspace, unit(), card(), noSleep);
    assert.equal(result.status, "failed");
    if (result.status !== "failed") return;
    assert.equal(result.failure, "llm_error");
    assert.equal(result.attempts, 1);
  });

  it("rethrows errors that are not LlmError", async () => {
    const client: LlmClient = {
      complete: async () => {
        throw new TypeError("bug");
      },
    };
    await assert.rejects(runCard(client, workspace, unit(), card(), noSleep), TypeError);
  });

  it("fails without retrying when the answer is cut off", async () => {
    const client = new ScriptedClient([
      { toolCalls: [], stopReason: "max_tokens", usage: { inputTokens: 5, outputTokens: 8192 } },
    ]);
    const result = await runCard(client, workspace, unit(), card(), noSleep);
    assert.equal(result.status, "failed");
    if (result.status !== "failed") return;
    assert.equal(result.failure, "truncated");
    assert.equal(client.requests.length, 1);
    assert.equal(result.usage.outputTokens, 8192);
  });

  it("retries malformed answers and fails with invalid_output at the end", async () => {
    const bad = reply([{ name: "propose_changes", input: { summary: "x", changes: [] } }]);
    const client = new ScriptedClient([bad, bad, bad]);
    const result = await runCard(client, workspace, unit(), card(), noSleep);
    assert.equal(result.status, "failed");
    if (result.status !== "failed") return;
    assert.equal(result.failure, "invalid_output");
    assert.equal(result.attempts, 3);
  });

  it("treats a missing tool call and several tool calls as invalid", async () => {
    const none = reply([]);
    const two = reply([
      { name: "report_blocked", input: { reason: "a" } },
      { name: "report_blocked", input: { reason: "b" } },
    ]);
    const good = reply([propose([{ path: "src/a.ts", content: "x" }])]);
    const client = new ScriptedClient([none, two, good]);
    const result = await runCard(client, workspace, unit(), card(), noSleep);
    assert.equal(result.status, "completed");
    assert.equal(result.attempts, 3);
  });

  it("rejects non-string content and non-object input", async () => {
    const wrongContent = reply([
      { name: "propose_changes", input: { summary: "x", changes: [{ path: "src/a.ts", content: 5 }] } },
    ]);
    const notObject = reply([{ name: "propose_changes", input: "text" }]);
    const good = reply([propose([{ path: "src/a.ts", content: "x" }])]);
    const client = new ScriptedClient([wrongContent, notObject, good]);
    const result = await runCard(client, workspace, unit(), card(), noSleep);
    assert.equal(result.status, "completed");
    assert.equal(result.attempts, 3);
  });

  it("adds up usage over all attempts", async () => {
    const client = new ScriptedClient([
      reply([], 10, 1),
      reply([propose([{ path: "src/a.ts", content: "x" }])], 20, 2),
    ]);
    const result = await runCard(client, workspace, unit(), card(), noSleep);
    assert.equal(result.status, "completed");
    assert.deepEqual(result.usage, { inputTokens: 30, outputTokens: 3 });
  });

  it("refuses to call the model when the files are too large", async () => {
    await workspace.applyChanges({
      cardId: "c0",
      changes: [{ path: "src/big.ts", baseVersion: 0, content: "x".repeat(50) }],
      allowedWrite: ["src/"],
    });
    const client = new ScriptedClient([]);
    const result = await runCard(client, workspace, unit(), card(), {
      ...noSleep,
      maxContextChars: 10,
    });
    assert.equal(result.status, "failed");
    if (result.status !== "failed") return;
    assert.equal(result.failure, "context_too_large");
    assert.equal(client.requests.length, 0);
    assert.equal(result.attempts, 0);
  });
  describe("review mode", () => {
    const reviewerUnit = () => unit({ kind: "reviewer", permission: "read", scope: { read: ["src/"], write: [] } });

    function review(verdict: string, findings: string[] = [], summary = "s"): LlmResponse {
      return reply([{ name: "submit_review", input: { verdict, summary, findings } }]);
    }

    async function seed(): Promise<void> {
      await workspace.applyChanges({
        cardId: "c0",
        changes: [{ path: "src/app.ts", baseVersion: 0, content: "export const x = 1;" }],
        allowedWrite: ["src/"],
      });
    }

    it("returns the verdict and shows the finished files", async () => {
      await seed();
      const client = new ScriptedClient([review("reject", ["no tests"], "missing tests")]);
      const result = await runCard(client, workspace, reviewerUnit(), card(), { ...noSleep, review: true });

      assert.equal(result.status, "reviewed");
      if (result.status !== "reviewed") return;
      assert.equal(result.verdict, "reject");
      assert.equal(result.summary, "missing tests");
      assert.deepEqual(result.findings, ["no tests"]);
      const request = client.requests[0];
      assert.deepEqual(request?.tools.map((t) => t.name), ["submit_review", "report_blocked"]);
      assert.ok(request?.prompt.includes("You are reviewing the finished work"));
      assert.ok(request?.prompt.includes("export const x = 1;"));
      assert.ok(!request?.prompt.includes("Files you may write"));
    });

    it("never changes files in review mode", async () => {
      const client = new ScriptedClient([review("approve")]);
      await runCard(client, workspace, reviewerUnit(), card(), { ...noSleep, review: true });
      assert.deepEqual(workspace.list(), []);
    });

    it("asks again when a rejection has no findings or the verdict is unknown", async () => {
      const client = new ScriptedClient([review("reject", []), review("maybe"), review("approve")]);
      const result = await runCard(client, workspace, reviewerUnit(), card(), { ...noSleep, review: true });

      assert.equal(result.status, "reviewed");
      assert.equal(result.attempts, 3);
      assert.ok(client.requests[1]?.prompt.includes("needs at least one finding"));
    });

    it("does not offer the review tool when the card is worked on", async () => {
      const client = new ScriptedClient([review("approve"), reply([propose([{ path: "src/a.ts", content: "x" }])])]);
      const result = await runCard(client, workspace, unit(), card(), noSleep);
      assert.equal(result.status, "completed");
      assert.ok(client.requests[1]?.prompt.includes("not available"));
    });

    it("refuses to review with a unit that can write", async () => {
      const client = new ScriptedClient([]);
      await assert.rejects(
        runCard(client, workspace, unit(), card(), { ...noSleep, review: true }),
        /cannot review/,
      );
    });

    it("shows reviewer feedback to the builder when it works again", async () => {
      const client = new ScriptedClient([reply([propose([{ path: "src/a.ts", content: "x" }])])]);
      await runCard(client, workspace, unit(), card(), { ...noSleep, feedback: "- add tests" });
      assert.ok(client.requests[0]?.prompt.includes("rejected your previous work"));
      assert.ok(client.requests[0]?.prompt.includes("- add tests"));
    });
  });
});
