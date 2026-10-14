import type { CardStatus, IterationReport, DashboardEvent, SessionPhase, SessionResult, UnitStatus } from "@rallypoint/shared";

export const CARD_STATUS_LABEL: Record<CardStatus, string> = {
  todo: "대기",
  in_progress: "진행 중",
  review: "검토 중",
  done: "완료",
  blocked: "막힘",
};

export const CARD_STATUS_ORDER: CardStatus[] = ["todo", "in_progress", "review", "done", "blocked"];

export const UNIT_STATUS_LABEL: Record<UnitStatus, string> = {
  idle: "대기",
  working: "작업 중",
  paused: "일시정지",
  failed: "실패",
};

export const PHASE_LABEL: Record<SessionPhase, string> = {
  idle: "시작 전",
  planning: "계획 중",
  waiting_for_user: "확인 필요",
  running: "실행 중",
  ended: "끝남",
};

const OUTCOME_LABEL: Record<SessionResult["outcome"], string> = {
  finished: "모든 카드를 끝냈습니다.",
  stalled: "더 진행할 수 없습니다.",
  stopped: "사용자가 멈췄습니다.",
  cancelled: "계획이 승인되지 않아 시작하지 않았습니다.",
  planning_failed: "계획을 만들지 못했습니다.",
  error: "오류로 멈췄습니다.",
};

export function describeResult(result: SessionResult): string {
  const base = OUTCOME_LABEL[result.outcome];
  return result.message ? `${base} ${result.message}` : base;
}

// 로그에 보여 줄 한 줄 설명
export function describeEvent(event: DashboardEvent): string {
  switch (event.type) {
    case "card_moved":
      return `카드 ${event.cardId}: ${CARD_STATUS_LABEL[event.to]} (이전: ${CARD_STATUS_LABEL[event.from]})`;
    case "unit_status_changed":
      return `유닛 ${event.unitId}: ${UNIT_STATUS_LABEL[event.status]}`;
    case "conflict_detected":
      return `${event.path} 충돌 (카드 ${event.cardIds.join(", ")})`;
    case "conflict_resolved":
      return `${event.path} 충돌 해소`;
    case "paused":
      return `일시정지: ${event.reason}`;
    case "resumed":
      return "다시 시작";
    case "issue_raised":
      return `카드 ${event.cardId} 문제: ${event.message}`;
    case "review_started":
      return `유닛 ${event.unitId}가 카드 ${event.cardId} 검토 시작`;
    case "review_result":
      return `카드 ${event.cardId} 검토 ${event.verdict === "approve" ? "승인" : "반려"}: ${event.summary}`;
    case "usage_updated":
      return `모델 호출 ${event.totalCalls}회`;
  }
}

export function truncate(text: string, max: number): string {
  const chars = [...text];
  return chars.length <= max ? text : `${chars.slice(0, Math.max(0, max - 1)).join("")}…`;
}

// ISO 시각에서 시:분:초만 꺼낸다.
export function formatClock(iso: string): string {
  return iso.length >= 19 ? iso.slice(11, 19) : iso;
}

export function formatCount(value: number): string {
  return value.toLocaleString("ko-KR");
}

// 브라우저는 @rallypoint/shared를 불러올 수 없어서(값 import 불가) shared의 describeIteration과 같은 문장을 여기서 만든다.
export function describeIteration(report: IterationReport): string {
  const done = report.cards.filter((c) => c.status === "done").length;
  const parts = [`반복 ${report.iteration}: 카드 ${report.cards.length}개 중 ${done}개 완료`];
  const notes: string[] = [];
  if (report.reviewRejections > 0) notes.push(`검토 반려 ${report.reviewRejections}회`);
  if (report.conflicts > 0) notes.push(`충돌 ${report.conflicts}회`);
  if (report.issues > 0) notes.push(`문제 ${report.issues}회`);
  if (notes.length > 0) parts.push(`(${notes.join(", ")})`);
  const open = report.cards.filter((c) => c.status !== "done").map((c) => `${c.id}(${c.status})`);
  if (open.length > 0) parts.push(`미완료: ${open.join(", ")}`);
  return parts.join(" ");
}
