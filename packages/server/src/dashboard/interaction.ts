import type { Plan, PlanDecision } from "@rallypoint/shared";
import type { Interaction, IssueInfo } from "../session/session.js";
import type { DashboardHub } from "./hub.js";

// 터미널 대신 대시보드 화면으로 사용자에게 묻는 Interaction.
export class DashboardInteraction implements Interaction {
  constructor(private readonly hub: DashboardHub) {}

  async answerQuestions(questions: string[]): Promise<string[]> {
    const reply = await this.hub.ask({ kind: "questions", questions });
    if (reply.kind !== "questions") {
      throw new Error("Unexpected reply kind");
    }
    return reply.answers;
  }

  async reviewPlan(plan: Plan): Promise<PlanDecision> {
    const reply = await this.hub.ask({ kind: "plan_review", plan });
    if (reply.kind !== "plan_review") {
      throw new Error("Unexpected reply kind");
    }
    return reply.decision;
  }

  async resolveIssue(issue: IssueInfo): Promise<"retry" | "stop"> {
    const reply = await this.hub.ask({
      kind: "issue",
      cardId: issue.cardId,
      title: issue.title,
      issueKind: issue.kind,
      message: issue.message,
    });
    if (reply.kind !== "issue") {
      throw new Error("Unexpected reply kind");
    }
    return reply.decision;
  }
}
