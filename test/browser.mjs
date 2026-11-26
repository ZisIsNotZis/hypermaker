// Launch a real browser without requiring the Playwright download when a
// system Chrome/Chromium build is already available.
//
// HYPERMAKER_CHROME (or CHROME_BIN) points at an existing executable; otherwise
// Playwright's bundled browser is used.
import { chromium } from "playwright";

const candidates = [process.env.HYPERMAKER_CHROME, process.env.CHROME_BIN].filter(Boolean);

export async function launchBrowser(options = {}) {
  if (candidates.length) return chromium.launch({ headless: true, executablePath: candidates[0], ...options });
  return chromium.launch({ headless: true, ...options });
}
