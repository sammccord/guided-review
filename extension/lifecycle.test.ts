import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import type { ExtensionChangeset, ExtensionCliCommandContext, ExtensionCommandContext, HunkExtensionAPI } from "hunkdiff/extension";
import { mailboxPaths, readMailbox, requestPath, writeJsonAtomic } from "../core/src/mailbox";
import { stop, tour } from "../core/test/fixtures";
import registerGuidedReview from "./index";

// Exercise the registered CLI, changeset transform, commands, and shutdown together.
test("tour open groups the full diff, keeps narrative navigation, resumes after close, and supports --fresh", async () => {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), "guided-review-lifecycle-")));
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
  const events = new Map<string, Array<Parameters<HunkExtensionAPI["on"]>[1]>>();
  const commands = new Map<string, Parameters<HunkExtensionAPI["registerCommand"]>[1]>();
  let cli: Parameters<HunkExtensionAPI["registerCliCommand"]>[1] = async () => ({ kind: "exit", code: 99 });
  let transform: Parameters<HunkExtensionAPI["transformChangeset"]>[0] = changeset => changeset;
  const api = {
    registerCliCommand: (_command: unknown, handler: typeof cli) => { cli = handler; },
    transformChangeset: (handler: typeof transform) => { transform = handler; },
    registerPane: () => {},
    registerCommand: (command: { id: string }, handler: Parameters<HunkExtensionAPI["registerCommand"]>[1]) => { commands.set(command.id, handler); },
    on: (name: string, handler: Parameters<HunkExtensionAPI["on"]>[1]) => { events.set(name, [...events.get(name) ?? [], handler]); },
  } as unknown as HunkExtensionAPI;
  let stderr = "";
  const ctx: ExtensionCliCommandContext = {
    cwd: repo, signal: new AbortController().signal, stdin: (async function* () {})(),
    stdout: { write: async () => {} }, stderr: { write: async text => { stderr += text; } },
  };
  const files = ["internal/code/file.go", "other/service.go", "internal/code/other-file.go", "internal/code/unannotated.go"]
    .map(path => ({ id: path, path, patch: "", stats: { additions: 1, deletions: 0 }, metadata: {}, agent: null }));
  const changeset: ExtensionChangeset = { id: "review", sourceLabel: repo, files, title: "Preserve metadata" };
  const sidecars = new Set<string>();
  try {
    git("init", "-q", "-b", "main");
    git("config", "user.name", "Test");
    git("config", "user.email", "t@example.com");
    git("config", "commit.gpgsign", "false");
    git("commit", "--allow-empty", "-q", "-m", "base");
    const base = git("rev-parse", "HEAD");
    git("branch", "review-base", base);
    git("commit", "--allow-empty", "-q", "-m", "advance base without changing anchors");
    const advancedBase = git("rev-parse", "HEAD");
    for (const file of files) {
      mkdirSync(dirname(join(repo, file.path)), { recursive: true });
      writeFileSync(join(repo, file.path), "package example\n");
    }
    git("add", ".");
    git("commit", "-q", "-m", "head");
    const data = tour({ base: "review-base", head: "HEAD", stops: files.slice(0, 3).map(file => stop({ path: file.path, line: 1 })) });
    const tourPath = join(repo, "review.tour.json");
    await writeJsonAtomic(tourPath, data);
    const previousConfigHome = process.env.XDG_CONFIG_HOME;
    const configHome = join(repo, "personal-config");
    process.env.XDG_CONFIG_HOME = configHome;
    try { registerGuidedReview(api); } finally {
      if (previousConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = previousConfigHome;
    }
    expect(await transform(changeset, {} as never)).toBe(changeset);

    let opens = 0;
    let expectedTheme: string | undefined;
    const open = async (extra: string[] = []) => {
      const result = await cli(["open", tourPath, ...extra], ctx);
      expect(result.kind).toBe("delegate");
      if (result.kind === "delegate") {
        expect(result.argv[1]).toBe(`${git("rev-parse", "review-base")}...${git("rev-parse", "HEAD")}`);
        const themeIndex = result.argv.indexOf("--theme");
        expect(themeIndex < 0 ? undefined : result.argv[themeIndex + 1]).toBe(expectedTheme);
        sidecars.add(result.argv[result.argv.indexOf("--agent-context") + 1]!);
      }
      expect(sidecars.size).toBe(1 + opens++);
      expect(stderr).toBe("");
      return readMailbox(mailboxPaths(tourPath));
    };
    const first = await open();
    const grouped = await transform(changeset, {} as never);
    expect(grouped.files.map(file => file.path)).toEqual([
      "internal/code/file.go", "internal/code/other-file.go", "internal/code/unannotated.go", "other/service.go",
    ]);
    expect(grouped.title).toBe(changeset.title);
    expect(changeset.files).toEqual(files);

    const settingsFile = join(configHome, "guided-review", "settings.json");
    expect(await Bun.file(settingsFile).exists()).toBe(false);
    expectedTheme = "catppuccin-mocha";
    for (const handler of events.get("theme_changed") ?? []) {
      await handler({ themeId: expectedTheme } as never, { notify: () => { throw new Error("unexpected settings warning"); } } as never);
    }
    expect(await Bun.file(settingsFile).json()).toEqual({ version: 1, theme: expectedTheme });

    const revealed: string[] = [];
    const commandCtx = {
      panes: { open: () => {} }, notify: () => {}, selection: { files },
      review: { snapshot: () => ({ files: files.map(file => ({ ...file, runtimeId: file.id })) }) },
      navigation: { revealLine: (id: string) => revealed.push(id) },
    } as unknown as ExtensionCommandContext;
    await commands.get("next")!(commandCtx);
    await commands.get("next")!(commandCtx);
    expect(revealed).toEqual(["internal/code/file.go", "other/service.go"]);

    const oldPaths = mailboxPaths(tourPath);
    const id = `q-${first.session!.reviewId}-1`;
    await writeJsonAtomic(requestPath(oldPaths, id), {
      id, seq: 1, at: "old", kind: "decision", decision: "agree", comment: "",
      stop: { number: 1, title: "Original", ask: "Agree?", anchor: { path: files[0]!.path, side: "new", line: 1 } },
    });
    for (const handler of events.get("shutdown") ?? []) await handler({} as never, {} as never);
    expect((await readMailbox(oldPaths)).session!.closedAt).toBeDefined();
    const resumed = await open();
    expect(resumed.session!.reviewId).toBe(first.session!.reviewId);
    expect(resumed.session!.closedAt).toBeUndefined();
    expect(resumed.requests).toHaveLength(1);
    const fresh = await open(["--fresh"]);
    expect(fresh.session!.reviewId).not.toBe(first.session!.reviewId);
    expect(fresh.requests).toEqual([]);
    expect((await readMailbox(oldPaths)).requests).toHaveLength(1);
    const unchangedRefs = await open();
    expect(unchangedRefs.session!.reviewId).toBe(fresh.session!.reviewId);
    const previousVote = (await readMailbox(oldPaths)).requests[0]!;
    const seedVote = async (box: typeof fresh) => {
      const id = `q-${box.session!.reviewId}-1`;
      await writeJsonAtomic(requestPath(mailboxPaths(tourPath), id), { ...previousVote, id });
    };
    await seedVote(fresh);
    git("commit", "--allow-empty", "-q", "-m", "move head without editing tour JSON");
    const movedHead = await open();
    expect(movedHead.session!.reviewId).not.toBe(fresh.session!.reviewId);
    expect(movedHead.requests).toEqual([]);
    expect(movedHead.session!.head).toBe(git("rev-parse", "HEAD"));
    await seedVote(movedHead);
    git("branch", "-f", "review-base", advancedBase);
    const movedBase = await open();
    expect(movedBase.session!.reviewId).not.toBe(movedHead.session!.reviewId);
    expect(movedBase.requests).toEqual([]);
    const bin = join(repo, "bin");
    mkdirSync(bin);
    const calls = join(repo, "launcher-calls");
    writeFileSync(join(bin, "hunk"), '#!/bin/sh\nprintf "%s\\n" "$@" > "$LAUNCHER_CALLS"\n', { mode: 0o755 });
    const launcher = new URL("../scripts/open-tour.sh", import.meta.url).pathname;
    for (const fresh of [false, true]) {
      const output = execFileSync("bash", [launcher, "--print", ...(fresh ? ["--fresh"] : []), repo, tourPath], {
        encoding: "utf8", env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, LAUNCHER_CALLS: calls },
      });
      expect(output.trim().endsWith("--fresh")).toBe(fresh);
      expect((await Bun.file(calls).text()).trim().split("\n")).toEqual(["--extension", new URL("..", import.meta.url).pathname.replace(/\/$/, ""), "tour", "check", tourPath]);
    }
    const otherTour = join(repo, "another.tour.json");
    await writeJsonAtomic(otherTour, { ...data, title: "Another tour" });
    const another = await cli(["open", otherTour], ctx);
    expect(another.kind).toBe("delegate");
    if (another.kind === "delegate") {
      expect(another.argv.slice(2, 4)).toEqual(["--theme", expectedTheme!]);
      sidecars.add(another.argv[another.argv.indexOf("--agent-context") + 1]!);
    }
    await Bun.write(settingsFile, "invalid JSON");
    const fallback = await cli(["open", otherTour, "--fresh"], ctx);
    expect(fallback.kind).toBe("delegate");
    if (fallback.kind === "delegate") {
      expect(fallback.argv).not.toContain("--theme");
      sidecars.add(fallback.argv[fallback.argv.indexOf("--agent-context") + 1]!);
    }
    expect(stderr).toContain("warning: could not load guided-review settings:");
    expect(await cli(["check", tourPath, "--fresh"], ctx)).toEqual({ kind: "exit", code: 2 });
    expect(await cli(["open", tourPath, "--unknown"], ctx)).toEqual({ kind: "exit", code: 2 });
  } finally {
    for (const path of sidecars) rmSync(dirname(path), { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});
