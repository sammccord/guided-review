import { build } from "esbuild";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("./", import.meta.url));
await build({
  entryPoints: { extension: `${root}src/extension.ts`, check: `${root}src/check.ts` },
  outdir: `${root}dist`,
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20",
  external: ["vscode"],
  sourcemap: true,
  logLevel: "info",
});
