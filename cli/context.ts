import type { PostPlan, SessionRecord } from "../core/src/index";

export type CliWriter = { write(text: string): Promise<void> | void };

/** Posts the agent's answer into the host's UI and returns the note id, or null when the host has no notes. */
export type NoteSink = { post(plan: PostPlan, session: SessionRecord): Promise<string | null> };

export const noNotes: NoteSink = { post: async () => null };

export type CliContext = {
  cwd: string;
  signal: AbortSignal;
  stdout: CliWriter;
  stderr: CliWriter;
  program: string;
  notes: NoteSink;
  /** Reads all of standard input for `--text-file -`; hosts without a usable stdin omit it. */
  readStdin?: () => Promise<string>;
};

export type CliResult = { kind: "exit"; code: number };

export async function writeLine(writer: CliWriter, value: unknown) {
  await writer.write(`${typeof value === "string" ? value : JSON.stringify(value)}\n`);
}
