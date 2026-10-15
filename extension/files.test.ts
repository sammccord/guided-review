import { expect, test } from "bun:test";
import { groupFilesByDirectory } from "./files";
import { toSidecar } from "./sidecar";
import { stop, tour, track } from "../core/test/fixtures";

function expectGrouped(paths: string[]) {
  const closed = new Set<string>();
  let previous: string[] = [];
  for (const path of paths) {
    const parts = path.split("/").slice(0, -1);
    const directories = parts.map((_, i) => parts.slice(0, i + 1).join("/"));
    // Both flat (exact parent) and tree (every ancestor) projections must not reopen groups.
    const parent = parts.join("/");
    const oldParent = previous.at(-1);
    if (oldParent !== undefined && oldParent !== parent) closed.add(`flat:${oldParent}`);
    expect(closed.has(`flat:${parent}`)).toBe(false);
    for (const directory of previous) if (!directories.includes(directory)) closed.add(directory);
    for (const directory of directories) expect(closed.has(directory)).toBe(false);
    previous = directories;
  }
}

test("groups the complete review, including files missing from the sidecar, without mutating it", () => {
  const narrative = tour({ tracks: [track([
    stop({ path: "internal/code/file.go" }),
    stop({ path: "other/service.go" }),
    stop({ path: "internal/code/other-file.go" }),
  ])], skipped: [{ path: "internal/code/generated.go", reason: "generated" }] });
  const sidecar = toSidecar(narrative);
  const input = [...sidecar.files, { path: "internal/code/unannotated.go" }, { path: "README.md" }];
  const before = [...input];
  const files = groupFilesByDirectory(input);
  expect(files.map(f => f.path)).toEqual([
    "README.md", "internal/code/file.go", "internal/code/generated.go",
    "internal/code/other-file.go", "internal/code/unannotated.go", "other/service.go",
  ]);
  expect(input).toEqual(before);
  expect(new Set(files)).toEqual(new Set(input));
  expectGrouped(files.map(f => f.path));
  expect(sidecar.files[0]!.annotations.map(a => a.id)).toEqual(["stop-1"]);
  expect(sidecar.files[1]!.annotations.map(a => a.id)).toEqual(["stop-2"]);
  expect(sidecar.files[2]!.annotations.map(a => a.id)).toEqual(["stop-3"]);
});

test("keeps parent files together before children and handles sibling directory name prefixes", () => {
  const paths = ["src/a/z.ts", "src/a/sub/a.ts", "src/a/a.ts", "src/a-b/a.ts", "src/z.ts", "src/A.ts", "src/a.b/x.ts", "z.ts", "a.ts"];
  const ordered = groupFilesByDirectory(paths.map(path => ({ path }))).map(f => f.path);
  expect(ordered).toEqual(["a.ts", "z.ts", "src/A.ts", "src/z.ts", "src/a/a.ts", "src/a/z.ts", "src/a/sub/a.ts", "src/a-b/a.ts", "src/a.b/x.ts"]);
  expectGrouped(ordered);
});

test("handles an empty review and preserves distinct file identities", () => {
  expect(groupFilesByDirectory([])).toEqual([]);
  const files = [{ path: "src/file.go", id: "first" }, { path: "src/file.go", id: "second" }];
  expect(groupFilesByDirectory(files)).toEqual(files);
});
