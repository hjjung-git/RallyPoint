import Anthropic from "@anthropic-ai/sdk";
import { LlmError } from "./llm.js";
import type { LlmClient, LlmRequest, LlmResponse, LlmStopReason } from "./llm.js";

export interface AnthropicClientOptions {
  apiKey: string;
  model: string;
}

// Anthropic SDK를 LlmClient 모양으로 감싼다.
// SDK의 자동 재시도는 끄고(maxRetries: 0), 재시도는 실행기가 한 곳에서 맡는다.
// 이 모델은 도구 호출 강제(tool_choice any)를 지원하지 않으므로 auto로 두고,
// 도구를 안 부른 답은 실행기가 이유를 붙여 다시 묻는다.
export function createAnthropicClient(options: AnthropicClientOptions): LlmClient {
  const sdk = new Anthropic({ apiKey: options.apiKey, maxRetries: 0 });

  return {
    async complete(request: LlmRequest): Promise<LlmResponse> {
      try {
        const response = await sdk.messages.create({
          model: options.model,
          max_tokens: request.maxTokens,
          system: request.system,
          messages: [{ role: "user", content: request.prompt }],
          tools: request.tools.map((tool) => ({
            name: tool.name,
            description: tool.description,
            input_schema: tool.inputSchema as Anthropic.Tool.InputSchema,
          })),
          tool_choice: { type: "auto" },
        });

        const toolCalls = response.content.flatMap((block) =>
          block.type === "tool_use" ? [{ name: block.name, input: block.input }] : [],
        );
        return {
          toolCalls,
          stopReason: mapStopReason(response.stop_reason),
          usage: {
            inputTokens: response.usage.input_tokens,
            outputTokens: response.usage.output_tokens,
          },
        };
      } catch (error) {
        throw toLlmError(error);
      }
    },
  };
}

function mapStopReason(reason: string | null): LlmStopReason {
  if (reason === "tool_use") return "tool_use";
  if (reason === "max_tokens") return "max_tokens";
  return "other";
}

// 일시적 오류(연결 끊김, 시간 초과, 요청 과다, 서버 오류)만 다시 시도할 수 있다.
function toLlmError(error: unknown): LlmError {
  if (error instanceof Anthropic.APIConnectionError) {
    return new LlmError(error.message, true);
  }
  if (error instanceof Anthropic.APIError) {
    const status = error.status;
    const retryable =
      status === 408 ||
      status === 409 ||
      status === 429 ||
      (status !== undefined && status >= 500);
    return new LlmError(error.message, retryable);
  }
  const message = error instanceof Error ? error.message : String(error);
  return new LlmError(message, false);
}
