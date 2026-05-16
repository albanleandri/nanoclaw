import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: [
      'src/**/*.test.ts',
      'setup/**/*.test.ts',
      'container/agent-runner/src/**/*.test.ts',
    ],
    exclude: [
      // mcp-tools tests use bun:test (not vitest); run via `bun test` in container/agent-runner/
      'container/agent-runner/src/mcp-tools/**/*.test.ts',
    ],
  },
});
