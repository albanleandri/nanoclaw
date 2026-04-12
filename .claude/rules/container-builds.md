# Container Build Safety

- `npm run container:build` rebuilds the image from `container/build.sh`.
- Skill edits in `container/skills/` require a full rebuild — kill running containers after.
- BuildKit caches COPY steps aggressively; if a rebuild produces stale output, prune the builder first.
- Do not edit the IPC protocol in `container/agent-runner/src/index.ts` without also updating the host-side callers in `src/container-runner.ts`.
