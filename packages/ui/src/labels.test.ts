import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { DashboardEvent } from "@rallypoint/shared";
import { describeEvent, describeIteration, describeResult, formatClock, truncate } from "./labels.js";

describe("labels", () => {
  it("describes every kind of event in a sentence", () => {
    const events: DashboardEvent[] = [
      { type: "card_moved", cardId: "c1", from: "todo", to: "in_progress" },
      { type: "unit_status_changed", unitId: "u1", status: "working" },
      { type: "conflict_detected", path: "src/a.ts", cardIds: ["c1", "c2"] },
      { type: "conflict_resolved", path: "src/a.ts" },
      { type: "paused", reason: "stuck" },
      { type: "resumed" },
      { type: "issue_raised", cardId: "c1", kind: "blocked", message: "m" },
      { type: "review_started", cardId: "c1", unitId: "r1" },
      { type: "review_result", cardId: "c1", verdict: "reject", summary: "s", findings: ["f"] },
      { type: "usage_updated", totalCalls: 3, inputTokens: 1, outputTokens: 1 },
    ];
    for (const event of events) {
      assert.ok(describeEvent(event).length > 0, event.type);
    }
    assert.equal(describeEvent(events[0] as DashboardEvent), "카드 c1: 진행 중 (이전: 대기)");
  });

  it("truncates by characters, not bytes", () => {
    assert.equal(truncate("abcdef", 6), "abcdef");
    assert.equal(truncate("abcdefg", 6), "abcde…");
    assert.equal(truncate("할 일 관리 프로그램 만들기", 8), "할 일 관리 …");
    assert.equal(truncate("x", 0), "…");
  });

  it("takes the clock part of an ISO time", () => {
    assert.equal(formatClock("2026-10-14T01:02:03.000Z"), "01:02:03");
    assert.equal(formatClock("bad"), "bad");
  });

  it("adds the message to a result sentence", () => {
    const base = { totalCalls: 1, inputTokens: 1, outputTokens: 1, report: null, retrospective: null, retrospectiveError: null };
    assert.equal(describeResult({ outcome: "finished", message: null, ...base }), "모든 카드를 끝냈습니다.");
    assert.match(describeResult({ outcome: "error", message: "폴더가 비어 있지 않음", ...base }), /폴더가 비어 있지 않음/);
  });
});

describe("describeIteration (UI copy)", () => {
  it("matches the shared description", async () => {
    const shared = await import("@rallypoint/shared");
    const report = {
      iteration: 1,
      cards: [
        { id: "a", title: "a", status: "done" as const },
        { id: "b", title: "b", status: "blocked" as const },
      ],
      reviewRejections: 1,
      conflicts: 2,
      issues: 0,
    };
    assert.equal(describeIteration(report), shared.describeIteration(report));
  });
});
