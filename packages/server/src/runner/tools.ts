import type { PermissionLevel } from "@rallypoint/shared";
import type { ToolCall, ToolDefinition } from "./llm.js";

export const PROPOSE_CHANGES = "propose_changes";
export const SUBMIT_REPORT = "submit_report";
export const SUBMIT_REVIEW = "submit_review";
export const REPORT_BLOCKED = "report_blocked";

// work: 카드의 일을 한다. review: 끝난 카드의 결과를 검토한다(읽기 전용 유닛만).
export type ToolMode = "work" | "review";

export interface ProposedFile {
  path: string;
  content: string;
}

export type ParsedOutput =
  | { kind: "changes"; summary: string; changes: ProposedFile[] }
  | { kind: "report"; summary: string }
  | { kind: "review"; verdict: "approve" | "reject"; summary: string; findings: string[] }
  | { kind: "blocked"; reason: string }
  | { kind: "invalid"; message: string };

const proposeChanges: ToolDefinition = {
  name: PROPOSE_CHANGES,
  description:
    "Submit the complete new content of every file you create or change for this card. " +
    "Each file is replaced as a whole, so always send full file content, never a diff.",
  inputSchema: {
    type: "object",
    properties: {
      summary: {
        type: "string",
        description: "Short report of what you did, in the requested report format.",
      },
      changes: {
        type: "array",
        description: "Files to create or replace.",
        items: {
          type: "object",
          properties: {
            path: {
              type: "string",
              description: 'Relative path with "/" separators, e.g. "src/app.ts".',
            },
            content: { type: "string", description: "Full new content of the file." },
          },
          required: ["path", "content"],
        },
      },
    },
    required: ["summary", "changes"],
  },
};

const submitReport: ToolDefinition = {
  name: SUBMIT_REPORT,
  description:
    "Submit your findings for this card. You cannot change files; this report is your whole output.",
  inputSchema: {
    type: "object",
    properties: {
      summary: {
        type: "string",
        description: "Your findings, in the requested report format.",
      },
    },
    required: ["summary"],
  },
};

const submitReview: ToolDefinition = {
  name: SUBMIT_REVIEW,
  description:
    "Submit your verdict on the finished work of this card. Approve only if the files shown meet " +
    "the done criteria. If you reject, list concrete findings the builder can act on.",
  inputSchema: {
    type: "object",
    properties: {
      verdict: { type: "string", enum: ["approve", "reject"] },
      summary: { type: "string", description: "Short reason for the verdict." },
      findings: {
        type: "array",
        items: { type: "string" },
        description: "What must be fixed. Required when rejecting.",
      },
    },
    required: ["verdict", "summary", "findings"],
  },
};

const reportBlocked: ToolDefinition = {
  name: REPORT_BLOCKED,
  description:
    "Use this only when the card cannot be done as written (missing information, " +
    "contradictory requirements, something outside your scope). Explain why.",
  inputSchema: {
    type: "object",
    properties: {
      reason: { type: "string", description: "Why the card cannot be completed." },
    },
    required: ["reason"],
  },
};

// 권한에 따라 쓸 수 있는 도구가 다르다. 읽기 전용 유닛에는 파일을 바꾸는 도구 자체를 주지 않는다.
export function toolsFor(
  permission: PermissionLevel,
  mode: ToolMode = "work",
): ToolDefinition[] {
  if (mode === "review") {
    return [submitReview, reportBlocked];
  }
  return permission === "propose"
    ? [proposeChanges, reportBlocked]
    : [submitReport, reportBlocked];
}

// 모델의 도구 호출을 검사해 정해진 형태로 바꾼다. 형태가 어긋나면 invalid와 이유를 돌려준다.
export function parseToolCalls(
  permission: PermissionLevel,
  calls: ToolCall[],
  mode: ToolMode = "work",
): ParsedOutput {
  if (calls.length !== 1) {
    return {
      kind: "invalid",
      message: `Call exactly one tool, but ${calls.length} tool calls were made.`,
    };
  }
  const call = calls[0];
  const allowed = toolsFor(permission, mode).map((tool) => tool.name);
  if (!allowed.includes(call.name)) {
    return {
      kind: "invalid",
      message: `Tool "${call.name}" is not available. Use one of: ${allowed.join(", ")}.`,
    };
  }
  if (typeof call.input !== "object" || call.input === null || Array.isArray(call.input)) {
    return { kind: "invalid", message: "Tool input must be a JSON object." };
  }
  const input = call.input as Record<string, unknown>;

  if (call.name === REPORT_BLOCKED) {
    return isNonEmptyString(input.reason)
      ? { kind: "blocked", reason: input.reason }
      : { kind: "invalid", message: '"reason" must be a non-empty string.' };
  }

  if (!isNonEmptyString(input.summary)) {
    return { kind: "invalid", message: '"summary" must be a non-empty string.' };
  }
  if (call.name === SUBMIT_REPORT) {
    return { kind: "report", summary: input.summary };
  }

  if (call.name === SUBMIT_REVIEW) {
    const verdict = input.verdict;
    if (verdict !== "approve" && verdict !== "reject") {
      return { kind: "invalid", message: '"verdict" must be "approve" or "reject".' };
    }
    if (
      !Array.isArray(input.findings) ||
      !(input.findings as unknown[]).every((f) => typeof f === "string" && f.trim() !== "")
    ) {
      return { kind: "invalid", message: '"findings" must be an array of non-empty strings.' };
    }
    const findings = input.findings as string[];
    if (verdict === "reject" && findings.length === 0) {
      return { kind: "invalid", message: "A rejection needs at least one finding." };
    }
    return { kind: "review", verdict, summary: input.summary, findings };
  }

  // propose_changes
  if (!Array.isArray(input.changes) || input.changes.length === 0) {
    return { kind: "invalid", message: '"changes" must be a non-empty array.' };
  }
  const changes: ProposedFile[] = [];
  for (const item of input.changes as unknown[]) {
    if (typeof item !== "object" || item === null) {
      return { kind: "invalid", message: "Every change must be an object with path and content." };
    }
    const { path, content } = item as Record<string, unknown>;
    if (!isNonEmptyString(path) || typeof content !== "string") {
      return {
        kind: "invalid",
        message: "Every change needs a non-empty string path and a string content.",
      };
    }
    changes.push({ path, content });
  }
  return { kind: "changes", summary: input.summary, changes };
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}
