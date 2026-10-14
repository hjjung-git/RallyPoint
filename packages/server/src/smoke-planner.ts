// 실제 API로 Planner를 한 번 돌려 보는 확인용 스크립트. 호출 비용이 든다(실행기보다 크다).
// 실행: node --env-file=.env packages/server/dist/smoke-planner.js "목표 프롬프트"
import { createAnthropicClient } from "./runner/anthropic-client.js";
import { planProject } from "./planner/planner.js";

const apiKey = process.env.ANTHROPIC_API_KEY;
const model = process.env.ANTHROPIC_MODEL;
if (!apiKey || !model) {
  console.error("ANTHROPIC_API_KEY and ANTHROPIC_MODEL must be set in .env");
  process.exit(1);
}

const goal =
  process.argv[2] ??
  "Build a small command-line todo app in TypeScript with add, list and done commands, plus a short README.";

const client = createAnthropicClient({ apiKey, model });
const result = await planProject(client, { goal });

if (result.status === "plan") {
  const { plan } = result;
  console.log(`areas: ${plan.areas.map((a) => a.id).join(", ")}`);
  console.log(`units: ${plan.units.map((u) => `${u.id}(${u.kind})`).join(", ")}`);
  for (const card of plan.cards) {
    console.log(
      `card ${card.id} [${card.unitKind}/${card.areaId ?? "-"}] iter ${card.iteration} deps [${card.dependsOn.join(", ")}]: ${card.title}`,
    );
  }
  console.log(`estimatedCalls: ${plan.estimatedCalls}`);
} else {
  console.log(JSON.stringify(result, null, 2));
}
console.log("usage:", result.usage, "attempts:", result.attempts);
