import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Area, Card, UnitSpec } from "@rallypoint/shared";
import { METRICS, computeLayout } from "./layout.js";
import type { Box } from "./layout.js";

function area(id: string, name = id): Area {
  return { id, name, goal: `${name} goal`, scope: { read: [], write: [`${id}/`] } };
}

function unit(id: string, areaId: string | null, kind: UnitSpec["kind"] = "builder"): UnitSpec {
  return {
    id,
    kind,
    role: "r",
    scope: { read: [], write: [] },
    permission: kind === "reviewer" ? "read" : "propose",
    reportFormat: "s",
    areaId,
  };
}

function card(id: string, areaId: string | null, dependsOn: string[] = []): Card {
  return {
    id,
    title: id,
    description: "",
    unitKind: "builder",
    areaId,
    scope: { read: [], write: [] },
    dependsOn,
    doneCriteria: "",
    status: "todo",
    assignedUnitId: null,
    iteration: 1,
  };
}

function overlaps(a: Box, b: Box): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

describe("computeLayout", () => {
  it("returns an empty layout for an empty plan", () => {
    const layout = computeLayout({ areas: [], units: [], cards: [] });
    assert.equal(layout.height, 0);
    assert.deepEqual(layout.lanes, []);
    assert.ok(layout.width > 0);
  });

  it("gives every area a lane in order, with the area name and goal", () => {
    const layout = computeLayout({
      areas: [area("web", "Web"), area("api", "API")],
      units: [],
      cards: [],
    });
    assert.deepEqual(layout.lanes.map((l) => l.id), ["web", "api"]);
    assert.equal(layout.lanes[0]?.label, "Web");
    assert.equal(layout.lanes[0]?.goal, "Web goal");
    assert.ok((layout.lanes[1]?.box.y ?? 0) > (layout.lanes[0]?.box.y ?? 0));
  });

  it("puts dependent cards in later columns so arrows go left to right", () => {
    const layout = computeLayout({
      areas: [area("a")],
      units: [],
      cards: [card("c1", "a"), card("c2", "a", ["c1"]), card("c3", "a", ["c2", "c1"])],
    });
    assert.deepEqual(layout.levels, { c1: 0, c2: 1, c3: 2 });
    const x = (id: string) => layout.cards[id]?.x ?? -1;
    assert.ok(x("c1") < x("c2") && x("c2") < x("c3"));
  });

  it("aligns levels across lanes when a card depends on another area's card", () => {
    const layout = computeLayout({
      areas: [area("a"), area("b")],
      units: [],
      cards: [card("c1", "a"), card("c2", "b", ["c1"])],
    });
    assert.equal(layout.levels.c2, 1);
    assert.ok((layout.cards.c2?.x ?? 0) > (layout.cards.c1?.x ?? 0) + (layout.cards.c1?.width ?? 0));
  });

  it("stacks cards of the same level and grows the lane", () => {
    const single = computeLayout({ areas: [area("a")], units: [], cards: [card("c1", "a")] });
    const stacked = computeLayout({
      areas: [area("a")],
      units: [],
      cards: [card("c1", "a"), card("c2", "a"), card("c3", "a")],
    });
    assert.equal(stacked.cards.c1?.x, stacked.cards.c3?.x);
    assert.ok((stacked.cards.c3?.y ?? 0) > (stacked.cards.c2?.y ?? 0));
    assert.ok((stacked.lanes[0]?.box.height ?? 0) > (single.lanes[0]?.box.height ?? 0));
  });

  it("puts units in the dock of their lane and grows the lane for many units", () => {
    const layout = computeLayout({
      areas: [area("a")],
      units: [unit("u1", "a"), unit("u2", "a"), unit("u3", "a"), unit("u4", "a")],
      cards: [card("c1", "a")],
    });
    const lane = layout.lanes[0]?.box as Box;
    for (const id of ["u1", "u2", "u3", "u4"]) {
      const p = layout.units[id];
      assert.ok(p && p.y - METRICS.unitRadius >= lane.y && p.y + METRICS.unitRadius <= lane.y + lane.height, id);
      assert.ok(p && p.x < (layout.cards.c1?.x ?? 0));
    }
    assert.ok(lane.height >= 4 * METRICS.unitSlot);
  });

  it("adds a common lane for units and cards without an area", () => {
    const layout = computeLayout({
      areas: [area("a")],
      units: [unit("u1", "a"), unit("r1", null, "reviewer")],
      cards: [card("c1", "a")],
    });
    assert.deepEqual(layout.lanes.map((l) => l.id), ["a", null]);
    assert.equal(layout.lanes[1]?.label, "공통");
    const common = layout.lanes[1]?.box as Box;
    const r1 = layout.units.r1 as { x: number; y: number };
    assert.ok(r1.y > common.y && r1.y < common.y + common.height);
  });

  it("does not add a common lane when everything has an area", () => {
    const layout = computeLayout({ areas: [area("a")], units: [unit("u1", "a")], cards: [card("c1", "a")] });
    assert.equal(layout.lanes.length, 1);
  });

  it("treats an unknown area like no area", () => {
    const layout = computeLayout({ areas: [area("a")], units: [], cards: [card("c1", "ghost")] });
    assert.deepEqual(layout.lanes.map((l) => l.id), ["a", null]);
  });

  it("never overlaps cards, and keeps everything inside the canvas", () => {
    const layout = computeLayout({
      areas: [area("a"), area("b")],
      units: [unit("u1", "a"), unit("u2", "b"), unit("r1", null, "reviewer")],
      cards: [
        card("c1", "a"),
        card("c2", "a"),
        card("c3", "a", ["c1"]),
        card("c4", "b", ["c2"]),
        card("c5", "b", ["c3", "c4"]),
        card("c6", null, ["c5"]),
      ],
    });
    const boxes = Object.values(layout.cards);
    for (let i = 0; i < boxes.length; i += 1) {
      const a = boxes[i] as Box;
      assert.ok(a.x >= 0 && a.y >= 0 && a.x + a.width <= layout.width && a.y + a.height <= layout.height);
      for (let j = i + 1; j < boxes.length; j += 1) {
        assert.ok(!overlaps(a, boxes[j] as Box), `${i} overlaps ${j}`);
      }
    }
    for (let i = 0; i < layout.lanes.length - 1; i += 1) {
      const lane = layout.lanes[i]?.box as Box;
      const next = layout.lanes[i + 1]?.box as Box;
      assert.ok(lane.y + lane.height <= next.y);
    }
  });

  it("keeps each card inside its own lane", () => {
    const layout = computeLayout({
      areas: [area("a"), area("b")],
      units: [],
      cards: [card("c1", "a"), card("c2", "a"), card("c3", "b")],
    });
    const laneA = layout.lanes[0]?.box as Box;
    const laneB = layout.lanes[1]?.box as Box;
    for (const id of ["c1", "c2"]) {
      const b = layout.cards[id] as Box;
      assert.ok(b.y >= laneA.y && b.y + b.height <= laneA.y + laneA.height);
    }
    const c3 = layout.cards.c3 as Box;
    assert.ok(c3.y >= laneB.y && c3.y + c3.height <= laneB.y + laneB.height);
  });

  it("ignores unknown dependencies and survives a cycle", () => {
    const layout = computeLayout({
      areas: [area("a")],
      units: [],
      cards: [card("c1", "a", ["ghost"]), card("c2", "a", ["c3"]), card("c3", "a", ["c2"])],
    });
    assert.equal(layout.levels.c1, 0);
    assert.ok(Number.isFinite(layout.levels.c2) && Number.isFinite(layout.levels.c3));
  });

  it("is deterministic", () => {
    const input = {
      areas: [area("a")],
      units: [unit("u1", "a")],
      cards: [card("c1", "a"), card("c2", "a", ["c1"])],
    };
    assert.deepEqual(computeLayout(input), computeLayout(input));
  });

  it("makes the canvas as wide as the deepest column", () => {
    const shallow = computeLayout({ areas: [area("a")], units: [], cards: [card("c1", "a")] });
    const deep = computeLayout({
      areas: [area("a")],
      units: [],
      cards: [card("c1", "a"), card("c2", "a", ["c1"]), card("c3", "a", ["c2"])],
    });
    assert.equal(deep.width - shallow.width, 2 * (METRICS.cardWidth + METRICS.columnGap));
  });
});
