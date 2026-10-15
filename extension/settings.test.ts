import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionEventContext, ExtensionEventHandler, HunkExtensionAPI } from "hunkdiff/extension";
import { registerSettings, settingsPath, TourSettings } from "./settings";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function setup() {
  const dir = mkdtempSync(join(tmpdir(), "guided-review-settings-"));
  dirs.push(dir);
  return { dir, settings: new TourSettings(join(dir, "settings.json")) };
}

function register(settings: TourSettings, isTour: () => boolean = () => true) {
  let handler: ExtensionEventHandler<"theme_changed"> | undefined;
  const api = {
    on: (event: string, callback: typeof handler) => {
      expect(event).toBe("theme_changed");
      handler = callback;
    },
  } as unknown as HunkExtensionAPI;
  registerSettings(api, settings, isTour);
  const notices: Array<[string, string | undefined]> = [];
  const ctx = { notify: (message: string, type?: string) => notices.push([message, type]) } as unknown as ExtensionEventContext;
  return { select: (themeId: string) => handler!({ themeId }, ctx), notices };
}

test("settings are user-scoped and respect XDG_CONFIG_HOME", () => {
  expect(settingsPath({ HOME: "/home/reviewer" })).toBe("/home/reviewer/.config/guided-review/settings.json");
  expect(settingsPath({ HOME: "/home/reviewer", XDG_CONFIG_HOME: "/personal/config" })).toBe("/personal/config/guided-review/settings.json");
  expect(settingsPath({ HOME: "/home/reviewer", XDG_CONFIG_HOME: "" })).toBe("/home/reviewer/.config/guided-review/settings.json");
});

test("a first tour leaves Hunk's configured theme alone and does not create settings", () => {
  const { dir, settings } = setup();
  expect(settings.cliArgs()).toEqual([]);
  register(settings);
  expect(readdirSync(dir)).toEqual([]);
});

test("a committed selection is available to another tour before the first tour closes", async () => {
  const { settings } = setup();
  const first = register(settings);
  await first.select("catppuccin-mocha");
  expect(new TourSettings(settings.path).cliArgs()).toEqual(["--theme", "catppuccin-mocha"]);
  expect(JSON.parse(readFileSync(settings.path, "utf8"))).toEqual({ version: 1, theme: "catppuccin-mocha" });
  expect(first.notices).toEqual([]);
});

test("simultaneous tours use the latest selection, and an untouched tour cannot overwrite it", async () => {
  const { dir, settings } = setup();
  const first = register(settings);
  const secondSettings = new TourSettings(settings.path);
  const second = register(secondSettings);
  await first.select("github-dark");
  await second.select("github-light");
  expect(settings.cliArgs()).toEqual(["--theme", "github-light"]);
  await first.select("terminal");
  expect(secondSettings.cliArgs()).toEqual(["--theme", "terminal"]);
  expect(readdirSync(dir)).toEqual(["settings.json"]);
});

test("loading the extension for an ordinary Hunk review does not save its theme", async () => {
  const { dir, settings } = setup();
  const ordinary = register(settings, () => false);
  await ordinary.select("github-light");
  expect(readdirSync(dir)).toEqual([]);
});

test("settings writes create missing parent directories", () => {
  const { dir } = setup();
  const settings = new TourSettings(join(dir, "nested", "config", "settings.json"));
  settings.saveTheme("auto");
  expect(settings.cliArgs()).toEqual(["--theme", "auto"]);
});

test.each([null, [], {}, { version: 2, theme: "terminal" }, { version: 1, theme: 3 }, { version: 1, theme: "" }, { version: 1, theme: "  " }, { version: 1, theme: "--no-extensions" }, { version: 1, theme: "bad\nname" }].map(raw => [raw]))("rejects invalid saved settings: %j", raw => {
  const { settings } = setup();
  writeFileSync(settings.path, JSON.stringify(raw));
  expect(() => settings.cliArgs()).toThrow("invalid settings");
});

test("malformed JSON and unreadable settings report errors rather than silently losing preferences", () => {
  const { dir, settings } = setup();
  writeFileSync(settings.path, "{");
  expect(() => settings.cliArgs()).toThrow();
  expect(() => new TourSettings(dir).cliArgs()).toThrow();
});

test("write failures warn without breaking the review or replacing existing files", async () => {
  const { dir } = setup();
  const blocker = join(dir, "not-a-directory");
  writeFileSync(blocker, "keep me");
  const { select, notices } = register(new TourSettings(join(blocker, "settings.json")));
  await select("github-dark");
  expect(notices).toHaveLength(1);
  expect(notices[0]![0]).toContain("Could not save guided-review settings:");
  expect(notices[0]![1]).toBe("warning");
  expect(readFileSync(blocker, "utf8")).toBe("keep me");
});

test("invalid event values cannot become launch options or overwrite a saved theme", async () => {
  const { settings } = setup();
  settings.saveTheme("terminal");
  const { select, notices } = register(settings);
  await select("--no-extensions");
  expect(notices).toHaveLength(1);
  expect(settings.cliArgs()).toEqual(["--theme", "terminal"]);
});
