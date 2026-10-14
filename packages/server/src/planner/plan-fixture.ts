// 테스트용: 모델이 도구로 낼 법한 원본 형태의 계획
export function rawPlan(): Record<string, any> {
  return {
    areas: [
      { id: "web", name: "Web", goal: "Pages", scope: { read: ["src/"], write: ["src/web/", "src/shared/"] } },
      { id: "api", name: "API", goal: "Server", scope: { read: ["src/"], write: ["src/api/", "src/shared/"] } },
    ],
    sharedPaths: ["src/shared/"],
    units: [
      { id: "web-1", kind: "builder", role: "Builds pages", scope: { read: ["src/"], write: ["src/web/"] }, permission: "propose", reportFormat: "short", areaId: "web" },
      { id: "api-1", kind: "builder", role: "Builds the server", scope: { read: ["src/"], write: ["src/api/", "src/shared/"] }, permission: "propose", reportFormat: "short", areaId: "api" },
      { id: "rev-1", kind: "reviewer", role: "Reviews code", scope: { read: ["src/"], write: [] }, permission: "read", reportFormat: "short", areaId: null },
    ],
    cards: [
      { id: "c1", title: "Types", description: "Shared types", unitKind: "builder", areaId: "api", scope: { read: [], write: ["src/shared/"] }, dependsOn: [], doneCriteria: "types exist", iteration: 1 },
      { id: "c2", title: "Page", description: "Main page", unitKind: "builder", areaId: "web", scope: { read: ["src/shared/"], write: ["src/web/"] }, dependsOn: ["c1"], doneCriteria: "page exists", iteration: 1 },
    ],
    estimatedCalls: 5,
  };
}
