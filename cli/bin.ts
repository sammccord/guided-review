#!/usr/bin/env node
import { runMain } from "./main";

const controller = new AbortController();
process.once("SIGINT", () => controller.abort());
process.once("SIGTERM", () => controller.abort());
const result = await runMain(process.argv.slice(2), {
  cwd: process.cwd(), signal: controller.signal,
  stdout: { write: (text) => { process.stdout.write(text); } },
  stderr: { write: (text) => { process.stderr.write(text); } },
});
process.exitCode = result.code;
