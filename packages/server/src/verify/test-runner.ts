import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { isValidScopeEntry } from "../board/scope.js";

export const DEFAULT_TEST_TIMEOUT_MS = 60_000;
export const DEFAULT_TEST_OUTPUT_CHARS = 20_000;

export type TestOutcome =
  // 테스트를 돌렸고 모두 통과했다
  | { status: "passed"; summary: string; output: string }
  // 테스트가 실패했거나, 시간 안에 끝나지 않았거나, 실행하지 못했다
  | { status: "failed"; summary: string; output: string }
  // 돌릴 테스트가 아직 없다
  | { status: "skipped"; summary: string };

// files가 null이면 작업 폴더 전체의 테스트를 찾아 돌린다. 테스트에서는 가짜로 바꿔 끼운다.
export type TestRunner = (root: string, files: string[] | null) => Promise<TestOutcome>;

export interface TestRunOptions {
  timeoutMs?: number;
  maxOutputChars?: number;
}

const TEST_FILE = /\.(c|m)?js$/;

// 환경 변수는 필요한 것만 넘긴다. API 키 같은 비밀 값은 넘기지 않는다.
const ENV_KEYS = [
  "PATH",
  "SystemRoot",
  "SYSTEMROOT",
  "TEMP",
  "TMP",
  "TMPDIR",
  "HOME",
  "USERPROFILE",
  "LANG",
];

export function testEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ENV_KEYS) {
    const value = source[key];
    if (value !== undefined) {
      env[key] = value;
    }
  }
  return env;
}

// 작업 폴더 안에서 Node 테스트 러너(node --test) 하나만 고정해서 돌린다.
// 모델이나 시나리오가 명령을 정하지 못한다. 샌드박스는 아니다(네트워크와 폴더 밖 접근은 막지 못한다).
export function createNodeTestRunner(options: TestRunOptions = {}): TestRunner {
  return (root, files) => runNodeTests(root, files, options);
}

export async function runNodeTests(
  root: string,
  files: string[] | null,
  options: TestRunOptions = {},
): Promise<TestOutcome> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TEST_TIMEOUT_MS;
  const maxChars = options.maxOutputChars ?? DEFAULT_TEST_OUTPUT_CHARS;
  const rootDir = resolve(root);

  let targets: string[] = [];
  if (files !== null) {
    const found: string[] = [];
    const missing: string[] = [];
    for (const file of files) {
      if (!isValidScopeEntry(file) || file.endsWith("/") || !TEST_FILE.test(file)) {
        return failed(`Invalid test file path: ${file}. Use a .js, .mjs or .cjs file inside the workspace.`, "");
      }
      const full = resolve(rootDir, ...file.split("/"));
      if (!full.startsWith(rootDir + sep)) {
        return failed(`Test file escapes the workspace: ${file}`, "");
      }
      if (await isFile(full)) {
        found.push(file);
      } else {
        missing.push(file);
      }
    }
    if (found.length === 0) {
      return { status: "skipped", summary: `Test file not created yet: ${missing.join(", ")}` };
    }
    targets = found;
  }

  const run = await spawnTests(rootDir, targets, timeoutMs, maxChars);
  if (run.error !== null) {
    return failed(`Could not run the tests: ${run.error}`, run.output);
  }
  if (run.timedOut) {
    return failed(`The tests did not finish within ${Math.round(timeoutMs / 1000)} seconds and were stopped.`, run.output);
  }
  const counts = parseTapCounts(run.output);
  if (run.exitCode === 0) {
    if (counts !== null && counts.tests === 0) {
      return { status: "skipped", summary: "No tests found." };
    }
    return {
      status: "passed",
      summary: counts === null ? "Tests passed." : `${counts.pass} of ${counts.tests} tests passed.`,
      output: run.output,
    };
  }
  const summary =
    counts === null
      ? `The test run failed (exit code ${run.exitCode ?? "unknown"}).`
      : `${counts.fail} of ${counts.tests} tests failed.`;
  return failed(summary, run.output);
}

function failed(summary: string, output: string): TestOutcome {
  return { status: "failed", summary, output };
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

export function parseTapCounts(output: string): { tests: number; pass: number; fail: number } | null {
  const read = (name: string): number | null => {
    const match = new RegExp(`^# ${name} (\\d+)\\s*$`, "m").exec(output);
    return match ? Number(match[1]) : null;
  };
  const tests = read("tests");
  const pass = read("pass");
  const fail = read("fail");
  if (tests === null || pass === null || fail === null) {
    return null;
  }
  return { tests, pass, fail };
}

interface SpawnResult {
  exitCode: number | null;
  timedOut: boolean;
  output: string;
  error: string | null;
}

function spawnTests(
  cwd: string,
  files: string[],
  timeoutMs: number,
  maxChars: number,
): Promise<SpawnResult> {
  return new Promise((resolvePromise) => {
    let output = "";
    let timedOut = false;
    let settled = false;
    const append = (chunk: Buffer): void => {
      output += chunk.toString("utf8");
      // 오래 쌓이지 않게 상한의 두 배를 넘으면 뒤쪽만 남긴다.
      if (output.length > maxChars * 2) {
        output = output.slice(-maxChars * 2);
      }
    };
    const finish = (exitCode: number | null, error: string | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise({ exitCode, timedOut, output: tail(output, maxChars), error });
    };

    let child;
    try {
      child = spawn(process.execPath, ["--test", "--test-reporter=tap", ...files], {
        cwd,
        env: testEnvironment(),
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (error) {
      resolvePromise({
        exitCode: null,
        timedOut: false,
        output: "",
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    child.on("error", (error) => finish(null, error.message));
    child.on("close", (code) => finish(code, null));
  });
}

// 길면 뒤쪽 maxChars만 남긴다(요약과 실패 내용이 뒤에 나온다).
export function tail(text: string, maxChars: number): string {
  return text.length <= maxChars ? text : `...(truncated)\n${text.slice(-maxChars)}`;
}
