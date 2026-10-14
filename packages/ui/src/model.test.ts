import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Card, DashboardSnapshot, LogEntry } from "@rallypoint/shared";
import { activeConflicts, pickModel } from "./model.js";

function card(id: string): Card {
  return {
    id, title: id, description: "", unitKind: "builder", areaId: null,
    scope: { read: [], write: [] }, dependsOn: [], doneCriteria: "", status: "todo",
    assignedUnitId: null, iteration: 1,
  };
}

function snapshot(partial: Partial<DashboardSnapshot>): DashboardSnapshot {
  return {
    phase: "idle", scenarioTitle: null, plan: null, cards: [], unitStatuses: {}, paused: false,
    pauseReason: null, usage: { totalCalls: 0, inputTokens: 0, outputTokens: 0 }, prompt: null,
    openIssues: [], activeReviews: [], result: null, log: [], ...partial,
  };
}

const at = (ms: number): string => new Date(ms).toISOString();
const NOW = Date.parse("2026-01-01T00:00:30.000Z");

describe("pickModel", () => {
  it("uses plan cards until the board has cards", () => {
    const plan = { areas: [], sharedPaths: [], units: [], cards: [card("p1")], estimatedCalls: 1 };
    assert.deepEqual(pickModel(snapshot({ plan })).cards.map((c) => c.id), ["p1"]);
    const live = pickModel(snapshot({ plan, cards: [{ ...card("p1"), status: "done" }] }));
    assert.equal(live.cards[0]?.status, "done");
  });

  it("is empty without a plan", () => {
    assert.deepEqual(pickModel(snapshot({})), { areas: [], units: [], cards: [] });
  });
});

describe("activeConflicts", () => {
  const detected = (seq: number, ms: number, path: string): LogEntry => ({
    seq, at: at(ms), event: { type: "conflict_detected", path, cardIds: ["c1", "c2"] },
  });
  const resolved = (seq: number, ms: number, path: string): LogEntry => ({
    seq, at: at(ms), event: { type: "conflict_resolved", path },
  });

  it("keeps recent unresolved conflicts only", () => {
    const log = [detected(1, NOW - 2000, "a.ts"), detected(2, NOW - 60_000, "old.ts")];
    assert.deepEqual(activeConflicts(log, NOW), [{ path: "a.ts", cardIds: ["c1", "c2"] }]);
  });

  it("drops a conflict once it is resolved, but not when it recurs", () => {
    const log = [detected(1, NOW - 5000, "a.ts"), resolved(2, NOW - 4000, "a.ts")];
    assert.deepEqual(activeConflicts(log, NOW), []);
    log.push(detected(3, NOW - 1000, "a.ts"));
    assert.equal(activeConflicts(log, NOW).length, 1);
  });
});
