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
  // 검토자 유닛이 카드 검토를 시작했다.
  | { type: "review_started"; cardId: string; unitId: string }
  // 검토자 유닛의 판정
  | {
      type: "review_result";
      cardId: string;
      verdict: "approve" | "reject";
      summary: string;
      findings: string[];
    }
  // 자동 테스트(회귀 게이트) 결과. 카드 게이트는 cardId가 있고, 반복이 끝난 뒤의 전체 테스트는 cardId가 null이다.
  | {
      type: "verification_result";
      scope: "card" | "iteration";
      cardId: string | null;
      status: "passed" | "failed" | "skipped";
      summary: string;
      // 실패했을 때 테스트 출력의 끝부분(길면 잘려 있다)
      details?: string;
    }
  // 지금까지 모델 호출 횟수와 토큰 합계
  | {
      type: "usage_updated";
      totalCalls: number;
      inputTokens: number;
      outputTokens: number;
    };
