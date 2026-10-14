import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { FileChange } from "@rallypoint/shared";
import { Workspace } from "./workspace.js";

const ALL = ["src/", "package.json"];

function change(path: string, content: string, baseVersion = 0): FileChange {
  return { path, content, baseVersion };
}

// 임시 폴더를 만들어 테스트에 넘기고, 끝나면 지운다.
async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "rallypoint-ws-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function openEmpty(dir: string): Promise<Workspace> {
  return Workspace.open(join(dir, "work"));
}

describe("작업 폴더 열기", () => {
  it("없는 폴더는 만들어 준다", async () => {
    await withTempDir(async (dir) => {
      const workspace = await openEmpty(dir);
      assert.deepEqual(await readdir(workspace.getRoot()), []);
    });
  });

  it("비어 있는 폴더는 그대로 연다", async () => {
    await withTempDir(async (dir) => {
      await Workspace.open(dir);
    });
  });

  it("운영체제가 만드는 파일만 있으면 비어 있는 것으로 본다", async () => {
    await withTempDir(async (dir) => {
      await writeFile(join(dir, ".DS_Store"), "x", "utf8");
      await Workspace.open(dir);
    });
  });

  it("다른 파일이 있으면 거부한다", async () => {
    await withTempDir(async (dir) => {
      await writeFile(join(dir, "notes.txt"), "x", "utf8");
      await assert.rejects(() => Workspace.open(dir));
    });
  });

  it("폴더가 아니라 파일이면 거부한다", async () => {
    await withTempDir(async (dir) => {
      const file = join(dir, "a-file");
      await writeFile(file, "x", "utf8");
      await assert.rejects(() => Workspace.open(file));
    });
  });
});

describe("변경안 적용", () => {
  it("새 파일은 버전 0에서 1이 되고 디스크에도 쓰인다", async () => {
    await withTempDir(async (dir) => {
      const workspace = await openEmpty(dir);
      const result = await workspace.applyChanges({
        cardId: "c1",
        changes: [change("src/a/b.ts", "hello")],
        allowedWrite: ALL,
      });

      assert.deepEqual(result, { ok: true, versions: { "src/a/b.ts": 1 } });
      assert.deepEqual(workspace.read("src/a/b.ts"), {
        version: 1,
        content: "hello",
      });
      const onDisk = await readFile(
        join(workspace.getRoot(), "src", "a", "b.ts"),
        "utf8",
      );
      assert.equal(onDisk, "hello");
    });
  });

  it("없는 파일을 읽으면 버전 0이고 내용이 null이다", async () => {
    await withTempDir(async (dir) => {
      const workspace = await openEmpty(dir);
      assert.deepEqual(workspace.read("src/none.ts"), {
        version: 0,
        content: null,
      });
    });
  });

  it("맞는 기준 버전으로 고치면 버전이 오른다", async () => {
    await withTempDir(async (dir) => {
      const workspace = await openEmpty(dir);
      await workspace.applyChanges({
        cardId: "c1",
        changes: [change("src/a.ts", "v1")],
        allowedWrite: ALL,
      });
      const result = await workspace.applyChanges({
        cardId: "c2",
        changes: [change("src/a.ts", "v2", 1)],
        allowedWrite: ALL,
      });
      assert.deepEqual(result, { ok: true, versions: { "src/a.ts": 2 } });
      assert.equal(workspace.read("src/a.ts").content, "v2");
    });
  });

  it("낡은 기준 버전은 거부하고, 파일을 마지막으로 고친 카드를 알려 준다", async () => {
    await withTempDir(async (dir) => {
      const workspace = await openEmpty(dir);
      await workspace.applyChanges({
        cardId: "c1",
        changes: [change("src/a.ts", "by c1")],
        allowedWrite: ALL,
      });

      const result = await workspace.applyChanges({
        cardId: "c2",
        changes: [change("src/a.ts", "by c2", 0)],
        allowedWrite: ALL,
      });

      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.equal(result.reason, "version_mismatch");
        assert.equal(result.path, "src/a.ts");
        assert.equal(result.currentVersion, 1);
        assert.equal(result.lastCardId, "c1");
      }
      assert.equal(workspace.read("src/a.ts").content, "by c1");
    });
  });

  it("두 카드가 같은 새 파일을 만들려 하면 나중 것이 거부된다", async () => {
    await withTempDir(async (dir) => {
      const workspace = await openEmpty(dir);
      const first = await workspace.applyChanges({
        cardId: "api-card",
        changes: [change("src/shared/types.ts", "export type A = 1;")],
        allowedWrite: ALL,
      });
      const second = await workspace.applyChanges({
        cardId: "ui-card",
        changes: [change("src/shared/types.ts", "export type B = 2;")],
        allowedWrite: ALL,
      });
      assert.equal(first.ok, true);
      assert.equal(second.ok, false);
      if (!second.ok) {
        assert.equal(second.reason, "version_mismatch");
        assert.equal(second.lastCardId, "api-card");
      }
    });
  });

  it("여러 파일 중 하나라도 버전이 틀리면 아무것도 적용하지 않는다", async () => {
    await withTempDir(async (dir) => {
      const workspace = await openEmpty(dir);
      await workspace.applyChanges({
        cardId: "c1",
        changes: [change("src/a.ts", "a1")],
        allowedWrite: ALL,
      });

      const result = await workspace.applyChanges({
        cardId: "c2",
        changes: [change("src/new.ts", "n"), change("src/a.ts", "a2", 0)],
        allowedWrite: ALL,
      });

      assert.equal(result.ok, false);
      assert.deepEqual(workspace.list(), ["src/a.ts"]);
      assert.equal(workspace.read("src/a.ts").content, "a1");
      assert.deepEqual(await readdir(join(workspace.getRoot(), "src")), ["a.ts"]);
    });
  });

  it("쓰기 범위 밖의 파일은 거부한다", async () => {
    await withTempDir(async (dir) => {
      const workspace = await openEmpty(dir);
      const result = await workspace.applyChanges({
        cardId: "c1",
        changes: [change("docs/readme.md", "x")],
        allowedWrite: ["src/"],
      });
      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.equal(result.reason, "out_of_scope");
      }
      assert.deepEqual(workspace.list(), []);
    });
  });

  it("작업 폴더 밖을 가리키는 경로는 거부한다", async () => {
    await withTempDir(async (dir) => {
      const workspace = await openEmpty(dir);
      const bad = [
        "../escape.txt",
        "src/../../escape.txt",
        "/etc/passwd",
        "C:/Windows/x.txt",
        "src\\a.ts",
        "src/",
        "",
      ];
      for (const path of bad) {
        const result = await workspace.applyChanges({
          cardId: "c1",
          changes: [change(path, "x")],
          allowedWrite: ["src/", "../", "/", ""],
        });
        assert.equal(result.ok, false, path);
        if (!result.ok) {
          assert.equal(result.reason, "invalid_path", path);
        }
      }
      assert.deepEqual(await readdir(dir), ["work"]);
    });
  });

  it("같은 경로를 두 번 제출하면 거부한다", async () => {
    await withTempDir(async (dir) => {
      const workspace = await openEmpty(dir);
      const result = await workspace.applyChanges({
        cardId: "c1",
        changes: [change("src/a.ts", "1"), change("src/a.ts", "2")],
        allowedWrite: ALL,
      });
      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.equal(result.reason, "duplicate_path");
      }
    });
  });

  it("빈 변경안과 잘못된 기준 버전은 거부한다", async () => {
    await withTempDir(async (dir) => {
      const workspace = await openEmpty(dir);
      const empty = await workspace.applyChanges({
        cardId: "c1",
        changes: [],
        allowedWrite: ALL,
      });
      assert.equal(empty.ok === false && empty.reason, "empty_request");

      for (const baseVersion of [-1, 1.5, Number.NaN]) {
        const result = await workspace.applyChanges({
          cardId: "c1",
          changes: [change("src/a.ts", "x", baseVersion)],
          allowedWrite: ALL,
        });
        assert.equal(result.ok === false && result.reason, "invalid_version");
      }
    });
  });

  it("디스크 쓰기가 중간에 실패하면 이미 쓴 파일을 되돌린다", async () => {
    await withTempDir(async (dir) => {
      const workspace = await openEmpty(dir);
      // src 자리에 파일이 있으면 src/x.ts 를 만들 수 없다. 앞에서 쓴 b.txt 는 되돌려져야 한다.
      await writeFile(join(workspace.getRoot(), "blocker"), "file", "utf8");

      await assert.rejects(() =>
        workspace.applyChanges({
          cardId: "c1",
          changes: [change("b.txt", "b"), change("blocker/x.ts", "x")],
          allowedWrite: ["b.txt", "blocker/"],
        }),
      );

      assert.deepEqual(workspace.list(), []);
      assert.deepEqual((await readdir(workspace.getRoot())).sort(), ["blocker"]);
    });
  });

  it("실패한 변경안 뒤에도 같은 작업공간을 계속 쓸 수 있다", async () => {
    await withTempDir(async (dir) => {
      const workspace = await openEmpty(dir);
      await mkdir(join(workspace.getRoot(), "keep"), { recursive: true });
      const bad = await workspace.applyChanges({
        cardId: "c1",
        changes: [change("src/a.ts", "x", 7)],
        allowedWrite: ALL,
      });
      assert.equal(bad.ok, false);
      const good = await workspace.applyChanges({
        cardId: "c1",
        changes: [change("src/a.ts", "x", 0)],
        allowedWrite: ALL,
      });
      assert.equal(good.ok, true);
    });
  });
});

describe("파일 읽기와 목록", () => {
  it("잘못된 경로를 읽으면 오류를 낸다", async () => {
    await withTempDir(async (dir) => {
      const workspace = await openEmpty(dir);
      assert.throws(() => workspace.read("../x"));
      assert.throws(() => workspace.read("src/"));
    });
  });

  it("목록은 경로순으로 정렬된다", async () => {
    await withTempDir(async (dir) => {
      const workspace = await openEmpty(dir);
      await workspace.applyChanges({
        cardId: "c1",
        changes: [change("src/b.ts", "b"), change("src/a.ts", "a")],
        allowedWrite: ALL,
      });
      assert.deepEqual(workspace.list(), ["src/a.ts", "src/b.ts"]);
    });
  });
});
