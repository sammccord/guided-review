import { dirname } from "node:path/posix";

/** Keep each directory's files together, before its subdirectories, including unannotated files. */
export function groupFilesByDirectory<T extends { path: string }>(files: readonly T[]): T[] {
  const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
  return files.map((file) => ({ file, directory: dirname(file.path).split("/") }))
    .sort((a, b) => {
      const length = Math.min(a.directory.length, b.directory.length);
      for (let i = 0; i < length; i++) {
        const order = compare(a.directory[i]!, b.directory[i]!);
        if (order) return order;
      }
      return a.directory.length - b.directory.length || compare(a.file.path, b.file.path);
    })
    .map(({ file }) => file);
}
