/** Thin fetch wrappers. Errors carry the server's message so the UI can show it as-is. */
async function request(path, init) {
  const res = await fetch(path, init);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `Request failed (${res.status})`);
  return body;
}

const json = (method, body) => ({
  method,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

export const api = {
  health: () => request('/api/health'),
  startRun: (options) => request('/api/runs', json('POST', options)),
  runs: () => request('/api/runs'),
  run: (id) => request(`/api/runs/${id}`),
  stop: (id) => request(`/api/runs/${id}/stop`, { method: 'POST' }),
  reviewVisual: (id, body) => request(`/api/runs/${id}/visual`, json('POST', body)),
  suites: () => request('/api/suites'),
  suite: (name) => request(`/api/suites/${name}`),
  saveSuite: (name, suite) => request(`/api/suites/${name}`, json('PUT', suite)),
  deleteSuite: (name) => request(`/api/suites/${name}`, { method: 'DELETE' }),
  suiteFromRun: (runId) => request(`/api/suites/from-run/${runId}`, { method: 'POST' }),
  recordings: () => request('/api/recordings'),
  recording: (id) => request(`/api/recordings/${id}`),
  deleteRecording: (id) => request(`/api/recordings/${id}`, { method: 'DELETE' }),
};

/** URL of a file inside a run folder (report, screenshot...). */
export const fileUrl = (runId, relPath) => `/files/runs/${runId}/${relPath}`;
