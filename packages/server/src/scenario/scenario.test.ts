import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { loadScenario, parseScenario, scenarioToGoal } from "./scenario.js";

function ok(text: string) {
  const result = parseScenario(text);
  assert.ok(result.ok, result.ok ? "" : result.message);
  return result.scenario;
}

function message(text: string): string {
  const result = parseScenario(text);
  assert.ok(!result.ok);
  return result.message;
}

describe("parseScenario", () => {
  it("reads title and all three sections", () => {
    const s = ok("# 제목\n\n## 목표\n만든다\n\n## 제약\n- A\n- B\n\n## 완료 기준\n끝\n");
    assert.deepEqual(s, {
      title: "제목",
      goal: "만든다",
      constraints: "- A\n- B",
      doneCriteria: "끝",
    });
  });

  it("allows the goal alone and leaves the others empty", () => {
    const s = ok("## 목표\n만든다");
    assert.equal(s.title, null);
    assert.equal(s.constraints, "");
    assert.equal(s.doneCriteria, "");
  });

  it("accepts English section names in any case and a trailing colon", () => {
    const s = ok("## Goal:\nbuild\n## CONSTRAINTS\nnone\n## Done Criteria\nwhen done");
    assert.equal(s.goal, "build");
    assert.equal(s.constraints, "none");
    assert.equal(s.doneCriteria, "when done");
  });

  it("works with Windows line endings", () => {
    const s = ok("## 목표\r\n한 줄\r\n둘째 줄\r\n## 제약\r\n하나\r\n");
    assert.equal(s.goal, "한 줄\n둘째 줄");
    assert.equal(s.constraints, "하나");
  });

  it("keeps headings inside code fences as content", () => {
    const s = ok("## 목표\n예시:\n```md\n## 제약\n```\n끝");
    assert.ok(s.goal.includes("## 제약"));
    assert.equal(s.constraints, "");
  });

  it("requires a non-empty goal", () => {
    assert.match(message("## 제약\n없음"), /목표/);
    assert.match(message("## 목표\n   \n## 제약\nx"), /목표/);
    assert.match(message(""), /목표/);
  });

  it("reports unknown sections instead of ignoring them", () => {
    assert.match(message("## 목표\nx\n## 목표들\ny"), /Unknown section "목표들"/);
  });

  it("rejects duplicate sections and text before the first section", () => {
    assert.match(message("## 목표\nx\n## 목표\ny"), /more than once/);
    assert.match(message("그냥 글\n## 목표\nx"), /before the first section/);
  });

  it("treats only the first level-1 heading before any section as the title", () => {
    assert.match(message("## 목표\nx\n# 또 제목\n"), /Unknown section/);
  });
});

describe("scenarioToGoal", () => {
  it("includes given parts and asks for defaults for missing ones", () => {
    const full = scenarioToGoal({ title: null, goal: "G", constraints: "C", doneCriteria: "D" });
    assert.ok(full.includes("Constraints:\nC") && full.includes("Done criteria:\nD"));

    const bare = scenarioToGoal({ title: null, goal: "G", constraints: "", doneCriteria: "" });
    assert.ok(bare.includes("Propose sensible defaults"));
    assert.ok(bare.includes("Propose checkable ones"));
  });
});

describe("loadScenario", () => {
  it("reads a file and reports a missing one", async () => {
    const dir = await mkdtemp(join(tmpdir(), "rp-scn-"));
    try {
      await writeFile(join(dir, "a.md"), "## 목표\n만든다\n", "utf8");
      const loaded = await loadScenario(join(dir, "a.md"));
      assert.ok(loaded.ok);

      const missing = await loadScenario(join(dir, "none.md"));
      assert.ok(!missing.ok && missing.message.includes("Cannot read"));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("can read the sample scenario in the repository", async () => {
    // dist/scenario/ 에서 리포 루트의 scenarios/ 까지
    const samplePath = new URL("../../../../scenarios/sample-todo-cli.md", import.meta.url);
    const loaded = await loadScenario(fileURLToPath(samplePath));
    assert.ok(loaded.ok, loaded.ok ? "" : loaded.message);
    if (loaded.ok) {
      assert.ok(loaded.scenario.constraints !== "" && loaded.scenario.doneCriteria !== "");
    }
  });
});
