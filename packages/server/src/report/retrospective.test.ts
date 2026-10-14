import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { LlmError } from "../runner/llm.js";
import { ScriptedClient, reply } from "../runner/scripted-client.js";
import {
  SUBMIT_RETROSPECTIVE,
  buildRetrospectivePrompt,
  parseRetrospective,
  writeRetrospective,
} from "./retrospective.js";
import type { RetrospectiveInput } from "./retrospective.js";

const input: RetrospectiveInput = {
  goal: "Build a todo CLI",
  outcome: "finished",
  report: {
    iterations: [
      { iteration: 1, cards: [{ id: "c1", title: "Types", status: "done" }], reviewRejections: 1, conflicts: 0, issues: 0 },
    ],
  },
  events: [
    { type: "review_result", cardId: "c1", verdict: "reject", summary: "Missing export", findings: ["no default export"] },
    { type: "review_result", cardId: "c1", verdict: "approve", summary: "ok", findings: [] },
    { type: "conflict_detected", path: "src/a.ts", cardIds: ["c1", "c2"] },
  ],
};

const good = {
  summary: "Went fine.",
  wentWell: ["Reviews caught a bug"],
  problems: ["One conflict"],
  nextSteps: ["Split shared files"],
};

const noWait = async (): Promise<void> => {};

describe("buildRetrospectivePrompt", () => {
  it("lists the goal, iterations and notable events but not approvals", () => {
    const prompt = buildRetrospectivePrompt(input);
    assert.ok(prompt.includes("Build a todo CLI"));
    assert.ok(prompt.includes("반복 1"));
    assert.ok(prompt.includes('c1 "Types" (done)'));
    assert.ok(prompt.includes("Review rejected card c1: Missing export no default export"));
    assert.ok(prompt.includes("Conflict on src/a.ts between cards c1, c2"));
    assert.ok(!prompt.includes("approve"));
  });

  it("caps the number of listed events", () => {
    const events = Array.from({ length: 30 }, (_, i) => ({
      type: "issue_raised" as const, cardId: `c${i}`, kind: "blocked" as const, message: "m",
    }));
    const prompt = buildRetrospectivePrompt({ ...input, events });
    assert.ok(prompt.includes("(10 more not shown)"));
  });
});

describe("parseRetrospective", () => {
  it("accepts a well-formed retrospective and trims it", () => {
    assert.deepEqual(parseRetrospective({ ...good, wentWell: ["  a  ", ""] }), { ...good, wentWell: ["a"] });
  });

  it("rejects missing or mistyped fields", () => {
    assert.equal(parseRetrospective(null), null);
    assert.equal(parseRetrospective({ ...good, summary: " " }), null);
    assert.equal(parseRetrospective({ ...good, problems: "x" }), null);
    assert.equal(parseRetrospective({ ...good, nextSteps: [1] }), null);
  });
});

describe("writeRetrospective", () => {
  it("returns the retrospective with usage", async () => {
    const client = new ScriptedClient([reply([{ name: SUBMIT_RETROSPECTIVE, input: good }], 7, 3)]);
    const result = await writeRetrospective(client, input);
    assert.equal(result.status, "ok");
    assert.deepEqual(result.usage, { inputTokens: 7, outputTokens: 3 });
    assert.equal(result.calls, 1);
  });

  it("retries a temporary error once", async () => {
    const client = new ScriptedClient([
      new LlmError("busy", true),
      reply([{ name: SUBMIT_RETROSPECTIVE, input: good }]),
    ]);
    const result = await writeRetrospective(client, input, { sleep: noWait });
    assert.equal(result.status, "ok");
    assert.equal(result.calls, 2);
  });

  it("fails without throwing on a permanent error or a bad answer", async () => {
    const permanent = await writeRetrospective(new ScriptedClient([new LlmError("bad key", false)]), input, { sleep: noWait });
    assert.equal(permanent.status, "failed");
    const bad = await writeRetrospective(new ScriptedClient([reply([])]), input, { sleep: noWait });
    assert.equal(bad.status, "failed");
    assert.equal(bad.calls, 1);
    assert.ok(bad.status === "failed" && bad.message.includes(SUBMIT_RETROSPECTIVE));
  });

  it("says why a retrospective was rejected", async () => {
    const wrong = reply([{ name: SUBMIT_RETROSPECTIVE, input: { ...good, problems: "x" } }]);
    const result = await writeRetrospective(new ScriptedClient([wrong]), input, { sleep: noWait });
    assert.ok(result.status === "failed" && result.message.includes('"problems"'));
    const cut = { ...reply([]), stopReason: "max_tokens" as const };
    const truncated = await writeRetrospective(new ScriptedClient([cut]), input, { sleep: noWait });
    assert.ok(truncated.status === "failed" && truncated.message.includes("cut off"));
  });
});
