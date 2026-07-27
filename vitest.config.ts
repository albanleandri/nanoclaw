import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // container/agent-runner tests run under Bun (they depend on bun:sqlite).
    // See container/agent-runner/package.json "test" script.
    // container/*.test.ts: top-level only — container/agent-runner tests run
    // under Bun (they depend on bun:sqlite) and must not be picked up here.
    include: ['src/**/*.test.ts', 'setup/**/*.test.ts', 'scripts/**/*.test.ts', 'container/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/**/*.d.ts'],
      reporter: ['text', 'lcov'],
      // Ratchet, not a target: set just under the measured values so coverage
      // cannot regress silently. Raise when it genuinely improves; lower only
      // deliberately. Mirrored for the agent-runner in
      // container/agent-runner/scripts/check-coverage.ts.
      thresholds: {
        statements: 64,
        branches: 58,
        functions: 70,
        lines: 67,
      },
    },
  },
});
