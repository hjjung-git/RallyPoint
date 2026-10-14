import type { CardStatus } from "./card.js";
import type { UnitStatus } from "./unit.js";

export type DashboardEvent =
  | { type: "card_moved"; cardId: string; from: CardStatus; to: CardStatus }
  | { type: "unit_status_changed"; unitId: string; status: UnitStatus }
  | { type: "conflict_detected"; path: string; cardIds: string[] }
  | { type: "conflict_resolved"; path: string }
  | { type: "paused"; reason: string }
  | { type: "resumed" }
  // 사용자에게 알려야 하는 문제. 카드가 막혔거나, 호출이 끝내 실패했거나, 충돌이 반복됐다.
  | {
      type: "issue_raised";
      cardId: string;
      kind: "blocked" | "failed" | "conflict";
      message: string;
    }
  // 지금까지 모델 호출 횟수와 토큰 합계
  | {
      type: "usage_updated";
      totalCalls: number;
      inputTokens: number;
      outputTokens: number;
    };
