import type { Card, DashboardSnapshot, UnitKind, UnitSpec } from "@rallypoint/shared";
import { Keyed, setAttrs, setText, svg } from "./dom.js";
import { CARD_STATUS_LABEL, UNIT_STATUS_LABEL, truncate } from "./labels.js";
import { METRICS, computeLayout } from "./layout.js";
import type { Box, GraphLayout } from "./layout.js";
import { activeConflicts, pickModel } from "./model.js";

const KIND_GLYPH: Record<UnitKind, string> = {
  planner: "계",
  scheduler: "일",
  builder: "빌",
  reviewer: "검",
  integrator: "통",
};

interface Tether {
  key: string;
  unitId: string;
  cardId: string;
  mode: "work" | "review";
}

// 유닛, 카드, 선행 관계, 지금 일어나는 작업(유닛에서 카드로 이어지는 점선)을 SVG로 그린다.
// 노드는 id로 재사용하고 속성만 바꾼다. 그래서 점선 흐름 같은 애니메이션이 갱신 때문에 끊기지 않는다.
export class GraphView {
  private readonly lanesLayer = svg("g");
  private readonly edgesLayer = svg("g");
  private readonly tethersLayer = svg("g");
  private readonly conflictsLayer = svg("g");
  private readonly cardsLayer = svg("g");
  private readonly unitsLayer = svg("g");

  private readonly lanes = new Keyed<SVGGElement>(this.lanesLayer);
  private readonly edges = new Keyed<SVGPathElement>(this.edgesLayer);
  private readonly tethers = new Keyed<SVGPathElement>(this.tethersLayer);
  private readonly conflicts = new Keyed<SVGGElement>(this.conflictsLayer);
  private readonly cards = new Keyed<SVGGElement>(this.cardsLayer);
  private readonly units = new Keyed<SVGGElement>(this.unitsLayer);

  constructor(private readonly root: SVGSVGElement) {
    root.replaceChildren(
      svg(
        "defs",
        {},
        arrowMarker("arrow", "#8A95A6"),
        arrowMarker("arrow-done", "#3F8F5B"),
      ),
      this.lanesLayer,
      this.edgesLayer,
      this.tethersLayer,
      this.cardsLayer,
      this.conflictsLayer,
      this.unitsLayer,
    );
  }

  update(snapshot: DashboardSnapshot, nowMs: number): { empty: boolean } {
    const model = pickModel(snapshot);
    if (model.units.length === 0 && model.cards.length === 0) {
      this.root.setAttribute("hidden", "");
      return { empty: true };
    }
    this.root.removeAttribute("hidden");

    const layout = computeLayout(model);
    setAttrs(this.root, {
      width: layout.width,
      height: layout.height,
      viewBox: `0 0 ${layout.width} ${layout.height}`,
    });

    const cardById = new Map(model.cards.map((c) => [c.id, c]));
    const issueCards = new Set(snapshot.openIssues.map((i) => i.cardId));
    const conflicts = activeConflicts(snapshot.log, nowMs);
    const conflictCards = new Set(conflicts.flatMap((c) => c.cardIds));

    this.lanes.sync(
      layout.lanes.map((lane) => ({
        key: lane.id ?? "__common",
        make: () => svg("g", { class: "lane" }, svg("rect"), svg("text"), svg("title")),
        update: (node) => {
          const [rect, text, title] = [...node.children] as [SVGRectElement, SVGTextElement, SVGTitleElement];
          setAttrs(rect, { x: lane.box.x, y: lane.box.y, width: lane.box.width, height: lane.box.height, rx: 10 });
          // 영역 이름은 띠의 왼쪽 위에 가로로 쓴다. 세로로 눕히면 짧은 한글 이름이 읽기 어렵다.
          setAttrs(text, { x: 12, y: lane.box.y + 16, "text-anchor": "start" });
          setText(text, truncate(lane.label, 8));
          setText(title, lane.goal ? `${lane.label}: ${lane.goal}` : lane.label);
        },
      })),
    );

    const edgeItems = model.cards.flatMap((card) =>
      card.dependsOn
        .filter((dep) => layout.cards[dep] && layout.cards[card.id])
        .map((dep) => ({
          key: `${dep}>${card.id}`,
          make: () => svg("path", { class: "edge" }),
          update: (node: SVGPathElement) => {
            const from = layout.cards[dep] as Box;
            const to = layout.cards[card.id] as Box;
            const done = cardById.get(dep)?.status === "done";
            setAttrs(node, {
              d: curve(from.x + from.width, from.y + from.height / 2, to.x, to.y + to.height / 2),
              class: done ? "edge is-done" : "edge",
              "marker-end": done ? "url(#arrow-done)" : "url(#arrow)",
            });
          },
        })),
    );
    this.edges.sync(edgeItems);

    this.tethers.sync(
      tethersFor(model.cards, snapshot, layout).map((tether) => ({
        key: tether.key,
        make: () => svg("path", { class: "tether" }),
        update: (node) => {
          const unit = layout.units[tether.unitId] as { x: number; y: number };
          const box = layout.cards[tether.cardId] as Box;
          setAttrs(node, {
            d: curve(unit.x + METRICS.unitRadius, unit.y, box.x, box.y + box.height / 2),
            class: `tether is-${tether.mode}`,
          });
        },
      })),
    );

    this.cards.sync(
      model.cards.map((card) => ({
        key: card.id,
        make: () => makeCardNode(),
        update: (node) =>
          updateCardNode(node, card, layout.cards[card.id] as Box, {
            issue: issueCards.has(card.id),
            conflict: conflictCards.has(card.id),
          }),
      })),
    );

    this.conflicts.sync(
      conflicts.flatMap((conflict) => {
        const boxes = conflict.cardIds
          .map((id) => layout.cards[id])
          .filter((b): b is Box => b !== undefined);
        return boxes.slice(1).map((box, i) => {
          const first = boxes[0] as Box;
          return {
            key: `${conflict.path}#${i}`,
            make: () => svg("g", { class: "conflict" }, svg("path"), svg("text")),
            update: (node: SVGGElement) => {
              const [line, label] = [...node.children] as [SVGPathElement, SVGTextElement];
              // 카드 오른쪽 가장자리끼리 바깥으로 불룩하게 이어서, 붙어 있는 카드끼리도 눈에 띄게 한다.
              const a = { x: first.x + first.width, y: first.y + first.height / 2 };
              const b = { x: box.x + box.width, y: box.y + box.height / 2 };
              const bulge = 46;
              setAttrs(line, { d: `M ${a.x} ${a.y} C ${a.x + bulge} ${a.y}, ${b.x + bulge} ${b.y}, ${b.x} ${b.y}` });
              setAttrs(label, { x: Math.max(a.x, b.x) + bulge * 0.75 + 4, y: (a.y + b.y) / 2 + 4 });
              setText(label, truncate(conflict.path, 18));
            },
          };
        });
      }),
    );

    this.units.sync(
      model.units.map((unit) => ({
        key: unit.id,
        make: () => makeUnitNode(),
        update: (node) =>
          updateUnitNode(node, unit, layout.units[unit.id] as { x: number; y: number }, snapshot.unitStatuses[unit.id] ?? "idle"),
      })),
    );

    return { empty: false };
  }
}

function arrowMarker(id: string, color: string): SVGMarkerElement {
  return svg(
    "marker",
    { id, viewBox: "0 0 10 10", refX: 9, refY: 5, markerWidth: 7, markerHeight: 7, orient: "auto" },
    svg("path", { d: "M 0 1 L 10 5 L 0 9 z", fill: color }),
  );
}

function curve(x1: number, y1: number, x2: number, y2: number): string {
  const dx = Math.max(24, (x2 - x1) / 2);
  return `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`;
}

function tethersFor(cards: Card[], snapshot: DashboardSnapshot, layout: GraphLayout): Tether[] {
  const out: Tether[] = [];
  const reviewed = new Set(snapshot.activeReviews.map((r) => r.cardId));
  for (const card of cards) {
    if (card.status === "in_progress" && card.assignedUnitId && layout.units[card.assignedUnitId] && layout.cards[card.id]) {
      out.push({ key: `w:${card.assignedUnitId}>${card.id}`, unitId: card.assignedUnitId, cardId: card.id, mode: "work" });
    }
  }
  for (const review of snapshot.activeReviews) {
    if (layout.units[review.unitId] && layout.cards[review.cardId] && reviewed.has(review.cardId)) {
      out.push({ key: `r:${review.unitId}>${review.cardId}`, unitId: review.unitId, cardId: review.cardId, mode: "review" });
    }
  }
  return out;
}

function makeCardNode(): SVGGElement {
  return svg(
    "g",
    { class: "card" },
    svg("rect", { class: "card-body", rx: 7 }),
    svg("rect", { class: "card-stripe", width: 5, rx: 2.5 }),
    svg("text", { class: "card-title" }),
    svg("text", { class: "card-meta" }),
    svg("g", { class: "badge" }, svg("circle", { r: 8 }), svg("text", {}, "!")),
    svg("title"),
  );
}

function updateCardNode(
  node: SVGGElement,
  card: Card,
  box: Box,
  flags: { issue: boolean; conflict: boolean },
): void {
  const [body, stripe, title, meta, badge, tip] = [...node.children] as [
    SVGRectElement, SVGRectElement, SVGTextElement, SVGTextElement, SVGGElement, SVGTitleElement,
  ];
  setAttrs(node, {
    class: `card is-${card.status}${flags.conflict ? " has-conflict" : ""}`,
    transform: `translate(${box.x} ${box.y})`,
  });
  setAttrs(body, { width: box.width, height: box.height });
  setAttrs(stripe, { x: 4, y: 6, height: box.height - 12 });
  setAttrs(title, { x: 18, y: 22 });
  setText(title, truncate(card.title, 14));
  setAttrs(meta, { x: 18, y: 40 });
  setText(meta, card.assignedUnitId ? `${CARD_STATUS_LABEL[card.status]}  ${truncate(card.assignedUnitId, 12)}` : CARD_STATUS_LABEL[card.status]);
  setAttrs(badge, { transform: `translate(${box.width - 4} 4)`, display: flags.issue ? undefined : "none" });
  const text = `${card.title}\n완료 기준: ${card.doneCriteria}`;
  setText(tip, text);
}

function makeUnitNode(): SVGGElement {
  return svg(
    "g",
    { class: "unit" },
    svg("circle", { class: "pulse" }),
    svg("circle", { class: "unit-body" }),
    svg("text", { class: "unit-glyph", "text-anchor": "middle" }),
    svg("text", { class: "unit-name", "text-anchor": "middle" }),
    svg("title"),
  );
}

function updateUnitNode(
  node: SVGGElement,
  unit: UnitSpec,
  point: { x: number; y: number },
  status: keyof typeof UNIT_STATUS_LABEL,
): void {
  const [pulse, body, glyph, name, tip] = [...node.children] as [
    SVGCircleElement, SVGCircleElement, SVGTextElement, SVGTextElement, SVGTitleElement,
  ];
  const r = METRICS.unitRadius;
  setAttrs(node, {
    class: `unit is-${status} kind-${unit.kind}`,
    transform: `translate(${point.x} ${point.y})`,
  });
  setAttrs(pulse, { r: r + 6 });
  setAttrs(body, { r });
  setAttrs(glyph, { y: 5 });
  setText(glyph, KIND_GLYPH[unit.kind]);
  setAttrs(name, { y: r + 16 });
  setText(name, truncate(unit.id, 11));
  setText(tip, `${unit.id}: ${unit.role}\n${UNIT_STATUS_LABEL[status]}`);
}
