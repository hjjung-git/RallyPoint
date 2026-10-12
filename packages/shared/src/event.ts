import type { CardStatus } from "./card.js";
import type { UnitStatus } from "./unit.js";

export type DashboardEvent =
  | { type: "card_moved"; cardId: string; from: CardStatus; to: CardStatus }
  | { type: "unit_status_changed"; unitId: string; status: UnitStatus }
  | { type: "conflict_detected"; path: string; cardIds: string[] }
  | { type: "conflict_resolved"; path: string }
  | { type: "paused"; reason: string }
  | { type: "resumed" }
  | { type: "usage_updated"; totalCalls: number };
