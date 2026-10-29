import { existsSync } from 'node:fs';
import { chromium } from 'playwright';

/** Usual install locations of a system Chrome/Edge, checked in order. */
function systemBrowserCandidates(env = process.env) {
  const win = [env.PROGRAMFILES, env['PROGRAMFILES(X86)'], env.LOCALAPPDATA]
    .filter(Boolean)
    .flatMap((base) => [
      `${base}\\Google\\Chrome\\Application\\chrome.exe`,
      `${base}\\Microsoft\\Edge\\Application\\msedge.exe`,
    ]);
  return [
    ...win,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ];
}

/**
 * Chromium binary used by EVERY component (agent, crawler, replay), so they never disagree:
 * explicit config > Playwright's full Chromium > an installed system Chrome/Edge.
 * Returns undefined only when nothing is found; callers then get Playwright's own error.
 * @param {{ chromePath?: string }} cfg
 * @returns {string | undefined}
 */
export function resolveChromePath(cfg) {
  if (cfg.chromePath) return cfg.chromePath;
  try {
    const pw = chromium.executablePath();
    if (pw && existsSync(pw)) return pw;
  } catch {
    /* Playwright browsers not installed */
  }
  return systemBrowserCandidates().find((p) => existsSync(p));
}
