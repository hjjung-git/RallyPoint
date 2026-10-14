import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { describeIteration } from "@rallypoint/shared";
import type { Card, DashboardEvent } from "@rallypoint/shared";
import { buildRunReport } from "./report.js";

function card(id: string, iteration: number, status: Card["status"]): Card {
  return {
    id, title: `t-${id}`, description: "", unitKind: "builder", areaId: null,
    scope: { read: [], write: [] }, dependsOn: [], doneCriteria: "", status,
    assignedUnitId: null, iteration,
  };
}

describe("buildRunReport", () => {
  const cards = [card("a", 2, "done"), card("b", 1, "done"), card("c", 1, "blocked")];

  it("groups cards by iteration in order", () => {
    const report = buildRunReport(cards, []);
    assert.deepEqual(report.iterations.map((r) => r.iteration), [1, 2]);
    assert.deepEqual(report.iterations[0]?.cards.map((c) => c.id), ["b", "c"]);
  });

  it("counts rejections, issues and conflicts per iteration", () => {
    const events: DashboardEvent[] = [
      { type: "review_result", cardId: "b", verdict: "reject", summary: "", findings: ["x"] },
      { type: "review_result", cardId: "b", verdict: "approve", summary: "", findings: [] },
      { type: "issue_raised", cardId: "c", kind: "blocked", message: "m" },
      { type: "conflict_detected", path: "p", cardIds: ["b", "c"] },
      { type: "conflict_detected", path: "q", cardIds: ["a", "c"] },
      { type: "issue_raised", cardId: "ghost", kind: "failed", message: "m" },
    ];
    const [one, two] = buildRunReport(cards, events).iterations;
    assert.deepEqual([one?.reviewRejections, one?.issues, one?.conflicts], [1, 1, 2]);
    assert.deepEqual([two?.reviewRejections, two?.issues, two?.conflicts], [0, 0, 1]);
  });
});

describe("describeIteration", () => {
  it("summarizes progress and lists open cards", () => {
    const [one] = buildRunReport(
      [card("b", 1, "done"), card("c", 1, "blocked")],
      [{ type: "review_result", cardId: "b", verdict: "reject", summary: "", findings: ["x"] }],
    ).iterations;
    assert.equal(
      describeIteration(one as NonNullable<typeof one>),
      "반복 1: 카드 2개 중 1개 완료 (검토 반려 1회) 미완료: c(blocked)",
    );
  });
});
