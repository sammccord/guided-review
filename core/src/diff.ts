export type DiffLineKind = "context" | "add" | "del";

export interface DiffLine {
  kind: DiffLineKind;
  oldLine?: number;
  newLine?: number;
  text: string;
}

export interface DiffHunk {
  header: string;
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  lines: DiffLine[];
}

export type DiffFileStatus = "modified" | "added" | "deleted" | "renamed";

export interface DiffFile {
  path: string;
  oldPath?: string;
  status: DiffFileStatus;
  binary: boolean;
  hunks: DiffHunk[];
}

const C_ESCAPES: Record<string, string> = { a: "\x07", b: "\b", t: "\t", n: "\n", v: "\v", f: "\f", r: "\r", '"': '"', "\\": "\\" };

function decodePath(raw: string): string {
  if (!raw.startsWith('"') || !raw.endsWith('"')) return raw;
  const body = raw.slice(1, -1);
  const encoder = new TextEncoder();
  const bytes: number[] = [];
  for (let i = 0; i < body.length;) {
    const ch = body[i]!;
    if (ch === "\\") {
      const octal = /^[0-7]{1,3}/.exec(body.slice(i + 1, i + 4));
      if (octal) {
        bytes.push(Number.parseInt(octal[0], 8));
        i += octal[0].length + 1;
        continue;
      }
      const escaped = body[i + 1] ?? "";
      bytes.push(...encoder.encode(C_ESCAPES[escaped] ?? escaped));
      i += 2;
    } else {
      const point = body.codePointAt(i)!;
      bytes.push(...encoder.encode(String.fromCodePoint(point)));
      i += point > 0xffff ? 2 : 1;
    }
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
}

function readHeaderPaths(header: string): [string, string] | null {
  const rest = header.slice(11);
  let split = rest.indexOf(" b/");
  if (rest.startsWith('"')) {
    for (let i = 1; i < rest.length; i++) {
      if (rest[i] === "\\") i++;
      else if (rest[i] === '"') {
        split = i + 1;
        break;
      }
    }
  } else if (split < 0) split = rest.indexOf(' "b/');
  if (split < 0) return null;
  const oldPath = decodePath(rest.slice(0, split));
  const newPath = decodePath(rest.slice(split + 1));
  if (!oldPath.startsWith("a/") || !newPath.startsWith("b/")) return null;
  return [oldPath.slice(2), newPath.slice(2)];
}

export function parseUnifiedDiff(patch: string): DiffFile[] {
  const files: DiffFile[] = [];
  let file: DiffFile | undefined;
  let hunk: DiffHunk | undefined;
  let oldPath = "";
  let oldLine = 0;
  let newLine = 0;
  let oldLeft = 0;
  let newLeft = 0;
  const lines = patch.split("\n");
  if (lines.at(-1) === "") lines.pop();
  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      file = undefined;
      hunk = undefined;
      const paths = readHeaderPaths(line);
      if (!paths) continue;
      oldPath = paths[0];
      file = { path: paths[1], status: "modified", binary: false, hunks: [] };
      files.push(file);
      continue;
    }
    if (!file || line.startsWith("\\ No newline at end of file")) continue;
    if (hunk && (oldLeft > 0 || newLeft > 0)) {
      const marker = line[0];
      if ((marker === " " || line === "") && oldLeft > 0 && newLeft > 0) {
        hunk.lines.push({ kind: "context", oldLine: oldLine++, newLine: newLine++, text: line.slice(1) });
        oldLeft--;
        newLeft--;
        continue;
      }
      if (marker === "-" && oldLeft > 0) {
        hunk.lines.push({ kind: "del", oldLine: oldLine++, text: line.slice(1) });
        oldLeft--;
        continue;
      }
      if (marker === "+" && newLeft > 0) {
        hunk.lines.push({ kind: "add", newLine: newLine++, text: line.slice(1) });
        newLeft--;
        continue;
      }
      hunk = undefined;
    }
    if (line.startsWith("rename from ")) {
      file.oldPath = decodePath(line.slice(12));
      file.status = "renamed";
    } else if (line.startsWith("rename to ")) {
      file.path = decodePath(line.slice(10));
      file.status = "renamed";
      file.oldPath ??= oldPath;
    } else if (line.startsWith("new file mode ") || line === "--- /dev/null") file.status = "added";
    else if (line.startsWith("deleted file mode ") || line === "+++ /dev/null") {
      file.status = "deleted";
      file.path = oldPath;
    } else if (line.startsWith("--- ") && line !== "--- /dev/null") {
      oldPath = decodePath(line.slice(4).split("\t")[0]!).replace(/^a\//, "");
      if (file.status === "deleted") file.path = oldPath;
    } else if (line.startsWith("+++ ") && line !== "+++ /dev/null") {
      file.path = decodePath(line.slice(4).split("\t")[0]!).replace(/^b\//, "");
    } else if (line.startsWith("Binary files ") || line === "GIT binary patch") {
      file.binary = true;
      file.hunks = [];
      hunk = undefined;
    } else if (!file.binary && line.startsWith("@@ ")) {
      const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (!match) continue;
      oldLine = Number(match[1]);
      newLine = Number(match[3]);
      oldLeft = match[2] === undefined ? 1 : Number(match[2]);
      newLeft = match[4] === undefined ? 1 : Number(match[4]);
      if (![oldLine, newLine, oldLeft, newLeft].every(Number.isSafeInteger)) continue;
      hunk = { header: line, oldStart: oldLine, oldCount: oldLeft, newStart: newLine, newCount: newLeft, lines: [] };
      file.hunks.push(hunk);
    }
  }
  return files;
}
