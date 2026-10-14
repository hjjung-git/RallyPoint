import type { Plan } from "@rallypoint/shared";
import { LlmError } from "../runner/llm.js";
import type { LlmClient, TokenUsage, ToolDefinition } from "../runner/llm.js";
import { defaultSleep, retryDelayMs } from "../runner/runner.js";
import { parsePlan } from "./plan-format.js";
import { validatePlan } from "./plan-validation.js";

export const SUBMIT_PLAN = "submit_plan";
export const ASK_USER = "ask_user";

export const PLANNER_MAX_TOKENS = 16000;
// 계획은 형식과 규칙을 한 번에 맞추기 어려워 실행기보다 시도 횟수를 넉넉히 준다.
export const PLANNER_MAX_ATTEMPTS = 4;
export const MAX_QUESTIONS = 5;

export interface PlanRequest {
  goal: string;
  // 사용자가 Planner의 질문에 답한 내용. 있으면 더 질문하지 않고 계획을 내야 한다.
  answers?: { question: string; answer: string }[];
  // 사용자가 계획을 보고 수정을 요청한 경우. 이전 계획과 요청 글.
  revision?: { plan: Plan; feedback: string };
}

export interface PlannerOptions {
  maxTokens?: number;
  maxAttempts?: number;
  sleep?: (ms: number) => Promise<void>;
}

export type PlannerFailure =
  | "llm_error"
  | "invalid_output" // 도구를 잘못 부르거나 계획 모양이 어긋남
  | "invalid_plan" // 모양은 맞지만 규칙에 어긋남
  | "truncated";

export type PlannerResult =
  | { status: "plan"; plan: Plan; usage: TokenUsage; attempts: number }
  | { status: "questions"; questions: string[]; usage: TokenUsage; attempts: number }
  | {
      status: "failed";
      failure: PlannerFailure;
      message: string;
      usage: TokenUsage;
      attempts: number;
    };

// 목표 프롬프트로 계획을 만든다. 목표가 모호하면 질문을 한 번만 내놓을 수 있다.
export async function planProject(
  client: LlmClient,
  request: PlanRequest,
  options: PlannerOptions = {},
): Promise<PlannerResult> {
  const maxTokens = options.maxTokens ?? PLANNER_MAX_TOKENS;
  const maxAttempts = options.maxAttempts ?? PLANNER_MAX_ATTEMPTS;
  const sleep = options.sleep ?? defaultSleep;

  // 질문은 처음 계획을 낼 때 한 번만 허용한다. 답을 받았거나 수정 중이면 계획을 내야 한다.
  const mayAsk = request.answers === undefined && request.revision === undefined;
  const tools = mayAsk ? [submitPlanTool, askUserTool] : [submitPlanTool];
  const system = buildSystem(mayAsk);
  const basePrompt = buildPrompt(request);

  const usage: TokenUsage = { inputTokens: 0, outputTokens: 0 };
  let attempts = 0;
  let lastFailure: PlannerFailure = "invalid_output";
  let feedback: string | null = null;

  while (attempts < maxAttempts) {
    attempts += 1;
    const prompt =
      feedback === null
        ? basePrompt
        : `${basePrompt}\n\nYour previous answer was rejected: ${feedback}\nAnswer again and fix this.`;

    let response;
    try {
      response = await client.complete({ system, prompt, tools, maxTokens });
    } catch (error) {
      if (!(error instanceof LlmError)) {
        throw error;
      }
      if (!error.retryable || attempts >= maxAttempts) {
        return { status: "failed", failure: "llm_error", message: error.message, usage, attempts };
      }
      await sleep(retryDelayMs(attempts));
      continue;
    }
    usage.inputTokens += response.usage.inputTokens;
    usage.outputTokens += response.usage.outputTokens;

    if (response.stopReason === "max_tokens") {
      return {
        status: "failed",
        failure: "truncated",
        message: `The plan was cut off at ${maxTokens} tokens. Ask for a smaller project or split the goal.`,
        usage,
        attempts,
      };
    }

    const rejected = (failure: PlannerFailure, message: string): void => {
      lastFailure = failure;
      feedback = message;
    };

    if (response.toolCalls.length !== 1) {
      rejected("invalid_output", `Call exactly one tool, but ${response.toolCalls.length} tool calls were made.`);
      continue;
    }
    const call = response.toolCalls[0] as { name: string; input: unknown };
    if (!tools.some((tool) => tool.name === call.name)) {
      rejected(
        "invalid_output",
        `Tool "${call.name}" is not available now. Use: ${tools.map((tool) => tool.name).join(", ")}.`,
      );
      continue;
    }

    if (call.name === ASK_USER) {
      const questions = parseQuestions(call.input);
      if (questions === null) {
        rejected("invalid_output", `"questions" must be an array of 1 to ${MAX_QUESTIONS} non-empty strings.`);
        continue;
      }
      return { status: "questions", questions, usage, attempts };
    }

    const parsed = parsePlan(call.input);
    if (!parsed.ok) {
      rejected("invalid_output", parsed.message);
      continue;
    }
    const problem = validatePlan(parsed.plan);
    if (problem !== null) {
      rejected("invalid_plan", problem);
      continue;
    }
    return { status: "plan", plan: parsed.plan, usage, attempts };
  }

  return {
    status: "failed",
    failure: lastFailure,
    message: feedback ?? "No attempts were made.",
    usage,
    attempts,
  };
}

function parseQuestions(input: unknown): string[] | null {
  if (typeof input !== "object" || input === null) {
    return null;
  }
  const questions = (input as { questions?: unknown }).questions;
  if (
    !Array.isArray(questions) ||
    questions.length === 0 ||
    questions.length > MAX_QUESTIONS ||
    !questions.every((q) => typeof q === "string" && q.trim() !== "")
  ) {
    return null;
  }
  return questions as string[];
}

function buildSystem(mayAsk: boolean): string {
  const lines = [
    "You are the Planner of RallyPoint, a system where several units build a software project together in an empty folder.",
    "Turn the user's goal into a plan that the system can execute. Answer only by calling exactly one tool.",
    "",
    "Plan rules:",
    "- Split the work into a few areas (big work zones). Every area needs at least one builder unit. Add more units only when the work really needs them.",
    "- Unit kinds: builder (writes files, permission \"propose\", belongs to exactly one area), reviewer (read-only, permission \"read\", empty write scope), integrator (joins areas; set areaId to null to work across areas).",
    "- A unit's write scope must lie inside its area's write scope. Areas may overlap in write scope only inside sharedPaths.",
    "- Scope entries are either an exact file path (\"src/app.ts\") or a folder prefix ending with \"/\" (\"src/\"). Use \"/\" separators, no wildcards, no absolute paths, no \"..\".",
    "- Cards are small tasks. Each card has a unitKind, an areaId (required for builder cards; null only for cards any area's unit may take), a scope, dependsOn (ids of cards that must be done first, no cycles), doneCriteria that can be checked, and an iteration number starting at 1 (later iterations build on earlier ones).",
    "- Every card needs a unit of its kind that can take it. Cards that write files need a unit with permission \"propose\".",
    "- Use short unique ASCII ids. Keep the plan as small as the goal allows: fewer, clearer cards are better than many vague ones.",
    "- estimatedCalls is your rough estimate of total model calls to finish, counting retries and reviews. It must be at least the number of cards.",
  ];
  if (mayAsk) {
    lines.push(
      "",
      "If the goal is too ambiguous to plan well, call ask_user once with up to 5 short questions. You get only one round of answers, so ask only what changes the plan. Otherwise call submit_plan directly.",
    );
  } else {
    lines.push("", "Call submit_plan. You cannot ask more questions.");
  }
  return lines.join("\n");
}

function buildPrompt(request: PlanRequest): string {
  const parts = [`Goal:\n${request.goal}`];
  if (request.answers && request.answers.length > 0) {
    parts.push(
      "The user answered your questions:\n" +
        request.answers.map((qa) => `Q: ${qa.question}\nA: ${qa.answer}`).join("\n\n"),
    );
  }
  if (request.revision) {
    parts.push(
      `Your previous plan:\n${JSON.stringify(toPlainPlan(request.revision.plan), null, 2)}`,
      `The user asked for changes:\n${request.revision.feedback}\nSubmit a revised full plan.`,
    );
  }
  return parts.join("\n\n");
}

// 모델이 채우지 않는 실행 상태(status, assignedUnitId)는 빼고 보여 준다.
function toPlainPlan(plan: Plan): unknown {
  return {
    ...plan,
    cards: plan.cards.map(({ status: _status, assignedUnitId: _assigned, ...rest }) => rest),
  };
}

const scopeSchema = {
  type: "object",
  properties: {
    read: { type: "array", items: { type: "string" } },
    write: { type: "array", items: { type: "string" } },
  },
  required: ["read", "write"],
};

const unitKindSchema = { type: "string", enum: ["builder", "reviewer", "integrator"] };

const submitPlanTool: ToolDefinition = {
  name: SUBMIT_PLAN,
  description: "Submit the complete plan: areas, shared paths, units, cards and the estimated number of model calls.",
  inputSchema: {
    type: "object",
    properties: {
      areas: {
        type: "array",
        items: {
          type: "object",
          properties: {
            id: { type: "string" },
            name: { type: "string" },
            goal: { type: "string" },
            scope: scopeSchema,
          },
          required: ["id", "name", "goal", "scope"],
        },
      },
      sharedPaths: { type: "array", items: { type: "string" } },
      units: {
        type: "array",
        items: {
          type: "object",
          properties: {
            id: { type: "string" },
            kind: unitKindSchema,
            role: { type: "string", description: "What this unit specializes in." },
            scope: scopeSchema,
            permission: { type: "string", enum: ["read", "propose"] },
            reportFormat: { type: "string", description: "How the unit should report." },
            areaId: { type: ["string", "null"] },
          },
          required: ["id", "kind", "role", "scope", "permission", "reportFormat", "areaId"],
        },
      },
      cards: {
        type: "array",
        items: {
          type: "object",
          properties: {
            id: { type: "string" },
            title: { type: "string" },
            description: { type: "string" },
            unitKind: unitKindSchema,
            areaId: { type: ["string", "null"] },
            scope: scopeSchema,
            dependsOn: { type: "array", items: { type: "string" } },
            doneCriteria: { type: "string" },
            iteration: { type: "integer", minimum: 1 },
          },
          required: ["id", "title", "description", "unitKind", "areaId", "scope", "dependsOn", "doneCriteria", "iteration"],
        },
      },
      estimatedCalls: { type: "integer", minimum: 1 },
    },
    required: ["areas", "sharedPaths", "units", "cards", "estimatedCalls"],
  },
};

const askUserTool: ToolDefinition = {
  name: ASK_USER,
  description: "Ask the user clarifying questions before planning. Allowed only once, with at most 5 questions.",
  inputSchema: {
    type: "object",
    properties: {
      questions: { type: "array", items: { type: "string" } },
    },
    required: ["questions"],
  },
};
