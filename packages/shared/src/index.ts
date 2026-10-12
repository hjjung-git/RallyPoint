export const ROLES = ["planner", "worker"] as const;

export type Role = (typeof ROLES)[number];
