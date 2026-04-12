# Setup Override

- Setup logic is dispatched via `npm run setup:step -- <step>` (e.g. `environment`, `container`, `groups`, `service`, `verify`).
- Do not free-edit individual setup step files without understanding the dispatcher in `setup/index.ts`.
- Setup tests live alongside steps as `setup/*.test.ts`; run them with `npm test` from the repo root.
- If you add a new step, register it in `setup/index.ts` and add a matching test.
