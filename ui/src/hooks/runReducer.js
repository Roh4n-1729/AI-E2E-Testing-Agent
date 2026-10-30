// @ts-nocheck -- UI code is linted by eslint; this pure module is also imported by tests
export const initial = {
  target: null,
  config: null,
  phases: { login: null, crawl: null, plan: null, run: null, report: null },
  site: [], // pages the crawler found: [{ url, title }]
  review: null, // { found: string[], remaining: string[] } from the plan review
  tests: {}, // id -> { id, title, goal, expectations, status, steps[], screenshots[], result? }
  order: [],
  logs: [],
  summary: null,
  finished: false,
  error: null,
};

const blank = (id, title = id, goal = '', expectations = []) => ({
  id,
  title,
  goal,
  expectations,
  status: 'pending',
  steps: [],
  screenshots: [],
  result: null,
});

/** Pure event -> state reducer: the whole live view is a function of the event stream. */
export function reduce(state, { type, data }) {
  switch (type) {
    case 'run.started':
      return { ...state, target: data.target, config: data.config };
    case 'phase':
      return {
        ...state,
        phases: { ...state.phases, [data.phase]: { status: data.status, detail: data.detail } },
      };
    case 'site.ready':
      return { ...state, site: data.pages ?? [] };
    case 'plan.review':
      return { ...state, review: data };
    case 'plan.ready': {
      const tests = {};
      for (const t of data.tests) tests[t.id] = blank(t.id, t.title, t.goal, t.expectations);
      return { ...state, tests, order: data.tests.map((t) => t.id) };
    }
    case 'test.started': {
      const t = state.tests[data.testId] ?? blank(data.testId, data.title, data.goal);
      return {
        ...state,
        tests: { ...state.tests, [data.testId]: { ...t, status: 'running' } },
        order: state.order.includes(data.testId) ? state.order : [...state.order, data.testId],
      };
    }
    case 'test.step':
    case 'test.screenshot': {
      const t = state.tests[data.testId];
      if (!t) return state;
      const key = type === 'test.step' ? 'steps' : 'screenshots';
      return {
        ...state,
        tests: { ...state.tests, [data.testId]: { ...t, [key]: [...t[key], data] } },
      };
    }
    case 'test.finished': {
      const t = state.tests[data.testId] ?? blank(data.testId, data.title);
      return {
        ...state,
        tests: { ...state.tests, [data.testId]: { ...t, status: data.status, result: data } },
      };
    }
    case 'log':
      return { ...state, logs: [...state.logs.slice(-199), data] };
    case 'run.finished':
      return { ...state, finished: true, summary: data.summary };
    case 'run.error':
      return { ...state, finished: true, error: data.message };
    default:
      return state;
  }
}

/**
 * Subscribe to a live run over SSE. Frames (the live browser view) are kept apart from the reducer
 * state so a 4 fps video does not re-run the reducer. Events are de-duplicated by id, because the
 * server replays history when EventSource reconnects.
 */
