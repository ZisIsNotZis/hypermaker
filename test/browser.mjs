// Launch a real browser without requiring the Playwright download when a
// system Chrome/Chromium build is already available.
//
// HYPERMAKER_CHROME (or CHROME_BIN) points at an existing executable; otherwise
// Playwright's bundled browser is used.
//
// When neither exists the failure is reported here with the one command that
// fixes it, because the Playwright banner ("Executable doesn't exist ... Please
// run ...") scrolls past eight tests and does not say that a local Chrome is an
// equally good answer.
import { existsSync } from "node:fs";
import { chromium } from "playwright";

const candidates = [process.env.HYPERMAKER_CHROME, process.env.CHROME_BIN].filter(Boolean);

export function browserPath() {
  return candidates[0] || chromium.executablePath();
}

export async function launchBrowser(options = {}) {
  if (candidates.length) {
    if (!existsSync(candidates[0])) throw new Error(`HYPERMAKER_CHROME/CHROME_BIN points at a browser that does not exist: ${candidates[0]}`);
    return chromium.launch({ headless: true, executablePath: candidates[0], ...options });
  }
  try {
    return await chromium.launch({ headless: true, ...options });
  } catch (error) {
    if (!/Executable doesn't exist/.test(error.message)) throw error;
    throw new Error([
      `No Chromium available for the browser tests. Playwright looked for ${chromium.executablePath()} and did not find it.`,
      "Either install it once with `npx playwright install chromium`, or point the tests at a Chrome you already have:",
      "  HYPERMAKER_CHROME=/path/to/chrome npm test",
      "Nothing else in `npm test` needs a browser; the unit tests and the canvas-script checks still run without one.",
    ].join("\n"));
  }
}
