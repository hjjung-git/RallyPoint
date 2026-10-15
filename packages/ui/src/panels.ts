import type { DashboardSnapshot, Plan, Prompt, PromptReply } from "@rallypoint/shared";
import { html, setText } from "./dom.js";
import { PHASE_LABEL, describeEvent, describeIteration, describeResult, formatClock, formatCount, truncate } from "./labels.js";

// 사용자 답을 서버로 보내는 함수. 실패하면 화면에 보여 줄 문장을 돌려주고, 성공하면 null이다.
export type SendReply = (reply: PromptReply) => Promise<string | null>;

export function renderHeader(
  elements: { title: HTMLElement; phase: HTMLElement; usage: HTMLElement },
  snapshot: DashboardSnapshot,
): void {
  setText(elements.title, snapshot.scenarioTitle ?? "RallyPoint");
  setText(elements.phase, PHASE_LABEL[snapshot.phase]);
  elements.phase.className = `phase is-${snapshot.phase}`;
  const u = snapshot.usage;
  setText(
    elements.usage,
    `호출 ${formatCount(u.totalCalls)}회, 입력 ${formatCount(u.inputTokens)}, 출력 ${formatCount(u.outputTokens)} 토큰`,
  );
}

export function renderBanner(banner: HTMLElement, snapshot: DashboardSnapshot, connected: boolean): void {
  let text = "";
  let kind = "";
  if (!connected) {
    text = "서버와 연결이 끊겼습니다. 다시 연결하는 중입니다.";
    kind = "is-offline";
  } else if (snapshot.paused) {
    text = `일시정지: ${truncate(snapshot.pauseReason ?? "문제가 있어 멈췄습니다.", 160)}`;
    kind = "is-paused";
  }
  banner.hidden = text === "";
  banner.className = `banner ${kind}`;
  setText(banner, text);
}

export function renderResult(root: HTMLElement, snapshot: DashboardSnapshot): void {
  root.hidden = snapshot.result === null;
  if (snapshot.result) {
    const lines = (snapshot.result.report?.iterations ?? []).map((r) => html("p", { class: "iteration" }, describeIteration(r)));
    const retro = snapshot.result.retrospective;
    const section = (title: string, items: string[]): Node[] =>
      items.length === 0 ? [] : [html("h3", {}, title), html("ul", {}, ...items.map((item) => html("li", {}, item)))];
    root.replaceChildren(
      html("p", { class: "result-text" }, describeResult(snapshot.result)),
      ...lines,
      ...(retro
        ? [
            html("h3", {}, "회고"),
            html("p", {}, retro.summary),
            ...section("잘된 점", retro.wentWell),
            ...section("문제", retro.problems),
            ...section("다음에 할 일", retro.nextSteps),
          ]
        : snapshot.result.retrospectiveError
          ? [html("p", { class: "muted" }, `회고를 쓰지 못했습니다: ${snapshot.result.retrospectiveError}`)]
          : []),
    );
  }
}

export function renderIssues(root: HTMLElement, snapshot: DashboardSnapshot): void {
  root.hidden = snapshot.openIssues.length === 0;
  root.replaceChildren(
    ...snapshot.openIssues.map((issue) =>
      html("li", {}, `카드 ${issue.cardId}: ${issue.message}`),
    ),
  );
}

export function renderLog(root: HTMLElement, snapshot: DashboardSnapshot): void {
  const entries = snapshot.log.slice(-40).reverse();
  root.replaceChildren(
    ...entries.map((entry) =>
      html("li", {}, html("time", {}, formatClock(entry.at)), ` ${describeEvent(entry.event)}`),
    ),
  );
}

// 사용자에게 묻는 패널. 같은 질문이 열려 있는 동안에는 다시 만들지 않아서 입력 중인 글이 지워지지 않는다.
export class PromptPanel {
  private shownId: string | null = null;

  constructor(
    private readonly root: HTMLElement,
    private readonly send: SendReply,
  ) {}

  update(prompt: Prompt | null): void {
    if (prompt === null) {
      this.shownId = null;
      this.root.hidden = true;
      this.root.replaceChildren();
      return;
    }
    if (prompt.id === this.shownId) return;
    this.shownId = prompt.id;
    this.root.hidden = false;
    this.root.replaceChildren(...this.build(prompt));
    const first = this.root.querySelector<HTMLElement>("textarea, button");
    first?.focus({ preventScroll: true });
  }

  private build(prompt: Prompt): Node[] {
    const error = html("p", { class: "prompt-error", role: "alert" });
    const buttons: HTMLButtonElement[] = [];
    const submit = async (reply: PromptReply): Promise<void> => {
      buttons.forEach((b) => (b.disabled = true));
      setText(error, "");
      const message = await this.send(reply);
      if (message !== null) {
        setText(error, message);
        buttons.forEach((b) => (b.disabled = false));
      }
    };
    const button = (label: string, kind: "primary" | "plain", onClick: () => void): HTMLButtonElement => {
      const b = html("button", { type: "button", class: `btn is-${kind}` }, label);
      b.addEventListener("click", onClick);
      buttons.push(b);
      return b;
    };

    if (prompt.kind === "questions") {
      const fields = prompt.questions.map((question, i) => {
        const input = html("textarea", { rows: 2, id: `q-${i}` });
        return { input, node: html("label", { class: "field", for: `q-${i}` }, html("span", {}, question), input) };
      });
      return [
        html("h2", {}, "Planner가 먼저 물어봅니다"),
        ...fields.map((f) => f.node),
        html(
          "div",
          { class: "actions" },
          button("답변 보내기", "primary", () =>
            void submit({ promptId: prompt.id, kind: "questions", answers: fields.map((f) => f.input.value) }),
          ),
        ),
        error,
      ];
    }

    if (prompt.kind === "plan_review") {
      const feedback = html("textarea", { rows: 3, id: "plan-feedback", placeholder: "고치고 싶은 점을 적어 주세요." });
      return [
        html("h2", {}, "계획을 확인해 주세요"),
        planSummary(prompt.plan),
        html("label", { class: "field", for: "plan-feedback" }, html("span", {}, "수정 요청"), feedback),
        html(
          "div",
          { class: "actions" },
          button("승인", "primary", () =>
            void submit({ promptId: prompt.id, kind: "plan_review", decision: { action: "approve" } }),
          ),
          button("수정 요청", "plain", () => {
            if (feedback.value.trim() === "") {
              setText(error, "수정할 내용을 적어 주세요.");
              feedback.focus();
              return;
            }
            void submit({ promptId: prompt.id, kind: "plan_review", decision: { action: "revise", feedback: feedback.value } });
          }),
          button("취소", "plain", () =>
            void submit({ promptId: prompt.id, kind: "plan_review", decision: { action: "cancel" } }),
          ),
        ),
        error,
      ];
    }

    const note = html("textarea", {
      rows: 3,
      id: "issue-note",
      placeholder: "막힌 이유에 대한 답이나 알려 주고 싶은 내용을 적으면 다시 시도할 때 유닛에게 전달됩니다.",
    });
    return [
      html("h2", {}, `카드 ${prompt.cardId} 확인이 필요합니다`),
      html("p", { class: "prompt-title" }, prompt.title),
      html("p", {}, prompt.message),
      html("label", { class: "field", for: "issue-note" }, html("span", {}, "추가 안내 (선택)"), note),
      html(
        "div",
        { class: "actions" },
        button("다시 시도", "primary", () =>
          void submit({
            promptId: prompt.id,
            kind: "issue",
            decision: "retry",
            ...(note.value.trim() !== "" ? { note: note.value } : {}),
          }),
        ),
        button("멈추기", "plain", () => void submit({ promptId: prompt.id, kind: "issue", decision: "stop" })),
      ),
      error,
    ];
  }
}

function planSummary(plan: Plan): HTMLElement {
  return html(
    "div",
    { class: "plan-summary" },
    html("p", {}, `영역 ${plan.areas.length}개, 유닛 ${plan.units.length}개, 카드 ${plan.cards.length}개. 모델 호출은 약 ${plan.estimatedCalls}회 예상됩니다.`),
    html(
      "ul",
      {},
      ...plan.areas.map((area) => {
        const units = plan.units.filter((u) => u.areaId === area.id).length;
        const cards = plan.cards.filter((c) => c.areaId === area.id).length;
        return html("li", {}, html("strong", {}, area.name), ` ${truncate(area.goal, 60)} (유닛 ${units}, 카드 ${cards})`);
      }),
    ),
    plan.sharedPaths.length > 0 ? html("p", { class: "muted" }, `공유 경로: ${plan.sharedPaths.join(", ")}`) : html("span"),
  );
}
