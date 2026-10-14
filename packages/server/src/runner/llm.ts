// 유닛 실행기가 모델과 주고받는 최소한의 형태.
// 실제 API(Anthropic SDK)는 anthropic-client.ts에서만 다루고, 나머지 코드는 이 인터페이스만 안다.
// 덕분에 테스트에서는 가짜 클라이언트를 끼워 넣을 수 있다.

export interface ToolDefinition {
  name: string;
  description: string;
  // JSON Schema (type: "object")
  inputSchema: Record<string, unknown>;
}

export interface LlmRequest {
  system: string;
  prompt: string;
  tools: ToolDefinition[];
  maxTokens: number;
}

export interface ToolCall {
  name: string;
  input: unknown;
}

export type LlmStopReason = "tool_use" | "max_tokens" | "other";

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface LlmResponse {
  toolCalls: ToolCall[];
  stopReason: LlmStopReason;
  usage: TokenUsage;
}

export interface LlmClient {
  complete(request: LlmRequest): Promise<LlmResponse>;
}

// 호출 실패. retryable이 true면 같은 요청을 다시 보내도 되는 일시적 오류다
// (네트워크 끊김, 속도 제한, 서버 오류). false면 다시 보내도 같은 결과다(키 오류, 잘못된 요청 등).
export class LlmError extends Error {
  readonly retryable: boolean;

  constructor(message: string, retryable: boolean) {
    super(message);
    this.name = "LlmError";
    this.retryable = retryable;
  }
}
