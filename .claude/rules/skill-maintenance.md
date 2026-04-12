# Skill Maintenance

- When editing `.claude/skills/**`, prefer canonical repo commands over raw service/build/setup invocations.
- Use `npm run deps:install` instead of separate root and `container/agent-runner` install commands when both are needed.
- Use `npm run container:build`, `npm run service:restart`, `npm run service:status`, and `npm run setup:step -- ...` where they cover the workflow.
- Do not reintroduce deleted helper scripts like `scripts/apply-skill.ts` in docs or skill instructions; use the current skill workflow and repo wrappers instead.
- Keep platform-specific raw commands only when the skill is explicitly documenting a platform-specific fallback or deep troubleshooting path.
