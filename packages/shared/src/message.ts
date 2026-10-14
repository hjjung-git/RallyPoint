import type { Area } from "./area.js";
import type { Card } from "./card.js";
import type { UnitSpec } from "./unit.js";

export interface FileChange {
  path: string;
  baseVersion: number;
  content: string;
}

export type Message =
  // 계획과 승인
  | {
      type: "plan_proposed";
      areas: Area[];
      sharedPaths: string[];
      units: UnitSpec[];
      cards: Card[];
      estimatedCalls: number;
    }
  | { type: "plan_approved" }
  | { type: "plan_revision_requested"; feedback: string }
  // 준비
  | { type: "register_areas"; areas: Area[]; sharedPaths: string[] }
  | { type: "register_units"; units: UnitSpec[] }
  | { type: "register_cards"; cards: Card[] }
  // 작업 진행
  | { type: "work_requested"; unitId: string }
  | { type: "card_assigned"; unitId: string; cardId: string }
  | {
      type: "change_proposed";
      unitId: string;
      cardId: string;
      changes: FileChange[];
    }
  | { type: "change_applied"; cardId: string; paths: string[] }
  | {
      type: "change_rejected";
      cardId: string;
      path: string;
      currentVersion: number;
      reason: string;
    }
  | { type: "card_completed"; unitId: string; cardId: string; report: string }
  | { type: "card_blocked"; unitId: string; cardId: string; reason: string }
  // 검토와 충돌
  | {
      type: "review_result";
      unitId: string;
      cardId: string;
      passed: boolean;
      reason: string;
    }
  | { type: "conflict_detected"; path: string; cardIds: string[] }
  | {
      type: "integration_result";
      path: string;
      resolved: boolean;
      note: string;
    }
  // 변수 발생
  | {
      type: "issue_raised";
      issueId: string;
      description: string;
      options: string[];
    }
  | { type: "issue_answered"; issueId: string; answer: string }
  | { type: "paused" }
  | { type: "resumed" }
  // 반복과 회고
  | {
      type: "iteration_report";
      iteration: number;
      completedCardIds: string[];
      nextPlan: string;
    }
  | { type: "retrospective"; wentWell: string[]; blocked: string[] };

export type MessageType = Message["type"];
