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
 * Flags for the browser Stagehand launches (the agent's and replay's browser). Playwright launches its own
 * browsers (crawler, login, theme reference) with --no-sandbox by default; Stagehand does not, and on Linux
 * CI runners (Ubuntu 24+ restricts the user namespaces Chrome's sandbox needs) and in root containers Chrome
 * then never starts ("waiting for dynamic debugging port"). Match Playwright on Linux unless
 * AIE2E_CHROME_SANDBOX=true. Windows and macOS keep Chrome's defaults.
 * @param {{ chromeArgs: string[], chromeSandbox?: boolean }} cfg
 * @param {NodeJS.Platform} [platform]
 * @returns {string[]}
 */
export function agentChromeArgs(cfg, platform = process.platform) {
  const args = [...cfg.chromeArgs];
  if (platform === 'linux' && !cfg.chromeSandbox && !args.includes('--no-sandbox'))
    args.push('--no-sandbox');
  return args;
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
