import type {
  DashboardEvent,
  DashboardSnapshot,
  IssuePrompt,
  LogEntry,
  OpenIssue,
  Plan,
  PlanReviewPrompt,
  Prompt,
  PromptReply,
  QuestionsPrompt,
  ServerMessage,
  SessionResult,
  UnitStatus,
} from "@rallypoint/shared";
import type { Board } from "../board/board.js";
import type { ProjectResult, SessionObserver } from "../session/session.js";

export const DEFAULT_MAX_LOG = 200;

export type PromptInput =
  | Omit<QuestionsPrompt, "id">
  | Omit<PlanReviewPrompt, "id">
  | Omit<IssuePrompt, "id">;

export type RespondResult =
  | { ok: true }
  | { ok: false; status: 400 | 409; error: string };

export interface HubOptions {
  scenarioTitle?: string | null;
  maxLog?: number;
  now?: () => Date;
}

type BaseState = "idle" | "planning" | "running" | "ended";

// 실행 중인 세션의 상태를 한곳에 모아 두고, 화면에 보낼 snapshot을 만든다.
// 세션이 알려 주는 것(observer)과 보드 이벤트(onEvent)를 받고, 사용자의 답(respond)을 되돌려 준다.
export class DashboardHub {
  private readonly scenarioTitle: string | null;
  private readonly maxLog: number;
  private readonly now: () => Date;

  private base: BaseState = "idle";
  private plan: Plan | null = null;
  private board: Board | null = null;
  private readonly unitStatuses: Record<string, UnitStatus> = {};
  private paused = false;
  private pauseReason: string | null = null;
  private usage = { totalCalls: 0, inputTokens: 0, outputTokens: 0 };
  private readonly openIssues = new Map<string, OpenIssue>();
  // 카드 id -> 검토 중인 유닛 id
  private readonly activeReviews = new Map<string, string>();
  private result: SessionResult | null = null;
  private log: LogEntry[] = [];
  private seq = 0;

  private promptCounter = 0;
  private pending: { prompt: Prompt; resolve: (reply: PromptReply) => void } | null = null;
  private readonly listeners = new Set<(message: ServerMessage) => void>();

  constructor(options: HubOptions = {}) {
    this.scenarioTitle = options.scenarioTitle ?? null;
    this.maxLog = options.maxLog ?? DEFAULT_MAX_LOG;
    this.now = options.now ?? (() => new Date());
  }

  // runProject의 observer로 넘긴다.
  readonly observer: SessionObserver = {
    onPhase: (phase) => {
      this.base = phase;
      this.broadcastSnapshot();
    },
    onPlan: (plan) => {
      this.plan = plan;
      this.broadcastSnapshot();
    },
    onBoardReady: (board) => {
      this.board = board;
      for (const unit of this.plan?.units ?? []) {
        this.unitStatuses[unit.id] ??= "idle";
      }
      this.broadcastSnapshot();
    },
    onEnd: (result: ProjectResult) => {
      this.base = "ended";
      this.usage = {
        totalCalls: result.totalCalls,
        inputTokens: result.usage.inputTokens,
        outputTokens: result.usage.outputTokens,
      };
      this.result = {
        outcome: result.outcome,
        message: result.message,
        totalCalls: result.totalCalls,
        inputTokens: result.usage.inputTokens,
        outputTokens: result.usage.outputTokens,
        report: result.report,
        retrospective: result.retrospective,
      };
      this.broadcastSnapshot();
    },
    onFail: (message) => {
      this.base = "ended";
      this.result = {
        outcome: "error",
        message,
        totalCalls: this.usage.totalCalls,
        inputTokens: this.usage.inputTokens,
        outputTokens: this.usage.outputTokens,
        report: null,
        retrospective: null,
      };
      this.broadcastSnapshot();
    },
  };

  // runProject의 onEvent로 넘긴다(보드와 오케스트레이터 이벤트).
  readonly onEvent = (event: DashboardEvent): void => {
    this.seq += 1;
    this.log.push({ seq: this.seq, at: this.now().toISOString(), event });
    if (this.log.length > this.maxLog) {
      this.log = this.log.slice(this.log.length - this.maxLog);
    }

    switch (event.type) {
      case "unit_status_changed":
        this.unitStatuses[event.unitId] = event.status;
        break;
      case "paused":
        this.paused = true;
        this.pauseReason = event.reason;
        break;
      case "resumed":
        this.paused = false;
        this.pauseReason = null;
        break;
      case "issue_raised":
        this.openIssues.set(event.cardId, {
          cardId: event.cardId,
          kind: event.kind,
          message: event.message,
        });
        break;
      case "card_moved":
        // 막힘에서 벗어나면 그 문제는 더 이상 열려 있지 않다.
        if (event.from === "blocked") {
          this.openIssues.delete(event.cardId);
        }
        // 검토 중이던 카드가 다른 곳으로 가면 검토는 끝난 것이다.
        if (event.from === "review") {
          this.activeReviews.delete(event.cardId);
        }
        break;
      case "review_started":
        this.activeReviews.set(event.cardId, event.unitId);
        break;
      case "review_result":
        this.activeReviews.delete(event.cardId);
        break;
      case "usage_updated":
        this.usage = {
          totalCalls: event.totalCalls,
          inputTokens: event.inputTokens,
          outputTokens: event.outputTokens,
        };
        break;
      default:
        break;
    }

    this.emit({ type: "event", event });
    this.broadcastSnapshot();
  };

  getSnapshot(): DashboardSnapshot {
    const prompt = this.pending?.prompt ?? null;
    return {
      phase: this.result ? "ended" : prompt ? "waiting_for_user" : this.base,
      scenarioTitle: this.scenarioTitle,
      plan: this.plan,
      cards: this.board ? this.board.getCards() : [],
      unitStatuses: { ...this.unitStatuses },
      paused: this.paused,
      pauseReason: this.pauseReason,
      usage: { ...this.usage },
      prompt,
      openIssues: [...this.openIssues.values()],
      activeReviews: [...this.activeReviews].map(([cardId, unitId]) => ({ cardId, unitId })),
      result: this.result,
      log: [...this.log],
    };
  }

  subscribe(listener: (message: ServerMessage) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  // 사용자에게 묻고 답이 올 때까지 기다린다. 한 번에 하나만 열 수 있다.
  ask(input: PromptInput): Promise<PromptReply> {
    if (this.pending) {
      throw new Error("A prompt is already open");
    }
    this.promptCounter += 1;
    const prompt = { ...input, id: `p${this.promptCounter}` } as Prompt;
    return new Promise<PromptReply>((resolve) => {
      this.pending = { prompt, resolve };
      this.broadcastSnapshot();
    });
  }

  // 화면에서 온 답을 검사해 기다리는 질문에 넘긴다. 잘못된 답은 이유와 함께 거부한다.
  respond(body: unknown): RespondResult {
    if (!this.pending) {
      return { ok: false, status: 409, error: "No prompt is open." };
    }
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      return { ok: false, status: 400, error: "Body must be a JSON object." };
    }
    const input = body as Record<string, unknown>;
    const { prompt, resolve } = this.pending;
    if (input.promptId !== prompt.id) {
      return { ok: false, status: 409, error: "This prompt is no longer open." };
    }

    const reply = parseReply(prompt, input);
    if (typeof reply === "string") {
      return { ok: false, status: 400, error: reply };
    }
    this.pending = null;
    resolve(reply);
    this.broadcastSnapshot();
    return { ok: true };
  }

  private emit(message: ServerMessage): void {
    for (const listener of [...this.listeners]) {
      listener(message);
    }
  }

  private broadcastSnapshot(): void {
    if (this.listeners.size > 0) {
      this.emit({ type: "snapshot", snapshot: this.getSnapshot() });
    }
  }
}

// 올바르면 PromptReply, 틀리면 이유 글을 돌려준다.
function parseReply(prompt: Prompt, input: Record<string, unknown>): PromptReply | string {
  if (input.kind !== prompt.kind) {
    return `kind must be "${prompt.kind}".`;
  }

  if (prompt.kind === "questions") {
    const answers = input.answers;
    if (
      !Array.isArray(answers) ||
      answers.length > prompt.questions.length ||
      !answers.every((a) => typeof a === "string")
    ) {
      return `answers must be an array of at most ${prompt.questions.length} strings.`;
    }
    return { promptId: prompt.id, kind: "questions", answers: answers as string[] };
  }

  if (prompt.kind === "issue") {
    if (input.decision !== "retry" && input.decision !== "stop") {
      return 'decision must be "retry" or "stop".';
    }
    return { promptId: prompt.id, kind: "issue", decision: input.decision };
  }

  const decision = input.decision;
  if (typeof decision !== "object" || decision === null) {
    return "decision must be an object.";
  }
  const { action, feedback } = decision as { action?: unknown; feedback?: unknown };
  if (action === "approve" || action === "cancel") {
    return { promptId: prompt.id, kind: "plan_review", decision: { action } };
  }
  if (action === "revise") {
    if (typeof feedback !== "string" || feedback.trim() === "") {
      return "A revision needs non-empty feedback.";
    }
    return { promptId: prompt.id, kind: "plan_review", decision: { action, feedback } };
  }
  return 'decision.action must be "approve", "revise" or "cancel".';
}
