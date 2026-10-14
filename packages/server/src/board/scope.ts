// 범위 항목은 정확한 파일 경로("src/app.ts") 또는 "/"로 끝나는 폴더 접두어("src/")다.
// 경로는 항상 "/"로 적고, 작업 폴더 밖을 가리키는 형태는 허용하지 않는다.
export function isValidScopeEntry(entry: string): boolean {
  if (entry === "") {
    return false;
  }
  if (entry.includes("\\")) {
    return false;
  }
  if (entry.startsWith("/")) {
    return false;
  }
  if (/^[A-Za-z]:/.test(entry)) {
    return false;
  }
  const segments = entry.split("/");
  for (let i = 0; i < segments.length; i += 1) {
    const segment = segments[i];
    if (segment === "." || segment === "..") {
      return false;
    }
    // 중간에 빈 구간("a//b")은 안 되고, 폴더 접두어의 끝("src/")만 허용한다.
    if (segment === "" && i !== segments.length - 1) {
      return false;
    }
  }
  return true;
}

// outer가 inner를 포함하는가: 같은 경로이거나, outer가 inner를 감싸는 폴더 접두어다.
export function covers(outer: string, inner: string): boolean {
  return outer === inner || (outer.endsWith("/") && inner.startsWith(outer));
}

export function isCoveredByAny(entry: string, outers: string[]): boolean {
  return outers.some((outer) => covers(outer, entry));
}

// 두 항목이 겹치는 부분(더 구체적인 쪽)을 돌려준다. 겹치지 않으면 null.
export function overlapRegion(a: string, b: string): string | null {
  if (covers(a, b)) {
    return b;
  }
  if (covers(b, a)) {
    return a;
  }
  return null;
}
