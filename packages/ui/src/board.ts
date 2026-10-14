import type { Card, DashboardSnapshot } from "@rallypoint/shared";
import { html } from "./dom.js";
import { CARD_STATUS_LABEL, CARD_STATUS_ORDER } from "./labels.js";
import { COMMON_LANE_LABEL } from "./layout.js";
import { pickModel } from "./model.js";

// 영역(행)과 상태(열)로 나눈 카드 보드. 바뀐 게 있을 때만 다시 그린다.
export class BoardView {
  private signature = "";

  constructor(private readonly root: HTMLElement) {}

  update(snapshot: DashboardSnapshot): void {
    const model = pickModel(snapshot);
    const issues = new Set(snapshot.openIssues.map((i) => i.cardId));
    const signature = JSON.stringify([
      model.areas.map((a) => [a.id, a.name]),
      model.cards.map((c) => [c.id, c.title, c.status, c.assignedUnitId, c.areaId, issues.has(c.id)]),
    ]);
    if (signature === this.signature) return;
    this.signature = signature;

    if (model.cards.length === 0) {
      this.root.replaceChildren();
      return;
    }

    const areaIds = new Set(model.areas.map((a) => a.id));
    const rows: { id: string | null; label: string; cards: Card[] }[] = model.areas.map((area) => ({
      id: area.id,
      label: area.name,
      cards: model.cards.filter((c) => c.areaId === area.id),
    }));
    const common = model.cards.filter((c) => c.areaId === null || !areaIds.has(c.areaId));
    if (common.length > 0) {
      rows.push({ id: null, label: COMMON_LANE_LABEL, cards: common });
    }

    const head = html(
      "div",
      { class: "board-row board-head" },
      html("div", { class: "board-label" }),
      ...CARD_STATUS_ORDER.map((status) =>
        html("div", { class: `board-col-title is-${status}` }, CARD_STATUS_LABEL[status]),
      ),
    );

    this.root.replaceChildren(
      head,
      ...rows.map((row) =>
        html(
          "div",
          { class: "board-row" },
          html("div", { class: "board-label" }, row.label),
          ...CARD_STATUS_ORDER.map((status) =>
            html(
              "div",
              { class: "board-cell" },
              ...row.cards
                .filter((c) => c.status === status)
                .map((card) =>
                  html(
                    "div",
                    { class: `board-card is-${status}`, title: card.doneCriteria },
                    html("div", { class: "board-card-title" }, card.title),
                    html(
                      "div",
                      { class: "board-card-meta" },
                      card.assignedUnitId ?? "담당 없음",
                      issues.has(card.id) ? " (확인 필요)" : "",
                    ),
                  ),
                ),
            ),
          ),
        ),
      ),
    );
  }
}
