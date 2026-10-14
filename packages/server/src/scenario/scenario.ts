import { readFile } from "node:fs/promises";

// 시나리오 파일(Markdown)에서 읽은 내용. 비어 있는 선택 항목은 빈 문자열이다.
export interface Scenario {
  title: string | null;
  goal: string;
  constraints: string;
  doneCriteria: string;
}

export type ParseScenarioResult =
  | { ok: true; scenario: Scenario }
  | { ok: false; message: string };

type SectionKey = "goal" | "constraints" | "doneCriteria";

// 제목(#)으로 구분된 섹션 이름. 한국어와 영어 둘 다 받는다.
const SECTION_NAMES: Record<string, SectionKey> = {
  목표: "goal",
  goal: "goal",
  제약: "constraints",
  constraints: "constraints",
  "완료 기준": "doneCriteria",
  "done criteria": "doneCriteria",
};

// 시나리오 파일을 읽는다. 목표(필수), 제약(선택), 완료 기준(선택) 세 섹션만 허용한다.
// 알 수 없는 섹션 이름은 오타일 가능성이 커서 조용히 무시하지 않고 오류로 알린다.
export function parseScenario(text: string): ParseScenarioResult {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");

  let title: string | null = null;
  let current: SectionKey | null = null;
  let inFence = false;
  const sections: Partial<Record<SectionKey, string[]>> = {};
  const before: string[] = [];

  for (const line of lines) {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
    }
    const heading = inFence ? null : /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (heading) {
      const level = (heading[1] as string).length;
      const name = normalizeName(heading[2] as string);
      const key = SECTION_NAMES[name];
      if (key) {
        if (sections[key] !== undefined) {
          return { ok: false, message: `Section "${heading[2]}" appears more than once.` };
        }
        sections[key] = [];
        current = key;
        continue;
      }
      if (level === 1 && current === null && title === null) {
        title = (heading[2] as string).trim();
        continue;
      }
      return {
        ok: false,
        message: `Unknown section "${(heading[2] as string).trim()}". Use: 목표, 제약, 완료 기준.`,
      };
    }
    if (current === null) {
      before.push(line);
    } else {
      (sections[current] as string[]).push(line);
    }
  }

  if (before.some((line) => line.trim() !== "")) {
    return { ok: false, message: "There is text before the first section. Put it under a section heading." };
  }

  const goal = (sections.goal ?? []).join("\n").trim();
  if (goal === "") {
    return { ok: false, message: 'The "목표" section is required and must not be empty.' };
  }
  return {
    ok: true,
    scenario: {
      title,
      goal,
      constraints: (sections.constraints ?? []).join("\n").trim(),
      doneCriteria: (sections.doneCriteria ?? []).join("\n").trim(),
    },
  };
}

export async function loadScenario(path: string): Promise<ParseScenarioResult> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { ok: false, message: `Cannot read the scenario file: ${reason}` };
  }
  return parseScenario(text);
}

// Planner에게 줄 목표 글. 비어 있는 항목은 Planner가 제안하도록 안내한다.
export function scenarioToGoal(scenario: Scenario): string {
  const parts = [scenario.goal];
  parts.push(
    scenario.constraints === ""
      ? "Constraints: none given. Propose sensible defaults."
      : `Constraints:\n${scenario.constraints}`,
  );
  parts.push(
    scenario.doneCriteria === ""
      ? "Done criteria: none given. Propose checkable ones in each card's doneCriteria."
      : `Done criteria:\n${scenario.doneCriteria}`,
  );
  return parts.join("\n\n");
}

function normalizeName(name: string): string {
  return name.trim().replace(/:$/, "").replace(/\s+/g, " ").toLowerCase();
}
