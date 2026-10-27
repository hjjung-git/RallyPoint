import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { parseTapCounts, runNodeTests, tail, testEnvironment } from "./test-runner.js";

async function project(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "rally-verify-"));
  for (const [path, content] of Object.entries(files)) {
    const full = join(dir, ...path.split("/"));
    await mkdir(join(full, ".."), { recursive: true });
    await writeFile(full, content);
  }
  return dir;
}

const PASSING = `const test = require("node:test"); const assert = require("node:assert");
test("adds", () => { assert.equal(1 + 1, 2); });`;
const FAILING = `const test = require("node:test"); const assert = require("node:assert");
test("adds", () => { assert.equal(1 + 1, 3); });`;

describe("runNodeTests", () => {
  it("passes when the given test file passes", async () => {
    const dir = await project({ "a.test.js": PASSING });
    const outcome = await runNodeTests(dir, ["a.test.js"]);
    assert.equal(outcome.status, "passed");
  });

  it("fails and keeps the failure output when a test fails", async () => {
    const dir = await project({ "a.test.js": FAILING });
    const outcome = await runNodeTests(dir, ["a.test.js"]);
    assert.equal(outcome.status, "failed");
    if (outcome.status === "failed") {
      assert.match(outcome.summary, /1 of 1 tests failed/);
      assert.match(outcome.output, /not ok/);
    }
  });

  it("skips when the test file does not exist yet", async () => {
    const dir = await project({ "x.js": "" });
    const outcome = await runNodeTests(dir, ["a.test.js"]);
    assert.equal(outcome.status, "skipped");
  });

  it("skips when the whole workspace has no tests", async () => {
    const dir = await project({ "x.js": "module.exports = 1;" });
    const outcome = await runNodeTests(dir, null);
    assert.equal(outcome.status, "skipped");
  });

  it("finds tests in the whole workspace", async () => {
    const dir = await project({ "src/a.test.js": PASSING, "src/b.test.js": FAILING });
    const outcome = await runNodeTests(dir, null);
    assert.equal(outcome.status, "failed");
  });

  it("stops tests that run too long", async () => {
    const dir = await project({
      "slow.test.js": `const test = require("node:test");
test("slow", async () => { await new Promise((r) => setTimeout(r, 30000)); });`,
    });
    const outcome = await runNodeTests(dir, ["slow.test.js"], { timeoutMs: 500 });
    assert.equal(outcome.status, "failed");
    if (outcome.status === "failed") {
      assert.match(outcome.summary, /did not finish/);
    }
  });

  it("rejects paths that are not test files in the workspace", async () => {
    const dir = await project({});
    for (const bad of ["../a.test.js", "src/", "a.txt", "/etc/a.js"]) {
      const outcome = await runNodeTests(dir, [bad]);
      assert.equal(outcome.status, "failed", bad);
    }
  });

  it("does not pass secrets to the test process", async () => {
    const dir = await project({
      "env.test.js": `const test = require("node:test"); const assert = require("node:assert");
test("no key", () => { assert.equal(process.env.ANTHROPIC_API_KEY, undefined); });`,
    });
    const previous = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = "secret";
    try {
      const outcome = await runNodeTests(dir, ["env.test.js"]);
      assert.equal(outcome.status, "passed");
    } finally {
      if (previous === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = previous;
    }
  });
});

describe("helpers", () => {
  it("keeps only allowed environment variables", () => {
    const env = testEnvironment({ PATH: "/bin", ANTHROPIC_API_KEY: "x", HOME: "/h" });
    assert.deepEqual(env, { PATH: "/bin", HOME: "/h" });
  });

  it("reads TAP counts", () => {
    assert.deepEqual(parseTapCounts("x\n# tests 5\n# pass 3\n# fail 2\n"), { tests: 5, pass: 3, fail: 2 });
    assert.equal(parseTapCounts("nothing"), null);
  });

  it("keeps the tail of long output", () => {
    assert.equal(tail("abc", 10), "abc");
    assert.match(tail("x".repeat(50), 10), /^\.\.\.\(truncated\)\nx{10}$/);
  });
});
