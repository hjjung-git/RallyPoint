import type { Card, FileChange, UnitSpec } from "@rallypoint/shared";
import { isCoveredByAny } from "../board/scope.js";
import type { Workspace } from "../workspace/workspace.js";
import { LlmError } from "./llm.js";
import type { LlmClient, TokenUsage } from "./llm.js";
import { parseToolCalls, toolsFor } from "./tools.js";

export const DEFAULT_MAX_TOKENS = 8192;
export const DEFAULT_MAX_ATTEMPTS = 3;
export const DEFAULT_MAX_CONTEXT_CHARS = 400_000;

export interface RunOptions {
  maxTokens?: number;
  // 호출 실패나 형식 오류 때 다시 시도하는 횟수를 포함한 총 시도 횟수
  maxAttempts?: number;
  // 모델에 보여줄 파일 내용의 최대 글자 수
  maxContextChars?: number;
  // 재시도 전 대기. 테스트에서 바꿔 끼운다.
  sleep?: (ms: number) => Promise<void>;
}

export type RunFailureKind =
  | "llm_error" // 호출이 계속 실패했다
  | "invalid_output" // 모델이 계속 형식에 맞지 않게 답했다
  | "truncated" // 답이 길이 제한에서 잘렸다
  | "context_too_large" // 보여줄 파일이 너무 많다
  | "apply_rejected"; // 변경안이 범위나 경로 규칙에 어긋나 거부됐다

export type RunResult =
  | {
      status: "completed";
      summary: string;
      // 적용된 파일의 새 버전. 읽기 전용 유닛이면 비어 있다.
      versions: Record<string, number>;
      usage: TokenUsage;
      attempts: number;
    }
  | { status: "blocked"; reason: string; usage: TokenUsage; attempts: number }
  | {
      status: "conflict";
      path: string | null;
      currentVersion: number | null;
      // 충돌 상대 카드
      lastCardId: string | null;
      message: string;
      usage: TokenUsage;
      attempts: number;
    }
  | {
      status: "failed";
      failure: RunFailureKind;
      message: string;
      usage: TokenUsage;
      attempts: number;
    };

// 카드 하나를 유닛이 한 번 수행한다.
// 모델이 보는 파일의 버전을 호출 전에 기록해 두고, 모델이 낸 변경안의 baseVersion으로 쓴다.
// 호출 사이에 다른 카드가 같은 파일을 바꿨다면 작업공간이 version_mismatch로 막고, 여기서는 conflict로 알린다.
export async function runCard(
  client: LlmClient,
  workspace: Workspace,
  unit: UnitSpec,
  card: Card,
  options: RunOptions = {},
): Promise<RunResult> {
  const maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS;
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const maxContextChars = options.maxContextChars ?? DEFAULT_MAX_CONTEXT_CHARS;
  const sleep = options.sleep ?? defaultSleep;

  const usage: TokenUsage = { inputTokens: 0, outputTokens: 0 };
  let attempts = 0;
  const fail = (failure: RunFailureKind, message: string): RunResult => ({
    status: "failed",
    failure,
    message,
    usage,
    attempts,
  });

  // 1. 모델에 보여줄 파일과 그 시점의 버전을 기록한다.
  const versions = new Map<string, number>();
  const sections: string[] = [];
  let contextChars = 0;
  for (const path of listVisibleFiles(workspace, card)) {
    const snapshot = workspace.read(path);
    versions.set(path, snapshot.version);
    const content = snapshot.content ?? "";
    contextChars += content.length;
    sections.push(`<file path="${path}" version="${snapshot.version}">\n${content}\n</file>`);
  }
  if (contextChars > maxContextChars) {
    return fail(
      "context_too_large",
      `Files for this card total ${contextChars} characters (limit ${maxContextChars}).`,
    );
  }

  // 2. 쓰기 범위는 카드 범위와 유닛 범위의 교집합이다.
  const allowedWrite =
    unit.permission === "propose"
      ? card.scope.write.filter((entry) => isCoveredByAny(entry, unit.scope.write))
      : [];

  const system = buildSystem(unit);
  const basePrompt = buildPrompt(card, sections, allowedWrite);
  const tools = toolsFor(unit.permission);

  // 3. 호출하고, 실패나 형식 오류는 정해진 횟수까지 다시 시도한다.
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
        return fail("llm_error", error.message);
      }
      await sleep(retryDelayMs(attempts));
      continue;
    }
    usage.inputTokens += response.usage.inputTokens;
    usage.outputTokens += response.usage.outputTokens;

    if (response.stopReason === "max_tokens") {
      return fail("truncated", `The answer was cut off at ${maxTokens} tokens.`);
    }

    const parsed = parseToolCalls(unit.permission, response.toolCalls);
    if (parsed.kind === "invalid") {
      if (attempts >= maxAttempts) {
        return fail("invalid_output", parsed.message);
      }
      feedback = parsed.message;
      continue;
    }
    if (parsed.kind === "blocked") {
      return { status: "blocked", reason: parsed.reason, usage, attempts };
    }
    if (parsed.kind === "report") {
      return { status: "completed", summary: parsed.summary, versions: {}, usage, attempts };
    }

    // 변경안: baseVersion은 보여준 시점의 버전. 보여준 적 없는 파일(새 파일)은 0이다.
    const changes: FileChange[] = parsed.changes.map((file) => ({
      path: file.path,
      baseVersion: versions.get(file.path) ?? 0,
      content: file.content,
    }));
    const applied = await workspace.applyChanges({
      cardId: card.id,
      changes,
      allowedWrite,
    });
    if (applied.ok) {
      return {
        status: "completed",
        summary: parsed.summary,
        versions: applied.versions,
        usage,
        attempts,
      };
    }
    if (applied.reason === "version_mismatch") {
      return {
        status: "conflict",
        path: applied.path,
        currentVersion: applied.currentVersion,
        lastCardId: applied.lastCardId,
        message: applied.message,
        usage,
        attempts,
      };
    }
    return fail("apply_rejected", applied.message);
  }

  // 반복문은 위에서 항상 return으로 끝나지만, 형식상 남겨 둔다.
  return fail("llm_error", "No attempts were made.");
}

// 카드가 읽을 수 있거나 쓸 수 있는 범위 안에서, 지금 작업공간에 있는 파일들
function listVisibleFiles(workspace: Workspace, card: Card): string[] {
  const entries = [...card.scope.read, ...card.scope.write];
  return workspace.list().filter((path) => isCoveredByAny(path, entries));
}

function buildSystem(unit: UnitSpec): string {
  const access =
    unit.permission === "propose"
      ? "You may propose file changes, which the system validates and applies."
      : "You are read-only: you cannot change files, only report findings.";
  return [
    "You are one unit in RallyPoint, a system where several units build a project together.",
    `Your role: ${unit.role}`,
    access,
    `Report format: ${unit.reportFormat}`,
    "Rules:",
    "- Answer only by calling exactly one tool.",
    '- Use relative paths with "/" separators and stay inside your write scope.',
    "- Work only on the card you are given; do not do other cards' work.",
    "- If the card cannot be done as written, use report_blocked instead of guessing.",
  ].join("\n");
}

function buildPrompt(card: Card, files: string[], allowedWrite: string[]): string {
  const parts = [
    `Card ${card.id}: ${card.title}`,
    `Description:\n${card.description}`,
    `Done criteria:\n${card.doneCriteria}`,
    `Files you may write: ${allowedWrite.length > 0 ? allowedWrite.join(", ") : "(none)"}`,
    files.length > 0
      ? `Current files:\n${files.join("\n")}`
      : "There are no existing files in your scope yet.",
  ];
  return parts.join("\n\n");
}

// 1초, 2초, 4초... 순으로 늘린다.
function retryDelayMs(attempt: number): number {
  return 1000 * 2 ** (attempt - 1);
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
