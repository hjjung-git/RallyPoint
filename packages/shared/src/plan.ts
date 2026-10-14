import type { Area } from "./area.js";
import type { Card } from "./card.js";
import type { UnitSpec } from "./unit.js";

// Planner가 내는 계획. 사용자가 승인하면 보드에 그대로 등록된다.
export interface Plan {
  areas: Area[];
  sharedPaths: string[];
  units: UnitSpec[];
  cards: Card[];
  // 모델 호출 횟수의 대략적인 예상. 사용자가 승인 전에 비용 감을 잡는 용도다.
  estimatedCalls: number;
}
