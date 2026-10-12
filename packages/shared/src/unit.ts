export const UNIT_KINDS = [
  "planner",
  "scheduler",
  "builder",
  "reviewer",
  "integrator",
] as const;

export type UnitKind = (typeof UNIT_KINDS)[number];

export const PERMISSION_LEVELS = ["read", "propose"] as const;

export type PermissionLevel = (typeof PERMISSION_LEVELS)[number];

export const UNIT_STATUSES = ["idle", "working", "paused", "failed"] as const;

export type UnitStatus = (typeof UNIT_STATUSES)[number];

// 경로는 항상 "/"로 적는다. 예: "src/app.ts"
export interface WorkScope {
  read: string[];
  write: string[];
}

export interface UnitSpec {
  id: string;
  kind: UnitKind;
  role: string;
  scope: WorkScope;
  permission: PermissionLevel;
  reportFormat: string;
}
