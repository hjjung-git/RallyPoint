import type { Card, DashboardEvent, Plan } from "@rallypoint/shared";
import { LlmError } from "../runner/llm.js";
import type { LlmClient, TokenUsage, ToolDefinition } from "../runner/llm.js";
import { defaultSleep, retryDelayMs } from "../runner/runner.js";
import { parseCards } from "./plan-format.js";
import { cardSchema } from "./planner.js";
import { validatePlan } from "./plan-validation.js";

export const SUBMIT_CARDS = "submit_cards";
export const FINISH_PROJECT = "finish_project";
export const NEXT_ITERATION_MAX_TOKENS = 8000;
export const NEXT_ITERATION_MAX_ATTEMPTS = 3;
export const MAX_NEW_CARDS = 8;
const MAX_FACTS = 15;

export interface NextIterationRequest {
  goal: string;
  // 지금까지의 계획(영역, 유닛, 처음 정의한 카드). 영역과 유닛은 바꾸지 않는다.
  plan: Plan;
  // 보드의 현재 카드 상태
  cards: Card[];
  // 새로 만들 반복 번호
  iteration: number;
  events: DashboardEvent[];
  // 사용자가 제안을 보고 고쳐 달라고 한 경우
  revision?: { cards: Card[]; feedback: string };
}

export interface NextIterationOptions {
  maxAttempts?: number;
  maxTokens?: number;
  sleep?: (ms: number) => Promise<void>;
}

export type NextIterationResult =
  | { status: "cards"; cards: Card[]; usage: TokenUsage; attempts: number }
  | { status: "done"; reason: string; usage: TokenUsage; attempts: number }
  | { status: "failed"; message: string; usage: TokenUsage; attempts: number };

const submitCardsTool: ToolDefinition = {
  name: SUBMIT_CARDS,
  description: "Submit only the NEW cards for the next iteration.",
  inputSchema: {
    type: "object",
    properties: { cards: { type: "array", items: cardSchema } },
    required: ["cards"],
  },
};

const finishTool: ToolDefinition = {
  name: FINISH_PROJECT,
  description: "Say that the goal is already met and no further iteration is needed.",
  inputSchema: {
    type: "object",
    properties: { reason: { type: "string" } },
    required: ["reason"],
  },
};

const SYSTEM = [
  "You are the Planner of RallyPoint. One iteration of the project is finished; decide whether another one is needed.",
  "Answer only by calling exactly one tool.",
  `- If the goal and its completion criteria are already met by the finished cards, call ${FINISH_PROJECT} with a short reason.`,
  `- Otherwise call ${SUBMIT_CARDS} with only the NEW cards (at most ${MAX_NEW_CARDS}) for the next iteration.`,
  "Rules for new cards:",
  "- Use only the existing areas and units. Do not add or change areas or units.",
  "- Card ids must be new and unique. dependsOn may reference existing cards. Set iteration to the number given.",
  "- Do not redo finished work. Cover what is missing, wrong or incomplete, using the review findings and issues as evidence.",
  "- Scope entries are exact file paths or folder prefixes ending with \"/\"; every write scope must lie inside the card's area.",
  "- Write titles, descriptions and doneCriteria in the same language as the goal.",
].join("\n");

export function buildNextIterationPrompt(request: NextIterationRequest): string {
  const lines = [`Goal:\n${request.goal}`, "", `Areas: ${request.plan.areas.map((a) => `${a.id} (${a.name})`).join(", ")}`];
  lines.push(
    `Units: ${request.plan.units.map((u) => `${u.id} [${u.kind}${u.areaId ? `, area ${u.areaId}` : ""}]`).join(", ")}`,
    "",
    "Existing cards:",
  );
  for (const card of request.cards) {
    lines.push(`- ${card.id} "${card.title}" (iteration ${card.iteration}, ${card.status}): done when ${card.doneCriteria}`);
  }

  const facts: string[] = [];
  for (const event of request.events) {
    if (event.type === "review_result" && event.verdict === "reject") {
      facts.push(`Review rejected card ${event.cardId}: ${event.summary} ${event.findings.join("; ")}`.trim());
    } else if (event.type === "issue_raised") {
      facts.push(`Issue on card ${event.cardId} (${event.kind}): ${event.message}`);
    }
  }
  lines.push("", "Notable events:");
  if (facts.length === 0) lines.push("- none");
  for (const fact of facts.slice(0, MAX_FACTS)) lines.push(`- ${fact}`);

  lines.push("", `The next iteration number is ${request.iteration}.`);
  if (request.revision) {
    lines.push(
      "",
      `You proposed these new cards earlier:\n${JSON.stringify(request.revision.cards.map(plainCard), null, 2)}`,
      `The user asked for changes:\n${request.revision.feedback}\nSubmit revised new cards (or finish if that is right).`,
    );
  }
  return lines.join("\n");
}

function plainCard({ status: _status, assignedUnitId: _assigned, ...rest }: Card): unknown {
  return rest;
}

// 끝난 반복 다음에 무엇을 할지 Planner에게 묻는다. 새 카드를 내거나, 이미 목표를 이뤘다고 답한다.
export async function planNextIteration(
  client: LlmClient,
  request: NextIterationRequest,
  options: NextIterationOptions = {},
): Promise<NextIterationResult> {
  const maxAttempts = options.maxAttempts ?? NEXT_ITERATION_MAX_ATTEMPTS;
  const maxTokens = options.maxTokens ?? NEXT_ITERATION_MAX_TOKENS;
  const sleep = options.sleep ?? defaultSleep;
  const basePrompt = buildNextIterationPrompt(request);
  const usage: TokenUsage = { inputTokens: 0, outputTokens: 0 };
  let attempts = 0;
  let feedback: string | null = null;
  let lastMessage = "The planner did not return usable cards.";

  while (attempts < maxAttempts) {
    attempts += 1;
    const prompt =
      feedback === null
        ? basePrompt
        : `${basePrompt}\n\nYour previous answer was rejected: ${feedback}\nAnswer again and fix this.`;

    let response;
    try {
      response = await client.complete({ system: SYSTEM, prompt, tools: [submitCardsTool, finishTool], maxTokens });
    } catch (error) {
      if (!(error instanceof LlmError)) throw error;
      if (!error.retryable || attempts >= maxAttempts) {
        return { status: "failed", message: error.message, usage, attempts };
      }
      await sleep(retryDelayMs(attempts));
      continue;
    }
    usage.inputTokens += response.usage.inputTokens;
    usage.outputTokens += response.usage.outputTokens;

    if (response.stopReason === "max_tokens") {
      return { status: "failed", message: "The answer was cut off.", usage, attempts };
    }
    const reject = (message: string): void => {
      feedback = message;
      lastMessage = message;
    };

    if (response.toolCalls.length !== 1) {
      reject(`Call exactly one tool, but ${response.toolCalls.length} tool calls were made.`);
      continue;
    }
    const call = response.toolCalls[0] as { name: string; input: unknown };

    if (call.name === FINISH_PROJECT) {
      const reason = (call.input as { reason?: unknown } | null)?.reason;
      return { status: "done", reason: typeof reason === "string" ? reason : "", usage, attempts };
    }
    if (call.name !== SUBMIT_CARDS) {
      reject(`Tool "${call.name}" is not available. Use ${SUBMIT_CARDS} or ${FINISH_PROJECT}.`);
      continue;
    }

    const parsed = parseCards((call.input as { cards?: unknown } | null)?.cards, "cards");
    if (!parsed.ok) {
      reject(parsed.message);
      continue;
    }
    if (parsed.cards.length === 0 || parsed.cards.length > MAX_NEW_CARDS) {
      reject(`Submit between 1 and ${MAX_NEW_CARDS} new cards.`);
      continue;
    }
    // 반복 번호는 모델이 틀리기 쉬워서 코드가 정해 준다.
    const cards = parsed.cards.map((card) => ({ ...card, iteration: request.iteration }));
    const combined: Plan = {
      ...request.plan,
      cards: [...request.plan.cards, ...cards],
      estimatedCalls: Math.max(request.plan.estimatedCalls, request.plan.cards.length + cards.length),
    };
    const problem = validatePlan(combined);
    if (problem !== null) {
      reject(problem);
      continue;
    }
    return { status: "cards", cards, usage, attempts };
  }
  return { status: "failed", message: lastMessage, usage, attempts };
}
