import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { HunkExtensionAPI } from "hunkdiff/extension";
import { writeJsonAtomicSync } from "../core/src/mailbox";

interface SavedSettings {
  version: 1;
  theme?: string;
}

function isTheme(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && !value.startsWith("-") && !/[\x00-\x1f\x7f]/.test(value);
}

export function settingsPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.XDG_CONFIG_HOME || join(env.HOME || homedir(), ".config"), "guided-review", "settings.json");
}

/** Personal view choices live outside worktrees and review generations. */
export class TourSettings {
  constructor(readonly path = settingsPath()) {}

  read(): SavedSettings {
    let source: string;
    try {
      source = readFileSync(this.path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1 };
      throw error;
    }
    const raw: unknown = JSON.parse(source);
    if (!raw || typeof raw !== "object" || !("version" in raw) || raw.version !== 1
      || ("theme" in raw && !isTheme(raw.theme))) {
      throw new Error(`invalid settings in ${this.path}`);
    }
    return { version: 1, ...("theme" in raw ? { theme: raw.theme as string } : {}) };
  }

  cliArgs(): string[] {
    const { theme } = this.read();
    return theme ? ["--theme", theme] : [];
  }

  saveTheme(theme: string): void {
    if (!isTheme(theme)) throw new Error("invalid theme id");
    // Commit before returning: a new tour can start immediately, even while this one stays open.
    // Atomic replacement gives simultaneous tours last-selection-wins behavior without torn reads.
    writeJsonAtomicSync(this.path, { version: 1, theme } satisfies SavedSettings);
  }
}

export function registerSettings(hunk: HunkExtensionAPI, settings: TourSettings, isTour: () => boolean): void {
  // Hunk emits only committed selections, never theme-picker previews or the initial theme.
  hunk.on("theme_changed", ({ themeId }, ctx) => {
    if (!isTour()) return;
    try {
      settings.saveTheme(themeId);
    } catch (error) {
      ctx.notify(`Could not save guided-review settings: ${error instanceof Error ? error.message : String(error)}`, "warning");
    }
  });
}
