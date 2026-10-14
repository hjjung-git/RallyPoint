import type { CardStatus } from "./card.js";

// 반복(iteration)마다 끝난 뒤 정리한 보고. 실행 기록에서 코드가 세어서 만든다(모델이 쓴 글이 아니다).
export interface IterationReport {
  iteration: number;
  cards: { id: string; title: string; status: CardStatus }[];
  // 이 반복의 카드가 검토에서 반려된 횟수
  reviewRejections: number;
  // 이 반복의 카드가 얽힌 충돌 횟수
  conflicts: number;
  // 사용자에게 알린 문제(막힘, 호출 실패, 충돌 반복) 횟수
  issues: number;
}

export interface RunReport {
  iterations: IterationReport[];
}

// 화면과 터미널이 같이 쓰는 한 줄 설명
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
