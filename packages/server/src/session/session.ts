import type { DashboardEvent, Plan, PlanDecision } from "@rallypoint/shared";
import { Board } from "../board/board.js";
import { Orchestrator } from "../orchestrator/orchestrator.js";
import { planProject } from "../planner/planner.js";
import type { PlannerOptions } from "../planner/planner.js";
import type { LlmClient, TokenUsage } from "../runner/llm.js";
import type { RunOptions } from "../runner/runner.js";
import { scenarioToGoal } from "../scenario/scenario.js";
import type { Scenario } from "../scenario/scenario.js";
import { Workspace } from "../workspace/workspace.js";

export type { PlanDecision };

export interface IssueInfo {
  cardId: string;
  title: string;
  kind: "blocked" | "failed" | "conflict";
  message: string;
}

// 사용자와 주고받는 부분. CLI에서는 터미널로, 나중에는 대시보드로 구현한다.
// 카드 검토는 reviewer 유닛이 하므로 여기에는 없다.
export interface Interaction {
  // 질문 순서대로 답을 돌려준다.
  answerQuestions(questions: string[]): Promise<string[]>;
  reviewPlan(plan: Plan): Promise<PlanDecision>;
  resolveIssue(issue: IssueInfo): Promise<"retry" | "stop">;
}

// 진행 상황을 바깥(대시보드 등)에 알리는 연결부. 모두 선택이다.
export interface SessionObserver {
  // Planner가 일하는 중이거나(planning), 승인된 계획을 실행하는 중이다(running).
  onPhase?(phase: "planning" | "running"): void;
  // 계획이 나올 때마다. 사용자 검토 전이다.
  onPlan?(plan: Plan): void;
  // 승인된 계획이 보드에 등록된 직후
  onBoardReady?(board: Board): void;
  onEnd?(result: ProjectResult): void;
  // 결과를 내지 못하고 오류로 끝났다(예: 작업 폴더가 비어 있지 않다).
  onFail?(message: string): void;
}

export interface RunProjectOptions {
  scenario: Scenario;
  client: LlmClient;
  workspaceDir: string;
  interaction: Interaction;
  onEvent?: (event: DashboardEvent) => void;
  observer?: SessionObserver;
  maxConcurrent?: number;
  plannerOptions?: PlannerOptions;
  runOptions?: RunOptions;
}

export type ProjectOutcome =
  | "finished"
  | "stalled" // 더 진행할 수 없다
  | "stopped" // 사용자가 문제 앞에서 멈추기로 했다
  | "cancelled" // 사용자가 계획을 승인하지 않았다
  | "planning_failed";

export interface ProjectResult {
  outcome: ProjectOutcome;
  plan: Plan | null;
  message: string | null;
  // Planner와 유닛 실행을 합친 모델 호출 횟수와 토큰
  totalCalls: number;
  usage: TokenUsage;
}

// 시나리오에서 시작해 끝까지 잇는다: 작업 폴더 열기, 계획과 승인, 보드 등록, 실행, 문제 해결.
export async function runProject(options: RunProjectOptions): Promise<ProjectResult> {
  try {
    const result = await runProjectSteps(options);
    options.observer?.onEnd?.(result);
    return result;
  } catch (error) {
    options.observer?.onFail?.(error instanceof Error ? error.message : String(error));
    throw error;
  }
}

async function runProjectSteps(options: RunProjectOptions): Promise<ProjectResult> {
  const { scenario, client, interaction } = options;
  const observer = options.observer ?? {};
  const onEvent = options.onEvent ?? (() => {});

  // 비용을 쓰기 전에 작업 폴더부터 확인한다. 비어 있지 않으면 여기서 오류가 난다.
  const workspace = await Workspace.open(options.workspaceDir);

  const planningUsage: TokenUsage = { inputTokens: 0, outputTokens: 0 };
  let planningCalls = 0;
  const result = (
    outcome: ProjectOutcome,
    plan: Plan | null,
    message: string | null,
    run?: { totalCalls: number; usage: TokenUsage },
  ): ProjectResult => ({
    outcome,
    plan,
    message,
    totalCalls: planningCalls + (run?.totalCalls ?? 0),
    usage: {
      inputTokens: planningUsage.inputTokens + (run?.usage.inputTokens ?? 0),
      outputTokens: planningUsage.outputTokens + (run?.usage.outputTokens ?? 0),
    },
  });

  // 1. 계획: 필요하면 질문 한 번, 그다음 사용자가 승인할 때까지 수정을 반복한다.
  const goal = scenarioToGoal(scenario);
  let answers: { question: string; answer: string }[] | undefined;
  let plan: Plan | null = null;
  let revision: { plan: Plan; feedback: string } | undefined;

  for (;;) {
    observer.onPhase?.("planning");
    const planned = await planProject(
      client,
      { goal, answers, revision },
      options.plannerOptions,
    );
    planningCalls += planned.attempts;
    planningUsage.inputTokens += planned.usage.inputTokens;
    planningUsage.outputTokens += planned.usage.outputTokens;

    if (planned.status === "failed") {
      return result("planning_failed", null, planned.message);
    }
    if (planned.status === "questions") {
      if (answers !== undefined) {
        return result("planning_failed", null, "The planner asked questions twice.");
      }
      const given = await interaction.answerQuestions(planned.questions);
      answers = planned.questions.map((question, i) => ({
        question,
        answer: given[i]?.trim() || "(no answer)",
      }));
      continue;
    }

    plan = planned.plan;
    observer.onPlan?.(plan);
    const decision = await interaction.reviewPlan(plan);
    if (decision.action === "cancel") {
      return result("cancelled", plan, null);
    }
    if (decision.action === "approve") {
      break;
    }
    revision = { plan, feedback: decision.feedback };
  }

  // 2. 승인된 계획을 보드에 등록한다. 영역, 유닛, 카드 순서다.
  observer.onPhase?.("running");
  const issues = new Map<string, { kind: IssueInfo["kind"]; message: string }>();
  const handleEvent = (event: DashboardEvent): void => {
    if (event.type === "issue_raised") {
      issues.set(event.cardId, { kind: event.kind, message: event.message });
    }
    onEvent(event);
  };
  const board = new Board({ maxConcurrent: options.maxConcurrent, onEvent: handleEvent });
  board.registerAreas(plan.areas, plan.sharedPaths);
  board.registerUnits(plan.units);
  board.registerCards(plan.cards);
  observer.onBoardReady?.(board);

  const orchestrator = new Orchestrator({
    board,
    workspace,
    client,
    units: plan.units,
    onEvent: handleEvent,
    runOptions: options.runOptions,
  });

  // 3. 실행: 멈출 때마다 이유에 맞게 사용자에게 묻고 이어서 돌린다.
  for (;;) {
    const summary = await orchestrator.run();
    const run = { totalCalls: summary.totalCalls, usage: summary.usage };

    if (summary.outcome === "finished") {
      return result("finished", plan, null, run);
    }

    if (summary.outcome === "paused") {
      for (const card of board.getCards().filter((c) => c.status === "blocked")) {
        const issue = issues.get(card.id) ?? { kind: "blocked" as const, message: "" };
        const decision = await interaction.resolveIssue({
          cardId: card.id,
          title: card.title,
          kind: issue.kind,
          message: issue.message,
        });
        if (decision === "stop") {
          return result("stopped", plan, `Stopped at card ${card.id}`, run);
        }
        orchestrator.retryBlocked(card.id);
      }
      continue;
    }

    const remaining = board
      .getCards()
      .filter((c) => c.status !== "done")
      .map((c) => `${c.id}(${c.status})`);
    return result("stalled", plan, `Cannot continue. Remaining cards: ${remaining.join(", ")}`, run);
  }
}
