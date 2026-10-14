// API 키 없이 대시보드 화면을 구경하는 데모. 가짜 진행 상황을 시간 순서대로 흘려 보낸다.
// 실행: npm run demo   (옵션: --port=3001 --speed=1)  빠르게 보려면 --speed=2
import type { Card, Plan, UnitSpec } from "@rallypoint/shared";
import { buildRunReport } from "./report/report.js";
import { Board } from "./board/board.js";
import { DashboardHub } from "./dashboard/hub.js";
import { startDashboardServer } from "./dashboard/server.js";

const arg = (name: string): string | undefined =>
  process.argv.slice(2).find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const speed = Number(arg("speed") ?? "1") || 1;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms / speed));

function unit(id: string, kind: UnitSpec["kind"], areaId: string | null, write: string[]): UnitSpec {
  return {
    id, kind, areaId,
    role: kind === "builder" ? `${areaId} 영역의 코드를 만듭니다` : kind === "reviewer" ? "완성된 카드를 검토합니다" : "영역을 하나로 합칩니다",
    scope: { read: ["src/"], write },
    permission: kind === "builder" ? "propose" : "read",
    reportFormat: "short",
  };
}

function card(id: string, title: string, kind: Card["unitKind"], areaId: string | null, dependsOn: string[]): Card {
  return {
    id, title, description: title, unitKind: kind, areaId, dependsOn, iteration: 1,
    scope: { read: ["src/"], write: areaId ? [`src/${areaId}/`] : [] },
    doneCriteria: `${title}이(가) 동작하고 검토를 통과한다`,
    status: "todo", assignedUnitId: null,
  };
}

const plan: Plan = {
  areas: [
    { id: "api", name: "서버", goal: "할 일 데이터를 저장하고 꺼내는 서버", scope: { read: ["src/"], write: ["src/api/", "src/shared/"] } },
    { id: "web", name: "화면", goal: "할 일을 보고 추가하는 화면", scope: { read: ["src/"], write: ["src/web/"] } },
  ],
  sharedPaths: ["src/shared/"],
  units: [
    unit("api-1", "builder", "api", ["src/api/", "src/shared/"]),
    unit("api-2", "builder", "api", ["src/api/"]),
    unit("web-1", "builder", "web", ["src/web/"]),
    unit("rev-1", "reviewer", null, []),
    unit("int-1", "integrator", null, ["src/shared/"]),
  ],
  cards: [
    card("c1", "공용 타입 정의", "builder", "api", []),
    card("c2", "저장소 만들기", "builder", "api", ["c1"]),
    card("c3", "서버 경로 만들기", "builder", "api", ["c1"]),
    card("c4", "화면 뼈대", "builder", "web", ["c1"]),
    card("c5", "할 일 목록 화면", "builder", "web", ["c3", "c4"]),
    card("c6", "서버와 화면 연결", "integrator", null, ["c2", "c5"]),
  ],
  estimatedCalls: 18,
};

const hub = new DashboardHub({ scenarioTitle: "할 일 관리 데모" });
const port = arg("port") !== undefined ? Number(arg("port")) : undefined;
const server = await startDashboardServer(hub, port === undefined ? {} : { port });
console.log(`데모 화면: ${server.url}  (끝내려면 Ctrl+C)`);

let calls = 0;
let tokens = 0;
const usage = (): void => {
  calls += 1;
  tokens += 900;
  hub.onEvent({ type: "usage_updated", totalCalls: calls, inputTokens: tokens, outputTokens: Math.round(tokens / 4) });
};

hub.observer.onPhase?.("planning");
await sleep(2500);
hub.observer.onPlan?.(plan);
const decision = await hub.ask({ kind: "plan_review", plan });
if (decision.kind !== "plan_review" || decision.decision.action !== "approve") {
  console.log("승인하지 않아 데모를 끝냅니다. 화면에서 '승인'을 누르면 진행 상황이 흘러갑니다.");
  hub.observer.onEnd?.({ outcome: "cancelled", plan, message: null, totalCalls: 0, report: null, retrospective: null, usage: { inputTokens: 0, outputTokens: 0 } } as never);
} else {
  const board = new Board({ maxConcurrent: 3, onEvent: hub.onEvent });
  board.registerAreas(plan.areas, plan.sharedPaths);
  board.registerUnits(plan.units);
  board.registerCards(structuredClone(plan.cards));
  hub.observer.onBoardReady?.(board);
  hub.observer.onPhase?.("running");

  const step = 2200;
  const review = async (cardId: string): Promise<void> => {
    board.move(cardId, "review");
    hub.onEvent({ type: "unit_status_changed", unitId: "rev-1", status: "working" });
    hub.onEvent({ type: "review_started", cardId, unitId: "rev-1" });
    usage();
    await sleep(step);
    hub.onEvent({ type: "review_result", cardId, verdict: "approve", summary: "기준을 충족합니다", findings: [] });
    board.move(cardId, "done");
    hub.onEvent({ type: "unit_status_changed", unitId: "rev-1", status: "idle" });
  };

  board.assign("api-1");
  await sleep(step); usage();
  await review("c1");

  board.assign("api-1"); // c2
  board.assign("api-2"); // c3
  board.assign("web-1"); // c4
  await sleep(step); usage();
  hub.onEvent({ type: "conflict_detected", path: "src/shared/types.ts", cardIds: ["c2", "c3"] });
  await sleep(step);
  hub.onEvent({ type: "conflict_resolved", path: "src/shared/types.ts" });
  usage();
  await review("c2");

  board.move("c4", "blocked");
  hub.onEvent({ type: "issue_raised", cardId: "c4", kind: "blocked", message: "화면 틀을 어떤 방식으로 만들지 정보가 부족합니다." });
  const answer = await hub.ask({ kind: "issue", cardId: "c4", title: "화면 뼈대", issueKind: "blocked", message: "화면 틀을 어떤 방식으로 만들지 정보가 부족합니다." });
  board.move("c4", "todo");
  if (answer.kind === "issue" && answer.decision === "retry") {
    board.assign("web-1");
  }
  await sleep(step); usage();
  await review("c3");
  await review("c4");

  board.assign("web-1");
  await sleep(step); usage();
  await review("c5");

  board.assign("int-1");
  await sleep(step); usage();
  await review("c6");

  hub.observer.onEnd?.({
    outcome: "finished", plan, message: null, totalCalls: calls,
    report: buildRunReport(board.getCards(), []),
    retrospective: {
      summary: "모든 카드를 끝냈습니다. 충돌 한 번과 막힌 카드 한 번이 있었지만 사용자의 확인으로 이어서 진행했습니다.",
      wentWell: ["검토 유닛이 모든 카드를 승인 전에 확인했습니다."],
      problems: ["공용 타입 파일에서 두 카드가 동시에 충돌했습니다.", "화면 뼈대 카드가 정보 부족으로 막혔습니다."],
      nextSteps: ["공용 파일을 쓰는 카드는 선행 관계로 순서를 정합니다.", "카드 설명에 화면 틀의 방식을 미리 적습니다."],
    },
    usage: { inputTokens: tokens, outputTokens: Math.round(tokens / 4) },
  } as never);
}
