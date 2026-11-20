export type CliWriter = { write(text: string): Promise<void> | void };

export type CliContext = {
  cwd: string;
  signal: AbortSignal;
  stdout: CliWriter;
  stderr: CliWriter;
  program: string;
  notes: NoteSink;
};

export type CliResult = { kind: "exit"; code: number };

export async function writeLine(writer: CliWriter, value: unknown) {
  await writer.write(`${typeof value === "string" ? value : JSON.stringify(value)}\n`);
}
import type { PostPlan, SessionRecord } from "../core/src/index";

export type NoteSink = { post(plan: PostPlan, session: SessionRecord): Promise<string | null> };

export const noNotes: NoteSink = { post: async () => null };
