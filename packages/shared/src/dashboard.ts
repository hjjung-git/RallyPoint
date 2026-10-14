import type { Card } from "./card.js";
import type { DashboardEvent } from "./event.js";
import type { Plan } from "./plan.js";
import type { RunReport } from "./report.js";
import type { UnitStatus } from "./unit.js";

// 대시보드 화면이 서버와 주고받는 형태. 서버는 변화가 있을 때마다 전체 상태(snapshot)를 보내고,
// 화면은 그것을 그대로 그린다. 개별 이벤트는 충돌 표시 같은 순간 효과용으로 함께 보낸다.

export type SessionPhase =
  | "idle" // 시작 전
  | "planning" // Planner가 계획 중
  | "waiting_for_user" // 사용자의 답을 기다리는 중
  | "running" // 카드를 실행 중
  | "ended"; // 끝남(결과는 result)

export type PlanDecision =
  | { action: "approve" }
  | { action: "revise"; feedback: string }
  | { action: "cancel" };

export interface QuestionsPrompt {
  id: string;
  kind: "questions";
  questions: string[];
}

export interface PlanReviewPrompt {
  id: string;
  kind: "plan_review";
  plan: Plan;
}

export interface IssuePrompt {
  id: string;
  kind: "issue";
  cardId: string;
  title: string;
  issueKind: "blocked" | "failed" | "conflict";
  message: string;
}

// 사용자의 답을 기다리는 질문. 한 번에 하나만 열린다.
export type Prompt = QuestionsPrompt | PlanReviewPrompt | IssuePrompt;

export type PromptReply =
  | { promptId: string; kind: "questions"; answers: string[] }
  | { promptId: string; kind: "plan_review"; decision: PlanDecision }
  | { promptId: string; kind: "issue"; decision: "retry" | "stop" };

export interface OpenIssue {
  cardId: string;
  kind: "blocked" | "failed" | "conflict";
  message: string;
}

export interface LogEntry {
  seq: number;
  // ISO 시각
  at: string;
  event: DashboardEvent;
}

export interface SessionResult {
  outcome:
    | "finished"
    | "stalled"
    | "stopped"
    | "cancelled"
    | "planning_failed"
    | "error";
  message: string | null;
  totalCalls: number;
  inputTokens: number;
  outputTokens: number;
  // 반복별 정리. 실행이 시작되지 못했으면 null이다.
  report: RunReport | null;
}

export interface DashboardSnapshot {
  phase: SessionPhase;
  scenarioTitle: string | null;
  // 계획이 나온 뒤부터 채워진다(승인 전 검토용 계획 포함).
  plan: Plan | null;
  // 보드가 준비된 뒤부터 채워진다.
  cards: Card[];
  unitStatuses: Record<string, UnitStatus>;
  paused: boolean;
  pauseReason: string | null;
  usage: { totalCalls: number; inputTokens: number; outputTokens: number };
  prompt: Prompt | null;
  openIssues: OpenIssue[];
  // 지금 검토 중인 카드와 검토하는 유닛
  activeReviews: { cardId: string; unitId: string }[];
  result: SessionResult | null;
  // 최근 이벤트. 오래된 것은 잘려 나간다.
  log: LogEntry[];
}

export type ServerMessage =
  | { type: "snapshot"; snapshot: DashboardSnapshot }
  | { type: "event"; event: DashboardEvent };
