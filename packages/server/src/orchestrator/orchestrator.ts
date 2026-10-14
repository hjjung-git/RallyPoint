import type { Card, DashboardEvent, UnitSpec } from "@rallypoint/shared";
import type { Board } from "../board/board.js";
import type { LlmClient, TokenUsage } from "../runner/llm.js";
import { runCard } from "../runner/runner.js";
import type { RunOptions, RunResult } from "../runner/runner.js";
import type { Workspace } from "../workspace/workspace.js";

// 같은 카드가 이 횟수까지 충돌하면 다시 시도하고, 넘으면 막힘으로 두고 사용자에게 알린다.
export const DEFAULT_MAX_CONFLICT_RETRIES = 1;
// 같은 카드가 이 횟수까지 반려되면 다시 하게 하고, 넘으면 막힘으로 두고 사용자에게 알린다.
export const DEFAULT_MAX_REVIEW_REJECTIONS = 2;

export interface OrchestratorOptions {
  board: Board;
  workspace: Workspace;
  client: LlmClient;
  // 보드에 등록한 유닛과 같은 목록. 등록은 호출하는 쪽이 보드에 한다.
  units: UnitSpec[];
  onEvent?: (event: DashboardEvent) => void;
  runOptions?: RunOptions;
  maxConflictRetries?: number;
  maxReviewRejections?: number;
}

export type OrchestratorOutcome =
  | "finished" // 모든 카드가 완료됐다
  | "paused" // 문제가 생겨 일시정지 중이다. 사용자 응답을 기다린다
  | "awaiting_review" // 검토 중인 카드가 있는데 검토할 유닛이 없다
  | "stalled"; // 더 진행할 수 없다(막힌 카드나 담당 유닛이 없는 카드 때문에)

export interface OrchestratorSummary {
  outcome: OrchestratorOutcome;
  totalCalls: number;
  usage: TokenUsage;
}

interface Finished {
  unit: UnitSpec;
  card: Card;
  result: RunResult;
  // 일이 아니라 검토를 한 실행인가
  review: boolean;
}

// 보드의 규칙에 따라 카드를 유닛에게 나눠 주고, 실행 결과를 보드에 반영하는 루프.
// 무엇을 할지는 보드와 실행기가 정하고, 여기서는 결과를 다음 상태로 옮기기만 한다.
export class Orchestrator {
  private readonly board: Board;
  private readonly workspace: Workspace;
  private readonly client: LlmClient;
  private readonly units: UnitSpec[];
  private readonly onEvent: (event: DashboardEvent) => void;
  private readonly runOptions: RunOptions;
  private readonly maxConflictRetries: number;
  private readonly maxReviewRejections: number;

  private readonly conflictCounts = new Map<string, number>();
  private readonly conflictPaths = new Map<string, string>();
  private readonly rejectionCounts = new Map<string, number>();
  // 반려된 카드에 builder가 다시 일할 때 보여 줄 지적 사항
  private readonly feedback = new Map<string, string>();
  // 지금 검토 중인 카드. 검토 대기 카드는 보드에서 상태가 그대로라 따로 기억한다.
  private readonly reviewing = new Set<string>();
  private totalCalls = 0;
  private readonly usage: TokenUsage = { inputTokens: 0, outputTokens: 0 };
  private running = false;

  constructor(options: OrchestratorOptions) {
    const ids = new Set<string>();
    for (const unit of options.units) {
      if (ids.has(unit.id)) {
        throw new Error(`Duplicate unit id: ${unit.id}`);
      }
      ids.add(unit.id);
    }
    this.board = options.board;
    this.workspace = options.workspace;
    this.client = options.client;
    this.units = [...options.units];
    this.onEvent = options.onEvent ?? (() => {});
    this.runOptions = options.runOptions ?? {};
    this.maxConflictRetries =
      options.maxConflictRetries ?? DEFAULT_MAX_CONFLICT_RETRIES;
    this.maxReviewRejections =
      options.maxReviewRejections ?? DEFAULT_MAX_REVIEW_REJECTIONS;
  }

  // 더 진행할 수 없을 때까지 카드를 나눠 주고 실행한다. 멈춘 뒤 다시 불러도 된다.
  async run(): Promise<OrchestratorSummary> {
    if (this.running) {
      throw new Error("Orchestrator is already running");
    }
    this.running = true;
    try {
      const inFlight = new Map<string, Promise<Finished>>();
      for (;;) {
        this.fill(inFlight);
        if (inFlight.size === 0) {
          break;
        }
        const finished = await Promise.race(inFlight.values());
        inFlight.delete(finished.unit.id);
        this.handle(finished);
      }
      return {
        outcome: this.outcome(),
        totalCalls: this.totalCalls,
        usage: { ...this.usage },
      };
    } finally {
      this.running = false;
    }
  }

  // 사용자가 검토 결과를 직접 뒤집을 때 쓴다. 승인하면 완료, 반려하면 할 일로 돌아간다.
  approveReview(cardId: string): void {
    this.assertInReview(cardId);
    this.board.move(cardId, "done");
    this.clearReviewState(cardId);
  }

  rejectReview(cardId: string): void {
    this.assertInReview(cardId);
    this.board.move(cardId, "todo");
  }

  // 사용자가 문제를 확인한 뒤, 막힌 카드를 다시 시도하게 하고 일시정지를 푼다.
  retryBlocked(cardId: string): void {
    const card = this.board.getCard(cardId);
    if (!card || card.status !== "blocked") {
      throw new Error(`Card ${cardId} is not blocked`);
    }
    this.board.move(cardId, "todo");
    this.conflictCounts.delete(cardId);
    this.rejectionCounts.delete(cardId);
    this.board.resume();
  }

  // 놀고 있는 유닛마다 카드를 요청해 실행을 시작한다. 동시 실행 한도 등은 보드가 판단한다.
  // 검토자 유닛은 일할 카드가 없으면 검토 대기 카드를 가져간다.
  private fill(inFlight: Map<string, Promise<Finished>>): void {
    for (const unit of this.units) {
      if (inFlight.has(unit.id)) {
        continue;
      }
      const card = this.board.assign(unit.id);
      if (card) {
        inFlight.set(unit.id, this.start(unit, card, false));
      }
    }

    for (const unit of this.units) {
      if (unit.kind !== "reviewer" || inFlight.has(unit.id)) {
        continue;
      }
      // 검토도 모델 호출이므로 같은 동시 실행 한도를 따른다.
      if (inFlight.size >= this.board.getMaxConcurrent()) {
        break;
      }
      const card = this.nextReviewFor(unit);
      if (card) {
        this.reviewing.add(card.id);
        this.onEvent({ type: "unit_status_changed", unitId: unit.id, status: "working" });
        inFlight.set(unit.id, this.start(unit, card, true));
      }
    }
  }

  private nextReviewFor(unit: UnitSpec): Card | undefined {
    return this.board
      .getCards()
      .filter(
        (card) =>
          card.status === "review" &&
          !this.reviewing.has(card.id) &&
          canReview(unit, card),
      )
      .sort((a, b) => a.iteration - b.iteration)[0];
  }

  private start(unit: UnitSpec, card: Card, review: boolean): Promise<Finished> {
    const options: RunOptions = review
      ? { ...this.runOptions, review: true }
      : { ...this.runOptions, feedback: this.feedback.get(card.id) };
    return runCard(this.client, this.workspace, unit, card, options).then(
      (result) => ({ unit, card, result, review }),
      // 실행기가 예상 못 한 오류를 던져도 카드가 진행 중으로 남지 않게 실패로 바꾼다.
      (error: unknown): Finished => ({
        unit,
        card,
        review,
        result: {
          status: "failed",
          failure: "llm_error",
          message: `Unexpected error: ${error instanceof Error ? error.message : String(error)}`,
          usage: { inputTokens: 0, outputTokens: 0 },
          attempts: 0,
        },
      }),
    );
  }

  private handle(finished: Finished): void {
    const { result } = finished;
    this.totalCalls += result.attempts;
    this.usage.inputTokens += result.usage.inputTokens;
    this.usage.outputTokens += result.usage.outputTokens;

    if (finished.review) {
      this.handleReview(finished);
    } else {
      this.handleWork(finished);
    }

    this.onEvent({
      type: "usage_updated",
      totalCalls: this.totalCalls,
      inputTokens: this.usage.inputTokens,
      outputTokens: this.usage.outputTokens,
    });
  }

  private handleWork({ unit, card, result }: Finished): void {
    switch (result.status) {
      case "completed": {
        const resolved = this.conflictPaths.get(card.id);
        if (resolved !== undefined) {
          this.conflictPaths.delete(card.id);
          this.onEvent({ type: "conflict_resolved", path: resolved });
        }
        if (this.needsReview(unit, card)) {
          this.board.move(card.id, "review");
        } else {
          this.board.move(card.id, "done");
          this.clearReviewState(card.id);
        }
        break;
      }
      case "blocked":
        this.raiseIssue(card.id, "blocked", result.reason);
        break;
      case "failed":
        this.raiseIssue(card.id, "failed", result.message);
        break;
      case "conflict": {
        const path = result.path ?? "";
        const count = (this.conflictCounts.get(card.id) ?? 0) + 1;
        this.conflictCounts.set(card.id, count);
        this.conflictPaths.set(card.id, path);
        this.onEvent({
          type: "conflict_detected",
          path,
          cardIds:
            result.lastCardId === null
              ? [card.id]
              : [card.id, result.lastCardId],
        });
        if (count > this.maxConflictRetries) {
          this.raiseIssue(card.id, "conflict", result.message);
        } else {
          // 바뀐 파일을 보고 처음부터 다시 하도록 할 일로 돌린다.
          this.board.move(card.id, "todo");
        }
        break;
      }
      default:
        this.raiseIssue(card.id, "failed", `Unexpected result: ${result.status}`);
    }
  }

  private handleReview({ unit, card, result }: Finished): void {
    this.reviewing.delete(card.id);
    this.onEvent({ type: "unit_status_changed", unitId: unit.id, status: "idle" });

    switch (result.status) {
      case "reviewed": {
        this.onEvent({
          type: "review_result",
          cardId: card.id,
          verdict: result.verdict,
          summary: result.summary,
          findings: result.findings,
        });
        if (result.verdict === "approve") {
          this.board.move(card.id, "done");
          this.clearReviewState(card.id);
          break;
        }
        const count = (this.rejectionCounts.get(card.id) ?? 0) + 1;
        this.rejectionCounts.set(card.id, count);
        this.feedback.set(card.id, result.findings.map((f) => `- ${f}`).join("\n"));
        if (count > this.maxReviewRejections) {
          this.raiseIssue(
            card.id,
            "blocked",
            `Rejected ${count} times. Last findings: ${result.findings.join("; ")}`,
          );
        } else {
          this.board.move(card.id, "todo");
        }
        break;
      }
      case "blocked":
        this.raiseIssue(card.id, "blocked", `Review could not be done: ${result.reason}`);
        break;
      case "failed":
        this.raiseIssue(card.id, "failed", result.message);
        break;
      default:
        this.raiseIssue(card.id, "failed", `Unexpected review result: ${result.status}`);
    }
  }

  // 카드를 막힘으로 두고, 사용자에게 알리고, 전체를 일시정지한다.
  private raiseIssue(
    cardId: string,
    kind: "blocked" | "failed" | "conflict",
    message: string,
  ): void {
    this.board.move(cardId, "blocked");
    this.onEvent({ type: "issue_raised", cardId, kind, message });
    this.board.pause(`Card ${cardId}: ${message}`);
  }

  // 변경안을 낸 유닛의 카드는, 그 카드를 검토할 수 있는 검토자 유닛이 있을 때만 검토를 거친다.
  private needsReview(unit: UnitSpec, card: Card): boolean {
    return (
      unit.permission === "propose" &&
      this.units.some((other) => other.kind === "reviewer" && canReview(other, card))
    );
  }

  private clearReviewState(cardId: string): void {
    this.rejectionCounts.delete(cardId);
    this.feedback.delete(cardId);
  }

  private assertInReview(cardId: string): void {
    const card = this.board.getCard(cardId);
    if (!card || card.status !== "review") {
      throw new Error(`Card ${cardId} is not in review`);
    }
  }

  private outcome(): OrchestratorOutcome {
    if (this.board.isFinished()) {
      return "finished";
    }
    if (this.board.isPaused()) {
      return "paused";
    }
    if (this.board.getCards().some((card) => card.status === "review")) {
      return "awaiting_review";
    }
    return "stalled";
  }
}

// 영역에 소속된 검토자는 자기 영역의 카드만, 소속 없는 검토자는 모든 카드를 검토한다.
function canReview(reviewer: UnitSpec, card: Card): boolean {
  return reviewer.areaId === null || reviewer.areaId === card.areaId;
}
