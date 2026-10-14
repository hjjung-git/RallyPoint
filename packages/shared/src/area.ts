import type { WorkScope } from "./unit.js";

// 영역: Planner가 처음에 크게 나눈 작업 구역이다.
// 영역 안에 유닛이 하나 이상 소속되고, 유닛의 쓰기 범위는 자기 영역의 쓰기 범위 안에 있어야 한다.
export interface Area {
  id: string;
  name: string;
  goal: string;
  scope: WorkScope;
}
