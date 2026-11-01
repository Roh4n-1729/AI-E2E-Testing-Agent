import { testFingerprint } from '../storage/recordStore.js';

/**
 * Exploring deeper. The crawler only follows links, so screens behind a click (a modal, a wizard step, a page a
 * button opens, the state after "Generate") never reach the planner, and tests about them can only ask visual
 * questions. Every passing test has already been to such screens. Discovery turns the screen each passing,
 * recorded test ended on into a starting point for the next round: what it offers (from the judge's evidence)
 * and the recorded steps that reach it (replayed by Playwright, no AI).
 *
 * @import { RecordStore } from './ports.js'
 * @import { RecordedStep, SitePage, SiteMap, TestCase, TestResult } from './types.js'
 */

/**
 * @typedef {object} Screen  A screen an earlier test reached that the crawl never saw.
 * @property {string} url
 * @property {string} title
 * @property {{ testId: string, title: string }} from  the test that ended there
 * @property {RecordedStep[]} steps  replayable steps that reach it
 * @property {SitePage} page  the screen in the crawler's terms, for the planner
 * @property {boolean} [direct]  opening `url` in a fresh browser shows this same screen: tests start there, with no
 *   steps to replay
 */

/** What a fresh browser shows at a URL. @typedef {{ url: string, title: string, text: string, buttons: string[] }} Snapshot */

/**
 * A screen already known (crawled or discovered). Identity is the route with ids folded (`/deck/:id`) plus the
 * controls it offers: two decks open in the same editor are one screen, whatever their slides say.
 * @typedef {{ route: string, controls: Set<string>, words: Set<string> }} Seen
 */

/** Two screens on one route are the same screen when this share of their controls match... */
const SAME_CONTROLS = 0.6;
/** ...or, for screens without controls, this share of their words. */
const SAME_WORDS = 0.7;

/** Lower-cased words, numbers folded ("Cart (2)" and "Cart (3)" are one screen), for comparing screens. */
const wordsOf = (/** @type {string} */ text) =>
  new Set(
    text
      .toLowerCase()
      .replace(/\d+(?:[.,]\d+)*/g, '#')
      .split(/[^\p{L}\p{N}#]+/u)
      .filter((w) => w.length > 1)
      .slice(0, 400),
  );

/** A path segment that names one record rather than a kind of page: `d_mvx951ic6i8i`, `42`, a uuid. */
const ID_SEGMENT = /^(?=.*\d)[\w-]{4,}$|^\d+$/;

/** `/deck/d_mvx951ic6i8i/present/1` -> `/deck/:id/present/:id`; query values dropped, keys kept. @param {string} url */
export const routeOf = (url) => {
  try {
    const u = new URL(url);
    const path = u.pathname
      .split('/')
      .map((seg) => (ID_SEGMENT.test(seg) ? ':id' : seg))
      .join('/')
      .replace(/\/+$/, '');
    const keys = [...u.searchParams.keys()].sort();
    return `${path || '/'}${keys.length ? `?${keys.join('&')}` : ''}`;
  } catch {
    return url;
  }
};

/** Short control labels (toolbar buttons, not slide thumbnails full of content), numbers folded. */
const controlsOf = (/** @type {string[]} */ buttons = []) =>
  new Set(
    buttons
      .map((b) => b.replace(/\s+/g, ' ').trim().toLowerCase())
      .filter((b) => b && b.length <= 30)
      .map((b) => b.replace(/\d+/g, '#')),
  );

/** Jaccard similarity of two word sets. @param {Set<string>} a @param {Set<string>} b */
export function similarity(a, b) {
  if (!a.size && !b.size) return 1;
  let both = 0;
  for (const w of a) if (b.has(w)) both++;
  return both / (a.size + b.size - both);
}

/** @param {string} url @param {string} text @param {string[]} [buttons] @returns {Seen} */
export const seenScreen = (url, text, buttons) => ({
  route: routeOf(url),
  controls: controlsOf(buttons),
  words: wordsOf(text),
});

/** The screens the crawl already showed the planner. @param {SiteMap} siteMap @returns {Seen[]} */
export const crawledScreens = (siteMap) =>
  siteMap.pages.map((p) => seenScreen(p.url, `${p.title} ${p.textExcerpt ?? ''}`, p.buttons));

/** @param {Seen} a @param {Seen} b */
export const sameScreen = (a, b) =>
  a.route === b.route &&
  (a.controls.size && b.controls.size
    ? similarity(a.controls, b.controls) >= SAME_CONTROLS
    : similarity(a.words, b.words) >= SAME_WORDS);

/**
 * The steps that reach a test's end screen: its recording, only when it belongs to this exact test (a recording
 * made for an older version of the test reaches somewhere else).
 * @param {RecordStore} store
 * @returns {(test: TestCase) => Promise<RecordedStep[] | null>}
 */
export const recordedSteps = (store) => async (test) => {
  const rec = await store.load(test.id);
  return rec && rec.fingerprint === testFingerprint(test) ? rec.steps : null;
};

/**
 * New screens the passing tests of the last round ended on, in plan order. A screen counts as new when no crawled
 * or already discovered screen has its route and mostly the same controls (or words). When several tests reach
 * the same new screen, the shortest recorded path to it is kept: every round-2 test replays it. `known` is
 * extended in place, so a later round does not rediscover them.
 * @param {{ results: TestResult[], known: Seen[], stepsFor: (test: TestCase) => Promise<RecordedStep[] | null>, origin: string, max: number }} o
 * @returns {Promise<Screen[]>}
 */
export async function discoverScreens({ results, known, stepsFor, origin, max }) {
  /** @type {Screen[]} */
  const screens = [];
  /** @type {Seen[]} the identity of each screen in `screens`, same order */
  const found = [];
  for (const r of results) {
    const ev = r.evidence;
    // only judge-approved runs, of tests that did something, ending on this app
    if (r.verdict.status !== 'pass' || !r.test.goal.trim() || !ev.finalUrl) continue;
    if (!ev.finalUrl.startsWith(origin)) continue;
    const seen = seenScreen(ev.finalUrl, `${ev.title} ${ev.pageTextExcerpt}`, ev.screen?.buttons);
    if (known.some((k) => sameScreen(k, seen))) continue;
    const steps = await stepsFor(r.test);
    // replayable, and more than just opening the start page
    if (!steps || !steps.some((s) => s.kind !== 'navigate' || s.index > 0)) continue;
    const twin = found.findIndex((f) => sameScreen(f, seen));
    if (twin >= 0) {
      if (steps.length >= screens[twin].steps.length) continue;
      screens.splice(twin, 1); // a shorter way to the same screen
      found.splice(twin, 1);
    } else if (screens.length >= max) continue;
    found.push(seen);
    const screen = ev.screen;
    screens.push({
      url: ev.finalUrl,
      title: ev.title,
      from: { testId: r.test.id, title: r.test.title },
      steps,
      page: {
        url: ev.finalUrl,
        title: ev.title,
        textExcerpt: ev.pageTextExcerpt.replace(/\s+/g, ' ').trim().slice(0, 1500),
        links: screen?.links ?? [],
        buttons: screen?.buttons ?? [],
        forms: screen?.forms ?? 0,
        apiCalls: screen?.apiCalls ?? [],
        testIds: screen?.testIds ?? [],
        hints: screen?.hints ?? [],
        inputs: screen?.inputs ?? [],
      },
    });
  }
  known.push(...found);
  return screens;
}

/**
 * Many screens behind a click still have their own address (`/deck/d_…`). Open each discovered screen's URL in a
 * fresh browser: when the same screen appears (same route and controls), round-2 tests start there in seconds
 * instead of replaying every step that led to it (on an AI app, generating a deck each time). When it does not
 * (the state lived only in that test's browser, or the URL redirects), the steps stay. Marks `direct` in place.
 * @param {Screen[]} screens @param {(url: string) => Promise<Snapshot | null>} open
 * @returns {Promise<number>} how many screens open directly
 */
export async function reachDirectly(screens, open) {
  let direct = 0;
  for (const sc of screens) {
    const snap = await open(sc.url).catch(() => null);
    if (!snap) continue;
    const was = seenScreen(
      sc.page.url,
      `${sc.page.title} ${sc.page.textExcerpt ?? ''}`,
      sc.page.buttons,
    );
    const now = seenScreen(snap.url, `${snap.title} ${snap.text}`, snap.buttons);
    if (sameScreen(was, now)) {
      sc.direct = true;
      direct++;
    }
  }
  return direct;
}
