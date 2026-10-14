import type { Area, Card, UnitSpec } from "@rallypoint/shared";

// 그래프 배치. 화면(DOM)과 무관한 순수 계산이라 Node에서 테스트한다.
// 영역은 가로 띠(레인)이고, 레인 왼쪽에 유닛, 오른쪽에 카드를 둔다.
// 카드는 선행 관계의 깊이(레벨)를 따라 왼쪽에서 오른쪽으로 놓여서 화살표가 항상 오른쪽으로 향한다.

export const METRICS = {
  laneLabelWidth: 36,
  dockWidth: 104,
  cardWidth: 172,
  cardHeight: 52,
  columnGap: 36,
  rowGap: 14,
  lanePadding: 14,
  laneGap: 10,
  unitRadius: 20,
  unitSlot: 64,
  rightPadding: 120,
} as const;

export interface Point {
  x: number;
  y: number;
}

export interface Box extends Point {
  width: number;
  height: number;
}

export interface LaneBox {
  // 영역 id. 영역에 속하지 않는 유닛과 카드를 모은 "공통" 레인은 null이다.
  id: string | null;
  label: string;
  goal: string;
  box: Box;
}

export interface GraphLayout {
  width: number;
  height: number;
  lanes: LaneBox[];
  // 유닛 원의 중심
  units: Record<string, Point>;
  cards: Record<string, Box>;
  // 카드의 선행 깊이(0부터)
  levels: Record<string, number>;
}

export interface LayoutInput {
  areas: Area[];
  units: UnitSpec[];
  cards: Card[];
}

export const COMMON_LANE_LABEL = "공통";

export function computeLayout(input: LayoutInput): GraphLayout {
  const { areas, units, cards } = input;
  const m = METRICS;
  const areaIds = new Set(areas.map((a) => a.id));
  const laneOf = (areaId: string | null): string | null =>
    areaId !== null && areaIds.has(areaId) ? areaId : null;

  const needsCommon =
    units.some((u) => laneOf(u.areaId) === null) || cards.some((c) => laneOf(c.areaId) === null);
  const laneIds: (string | null)[] = [...areas.map((a) => a.id), ...(needsCommon ? [null] : [])];

  const levels = computeLevels(cards);
  const maxLevel = cards.reduce((max, c) => Math.max(max, levels[c.id] ?? 0), 0);

  const lanes: LaneBox[] = [];
  const unitPoints: Record<string, Point> = {};
  const cardBoxes: Record<string, Box> = {};

  const cardLeft = m.laneLabelWidth + m.dockWidth;
  const columnWidth = m.cardWidth + m.columnGap;
  const rowHeight = m.cardHeight + m.rowGap;
  const width = cardLeft + (maxLevel + 1) * columnWidth + m.rightPadding;

  let y = 0;
  for (const laneId of laneIds) {
    const laneCards = cards.filter((c) => laneOf(c.areaId) === laneId);
    const laneUnits = units.filter((u) => laneOf(u.areaId) === laneId);

    // 같은 레벨의 카드는 위에서 아래로 쌓는다.
    const rowsByLevel = new Map<number, number>();
    for (const card of laneCards) {
      const level = levels[card.id] ?? 0;
      const row = rowsByLevel.get(level) ?? 0;
      rowsByLevel.set(level, row + 1);
      cardBoxes[card.id] = {
        x: cardLeft + level * columnWidth,
        y: y + m.lanePadding + row * rowHeight,
        width: m.cardWidth,
        height: m.cardHeight,
      };
    }

    const rows = Math.max(1, ...rowsByLevel.values());
    const contentHeight = Math.max(rows * rowHeight - m.rowGap, laneUnits.length * m.unitSlot);
    const laneHeight = Math.max(contentHeight, m.cardHeight) + 2 * m.lanePadding;

    // 유닛은 레인 왼쪽 독에 세로로 가운데 모아 둔다.
    const unitsTop = y + (laneHeight - laneUnits.length * m.unitSlot) / 2;
    laneUnits.forEach((unit, i) => {
      unitPoints[unit.id] = {
        x: m.laneLabelWidth + m.dockWidth / 2,
        y: unitsTop + i * m.unitSlot + m.unitSlot / 2,
      };
    });

    const area = areas.find((a) => a.id === laneId);
    lanes.push({
      id: laneId,
      label: area ? area.name : COMMON_LANE_LABEL,
      goal: area ? area.goal : "",
      box: { x: 0, y, width, height: laneHeight },
    });
    y += laneHeight + m.laneGap;
  }

  const height = lanes.length === 0 ? 0 : y - m.laneGap;
  return { width, height, lanes, units: unitPoints, cards: cardBoxes, levels };
}

// 카드마다 선행 카드의 가장 깊은 레벨 + 1. 순환이 있어도 멈추지 않도록 방문 중인 카드는 0으로 본다.
function computeLevels(cards: Card[]): Record<string, number> {
  const byId = new Map(cards.map((c) => [c.id, c]));
  const memo = new Map<string, number>();
  const visiting = new Set<string>();

  const level = (id: string): number => {
    const known = memo.get(id);
    if (known !== undefined) return known;
    const card = byId.get(id);
    if (!card || visiting.has(id)) return 0;
    visiting.add(id);
    let result = 0;
    for (const dep of card.dependsOn) {
      if (byId.has(dep)) {
        result = Math.max(result, level(dep) + 1);
      }
    }
    visiting.delete(id);
    memo.set(id, result);
    return result;
  };

  const out: Record<string, number> = {};
  for (const card of cards) {
    out[card.id] = level(card.id);
  }
  return out;
}
