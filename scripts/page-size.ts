// The form script is loaded on other sites' pages, so its size is watched: the build fails when the gzipped script
// grows past the budget.
import { readFileSync } from "node:fs";
import { gzipSync } from "node:zlib";

const BUDGET = 16 * 1024;
const file = new URL("../dist/page/f.js", import.meta.url);
const raw = readFileSync(file);
const gz = gzipSync(raw, { level: 9 }).length;
console.log(`dist/page/f.js: ${(raw.length / 1024).toFixed(1)} KiB, ${(gz / 1024).toFixed(1)} KiB gzipped (budget ${BUDGET / 1024} KiB)`);
if (gz > BUDGET) {
  console.error("The form script is over its budget; make it smaller or raise BUDGET with a reason.");
  process.exit(1);
}
