import { resolve } from "node:path";
import { loadTour } from "./repository";

async function main(): Promise<void> {
  const [directory, file, ...extra] = process.argv.slice(2);
  if (!directory || !file || extra.length) {
    console.error("usage: node cursor-extension/dist/check.js <repo> <tour.json>");
    process.exitCode = 2;
  } else {
    try {
      const loaded = await loadTour(resolve(file), resolve(directory));
      for (const warning of loaded.warnings) console.error(`warning: ${warning}`);
      console.log(`ok: ${loaded.stops.length} stops in ${loaded.tour.tracks.length} tracks across ${new Set(loaded.stops.map(({ stop }) => stop.path)).size} files, verdict ${loaded.tour.verdict}`);
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
  }
}
void main();
