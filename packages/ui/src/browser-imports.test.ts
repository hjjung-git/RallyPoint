import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

// 브라우저는 "@rallypoint/shared" 같은 패키지 이름을 해석하지 못한다.
// 빌드된 화면 스크립트에 그런 import가 하나라도 남으면 화면 전체가 멈추므로 여기서 막는다.
describe("browser scripts", () => {
  it("only import relative modules", async () => {
    const dir = fileURLToPath(new URL(".", import.meta.url));
    const files = (await readdir(dir)).filter((f) => f.endsWith(".js") && !f.endsWith(".test.js"));
    assert.ok(files.length > 0);
    for (const file of files) {
      const code = await readFile(`${dir}/${file}`, "utf8");
      const specifiers = [...code.matchAll(/(?:from|import)\s*["']([^"']+)["']/g)].map((m) => m[1] as string);
      for (const spec of specifiers) {
        assert.ok(spec.startsWith("./"), `${file} imports "${spec}"`);
      }
    }
  });
});
