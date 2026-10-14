import type { DashboardSnapshot, PromptReply, ServerMessage } from "@rallypoint/shared";
import { BoardView } from "./board.js";
import { GraphView } from "./graph.js";
import { PromptPanel, renderBanner, renderHeader, renderIssues, renderLog, renderResult } from "./panels.js";

function byId<T extends Element>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing element #${id}`);
  return node as unknown as T;
}

async function sendReply(reply: PromptReply): Promise<string | null> {
  try {
    const response = await fetch("/api/reply", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(reply),
    });
    const body = (await response.json()) as { ok: boolean; error?: string };
    return body.ok ? null : (body.error ?? "답을 보내지 못했습니다.");
  } catch {
    return "서버에 연결할 수 없어 답을 보내지 못했습니다.";
  }
}

const graph = new GraphView(byId<SVGSVGElement>("graph"));
const board = new BoardView(byId<HTMLElement>("board"));
const prompt = new PromptPanel(byId<HTMLElement>("prompt"), sendReply);
const emptyState = byId<HTMLElement>("empty");
const tabs = [byId<HTMLButtonElement>("tab-graph"), byId<HTMLButtonElement>("tab-board")];

let snapshot: DashboardSnapshot | null = null;
let connected = false;
let scheduled = false;

function currentView(): "graph" | "board" {
  return window.location.hash === "#board" ? "board" : "graph";
}

function render(): void {
  scheduled = false;
  if (snapshot === null) return;
  const view = currentView();
  renderHeader({ title: byId("title"), phase: byId("phase"), usage: byId("usage") }, snapshot);
  renderBanner(byId("banner"), snapshot, connected);
  const graphState = graph.update(snapshot, Date.now());
  board.update(snapshot);
  byId<HTMLElement>("graph-wrap").hidden = view !== "graph";
  byId<HTMLElement>("board").hidden = view !== "board";
  emptyState.hidden = !graphState.empty;
  if (graphState.empty) {
    emptyState.textContent =
      snapshot.phase === "planning" ? "Planner가 계획을 만들고 있습니다." : "아직 표시할 계획이 없습니다.";
  }
  tabs.forEach((tab) => {
    const active = tab.dataset.view === view;
    tab.setAttribute("aria-selected", String(active));
  });
  prompt.update(snapshot.prompt);
  renderResult(byId("result"), snapshot);
  renderIssues(byId("issues"), snapshot);
  byId<HTMLElement>("result-panel").hidden = snapshot.result === null && snapshot.openIssues.length === 0;
  renderLog(byId("log"), snapshot);
}

function schedule(): void {
  if (scheduled) return;
  scheduled = true;
  window.requestAnimationFrame(render);
}

const source = new EventSource("/api/stream");
source.onopen = () => {
  connected = true;
  schedule();
};
source.onerror = () => {
  connected = false;
  schedule();
};
source.onmessage = (message: MessageEvent<string>) => {
  const data = JSON.parse(message.data) as ServerMessage;
  if (data.type === "snapshot") {
    snapshot = data.snapshot;
    schedule();
  }
};

window.addEventListener("hashchange", schedule);
tabs.forEach((tab) =>
  tab.addEventListener("click", () => {
    window.location.hash = tab.dataset.view === "board" ? "board" : "graph";
  }),
);
// 충돌 표시가 시간이 지나 사라지도록 가끔 다시 그린다.
window.setInterval(schedule, 1000);
