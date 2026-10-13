import type {
  Card,
  CardStatus,
  DashboardEvent,
  UnitSpec,
} from "@rallypoint/shared";

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

  registerUnits(units: UnitSpec[]): void {
    const seen = new Set<string>();
    for (const unit of units) {
      if (this.units.has(unit.id) || seen.has(unit.id)) {
        throw new Error(`Duplicate unit id: ${unit.id}`);
      }
      seen.add(unit.id);
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
    const batchIds = new Set<string>();
    for (const card of cards) {
      if (this.cards.has(card.id) || batchIds.has(card.id)) {
        throw new Error(`Duplicate card id: ${card.id}`);
      }
      batchIds.add(card.id);
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

  private currentCardOf(unitId: string): Card | undefined {
    for (const card of this.cards.values()) {
      if (card.status === "in_progress" && card.assignedUnitId === unitId) {
        return card;
      }
    }
    return undefined;
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
