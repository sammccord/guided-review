import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

test("the core index's transitive relative imports contain no node built-ins", () => {
  const pending = [resolve(import.meta.dir, "../src/index.ts")];
  const visited = new Set<string>();
  while (pending.length > 0) {
    const path = pending.pop()!;
    if (visited.has(path)) continue;
    visited.add(path);
    const source = readFileSync(path, "utf8");
    const specifiers = [...source.matchAll(/(?:\bfrom\s*|\bimport\s*(?:\(\s*)?)["']([^"']+)["']/g)].map(match => match[1]!);
    for (const specifier of specifiers) {
      expect({ path, specifier }).not.toMatchObject({ specifier: expect.stringMatching(/^node:/) });
      if (specifier.startsWith(".")) pending.push(resolve(dirname(path), /\.tsx?$/.test(specifier) ? specifier : `${specifier}.ts`));
    }
  }
  expect(visited.has(resolve(import.meta.dir, "../src/layout.ts"))).toBe(true);
  expect(visited.has(resolve(import.meta.dir, "../src/qa.ts"))).toBe(true);
});
