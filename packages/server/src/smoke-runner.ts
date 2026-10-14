// 실제 API로 유닛 실행기를 한 번 돌려 보는 확인용 스크립트. 호출 비용이 조금 든다.
// 실행: node --env-file=.env packages/server/dist/smoke-runner.js
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Card, UnitSpec } from "@rallypoint/shared";
import { Workspace } from "./workspace/workspace.js";
import { createAnthropicClient } from "./runner/anthropic-client.js";
import { runCard } from "./runner/runner.js";

const apiKey = process.env.ANTHROPIC_API_KEY;
const model = process.env.ANTHROPIC_MODEL;
if (!apiKey || !model) {
  console.error("ANTHROPIC_API_KEY and ANTHROPIC_MODEL must be set in .env");
  process.exit(1);
}

const folder = join(await mkdtemp(join(tmpdir(), "rp-smoke-")), "work");
const workspace = await Workspace.open(folder);

const unit: UnitSpec = {
  id: "u1",
  kind: "builder",
  role: "Writes small, clear documents",
  scope: { read: ["docs/"], write: ["docs/"] },
  permission: "propose",
  reportFormat: "One sentence",
  areaId: null,
};
const card: Card = {
  id: "c1",
  title: "Write a greeting document",
  description: "Create docs/hello.md with a title and one friendly sentence.",
  unitKind: "builder",
  areaId: null,
  scope: { read: [], write: ["docs/"] },
  dependsOn: [],
  doneCriteria: "docs/hello.md exists and is not empty",
  status: "in_progress",
  assignedUnitId: "u1",
  iteration: 1,
};

const client = createAnthropicClient({ apiKey, model });
const result = await runCard(client, workspace, unit, card);

console.log(JSON.stringify(result, null, 2));
console.log("workspace folder:", folder);
console.log("files:", workspace.list());
