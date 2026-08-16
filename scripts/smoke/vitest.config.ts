import { defineConfig } from 'vitest/config';

/**
 * Vitest config for the bridge-smoke runner — PM-2.5 (2026-06-13).
 *
 * Separate config from the project root vitest.config.ts because:
 *   - Smoke tests need the bridge live; unit tests don't.
 *   - Smoke runs a different glob (scripts/smoke/**.smoke.ts).
 *   - Smoke wants a long timeout (some endpoints take > 5s on cold cache).
 *
 * Run via: `npm run smoke:bridge:ts`
 *   or:    `npx vitest run --config scripts/smoke/vitest.config.ts`
 */
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['scripts/smoke/**/*.smoke.ts'],
    // Smoke calls out to the live bridge — give it 30s per test, plenty
    // for first-call brain decide paths but bounded so a hung bridge
    // doesn't lock CI forever.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // Smoke is mostly serial — concurrent dispatches against the same DB
    // can create flake. Single-fork is fine for the volume we have.
    pool: 'forks',
    fileParallelism: false,
    reporters: ['default'],
  },
});
