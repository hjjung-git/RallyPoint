import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Area, Card, UnitSpec } from "@rallypoint/shared";
import { Board } from "./board.js";
import {
  covers,
  isCoveredByAny,
  isValidScopeEntry,
  overlapRegion,
} from "./scope.js";

function makeArea(id: string, write: string[], read: string[] = []): Area {
  return { id, name: id, goal: `goal of ${id}`, scope: { read, write } };
}

function makeUnit(id: string, overrides: Partial<UnitSpec> = {}): UnitSpec {
  return {
    id,
    kind: "builder",
    role: "test unit",
    scope: { read: [], write: [] },
    permission: "propose",
    reportFormat: "",
    areaId: "api",
    ...overrides,
  };
}

function makeCard(id: string, overrides: Partial<Card> = {}): Card {
  return {
    id,
    title: `card ${id}`,
    description: "",
    unitKind: "builder",
    areaId: "api",
    scope: { read: [], write: [] },
    dependsOn: [],
    doneCriteria: "",
    status: "todo",
    assignedUnitId: null,
    iteration: 1,
    ...overrides,
  };
}

const SHARED = "src/shared/types.ts";

// api와 ui 두 영역이 공유 타입 파일 하나만 함께 쓰는 보드
function setupTwoAreas(maxConcurrent = 5) {
  const board = new Board({ maxConcurrent });
  board.registerAreas(
    [
      makeArea("api", ["src/api/", SHARED]),
      makeArea("ui", ["src/ui/", SHARED]),
    ],
    [SHARED],
  );
  return board;
}

describe("범위 항목 검사", () => {
  it("올바른 항목을 받아들인다", () => {
    for (const entry of ["src/app.ts", "src/", "package.json", "a/b/c.ts"]) {
      assert.equal(isValidScopeEntry(entry), true, entry);
    }
  });

  it("작업 폴더 밖을 가리키거나 형식이 틀린 항목을 거부한다", () => {
    const bad = [
      "",
      "/",
      "/etc/passwd",
      "../secret.txt",
      "src/../secret.txt",
      "src\\app.ts",
      "C:/Users/x",
      "a//b",
      "./a",
      "src/./a",
    ];
    for (const entry of bad) {
      assert.equal(isValidScopeEntry(entry), false, entry);
    }
  });

  it("폴더 접두어는 하위 경로를 포함한다", () => {
    assert.equal(covers("src/", "src/a/b.ts"), true);
    assert.equal(covers("src/", "src/"), true);
    assert.equal(covers("src/a.ts", "src/a.ts"), true);
    assert.equal(covers("src/a.ts", "src/a.tsx"), false);
    assert.equal(covers("src", "src/a.ts"), false);
    assert.equal(covers("src/a/", "src/"), false);
  });

  it("겹치는 부분은 더 구체적인 쪽이다", () => {
    assert.equal(overlapRegion("src/", "src/b/"), "src/b/");
    assert.equal(overlapRegion("src/b/", "src/"), "src/b/");
    assert.equal(overlapRegion("src/a.ts", "src/a.ts"), "src/a.ts");
    assert.equal(overlapRegion("src/a/", "src/b/"), null);
  });

  it("목록 안에 포함되는지 확인한다", () => {
    assert.equal(isCoveredByAny("src/a/x.ts", ["lib/", "src/a/"]), true);
    assert.equal(isCoveredByAny("src/b/x.ts", ["lib/", "src/a/"]), false);
  });
});

describe("영역 등록", () => {
  it("영역이 하나도 없으면 거부한다", () => {
    assert.throws(() => new Board().registerAreas([]));
  });

  it("영역 id가 중복되거나 비어 있으면 거부한다", () => {
    assert.throws(() =>
      new Board().registerAreas([makeArea("a", ["a/"]), makeArea("a", ["b/"])]),
    );
    assert.throws(() => new Board().registerAreas([makeArea("", ["a/"])]));
  });

  it("영역은 한 번만 등록할 수 있다", () => {
    const board = new Board();
    board.registerAreas([makeArea("a", ["a/"])]);
    assert.throws(() => board.registerAreas([makeArea("b", ["b/"])]));
  });

  it("공유 경로 밖에서 쓰기 범위가 겹치면 거부한다", () => {
    assert.throws(() =>
      new Board().registerAreas([
        makeArea("api", ["src/api/", SHARED]),
        makeArea("ui", ["src/ui/", SHARED]),
      ]),
    );
  });

  it("공유 경로로 지정하면 겹침을 허용한다", () => {
    const board = new Board();
    board.registerAreas(
      [
        makeArea("api", ["src/api/", SHARED]),
        makeArea("ui", ["src/ui/", SHARED]),
      ],
      [SHARED],
    );
    assert.equal(board.getAreas().length, 2);
    assert.deepEqual(board.getSharedPaths(), [SHARED]);
  });

  it("폴더가 다른 폴더를 포함하는 겹침도 찾아낸다", () => {
    assert.throws(() =>
      new Board().registerAreas([
        makeArea("all", ["src/"]),
        makeArea("ui", ["src/ui/"]),
      ]),
    );
  });

  it("공유 폴더 접두어는 그 아래 겹침을 모두 허용한다", () => {
    const board = new Board();
    board.registerAreas(
      [
        makeArea("api", ["src/api/", "src/shared/a.ts"]),
        makeArea("ui", ["src/ui/", "src/shared/a.ts"]),
      ],
      ["src/shared/"],
    );
    assert.equal(board.getAreas().length, 2);
  });

  it("잘못된 경로 항목은 거부한다", () => {
    assert.throws(() => new Board().registerAreas([makeArea("a", ["../x"])]));
    assert.throws(() =>
      new Board().registerAreas([makeArea("a", ["a/"], ["C:/x"])]),
    );
    assert.throws(() =>
      new Board().registerAreas([makeArea("a", ["a/"])], ["a\\b"]),
    );
  });

  it("영역 등록 전에는 유닛과 카드를 등록할 수 없다", () => {
    const board = new Board();
    assert.throws(() => board.registerUnits([makeUnit("u1")]));
    assert.throws(() => board.registerCards([makeCard("c1")]));
  });

  it("돌려받은 영역을 바꿔도 보드 내부는 바뀌지 않는다", () => {
    const board = setupTwoAreas();
    const copy = board.getAreas();
    const first = copy[0];
    assert.ok(first);
    first.name = "changed";
    assert.equal(board.getAreas()[0]?.name, "api");
  });
});

describe("유닛 등록", () => {
  it("builder는 영역 없이 등록할 수 없다", () => {
    const board = setupTwoAreas();
    assert.throws(() => board.registerUnits([makeUnit("u1", { areaId: null })]));
  });

  it("없는 영역에 소속시키면 거부한다", () => {
    const board = setupTwoAreas();
    assert.throws(() =>
      board.registerUnits([makeUnit("u1", { areaId: "ghost" })]),
    );
  });

  it("쓰기 범위가 자기 영역 밖이면 거부한다", () => {
    const board = setupTwoAreas();
    assert.throws(() =>
      board.registerUnits([
        makeUnit("u1", { scope: { read: [], write: ["src/ui/button.ts"] } }),
      ]),
    );
  });

  it("쓰기 범위가 자기 영역 안이면 등록된다", () => {
    const board = setupTwoAreas();
    board.registerUnits([
      makeUnit("u1", {
        scope: { read: ["src/"], write: ["src/api/routes.ts", SHARED] },
      }),
    ]);
    assert.ok(board.assign("u1") === null);
  });

  it("전 영역 유닛은 어느 영역의 쓰기 범위 안이면 등록된다", () => {
    const board = setupTwoAreas();
    board.registerUnits([
      makeUnit("i1", {
        kind: "integrator",
        areaId: null,
        scope: { read: ["src/"], write: [SHARED] },
      }),
    ]);
    assert.throws(() =>
      board.registerUnits([
        makeUnit("i2", {
          kind: "integrator",
          areaId: null,
          scope: { read: [], write: ["docs/readme.md"] },
        }),
      ]),
    );
  });

  it("한 영역에 유닛을 여러 개 둘 수 있다", () => {
    const board = setupTwoAreas();
    board.registerUnits([makeUnit("u1"), makeUnit("u2"), makeUnit("u3")]);
  });
});

describe("카드 등록", () => {
  it("builder 카드는 영역이 있어야 한다", () => {
    const board = setupTwoAreas();
    assert.throws(() => board.registerCards([makeCard("c1", { areaId: null })]));
  });

  it("없는 영역의 카드는 거부한다", () => {
    const board = setupTwoAreas();
    assert.throws(() =>
      board.registerCards([makeCard("c1", { areaId: "ghost" })]),
    );
  });

  it("카드의 쓰기 범위가 영역 밖이면 거부한다", () => {
    const board = setupTwoAreas();
    assert.throws(() =>
      board.registerCards([
        makeCard("c1", { scope: { read: [], write: ["src/ui/x.ts"] } }),
      ]),
    );
  });

  it("reviewer 카드는 영역 없이도 등록된다", () => {
    const board = setupTwoAreas();
    board.registerCards([
      makeCard("c1", { unitKind: "reviewer", areaId: null }),
    ]);
    assert.equal(board.getCards().length, 1);
  });
});

describe("영역별 배정", () => {
  it("유닛은 자기 영역의 카드만 가져간다", () => {
    const board = setupTwoAreas();
    board.registerUnits([makeUnit("api-1", { areaId: "api" })]);
    board.registerCards([
      makeCard("ui-card", { areaId: "ui" }),
      makeCard("api-card", { areaId: "api" }),
    ]);
    assert.equal(board.assign("api-1")?.id, "api-card");
  });

  it("자기 영역에 줄 카드가 없으면 다른 영역 카드가 있어도 받지 못한다", () => {
    const board = setupTwoAreas();
    board.registerUnits([makeUnit("api-1", { areaId: "api" })]);
    board.registerCards([makeCard("ui-card", { areaId: "ui" })]);
    assert.equal(board.assign("api-1"), null);
  });

  it("같은 영역의 유닛들이 카드를 나눠 가진다", () => {
    const board = setupTwoAreas();
    board.registerUnits([makeUnit("u1"), makeUnit("u2")]);
    board.registerCards([makeCard("c1"), makeCard("c2")]);
    assert.equal(board.assign("u1")?.id, "c1");
    assert.equal(board.assign("u2")?.id, "c2");
  });

  it("전 영역 유닛은 어느 영역의 카드든 가져간다", () => {
    const board = setupTwoAreas();
    board.registerUnits([
      makeUnit("r1", { kind: "reviewer", permission: "read", areaId: null }),
    ]);
    board.registerCards([
      makeCard("c1", { unitKind: "reviewer", areaId: "ui" }),
      makeCard("c2", { unitKind: "reviewer", areaId: null }),
    ]);
    assert.equal(board.assign("r1")?.id, "c1");
  });

  it("영역이 있는 reviewer는 영역 없는 카드와 다른 영역 카드를 받지 않는다", () => {
    const board = setupTwoAreas();
    board.registerUnits([
      makeUnit("r1", { kind: "reviewer", permission: "read", areaId: "api" }),
    ]);
    board.registerCards([
      makeCard("c1", { unitKind: "reviewer", areaId: "ui" }),
      makeCard("c2", { unitKind: "reviewer", areaId: null }),
    ]);
    assert.equal(board.assign("r1"), null);
  });

  it("영역이 달라도 동시 실행 한도는 함께 적용된다", () => {
    const board = setupTwoAreas(2);
    board.registerUnits([
      makeUnit("a1", { areaId: "api" }),
      makeUnit("a2", { areaId: "api" }),
      makeUnit("u1", { areaId: "ui" }),
    ]);
    board.registerCards([
      makeCard("c1", { areaId: "api" }),
      makeCard("c2", { areaId: "api" }),
      makeCard("c3", { areaId: "ui" }),
    ]);
    assert.ok(board.assign("a1"));
    assert.ok(board.assign("a2"));
    assert.equal(board.assign("u1"), null);
  });
});
