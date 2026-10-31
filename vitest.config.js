import { defineConfig } from 'vitest/config';

// Integration tests drive real Chromium instances; on a busy laptop or CI runner one evidence
// collection (settle + a11y + theme audit) can take several seconds, so the per-test budget is generous.
export default defineConfig({
  test: {
    include: ['tests/**/*.test.js'],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    // tests never call a real model, even when an API key is set in the shell
    env: { AIE2E_EXPLAIN: 'false' },
  },
});
