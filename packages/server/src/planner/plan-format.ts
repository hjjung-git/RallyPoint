import { PERMISSION_LEVELS } from "@rallypoint/shared";
import type { Area, Card, Plan, UnitSpec, WorkScope } from "@rallypoint/shared";

// Planner가 계획에 넣을 수 있는 유닛 종류. planner와 scheduler는 이 계획으로 만들어지는 유닛이 아니다.
export const PLANNABLE_KINDS = ["builder", "reviewer", "integrator"] as const;
type PlannableKind = (typeof PLANNABLE_KINDS)[number];

export type ParsePlanResult =
  | { ok: true; plan: Plan }
  | { ok: false; message: string };

class FormatError extends Error {}

// 모델이 도구로 낸 값을 Plan 모양으로 바꾼다. 모양이 어긋나면 어디가 어떻게 틀렸는지 알려 준다.
// 경로 문법이나 영역 규칙 같은 내용 검사는 validatePlan이 한다.
export function parsePlan(input: unknown): ParsePlanResult {
  try {
    const root = asObject(input, "plan");
    const plan: Plan = {
      areas: asArray(root.areas, "areas").map((v, i) => parseArea(v, `areas[${i}]`)),
      sharedPaths: asStringArray(root.sharedPaths, "sharedPaths"),
      units: asArray(root.units, "units").map((v, i) => parseUnit(v, `units[${i}]`)),
      cards: asArray(root.cards, "cards").map((v, i) => parseCard(v, `cards[${i}]`)),
      estimatedCalls: asInt(root.estimatedCalls, "estimatedCalls", 1),
    };
    return { ok: true, plan };
  } catch (error) {
    if (error instanceof FormatError) {
      return { ok: false, message: error.message };
    }
    throw error;
  }
}

// 카드 목록만 따로 읽는다(다음 반복에서 Planner가 새 카드만 낼 때 쓴다).
export function parseCards(input: unknown, path = "cards"): { ok: true; cards: Card[] } | { ok: false; message: string } {
  try {
    return { ok: true, cards: asArray(input, path).map((v, i) => parseCard(v, `${path}[${i}]`)) };
  } catch (error) {
    if (error instanceof FormatError) {
      return { ok: false, message: error.message };
    }
    throw error;
  }
}

function parseArea(value: unknown, path: string): Area {
  const o = asObject(value, path);
  return {
    id: asString(o.id, `${path}.id`),
    name: asString(o.name, `${path}.name`),
    goal: asString(o.goal, `${path}.goal`),
    scope: parseScope(o.scope, `${path}.scope`),
  };
}

function parseUnit(value: unknown, path: string): UnitSpec {
  const o = asObject(value, path);
  const permission = asString(o.permission, `${path}.permission`);
  if (!(PERMISSION_LEVELS as readonly string[]).includes(permission)) {
    throw new FormatError(`${path}.permission must be "read" or "propose".`);
  }
  return {
    id: asString(o.id, `${path}.id`),
    kind: asKind(o.kind, `${path}.kind`),
    role: asString(o.role, `${path}.role`),
    scope: parseScope(o.scope, `${path}.scope`),
    permission: permission as UnitSpec["permission"],
    reportFormat: asString(o.reportFormat, `${path}.reportFormat`),
    areaId: asNullableString(o.areaId, `${path}.areaId`),
  };
}

function parseCard(value: unknown, path: string): Card {
  const o = asObject(value, path);
  return {
    id: asString(o.id, `${path}.id`),
    title: asString(o.title, `${path}.title`),
    description: asString(o.description, `${path}.description`),
    unitKind: asKind(o.unitKind, `${path}.unitKind`),
    areaId: asNullableString(o.areaId, `${path}.areaId`),
    scope: parseScope(o.scope, `${path}.scope`),
    dependsOn: asStringArray(o.dependsOn, `${path}.dependsOn`),
    doneCriteria: asString(o.doneCriteria, `${path}.doneCriteria`),
    status: "todo",
    assignedUnitId: null,
    iteration: asInt(o.iteration, `${path}.iteration`, 1),
    ...(o.verify === undefined || (Array.isArray(o.verify) && o.verify.length === 0)
      ? {}
      : { verify: asStringArray(o.verify, `${path}.verify`) }),
  };
}

function parseScope(value: unknown, path: string): WorkScope {
  const o = asObject(value, path);
  return {
    read: asStringArray(o.read, `${path}.read`),
    write: asStringArray(o.write, `${path}.write`),
  };
}

function asKind(value: unknown, path: string): PlannableKind {
  if (typeof value !== "string" || !(PLANNABLE_KINDS as readonly string[]).includes(value)) {
    throw new FormatError(`${path} must be one of: ${PLANNABLE_KINDS.join(", ")}.`);
  }
  return value as PlannableKind;
}

function asObject(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new FormatError(`${path} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function asArray(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new FormatError(`${path} must be an array.`);
  }
  return value;
}

function asString(value: unknown, path: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new FormatError(`${path} must be a non-empty string.`);
  }
  return value;
}

function asNullableString(value: unknown, path: string): string | null {
  if (value === null) {
    return null;
  }
  return asString(value, `${path} (a string or null)`);
}

function asStringArray(value: unknown, path: string): string[] {
  return asArray(value, path).map((item, i) => {
    if (typeof item !== "string") {
      throw new FormatError(`${path}[${i}] must be a string.`);
    }
    return item;
  });
}

function asInt(value: unknown, path: string, min: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min) {
    throw new FormatError(`${path} must be an integer of ${min} or more.`);
  }
  return value;
}
