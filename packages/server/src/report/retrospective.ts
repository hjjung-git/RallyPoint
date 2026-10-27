import { describeIteration } from "@rallypoint/shared";
import type { DashboardEvent, Retrospective, RunReport } from "@rallypoint/shared";
import { LlmError } from "../runner/llm.js";
import type { LlmClient, TokenUsage, ToolDefinition } from "../runner/llm.js";
import { defaultSleep, retryDelayMs } from "../runner/runner.js";

export const SUBMIT_RETROSPECTIVE = "submit_retrospective";
export const RETROSPECTIVE_MAX_TOKENS = 4000;
export const RETROSPECTIVE_MAX_ATTEMPTS = 2;
const MAX_ITEMS = 8;
const MAX_ITEM_CHARS = 300;
const MAX_FACTS = 20;

export interface RetrospectiveInput {
  goal: string;
  outcome: string;
  report: RunReport;
  events: DashboardEvent[];
}

export interface RetrospectiveOptions {
  maxAttempts?: number;
  sleep?: (ms: number) => Promise<void>;
}

export type RetrospectiveResult =
  | { status: "ok"; retrospective: Retrospective; usage: TokenUsage; calls: number }
  | { status: "failed"; message: string; usage: TokenUsage; calls: number };

const tool: ToolDefinition = {
  name: SUBMIT_RETROSPECTIVE,
  description: "Submit the retrospective of this run.",
  inputSchema: {
    type: "object",
    properties: {
      summary: { type: "string", description: "Two or three sentences on how the run went." },
      wentWell: { type: "array", items: { type: "string" } },
      problems: { type: "array", items: { type: "string" } },
      nextSteps: { type: "array", items: { type: "string" } },
    },
    required: ["summary", "wentWell", "problems", "nextSteps"],
  },
};

const SYSTEM = [
  "You write a short retrospective of a finished multi-unit software build.",
  "Use only the facts given. Do not invent causes you cannot see in the facts; say when something is unknown.",
  "Write in the same language as the goal. Keep each item to one or two sentences.",
  `Call ${SUBMIT_RETROSPECTIVE} exactly once.`,
].join("\n");

// 모델에게 줄 사실 목록. 숫자 보고에 검토 지적과 문제 내용을 더한다.
export function buildRetrospectivePrompt(input: RetrospectiveInput): string {
  const lines: string[] = [`Goal:\n${input.goal}`, "", `Outcome: ${input.outcome}`, "", "Iterations:"];
  for (const iteration of input.report.iterations) {
    lines.push(`- ${describeIteration(iteration)}`);
    // 어떤 카드가 어느 반복이었는지 알아야 "왜 반복이 더 필요했나" 같은 해석을 할 수 있다.
    for (const card of iteration.cards) {
      lines.push(`    - ${card.id} "${card.title}" (${card.status})`);
    }
  }

  const facts: string[] = [];
  for (const event of input.events) {
    if (event.type === "review_result" && event.verdict === "reject") {
      facts.push(`Review rejected card ${event.cardId}: ${event.summary} ${event.findings.join("; ")}`.trim());
    } else if (event.type === "issue_raised") {
      facts.push(`Issue on card ${event.cardId} (${event.kind}): ${event.message}`);
    } else if (event.type === "conflict_detected") {
      facts.push(`Conflict on ${event.path} between cards ${event.cardIds.join(", ")}`);
    } else if (event.type === "verification_result" && event.status === "failed") {
      const target = event.cardId === null ? "Whole-project tests" : `Tests for card ${event.cardId}`;
      facts.push(`${target} failed: ${event.summary}`);
    }
  }
  lines.push("", "Notable events:");
  if (facts.length === 0) {
    lines.push("- none");
  }
  for (const fact of facts.slice(0, MAX_FACTS)) {
    lines.push(`- ${fact}`);
  }
  if (facts.length > MAX_FACTS) {
    lines.push(`- (${facts.length - MAX_FACTS} more not shown)`);
  }
  return lines.join("\n");
}

function strings(value: unknown): string[] | null {
  if (!Array.isArray(value) || !value.every((v) => typeof v === "string")) return null;
  return (value as string[])
    .map((v) => v.trim().slice(0, MAX_ITEM_CHARS))
    .filter((v) => v !== "")
    .slice(0, MAX_ITEMS);
}

export type ParseRetrospectiveResult = { ok: true; retrospective: Retrospective } | { ok: false; message: string };

// 어느 항목이 잘못됐는지 알려 주도록 자세히 읽는다.
export function parseRetrospectiveDetailed(input: unknown): ParseRetrospectiveResult {
  if (typeof input !== "object" || input === null) {
    return { ok: false, message: "The retrospective was not an object." };
  }
  const o = input as Record<string, unknown>;
  if (typeof o.summary !== "string" || o.summary.trim() === "") {
    return { ok: false, message: "The retrospective has no summary." };
  }
  const lists: Record<string, string[] | null> = {
    wentWell: strings(o.wentWell),
    problems: strings(o.problems),
    nextSteps: strings(o.nextSteps),
  };
  for (const [name, value] of Object.entries(lists)) {
    if (value === null) return { ok: false, message: `"${name}" must be an array of strings.` };
  }
  return {
    ok: true,
    retrospective: {
      summary: o.summary.trim().slice(0, 600),
      wentWell: lists.wentWell as string[],
      problems: lists.problems as string[],
      nextSteps: lists.nextSteps as string[],
    },
  };
}

export function parseRetrospective(input: unknown): Retrospective | null {
  const parsed = parseRetrospectiveDetailed(input);
  return parsed.ok ? parsed.retrospective : null;
}

// 회고는 부가 기능이라 실패해도 실행 결과를 해치지 않는다. 실패하면 이유만 돌려준다.
export async function writeRetrospective(
  client: LlmClient,
  input: RetrospectiveInput,
  options: RetrospectiveOptions = {},
): Promise<RetrospectiveResult> {
  const maxAttempts = options.maxAttempts ?? RETROSPECTIVE_MAX_ATTEMPTS;
  const sleep = options.sleep ?? defaultSleep;
  const usage: TokenUsage = { inputTokens: 0, outputTokens: 0 };
  let calls = 0;
  const prompt = buildRetrospectivePrompt(input);

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      calls += 1;
      const response = await client.complete({
        system: SYSTEM,
        prompt,
        tools: [tool],
        maxTokens: RETROSPECTIVE_MAX_TOKENS,
      });
      usage.inputTokens += response.usage.inputTokens;
      usage.outputTokens += response.usage.outputTokens;
      if (response.stopReason === "max_tokens") {
        return { status: "failed", message: `The retrospective was cut off at ${RETROSPECTIVE_MAX_TOKENS} tokens.`, usage, calls };
      }
      const call = response.toolCalls.find((c) => c.name === SUBMIT_RETROSPECTIVE);
      if (!call) {
        return { status: "failed", message: `The model did not call ${SUBMIT_RETROSPECTIVE}.`, usage, calls };
      }
      const parsed = parseRetrospectiveDetailed(call.input);
      if (parsed.ok) {
        return { status: "ok", retrospective: parsed.retrospective, usage, calls };
      }
      return { status: "failed", message: parsed.message, usage, calls };
    } catch (error) {
      if (error instanceof LlmError && error.retryable && attempt < maxAttempts) {
        await sleep(retryDelayMs(attempt));
        continue;
      }
      return {
        status: "failed",
        message: error instanceof Error ? error.message : String(error),
        usage,
        calls,
      };
    }
  }
  return { status: "failed", message: "Retrospective failed.", usage, calls };
}
