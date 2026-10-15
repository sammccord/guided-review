import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { once } from "node:events";

const root = fileURLToPath(new URL("../../", import.meta.url));
const executable = process.env.CURSOR_EXECUTABLE ?? (process.platform === "darwin" ? "/Applications/Cursor.app/Contents/MacOS/Cursor" : undefined);
if (!executable) throw new Error("Set CURSOR_EXECUTABLE to Cursor's Electron executable (not its shell CLI).");
const { stdout } = await promisify(execFile)(join(root, "examples/demo/run.sh"), ["--cursor", "--print", "--keep"]);
const repo = stdout.match(/^Demo repo: (.+)$/m)?.[1];
if (!repo) throw new Error(`Demo fixture was not created: ${stdout}`);
await writeFile(join(repo, "smoke-tour.json"), await readFile(join(repo, "../tour.json")));
const profile = await mkdtemp(join(tmpdir(), "guided-review-cursor-smoke-"));
await mkdir(join(profile, "User"));
await writeFile(join(profile, "User/settings.json"), JSON.stringify({ "workbench.startupEditor": "none", "window.restoreWindows": "none" }));
const output = await import("node:fs");
const log = output.createWriteStream(join(profile, "smoke.log"));
const child = spawn(executable, [
  "--classic", "--user-data-dir", profile, "--extensions-dir", join(profile, "extensions"),
  `--extensionDevelopmentPath=${join(root, "cursor-extension")}`,
  `--extensionTestsPath=${join(root, "cursor-extension/test/smoke.cjs")}`,
  "--disable-extensions", "--disable-workspace-trust", "--skip-welcome", "--skip-release-notes", "--new-window", repo,
], { stdio: ["ignore", "pipe", "pipe"] });
child.stdout.pipe(log); child.stderr.pipe(log);
let launchError;
child.on("error", error => { launchError = error; });
console.log(`Cursor smoke fixture: ${repo}\nIsolated profile and logs: ${profile}`);
try {
  let report;
  for (let i = 0; i < 900; i++) {
    if (launchError) throw launchError;
    try { report = JSON.parse(await readFile(join(repo, "smoke-result.json"), "utf8")); break; } catch (error) { if (error.code !== "ENOENT") throw error; }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  if (!report) throw new Error(`Cursor smoke timed out after 90s; inspect ${profile}/smoke.log`);
  if (!report.ok) throw new Error(report.error);
  console.log(`Cursor smoke passed: ${report.checks.join(", ")}`);
} finally {
  if (child.exitCode === null && child.signalCode === null) {
    const exited = once(child, "exit");
    child.kill("SIGTERM");
    const kill = setTimeout(() => child.kill("SIGKILL"), 3000);
    await exited;
    clearTimeout(kill);
  }
  child.stdout.destroy();
  child.stderr.destroy();
  log.end();
}
