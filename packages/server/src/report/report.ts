import type { Card, DashboardEvent, IterationReport, RunReport } from "@rallypoint/shared";

// 최종 카드 상태와 실행 중 이벤트를 합쳐 반복별 보고를 만든다.
export function buildRunReport(cards: Card[], events: DashboardEvent[]): RunReport {
  const iterationOf = new Map(cards.map((c) => [c.id, c.iteration]));
  const byIteration = new Map<number, IterationReport>();
  for (const card of cards) {
    let report = byIteration.get(card.iteration);
    if (!report) {
      report = { iteration: card.iteration, cards: [], reviewRejections: 0, conflicts: 0, issues: 0 };
      byIteration.set(card.iteration, report);
    }
    report.cards.push({ id: card.id, title: card.title, status: card.status });
  }

  for (const event of events) {
    if (event.type === "review_result" && event.verdict === "reject") {
      const it = iterationOf.get(event.cardId);
      if (it !== undefined) (byIteration.get(it) as IterationReport).reviewRejections += 1;
    } else if (event.type === "issue_raised") {
      const it = iterationOf.get(event.cardId);
      if (it !== undefined) (byIteration.get(it) as IterationReport).issues += 1;
    } else if (event.type === "conflict_detected") {
      // 한 충돌이 같은 반복의 카드 여러 장에 걸쳐도 그 반복에서는 한 번으로 센다.
      const touched = new Set(
        event.cardIds.map((id) => iterationOf.get(id)).filter((n): n is number => n !== undefined),
      );
      for (const it of touched) (byIteration.get(it) as IterationReport).conflicts += 1;
    }
  }

  return { iterations: [...byIteration.values()].sort((a, b) => a.iteration - b.iteration) };
}
