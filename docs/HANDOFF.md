# Handoff

## Current objective
Improve dual-agent friendliness by standardizing common operational commands into repo scripts, adding scoped shared rules, and reducing instruction drift between Codex and Claude Code across the broader Claude skill set.

## Files changed
- `AGENTS.md`
- `CLAUDE.md`
- `docs/HANDOFF.md`
- `docs/DEBUG_CHECKLIST.md`
- `docs/OPERATIONS.md`
- `package.json`
- `scripts/install-deps.sh`
- `scripts/build-agent-image.sh`
- `scripts/service-restart.sh`
- `scripts/service-status.sh`
- `scripts/setup-step.sh`
- `.claude/rules/shared-workflow.md`
- `.claude/rules/skill-maintenance.md`
- `container/agent-runner/AGENTS.override.md`
- `.claude/skills/setup/SKILL.md`
- `.claude/skills/add-telegram/SKILL.md`
- `.claude/skills/add-whatsapp/SKILL.md`
- `.claude/skills/add-slack/SKILL.md`
- `.claude/skills/add-discord/SKILL.md`
- `.claude/skills/add-gmail/SKILL.md`
- `.claude/skills/use-native-credential-proxy/SKILL.md`
- `.claude/skills/debug/SKILL.md`
- `.claude/skills/add-ollama-tool/SKILL.md`
- `.claude/skills/add-image-vision/SKILL.md`
- `.claude/skills/add-compact/SKILL.md`
- `.claude/skills/add-parallel/SKILL.md`
- `.claude/skills/channel-formatting/SKILL.md`
- `.claude/skills/init-onecli/SKILL.md`
- `.claude/skills/add-voice-transcription/SKILL.md`
- `.claude/skills/add-emacs/SKILL.md`
- `.claude/skills/add-pdf-reader/SKILL.md`
- `.claude/skills/add-reactions/SKILL.md`
- `.claude/skills/x-integration/SKILL.md`
- `.claude/skills/convert-to-apple-container/SKILL.md`
- `.claude/skills/claw/SKILL.md`
- `.claude/skills/add-telegram-swarm/SKILL.md`

## Commands run
- `rg --files`
- `find . -maxdepth 3 -type d | sort`
- `rg -n "apply-skill|systemctl --user|launchctl|container/build.sh|start-nanoclaw.sh|npm run setup|tsx setup/index.ts|npm install|cd container/agent-runner && npm install" README.md CLAUDE.md AGENTS.md docs CONTRIBUTING.md .claude/skills -g '!node_modules'`
- `ls -1 scripts`
- `sed -n '1,260p' docs/DEBUG_CHECKLIST.md`
- `sed -n '1,260p' .claude/skills/setup/SKILL.md`
- `nl -ba AGENTS.md | sed -n '1,220p'`
- `nl -ba CLAUDE.md | sed -n '1,220p'`
- `nl -ba package.json | sed -n '1,220p'`
- `nl -ba setup.sh | sed -n '1,220p'`
- `nl -ba start-nanoclaw.sh | sed -n '1,220p'`
- `nl -ba container/build.sh | sed -n '1,220p'`
- `sed -n '1,260p' CONTRIBUTING.md`
- `sed -n '1,340p' .claude/skills/setup/SKILL.md`
- `sed -n '1,260p' .claude/skills/add-telegram/SKILL.md`
- `sed -n '1,420p' .claude/skills/add-whatsapp/SKILL.md`
- `sed -n '1,260p' .claude/skills/add-slack/SKILL.md`
- `sed -n '1,260p' .claude/skills/add-discord/SKILL.md`
- `sed -n '1,280p' .claude/skills/add-gmail/SKILL.md`
- `rg -n "npm install|npx tsx setup/index\\.ts --step|launchctl kickstart -k gui/\\$\\(id -u\\)/com\\.nanoclaw|systemctl --user restart nanoclaw|launchctl list \\| grep nanoclaw|cd container && \\./build\\.sh" .claude/skills/setup/SKILL.md .claude/skills/add-telegram/SKILL.md .claude/skills/add-whatsapp/SKILL.md .claude/skills/add-slack/SKILL.md .claude/skills/add-discord/SKILL.md .claude/skills/add-gmail/SKILL.md`
- `rg -n "npm install|npx tsx setup/index\\.ts --step|launchctl kickstart -k gui/\\$\\(id -u\\)/com\\.nanoclaw|systemctl --user restart nanoclaw|launchctl list \\| grep nanoclaw|cd container && \\./build\\.sh" AGENTS.md CLAUDE.md README.md docs/DEBUG_CHECKLIST.md .claude/rules/shared-workflow.md .claude/rules/skill-maintenance.md .claude/skills/setup/SKILL.md .claude/skills/add-telegram/SKILL.md .claude/skills/add-whatsapp/SKILL.md .claude/skills/add-slack/SKILL.md .claude/skills/add-discord/SKILL.md .claude/skills/add-gmail/SKILL.md package.json`
- `git status --short`
- `rg -n "npm install|npx tsx setup/index\\.ts --step|launchctl kickstart -k gui/\\$\\(id -u\\)/com\\.nanoclaw|systemctl --user restart nanoclaw|launchctl list \\| grep nanoclaw|\\.\\/container/build\\.sh|cd container && \\./build\\.sh|\\./container/build\\.sh|bash start-nanoclaw\\.sh|systemctl --user status nanoclaw" .claude/skills -g 'SKILL.md'`
- `sed -n '1,360p' .claude/skills/use-native-credential-proxy/SKILL.md`
- `sed -n '1,340p' .claude/skills/debug/SKILL.md`
- `sed -n '1,460p' .claude/skills/x-integration/SKILL.md`
- `sed -n '1,260p' .claude/skills/add-ollama-tool/SKILL.md`
- `sed -n '1,220p' .claude/skills/add-image-vision/SKILL.md`
- `sed -n '1,240p' .claude/skills/add-compact/SKILL.md`
- `sed -n '1,340p' .claude/skills/add-parallel/SKILL.md`
- `sed -n '1,220p' .claude/skills/channel-formatting/SKILL.md`
- `sed -n '1,260p' .claude/skills/init-onecli/SKILL.md`
- `sed -n '1,260p' .claude/skills/add-telegram-swarm/SKILL.md`
- `sed -n '1,220p' .claude/skills/add-voice-transcription/SKILL.md`
- `sed -n '1,340p' .claude/skills/add-emacs/SKILL.md`
- `sed -n '1,180p' .claude/skills/add-pdf-reader/SKILL.md`
- `sed -n '1,180p' .claude/skills/add-reactions/SKILL.md`
- `sed -n '80,220p' .claude/skills/convert-to-apple-container/SKILL.md`
- `sed -n '100,140p' .claude/skills/claw/SKILL.md`

## Test/lint status
- Not run yet. This patch updates shell wrappers, shared instructions, and Claude skill docs.

## Open issues / next steps
- Only a few intentional/raw references remain in `.claude/skills/**`: `x-integration` has an extra package install fallback (`npm ls ... || npm install ...`), `add-whatsapp` still documents `bash start-nanoclaw.sh` as a nohup/manual fallback, and a couple of commented fallback lines remain in `add-telegram-swarm` and `customize`.
- If you want absolute consistency, do a small third pass that either rewrites those comments to reference `npm run service:restart`/`npm run service:status` or documents them as explicitly non-canonical fallback paths.
- If a Linux service unit is added to the repo later, update `scripts/service-restart.sh`, `scripts/service-status.sh`, and `docs/OPERATIONS.md` to match it.
