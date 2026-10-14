import type { Area, Card, DashboardSnapshot, LogEntry, UnitSpec } from "@rallypoint/shared";

// 화면이 그릴 구조. 보드가 준비되기 전에는 계획(승인 전 계획 포함)의 카드를 모두 "대기"로 보여 준다.
export interface ViewModel {
  areas: Area[];
  units: UnitSpec[];
  cards: Card[];
}

export function pickModel(snapshot: DashboardSnapshot): ViewModel {
  const plan = snapshot.plan;
  const cards = snapshot.cards.length > 0 ? snapshot.cards : (plan?.cards ?? []);
  return { areas: plan?.areas ?? [], units: plan?.units ?? [], cards };
}

export const CONFLICT_VISIBLE_MS = 12_000;

export interface ActiveConflict {
  path: string;
  cardIds: string[];
}

// 최근에 감지됐고 아직 해소되지 않은 충돌. 경로마다 가장 마지막 이벤트가 감지일 때만 남긴다.
export function activeConflicts(
  log: LogEntry[],
  nowMs: number,
  visibleMs: number = CONFLICT_VISIBLE_MS,
): ActiveConflict[] {
  const latest = new Map<string, { detected: boolean; cardIds: string[]; atMs: number }>();
  for (const entry of log) {
    const event = entry.event;
    if (event.type === "conflict_detected") {
      latest.set(event.path, { detected: true, cardIds: event.cardIds, atMs: Date.parse(entry.at) });
    } else if (event.type === "conflict_resolved") {
      latest.set(event.path, { detected: false, cardIds: [], atMs: Date.parse(entry.at) });
    }
  }
  const out: ActiveConflict[] = [];
  for (const [path, state] of latest) {
    if (state.detected && nowMs - state.atMs <= visibleMs && nowMs - state.atMs >= -visibleMs) {
      out.push({ path, cardIds: state.cardIds });
    }
  }
  return out;
}
