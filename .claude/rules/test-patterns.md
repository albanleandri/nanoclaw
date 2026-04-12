# Test Patterns

- Unit tests live alongside source: `src/*.test.ts` and `setup/*.test.ts`.
- Run all tests with `npm test` (vitest) from the repo root.
- Container skill tests: `container/skills/**/test_*.py` (pytest, run inside a container).
- `container/agent-runner/package.json` test/lint scripts are stubs — run from repo root instead.
- Always run `npm test` before marking a task complete.
