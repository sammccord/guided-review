#!/usr/bin/env node
// Copies the host-neutral sources into another repository and records what it copied.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE_DIRS = ["core/src", "cli"];
const SKILL_FILES = [
  { source: "SKILL.md", dest: "SKILL.md" },
  { source: "references/lenses.md", dest: "references/lenses.md" },
  { source: "docs/tour-format.md", dest: "references/tour-format.md" },
  { source: "scripts/prepare.py", dest: "scripts/prepare.py" },
];
const SOURCE_URL = "https://github.com/sammccord/guided-review";

function sources(dir) {
  return readdirSync(join(root, dir), { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts"))
    .map((entry) => `${dir}/${entry.name}`)
    .sort();
}

const [dest] = process.argv.slice(2);
if (!dest) {
  console.error("usage: scripts/vendor.mjs <destination directory>");
  process.exit(2);
}
if (execFileSync("git", ["-C", root, "status", "--porcelain", "--", ...SOURCE_DIRS, ...SKILL_FILES.map(({ source }) => source)], { encoding: "utf8" }).trim()) {
  console.error("vendor: commit changes under core/src, cli, and the skill files first so the recorded commit matches the files");
  process.exit(1);
}

const commit = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const out = resolve(dest);
rmSync(out, { recursive: true, force: true });
const files = {};
for (const { source, dest } of [...SOURCE_DIRS.flatMap(sources).map((file) => ({ source: file, dest: file })), ...SKILL_FILES]) {
  mkdirSync(dirname(join(out, dest)), { recursive: true });
  cpSync(join(root, source), join(out, dest));
  files[dest] = createHash("sha256").update(readFileSync(join(root, source))).digest("hex");
}
writeFileSync(join(out, "VENDOR.json"), `${JSON.stringify({ source: SOURCE_URL, commit, files }, null, 2)}\n`);
console.log(`vendored ${Object.keys(files).length} files at ${commit.slice(0, 12)} into ${relative(process.cwd(), out) || "."}`);
