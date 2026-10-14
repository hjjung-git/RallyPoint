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

// 범위 항목은 정확한 파일 경로("src/app.ts") 또는 "/"로 끝나는 폴더 접두어("src/")다.
// 경로는 항상 "/"로 적는다.
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
  // 소속 영역. builder는 반드시 영역 하나에 속한다.
  // 그 밖의 유닛(reviewer, integrator 등)은 null이면 모든 영역에 걸쳐 일한다.
  areaId: string | null;
}
