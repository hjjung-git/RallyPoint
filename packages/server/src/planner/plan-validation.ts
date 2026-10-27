import type { Plan } from "@rallypoint/shared";
import { Board } from "../board/board.js";
import { isCoveredByAny, isValidScopeEntry } from "../board/scope.js";

// 계획이 실제로 돌아갈 수 있는지 검사한다. 문제가 없으면 null, 있으면 고칠 수 있게 이유를 돌려준다.
// 영역, 범위, 의존 관계 규칙은 보드 등록과 같은 코드로 검사해서 두 곳의 규칙이 어긋나지 않게 한다.
export function validatePlan(plan: Plan): string | null {
  if (plan.cards.length === 0) {
    return "The plan needs at least one card.";
  }
  if (plan.estimatedCalls < plan.cards.length) {
    return `estimatedCalls (${plan.estimatedCalls}) must be at least the number of cards (${plan.cards.length}).`;
  }

  for (const unit of plan.units) {
    if (unit.kind === "builder" && unit.permission !== "propose") {
      return `Unit "${unit.id}" is a builder, so its permission must be "propose".`;
    }
    if (unit.kind === "reviewer" && unit.permission !== "read") {
      return `Unit "${unit.id}" is a reviewer, so its permission must be "read".`;
    }
    if (unit.permission === "read" && unit.scope.write.length > 0) {
      return `Unit "${unit.id}" is read-only, so its write scope must be empty.`;
    }
  }

  const board = new Board();
  try {
    board.registerAreas(plan.areas, plan.sharedPaths);
    board.registerUnits(plan.units);
    board.registerCards(plan.cards);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }

  for (const area of plan.areas) {
    const hasBuilder = plan.units.some(
      (unit) => unit.kind === "builder" && unit.areaId === area.id,
    );
    if (!hasBuilder) {
      return `Area "${area.id}" has no builder unit. Every area needs at least one.`;
    }
  }

  // 검증 파일은 테스트로 돌릴 수 있는 .js 파일이어야 하고, 계획 안의 어느 카드가 만들 수 있는 위치여야 한다.
  const allWrite = plan.cards.flatMap((card) => card.scope.write);
  for (const card of plan.cards) {
    for (const file of card.verify ?? []) {
      if (!isValidScopeEntry(file) || file.endsWith("/") || !/\.(c|m)?js$/.test(file)) {
        return `Card "${card.id}" has an invalid verify path "${file}". Use a test file path ending in .js, .mjs or .cjs.`;
      }
      if (!isCoveredByAny(file, allWrite)) {
        return `Card "${card.id}" verifies "${file}", but no card in the plan can write that file.`;
      }
    }
  }

  // 카드를 가져갈 유닛이 없으면 실행 중에 멈춘다. 계획 단계에서 막는다.
  for (const card of plan.cards) {
    const candidates = plan.units.filter(
      (unit) =>
        unit.kind === card.unitKind &&
        (unit.areaId === null || unit.areaId === card.areaId),
    );
    if (candidates.length === 0) {
      return `Card "${card.id}" has no unit that can take it (kind "${card.unitKind}", area ${card.areaId === null ? "none" : `"${card.areaId}"`}).`;
    }
    if (
      card.scope.write.length > 0 &&
      !candidates.some((unit) => unit.permission === "propose")
    ) {
      return `Card "${card.id}" writes files, but every unit that could take it is read-only.`;
    }
  }

  return null;
}
