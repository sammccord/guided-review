import { execFile } from "node:child_process";
import { parseDiffRanges, type DiffRanges } from "./anchors";

const GIT_PREFIX_ARGS = [
  "-c",
  "core.quotePath=true",
  "-c",
  "diff.noprefix=false",
  "-c",
  "diff.mnemonicPrefix=false",
  "-c",
  "diff.srcPrefix=a/",
  "-c",
  "diff.dstPrefix=b/",
];

/** Run git with hunk's own diff arguments and collect hunk ranges per path. */
export function readDiffRanges(cwd: string, base: string, head: string): Promise<DiffRanges> {
  const range = `${base}...${head}`;
  const args = ["-C", cwd, ...GIT_PREFIX_ARGS, "diff", "--no-ext-diff", "--find-renames", "--no-color", range];
  return new Promise((resolve, reject) => {
    execFile("git", args, { maxBuffer: 256 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        const detail = String(stderr).trim() || error.message;
        reject(new Error(`git diff ${range} failed in ${cwd}: ${detail}`));
        return;
      }
      resolve(parseDiffRanges(String(stdout)));
    });
  });
}
