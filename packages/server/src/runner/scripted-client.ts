import { LlmError } from "./llm.js";
import type { LlmClient, LlmRequest, LlmResponse, ToolCall } from "./llm.js";

// 테스트용: 미리 정해 둔 답을 호출 순서대로 돌려주는 가짜 클라이언트.
// 단계가 함수이면 호출 때 실행해서, 답이 늦게 오는 상황이나 그 사이 벌어지는 일을 흉내 낼 수 있다.
export type ScriptedStep =
  | LlmResponse
  | LlmError
  | ((request: LlmRequest) => Promise<LlmResponse | LlmError>);

export class ScriptedClient implements LlmClient {
  readonly requests: LlmRequest[] = [];
  private readonly steps: ScriptedStep[];

  constructor(steps: ScriptedStep[]) {
    this.steps = [...steps];
  }

  async complete(request: LlmRequest): Promise<LlmResponse> {
    this.requests.push(request);
    const step = this.steps.shift();
    if (step === undefined) {
      throw new Error("ScriptedClient ran out of steps");
    }
    const result = typeof step === "function" ? await step(request) : step;
    if (result instanceof LlmError) {
      throw result;
    }
    return result;
  }
}

export function reply(
  calls: ToolCall[],
  inputTokens = 10,
  outputTokens = 5,
): LlmResponse {
  return {
    toolCalls: calls,
    stopReason: "tool_use",
    usage: { inputTokens, outputTokens },
  };
}

export function propose(
  files: { path: string; content: string }[],
  summary = "done",
): ToolCall {
  return { name: "propose_changes", input: { summary, changes: files } };
}
