import { afterAll, beforeAll, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let root: string, repo: string, tour: string, launcher: string, capture: string;
const run = promisify(execFile);
beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "guided-review-launcher-")));
  repo = join(root, "reviewer's code ü"); tour = join(root, "tour with spaces.json");
  capture = join(root, "cursor-args"); launcher = join(root, "scripts/open-tour.sh");
  mkdirSync(repo); mkdirSync(join(root, "scripts")); mkdirSync(join(root, "bin"));
  mkdirSync(join(root, "cursor-extension/dist"), { recursive: true });
  copyFileSync(new URL("../../scripts/open-tour.sh", import.meta.url), launcher);
  writeFileSync(tour, "{}");
  writeFileSync(join(root, "cursor-extension/dist/check.js"), "console.log('ok: fixture checked');\n");
  writeFileSync(join(root, "bin/cursor"), '#!/bin/sh\nprintf "%s\\n" "$@" > "$CAPTURE"\n');
  writeFileSync(join(root, "bin/hunk"), '#!/bin/sh\necho "Hunk must not run for Cursor" >&2\nexit 99\n');
  chmodSync(join(root, "bin/cursor"), 0o755); chmodSync(join(root, "bin/hunk"), 0o755);
});
afterAll(() => rmSync(root, { recursive: true, force: true }));
const env = () => ({ ...process.env, PATH: `${join(root, "bin")}:${process.env.PATH}`, TMPDIR: root, CAPTURE: capture });

test("Cursor print mode validates without Hunk or launching a window", async () => {
  const { stdout } = await run("bash", [launcher, "--cursor", "--print", repo, tour], { env: env() });
  expect(stdout).toContain("ok: fixture checked");
  expect(stdout).toContain("Tour command:");
  expect(stdout).toContain("'\\''"); // Apostrophes are shell-quoted, not interpolated.
  expect(existsSync(capture)).toBe(false);
});

test("Cursor launcher writes an isolated workspace with exact repo/tour paths", async () => {
  await run("bash", [launcher, "--cursor", repo, tour], { env: env() });
  const [flag, workspace] = readFileSync(capture, "utf8").trimEnd().split("\n");
  expect(flag).toBe("--new-window");
  expect(JSON.parse(readFileSync(workspace!, "utf8"))).toEqual({ folders: [{ path: repo }], settings: { "guidedReview.tourFile": tour } });
  expect(existsSync(join(repo, ".vscode"))).toBe(false);
});
