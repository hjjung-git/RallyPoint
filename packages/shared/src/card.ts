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
  scope: WorkScope;
  dependsOn: string[];
  doneCriteria: string;
  status: CardStatus;
  assignedUnitId: string | null;
  iteration: number;
}
