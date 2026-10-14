// 시나리오 파일로 RallyPoint를 실행한다.
// 실행: npm run rally -- scenarios/sample-todo-cli.md <빈 작업 폴더>
import { createInterface } from "node:readline/promises";
import type { DashboardEvent, Plan } from "@rallypoint/shared";
import { createAnthropicClient } from "./runner/anthropic-client.js";
import { loadScenario } from "./scenario/scenario.js";
import { runProject } from "./session/session.js";
import type { Interaction, IssueInfo, PlanDecision } from "./session/session.js";

const [scenarioPath, workDir] = process.argv.slice(2);
const apiKey = process.env.ANTHROPIC_API_KEY;
const model = process.env.ANTHROPIC_MODEL;

if (!scenarioPath || !workDir) {
  console.error("사용법: npm run rally -- <시나리오 파일> <빈 작업 폴더>");
  process.exit(1);
}
if (!apiKey || !model) {
  console.error(".env에 ANTHROPIC_API_KEY와 ANTHROPIC_MODEL을 설정해야 합니다.");
  process.exit(1);
}

const loaded = await loadScenario(scenarioPath);
if (!loaded.ok) {
  console.error(`시나리오 오류: ${loaded.message}`);
  process.exit(1);
}

const rl = createInterface({ input: process.stdin, output: process.stdout });

function printPlan(plan: Plan): void {
  console.log("\n===== 계획 =====");
  for (const area of plan.areas) {
    console.log(`영역 ${area.id}: ${area.goal}`);
  }
  console.log(`공유 경로: ${plan.sharedPaths.length > 0 ? plan.sharedPaths.join(", ") : "(없음)"}`);
  for (const unit of plan.units) {
    console.log(`유닛 ${unit.id} [${unit.kind}/${unit.permission}] 영역 ${unit.areaId ?? "-"}: ${unit.role}`);
  }
  for (const card of plan.cards) {
    const deps = card.dependsOn.length > 0 ? ` (선행: ${card.dependsOn.join(", ")})` : "";
    console.log(`카드 ${card.id} [${card.unitKind}/${card.areaId ?? "-"}] 반복 ${card.iteration}${deps}: ${card.title}`);
    console.log(`    완료 기준: ${card.doneCriteria}`);
  }
  console.log(`예상 모델 호출 수: 약 ${plan.estimatedCalls}회`);
}

const interaction: Interaction = {
  async answerQuestions(questions: string[]): Promise<string[]> {
    console.log("\nPlanner가 계획 전에 묻습니다.");
    const answers: string[] = [];
    for (const question of questions) {
      answers.push(await rl.question(`? ${question}\n> `));
    }
    return answers;
  },

  async reviewPlan(plan: Plan): Promise<PlanDecision> {
    printPlan(plan);
    const input = (
      await rl.question("\n승인하려면 y, 취소하려면 n, 수정하려면 수정할 내용을 입력하세요.\n> ")
    ).trim();
    const lower = input.toLowerCase();
    if (["y", "yes", "승인"].includes(lower)) return { action: "approve" };
    if (["n", "no", "취소"].includes(lower)) return { action: "cancel" };
    if (input === "") return { action: "cancel" };
    return { action: "revise", feedback: input };
  },

  async resolveIssue(issue: IssueInfo): Promise<"retry" | "stop"> {
    console.log(`\n문제: 카드 ${issue.cardId} "${issue.title}" (${issue.kind})\n  ${issue.message}`);
    const input = (await rl.question("다시 시도하려면 r, 멈추려면 s\n> ")).trim().toLowerCase();
    return input === "r" ? "retry" : "stop";
  },
};

function printEvent(event: DashboardEvent): void {
  switch (event.type) {
    case "card_moved":
      console.log(`  카드 ${event.cardId}: ${event.from} → ${event.to}`);
      break;
    case "review_result":
      console.log(
        `  검토 ${event.cardId}: ${event.verdict === "approve" ? "승인" : "반려"} - ${event.summary}`,
      );
      for (const finding of event.findings) {
        console.log(`    · ${finding}`);
      }
      break;
    case "conflict_detected":
      console.log(`  충돌: ${event.path} (카드 ${event.cardIds.join(", ")})`);
      break;
    case "conflict_resolved":
      console.log(`  충돌 해소: ${event.path}`);
      break;
    case "paused":
      console.log(`  일시정지: ${event.reason}`);
      break;
    case "resumed":
      console.log("  재개");
      break;
    default:
      break;
  }
}

try {
  const client = createAnthropicClient({ apiKey, model });
  const result = await runProject({
    scenario: loaded.scenario,
    client,
    workspaceDir: workDir,
    interaction,
    onEvent: printEvent,
  });

  console.log(`\n결과: ${result.outcome}${result.message ? ` - ${result.message}` : ""}`);
  console.log(
    `모델 호출 ${result.totalCalls}회, 토큰 입력 ${result.usage.inputTokens} / 출력 ${result.usage.outputTokens}`,
  );
  process.exitCode = result.outcome === "finished" ? 0 : 1;
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  rl.close();
}
