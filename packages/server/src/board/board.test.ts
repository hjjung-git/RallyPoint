import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Card, DashboardEvent, UnitSpec } from "@rallypoint/shared";
import { Board } from "./board.js";

function makeCard(id: string, overrides: Partial<Card> = {}): Card {
  return {
    id,
    title: `card ${id}`,
    description: "",
    unitKind: "builder",
    scope: { read: [], write: [] },
    dependsOn: [],
    doneCriteria: "",
    status: "todo",
    assignedUnitId: null,
    iteration: 1,
    ...overrides,
  };
}

function makeUnit(id: string, overrides: Partial<UnitSpec> = {}): UnitSpec {
  return {
    id,
    kind: "builder",
    role: "test unit",
    scope: { read: [], write: [] },
    permission: "propose",
    reportFormat: "",
    ...overrides,
  };
}

function setup(maxConcurrent?: number) {
  const events: DashboardEvent[] = [];
  const board = new Board({
    maxConcurrent,
    onEvent: (event) => events.push(event),
  });
  return { board, events };
}

describe("카드 등록", () => {
  it("중복된 카드 id는 거부한다", () => {
    const { board } = setup();
    assert.throws(() => board.registerCards([makeCard("a"), makeCard("a")]));
  });

  it("없는 카드를 선행으로 지정하면 거부한다", () => {
    const { board } = setup();
    assert.throws(() =>
      board.registerCards([makeCard("a", { dependsOn: ["ghost"] })]),
    );
  });

  it("순환 의존은 거부하고 아무것도 등록하지 않는다", () => {
    const { board } = setup();
    assert.throws(() =>
      board.registerCards([
        makeCard("a", { dependsOn: ["b"] }),
        makeCard("b", { dependsOn: ["a"] }),
      ]),
    );
    assert.equal(board.getCards().length, 0);
  });

  it("자기 자신을 선행으로 지정하면 거부한다", () => {
    const { board } = setup();
    assert.throws(() =>
      board.registerCards([makeCard("a", { dependsOn: ["a"] })]),
    );
  });

  it("이미 등록된 카드를 선행으로 지정할 수 있다", () => {
    const { board } = setup();
    board.registerCards([makeCard("a")]);
    board.registerCards([makeCard("b", { dependsOn: ["a"] })]);
    assert.equal(board.getCards().length, 2);
  });

  it("들어온 상태와 상관없이 todo로 시작한다", () => {
    const { board } = setup();
    board.registerCards([
      makeCard("a", { status: "done", assignedUnitId: "u1" }),
    ]);
    const card = board.getCard("a");
    assert.equal(card?.status, "todo");
    assert.equal(card?.assignedUnitId, null);
  });
});

describe("카드 배정", () => {
  it("선행 카드가 끝나기 전에는 배정하지 않는다", () => {
    const { board } = setup();
    board.registerUnits([makeUnit("u1"), makeUnit("u2")]);
    board.registerCards([makeCard("a"), makeCard("b", { dependsOn: ["a"] })]);

    assert.equal(board.assign("u1")?.id, "a");
    assert.equal(board.assign("u2"), null);

    board.move("a", "done");
    assert.equal(board.assign("u2")?.id, "b");
  });

  it("선행 카드가 검토 중이면 아직 배정하지 않는다", () => {
    const { board } = setup();
    board.registerUnits([makeUnit("u1"), makeUnit("u2")]);
    board.registerCards([makeCard("a"), makeCard("b", { dependsOn: ["a"] })]);

    board.assign("u1");
    board.move("a", "review");
    assert.equal(board.assign("u2"), null);
  });

  it("유닛 종류가 다른 카드는 주지 않는다", () => {
    const { board } = setup();
    board.registerUnits([makeUnit("r1", { kind: "reviewer" })]);
    board.registerCards([makeCard("a", { unitKind: "builder" })]);
    assert.equal(board.assign("r1"), null);
  });

  it("반복 번호가 낮은 카드를 먼저 준다", () => {
    const { board } = setup();
    board.registerUnits([makeUnit("u1")]);
    board.registerCards([
      makeCard("late", { iteration: 2 }),
      makeCard("early", { iteration: 1 }),
    ]);
    assert.equal(board.assign("u1")?.id, "early");
  });

  it("유닛은 한 번에 카드 하나만 가진다", () => {
    const { board } = setup(5);
    board.registerUnits([makeUnit("u1")]);
    board.registerCards([makeCard("a"), makeCard("b")]);
    assert.equal(board.assign("u1")?.id, "a");
    assert.equal(board.assign("u1"), null);
  });

  it("등록되지 않은 유닛은 오류를 낸다", () => {
    const { board } = setup();
    assert.throws(() => board.assign("nobody"));
  });

  it("배정하면 카드에 담당 유닛이 기록된다", () => {
    const { board } = setup();
    board.registerUnits([makeUnit("u1")]);
    board.registerCards([makeCard("a")]);
    board.assign("u1");
    const card = board.getCard("a");
    assert.equal(card?.status, "in_progress");
    assert.equal(card?.assignedUnitId, "u1");
  });
});

describe("동시 실행 한도", () => {
  it("한도에 차면 더 배정하지 않는다", () => {
    const { board } = setup(2);
    board.registerUnits([makeUnit("u1"), makeUnit("u2"), makeUnit("u3")]);
    board.registerCards([makeCard("a"), makeCard("b"), makeCard("c")]);

    assert.ok(board.assign("u1"));
    assert.ok(board.assign("u2"));
    assert.equal(board.assign("u3"), null);
    assert.equal(board.runningCount(), 2);
  });

  it("카드가 끝나면 자리가 난다", () => {
    const { board } = setup(1);
    board.registerUnits([makeUnit("u1"), makeUnit("u2")]);
    board.registerCards([makeCard("a"), makeCard("b")]);

    board.assign("u1");
    assert.equal(board.assign("u2"), null);
    board.move("a", "done");
    assert.equal(board.assign("u2")?.id, "b");
  });

  it("기본 한도는 2다", () => {
    const { board } = setup();
    board.registerUnits([makeUnit("u1"), makeUnit("u2"), makeUnit("u3")]);
    board.registerCards([makeCard("a"), makeCard("b"), makeCard("c")]);
    board.assign("u1");
    board.assign("u2");
    assert.equal(board.assign("u3"), null);
  });

  it("잘못된 한도 값은 거부한다", () => {
    assert.throws(() => new Board({ maxConcurrent: 0 }));
    assert.throws(() => new Board({ maxConcurrent: 1.5 }));
  });
});

describe("일시정지", () => {
  it("일시정지 중에는 쓰기 유닛에게 새 카드를 주지 않는다", () => {
    const { board } = setup();
    board.registerUnits([makeUnit("u1")]);
    board.registerCards([makeCard("a")]);

    board.pause("answer needed");
    assert.equal(board.assign("u1"), null);

    board.resume();
    assert.equal(board.assign("u1")?.id, "a");
  });

  it("일시정지 중에도 읽기 전용 유닛은 카드를 받는다", () => {
    const { board } = setup();
    board.registerUnits([
      makeUnit("r1", { kind: "reviewer", permission: "read" }),
    ]);
    board.registerCards([makeCard("a", { unitKind: "reviewer" })]);

    board.pause("answer needed");
    assert.equal(board.assign("r1")?.id, "a");
  });

  it("이미 진행 중인 카드는 일시정지해도 끝낼 수 있다", () => {
    const { board } = setup();
    board.registerUnits([makeUnit("u1")]);
    board.registerCards([makeCard("a")]);

    board.assign("u1");
    board.pause("answer needed");
    board.move("a", "done");
    assert.equal(board.getCard("a")?.status, "done");
  });

  it("같은 상태로 다시 일시정지나 재개를 해도 이벤트가 중복되지 않는다", () => {
    const { board, events } = setup();
    board.pause("x");
    board.pause("x");
    board.resume();
    board.resume();
    const types = events.map((event) => event.type);
    assert.deepEqual(types, ["paused", "resumed"]);
  });
});

describe("상태 이동", () => {
  it("허용되지 않은 이동은 거부한다", () => {
    const { board } = setup();
    board.registerUnits([makeUnit("u1")]);
    board.registerCards([makeCard("a")]);

    assert.throws(() => board.move("a", "done"));
    assert.throws(() => board.move("a", "in_progress"));

    board.assign("u1");
    board.move("a", "done");
    assert.throws(() => board.move("a", "todo"));
  });

  it("검토에서 반려되면 todo로 돌아가고 담당이 비워진다", () => {
    const { board } = setup();
    board.registerUnits([makeUnit("u1")]);
    board.registerCards([makeCard("a")]);

    board.assign("u1");
    board.move("a", "review");
    board.move("a", "todo");

    const card = board.getCard("a");
    assert.equal(card?.status, "todo");
    assert.equal(card?.assignedUnitId, null);
    assert.equal(board.assign("u1")?.id, "a");
  });

  it("막힌 카드는 담당이 비워지고 todo로만 돌아간다", () => {
    const { board } = setup();
    board.registerUnits([makeUnit("u1")]);
    board.registerCards([makeCard("a")]);

    board.assign("u1");
    board.move("a", "blocked");
    assert.equal(board.getCard("a")?.assignedUnitId, null);
    assert.throws(() => board.move("a", "done"));
    board.move("a", "todo");
    assert.equal(board.getCard("a")?.status, "todo");
  });

  it("없는 카드는 오류를 낸다", () => {
    const { board } = setup();
    assert.throws(() => board.move("ghost", "done"));
  });

  it("모든 카드가 done이면 끝난 것으로 본다", () => {
    const { board } = setup();
    assert.equal(board.isFinished(), false);
    board.registerUnits([makeUnit("u1")]);
    board.registerCards([makeCard("a")]);
    assert.equal(board.isFinished(), false);
    board.assign("u1");
    board.move("a", "done");
    assert.equal(board.isFinished(), true);
  });
});

describe("대시보드 이벤트", () => {
  it("배정과 완료에서 카드 이동과 유닛 상태 이벤트를 순서대로 낸다", () => {
    const { board, events } = setup();
    board.registerUnits([makeUnit("u1")]);
    board.registerCards([makeCard("a")]);
    events.length = 0;

    board.assign("u1");
    board.move("a", "done");

    assert.deepEqual(events, [
      { type: "card_moved", cardId: "a", from: "todo", to: "in_progress" },
      { type: "unit_status_changed", unitId: "u1", status: "working" },
      { type: "card_moved", cardId: "a", from: "in_progress", to: "done" },
      { type: "unit_status_changed", unitId: "u1", status: "idle" },
    ]);
  });
});

describe("복사본 보호", () => {
  it("돌려받은 카드를 바꿔도 보드 내부는 바뀌지 않는다", () => {
    const { board } = setup();
    board.registerCards([makeCard("a")]);
    const copy = board.getCard("a");
    assert.ok(copy);
    copy.status = "done";
    assert.equal(board.getCard("a")?.status, "todo");
  });
});
