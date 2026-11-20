export type CliWriter = { write(text: string): Promise<void> | void };

export type CliContext = {
  cwd: string;
  signal: AbortSignal;
  stdout: CliWriter;
  stderr: CliWriter;
  program: string;
};

export type CliResult = { kind: "exit"; code: number };

export async function writeLine(writer: CliWriter, value: unknown) {
  await writer.write(`${typeof value === "string" ? value : JSON.stringify(value)}\n`);
}
