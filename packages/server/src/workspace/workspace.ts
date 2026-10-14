import { mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import type { FileChange } from "@rallypoint/shared";
import { isCoveredByAny, isValidScopeEntry } from "../board/scope.js";

// 새로 만든 폴더에 운영체제가 자동으로 만드는 파일은 "비어 있음" 검사에서 제외한다.
const IGNORABLE_NAMES = new Set([".DS_Store", "Thumbs.db", "desktop.ini"]);

export type ApplyFailureReason =
  | "empty_request"
  | "invalid_path"
  | "invalid_version"
  | "duplicate_path"
  | "out_of_scope"
  | "version_mismatch";

export type ApplyResult =
  | { ok: true; versions: Record<string, number> }
  | {
      ok: false;
      reason: ApplyFailureReason;
      path: string | null;
      // version_mismatch일 때: 지금 파일의 버전과, 그 파일을 마지막으로 고친 카드(충돌 상대)
      currentVersion: number | null;
      lastCardId: string | null;
      message: string;
    };

export interface ApplyRequest {
  cardId: string;
  changes: FileChange[];
  // 이 변경안을 낸 유닛에게 허용된 쓰기 범위
  allowedWrite: string[];
}

export interface FileSnapshot {
  // 없는 파일은 버전 0, 내용 null
  version: number;
  content: string | null;
}

interface FileEntry {
  version: number;
  content: string;
  lastCardId: string;
}

// 파일 버전을 메모리에서 관리하고, 적용된 내용은 실제 작업 폴더에도 쓴다.
// 변경안은 전부 적용되거나 전부 거부된다.
export class Workspace {
  private readonly root: string;
  private readonly files = new Map<string, FileEntry>();

  private constructor(root: string) {
    this.root = root;
  }

  // 작업 폴더를 연다. 없으면 만들고, 있으면 비어 있어야 한다.
  static async open(rootDir: string): Promise<Workspace> {
    const root = resolve(rootDir);

    let info: { isDirectory(): boolean };
    try {
      info = await stat(root);
    } catch (error) {
      if (isNotFound(error)) {
        await mkdir(root, { recursive: true });
        return new Workspace(root);
      }
      throw error;
    }

    if (!info.isDirectory()) {
      throw new Error(`Workspace path is not a folder: ${root}`);
    }
    const names = (await readdir(root)).filter(
      (name) => !IGNORABLE_NAMES.has(name),
    );
    if (names.length > 0) {
      throw new Error(
        `Workspace folder must be empty: ${root} (found: ${names.slice(0, 3).join(", ")})`,
      );
    }
    return new Workspace(root);
  }

  getRoot(): string {
    return this.root;
  }

  read(path: string): FileSnapshot {
    assertFilePath(path);
    const entry = this.files.get(path);
    return entry
      ? { version: entry.version, content: entry.content }
      : { version: 0, content: null };
  }

  list(): string[] {
    return [...this.files.keys()].sort();
  }

  async applyChanges(request: ApplyRequest): Promise<ApplyResult> {
    const { cardId, changes, allowedWrite } = request;

    if (changes.length === 0) {
      return failure("empty_request", null, "No changes were submitted");
    }

    const seen = new Set<string>();
    for (const change of changes) {
      const { path } = change;
      if (!isFilePath(path)) {
        return failure("invalid_path", path, `Invalid file path: ${path}`);
      }
      if (seen.has(path)) {
        return failure("duplicate_path", path, `Path submitted twice: ${path}`);
      }
      seen.add(path);

      if (!isCoveredByAny(path, allowedWrite)) {
        return failure("out_of_scope", path, `Outside the write scope: ${path}`);
      }
      if (!Number.isInteger(change.baseVersion) || change.baseVersion < 0) {
        return failure(
          "invalid_version",
          path,
          `Invalid base version for ${path}: ${change.baseVersion}`,
        );
      }
    }

    // 모든 파일의 버전이 맞아야 하나도 적용한다.
    for (const change of changes) {
      const entry = this.files.get(change.path);
      const currentVersion = entry?.version ?? 0;
      if (change.baseVersion !== currentVersion) {
        return {
          ok: false,
          reason: "version_mismatch",
          path: change.path,
          currentVersion,
          lastCardId: entry?.lastCardId ?? null,
          message: `Base version ${change.baseVersion} is stale for ${change.path} (current: ${currentVersion})`,
        };
      }
    }

    await this.writeToDisk(changes);

    const versions: Record<string, number> = {};
    for (const change of changes) {
      const version = (this.files.get(change.path)?.version ?? 0) + 1;
      this.files.set(change.path, {
        version,
        content: change.content,
        lastCardId: cardId,
      });
      versions[change.path] = version;
    }
    return { ok: true, versions };
  }

  // 디스크 쓰기 중 하나라도 실패하면 이미 쓴 파일을 되돌리고 오류를 던진다.
  private async writeToDisk(changes: FileChange[]): Promise<void> {
    const written: { path: string; before: string | null }[] = [];
    try {
      for (const change of changes) {
        const full = this.diskPath(change.path);
        await mkdir(dirname(full), { recursive: true });
        await writeFile(full, change.content, "utf8");
        written.push({
          path: change.path,
          before: this.files.get(change.path)?.content ?? null,
        });
      }
    } catch (error) {
      for (const item of written.reverse()) {
        const full = this.diskPath(item.path);
        if (item.before === null) {
          await rm(full, { force: true });
        } else {
          await writeFile(full, item.before, "utf8");
        }
      }
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to write files to the workspace: ${reason}`);
    }
  }

  private diskPath(path: string): string {
    const full = resolve(this.root, ...path.split("/"));
    if (full !== this.root && !full.startsWith(this.root + sep)) {
      throw new Error(`Path escapes the workspace: ${path}`);
    }
    return full;
  }
}

// 파일 경로는 범위 항목 규칙을 따르되, 폴더 접두어("src/")는 파일이 아니므로 안 된다.
function isFilePath(path: string): boolean {
  return isValidScopeEntry(path) && !path.endsWith("/");
}

function assertFilePath(path: string): void {
  if (!isFilePath(path)) {
    throw new Error(`Invalid file path: ${path}`);
  }
}

function failure(
  reason: ApplyFailureReason,
  path: string | null,
  message: string,
): ApplyResult {
  return {
    ok: false,
    reason,
    path,
    currentVersion: null,
    lastCardId: null,
    message,
  };
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: string }).code === "ENOENT"
  );
}
