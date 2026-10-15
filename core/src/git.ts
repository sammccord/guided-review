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

/** Resolve moving refs once, then use immutable commits for validation and the displayed diff. */
export async function resolveDiffRefs(cwd: string, base: string, head: string): Promise<{ base: string; head: string }> {
  const commit = (ref: string): Promise<string> => {
    if (/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(ref)) return Promise.resolve(ref.toLowerCase());
    return new Promise((resolve, reject) => {
      execFile("git", ["-C", cwd, "rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`], (error, stdout, stderr) => {
        if (error) reject(new Error(`cannot resolve ${ref} in ${cwd}: ${String(stderr).trim() || error.message}`));
        else resolve(String(stdout).trim());
      });
    });
  };
  const [resolvedBase, resolvedHead] = await Promise.all([commit(base), commit(head)]);
  return { base: resolvedBase, head: resolvedHead };
}

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
