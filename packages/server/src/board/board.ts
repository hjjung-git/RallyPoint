import type {
  Area,
  Card,
  CardStatus,
  DashboardEvent,
  UnitSpec,
  WorkScope,
} from "@rallypoint/shared";
import {
  isCoveredByAny,
  isValidScopeEntry,
  overlapRegion,
} from "./scope.js";

export const DEFAULT_MAX_CONCURRENT = 2;

// 외부에서 move()로 옮길 수 있는 상태 이동.
// todo -> in_progress 는 assign()으로만 가능하다. 규칙 검사를 건너뛰지 못하게 하기 위함이다.
const ALLOWED_MOVES: Record<CardStatus, CardStatus[]> = {
  todo: [],
  in_progress: ["review", "done", "blocked", "todo"],
  review: ["done", "todo"],
  blocked: ["todo"],
  done: [],
};

export interface BoardOptions {
  maxConcurrent?: number;
  onEvent?: (event: DashboardEvent) => void;
}

export class Board {
  private readonly areas = new Map<string, Area>();
  private sharedPaths: string[] = [];
  private readonly cards = new Map<string, Card>();
  private readonly units = new Map<string, UnitSpec>();
  private readonly maxConcurrent: number;
  private readonly onEvent: (event: DashboardEvent) => void;
  private paused = false;

  constructor(options: BoardOptions = {}) {
    const max = options.maxConcurrent ?? DEFAULT_MAX_CONCURRENT;
    if (!Number.isInteger(max) || max < 1) {
      throw new Error("maxConcurrent must be an integer of 1 or more");
    }
    this.maxConcurrent = max;
    this.onEvent = options.onEvent ?? (() => {});
  }

  // 영역과 공유 경로를 등록한다. 계획 승인 뒤 한 번만 호출하며, 유닛과 카드보다 먼저 해야 한다.
  // 영역끼리 쓰기 범위가 겹치는 곳은 공유 경로 안에서만 허용한다.
  registerAreas(areas: Area[], sharedPaths: string[] = []): void {
    if (this.areas.size > 0) {
      throw new Error("Areas are already registered");
    }
    if (areas.length === 0) {
      throw new Error("At least one area is required");
    }

    for (const path of sharedPaths) {
      if (!isValidScopeEntry(path)) {
        throw new Error(`Invalid shared path: ${path}`);
      }
    }

    const seen = new Set<string>();
    for (const area of areas) {
      if (area.id === "" || seen.has(area.id)) {
        throw new Error(`Invalid or duplicate area id: "${area.id}"`);
      }
      seen.add(area.id);
      assertValidScope(area.scope, `area ${area.id}`);
    }

    for (let i = 0; i < areas.length; i += 1) {
      for (let j = i + 1; j < areas.length; j += 1) {
        const first = areas[i] as Area;
        const second = areas[j] as Area;
        for (const x of first.scope.write) {
          for (const y of second.scope.write) {
            const region = overlapRegion(x, y);
            if (region !== null && !isCoveredByAny(region, sharedPaths)) {
              throw new Error(
                `Areas ${first.id} and ${second.id} overlap at ${region} outside the shared paths`,
              );
            }
          }
        }
      }
    }

    for (const area of areas) {
      this.areas.set(area.id, structuredClone(area));
    }
    this.sharedPaths = [...sharedPaths];
  }

  registerUnits(units: UnitSpec[]): void {
    this.assertAreasRegistered();

    const seen = new Set<string>();
    for (const unit of units) {
      if (this.units.has(unit.id) || seen.has(unit.id)) {
        throw new Error(`Duplicate unit id: ${unit.id}`);
      }
      seen.add(unit.id);

      if (unit.kind === "builder" && unit.areaId === null) {
        throw new Error(`Builder ${unit.id} must belong to exactly one area`);
      }
      assertValidScope(unit.scope, `unit ${unit.id}`);
      this.assertWithinArea(unit.scope, unit.areaId, `unit ${unit.id}`);
    }

    for (const unit of units) {
      this.units.set(unit.id, structuredClone(unit));
      this.onEvent({
        type: "unit_status_changed",
        unitId: unit.id,
        status: "idle",
      });
    }
  }

  // 전부 검증한 뒤에 등록한다. 하나라도 문제가 있으면 아무것도 등록하지 않는다.
  registerCards(cards: Card[]): void {
    this.assertAreasRegistered();

    const batchIds = new Set<string>();
    for (const card of cards) {
      if (this.cards.has(card.id) || batchIds.has(card.id)) {
        throw new Error(`Duplicate card id: ${card.id}`);
      }
      batchIds.add(card.id);

      // 담당할 builder는 반드시 영역에 속하므로, 영역 없는 builder 카드는 아무도 가져갈 수 없다.
      if (card.unitKind === "builder" && card.areaId === null) {
        throw new Error(`Card ${card.id} for a builder must have an area`);
      }
      assertValidScope(card.scope, `card ${card.id}`);
      this.assertWithinArea(card.scope, card.areaId, `card ${card.id}`);
    }

    const dependencies = new Map<string, string[]>();
    for (const [id, card] of this.cards) {
      dependencies.set(id, card.dependsOn);
    }
    for (const card of cards) {
      dependencies.set(card.id, card.dependsOn);
    }

    for (const card of cards) {
      for (const dep of card.dependsOn) {
        if (!dependencies.has(dep)) {
          throw new Error(`Card ${card.id} depends on unknown card: ${dep}`);
        }
      }
    }

    const cyclic = findCycle(dependencies);
    if (cyclic) {
      throw new Error(`Dependency cycle detected at card: ${cyclic}`);
    }

    for (const card of cards) {
      const stored = structuredClone(card);
      stored.status = "todo";
      stored.assignedUnitId = null;
      this.cards.set(stored.id, stored);
    }
  }

  // 놀고 있는 유닛이 다음 카드를 요청한다. 줄 수 있는 카드가 없으면 null.
  assign(unitId: string): Card | null {
    const unit = this.units.get(unitId);
    if (!unit) {
      throw new Error(`Unknown unit: ${unitId}`);
    }
    // 일시정지 중에는 읽기만 하는 유닛만 새 카드를 받는다.
    if (this.paused && unit.permission !== "read") {
      return null;
    }
    if (this.runningCount() >= this.maxConcurrent) {
      return null;
    }
    if (this.currentCardOf(unitId)) {
      return null;
    }

    const candidate = [...this.cards.values()]
      .filter(
        (card) =>
          card.status === "todo" &&
          card.unitKind === unit.kind &&
          // 영역에 소속된 유닛은 자기 영역의 카드만 가져간다. 전 영역 유닛(areaId가 null)은 모든 카드를 본다.
          (unit.areaId === null || card.areaId === unit.areaId) &&
          card.dependsOn.every((dep) => this.cards.get(dep)?.status === "done"),
      )
      .sort((a, b) => a.iteration - b.iteration)[0];

    if (!candidate) {
      return null;
    }

    candidate.status = "in_progress";
    candidate.assignedUnitId = unitId;
    this.onEvent({
      type: "card_moved",
      cardId: candidate.id,
      from: "todo",
      to: "in_progress",
    });
    this.onEvent({
      type: "unit_status_changed",
      unitId,
      status: "working",
    });
    return structuredClone(candidate);
  }

  move(cardId: string, to: CardStatus): void {
    const card = this.cards.get(cardId);
    if (!card) {
      throw new Error(`Unknown card: ${cardId}`);
    }
    const from = card.status;
    if (!ALLOWED_MOVES[from].includes(to)) {
      throw new Error(`Invalid move for card ${cardId}: ${from} -> ${to}`);
    }

    const releasedUnitId = from === "in_progress" ? card.assignedUnitId : null;
    card.status = to;
    if (to === "todo" || to === "blocked") {
      card.assignedUnitId = null;
    }
    this.onEvent({ type: "card_moved", cardId, from, to });

    if (releasedUnitId) {
      this.onEvent({
        type: "unit_status_changed",
        unitId: releasedUnitId,
        status: "idle",
      });
    }
  }

  pause(reason: string): void {
    if (this.paused) {
      return;
    }
    this.paused = true;
    this.onEvent({ type: "paused", reason });
  }

  resume(): void {
    if (!this.paused) {
      return;
    }
    this.paused = false;
    this.onEvent({ type: "resumed" });
  }

  isPaused(): boolean {
    return this.paused;
  }

  runningCount(): number {
    let count = 0;
    for (const card of this.cards.values()) {
      if (card.status === "in_progress") {
        count += 1;
      }
    }
    return count;
  }

  isFinished(): boolean {
    return (
      this.cards.size > 0 &&
      [...this.cards.values()].every((card) => card.status === "done")
    );
  }

  getCard(cardId: string): Card | undefined {
    const card = this.cards.get(cardId);
    return card ? structuredClone(card) : undefined;
  }

  getCards(): Card[] {
    return [...this.cards.values()].map((card) => structuredClone(card));
  }

  getAreas(): Area[] {
    return [...this.areas.values()].map((area) => structuredClone(area));
  }

  getSharedPaths(): string[] {
    return [...this.sharedPaths];
  }

  private currentCardOf(unitId: string): Card | undefined {
    for (const card of this.cards.values()) {
      if (card.status === "in_progress" && card.assignedUnitId === unitId) {
        return card;
      }
    }
    return undefined;
  }

  private assertAreasRegistered(): void {
    if (this.areas.size === 0) {
      throw new Error("Register areas before units and cards");
    }
  }

  // 쓰기 범위가 해당 영역의 쓰기 범위 안에 있는지 확인한다.
  // areaId가 null이면(전 영역) 어느 영역의 쓰기 범위 안에든 있으면 된다.
  private assertWithinArea(
    scope: WorkScope,
    areaId: string | null,
    owner: string,
  ): void {
    let allowed: string[];
    if (areaId === null) {
      allowed = [...this.areas.values()].flatMap((area) => area.scope.write);
    } else {
      const area = this.areas.get(areaId);
      if (!area) {
        throw new Error(`${owner} belongs to unknown area: ${areaId}`);
      }
      allowed = area.scope.write;
    }
    for (const entry of scope.write) {
      if (!isCoveredByAny(entry, allowed)) {
        throw new Error(`${owner} writes outside its area: ${entry}`);
      }
    }
  }
}

function assertValidScope(scope: WorkScope, owner: string): void {
  for (const entry of [...scope.read, ...scope.write]) {
    if (!isValidScopeEntry(entry)) {
      throw new Error(`Invalid scope entry for ${owner}: "${entry}"`);
    }
  }
}

// 순환이 있으면 순환에 걸린 카드 id 하나를 돌려주고, 없으면 null.
function findCycle(dependencies: Map<string, string[]>): string | null {
  const VISITING = 1;
  const DONE = 2;
  const state = new Map<string, number>();

  const visit = (id: string): string | null => {
    const current = state.get(id);
    if (current === DONE) {
      return null;
    }
    if (current === VISITING) {
      return id;
    }
    state.set(id, VISITING);
    for (const dep of dependencies.get(id) ?? []) {
      const found = visit(dep);
      if (found) {
        return found;
      }
    }
    state.set(id, DONE);
    return null;
  };

  for (const id of dependencies.keys()) {
    const found = visit(id);
    if (found) {
      return found;
    }
  }
  return null;
}
