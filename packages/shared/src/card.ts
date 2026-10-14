import type { UnitKind, WorkScope } from "./unit.js";

export const CARD_STATUSES = [
  "todo",
  "in_progress",
  "review",
  "done",
  "blocked",
] as const;

export type CardStatus = (typeof CARD_STATUSES)[number];

export interface Card {
  id: string;
  title: string;
  description: string;
  unitKind: UnitKind;
  // 카드가 속한 영역. null이면 영역에 걸치는 카드(전 영역 유닛이 가져간다).
  areaId: string | null;
  scope: WorkScope;
  dependsOn: string[];
  doneCriteria: string;
  status: CardStatus;
  assignedUnitId: string | null;
  iteration: number;
}
