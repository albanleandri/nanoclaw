import fs from 'fs';
import path from 'path';

export const RECOMMENDED_SECONDARY_TOOLS = [
  'Bash',
  'Read',
  'Write',
  'Edit',
  'Glob',
  'Grep',
  'WebSearch',
  'WebFetch',
  'SendMessage',
  'TodoWrite',
  'ToolSearch',
  'Skill',
  'mcp__nanoclaw__send_message',
  'mcp__nanoclaw__schedule_task',
  'mcp__nanoclaw__list_tasks',
  'mcp__nanoclaw__pause_task',
  'mcp__nanoclaw__resume_task',
  'mcp__nanoclaw__cancel_task',
  'mcp__nanoclaw__update_task',
];

export const RECOMMENDED_SECONDARY_SKILLS = [
  'agent-browser',
  'capabilities',
  'status',
];

export const SELECTABLE_RUNTIME_TOOLS = [
  ['Bash', 'Run shell commands in the sandbox.', true],
  ['Read', 'Read files from the mounted workspace.', true],
  ['Write', 'Create files directly in the workspace.', true],
  ['Edit', 'Edit existing files in place.', true],
  ['Glob', 'Find files by path pattern.', true],
  ['Grep', 'Search file contents by pattern.', true],
  ['WebSearch', 'Search the web for information.', true],
  ['WebFetch', 'Fetch and read web pages directly.', true],
  ['Task', 'Run delegated sub-tasks.', false],
  ['TaskOutput', 'Inspect delegated task output.', false],
  ['TaskStop', 'Stop delegated tasks.', false],
  ['TeamCreate', 'Create agent teams for parallel work.', false],
  ['TeamDelete', 'Delete agent teams.', false],
  ['SendMessage', 'Use Claude Code messaging primitives while working.', true],
  ['TodoWrite', 'Maintain structured working todo lists.', true],
  ['ToolSearch', 'Search the runtime tool catalog.', true],
  ['Skill', 'Invoke installed runtime skills.', true],
  ['NotebookEdit', 'Edit Claude notebook state.', false],
  [
    'mcp__nanoclaw__send_message',
    'Send a chat message immediately through NanoClaw IPC.',
    true,
  ],
  [
    'mcp__nanoclaw__schedule_task',
    'Create scheduled or recurring tasks for this group.',
    true,
  ],
  [
    'mcp__nanoclaw__list_tasks',
    'List scheduled tasks visible to this group.',
    true,
  ],
  ['mcp__nanoclaw__pause_task', 'Pause a scheduled task.', true],
  ['mcp__nanoclaw__resume_task', 'Resume a paused task.', true],
  ['mcp__nanoclaw__cancel_task', 'Cancel and delete a scheduled task.', true],
  ['mcp__nanoclaw__update_task', 'Update a scheduled task.', true],
] as const;

export interface SkillOption {
  name: string;
  description: string;
  recommended: boolean;
}

type FsLike = Pick<
  typeof fs,
  'existsSync' | 'readFileSync' | 'readdirSync' | 'statSync'
>;

export function readSkillSummary(
  skillDir: string,
  fsImpl: FsLike = fs,
): string {
  const skillDoc = path.join(skillDir, 'SKILL.md');
  if (!fsImpl.existsSync(skillDoc)) {
    return 'Runtime skill.';
  }

  const lines = fsImpl
    .readFileSync(skillDoc, 'utf-8')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !line.startsWith('#'))
    .filter((line) => !line.startsWith('```'));

  return lines[0]?.slice(0, 140) || 'Runtime skill.';
}

export function getAvailableSkillOptions(
  fsImpl: FsLike = fs,
  candidateRoots = [
    '/workspace/project/container/skills',
    '/home/node/.claude/skills',
  ],
): SkillOption[] {
  for (const root of candidateRoots) {
    if (!fsImpl.existsSync(root)) {
      continue;
    }

    return fsImpl
      .readdirSync(root)
      .filter((entry) => entry !== 'agents')
      .filter((entry) => fsImpl.statSync(path.join(root, entry)).isDirectory())
      .sort()
      .map((entry) => ({
        name: entry,
        description: readSkillSummary(path.join(root, entry), fsImpl),
        recommended: RECOMMENDED_SECONDARY_SKILLS.includes(entry),
      }));
  }

  return [];
}

export function formatRuntimeSelectionList(skillOptions: SkillOption[]): string {
  const toolLines = SELECTABLE_RUNTIME_TOOLS.map(
    ([id, description, recommended], index) =>
      `${index + 1}. \`${id}\` - ${description}${recommended ? ' [recommended]' : ''}`,
  );
  const recommendedToolNumbers = SELECTABLE_RUNTIME_TOOLS.map(
    ([, , recommended], index) => (recommended ? index + 1 : null),
  )
    .filter((value): value is number => value !== null)
    .join(',');
  const skillLines = skillOptions.map(
    (skill, index) =>
      `${index + 1}. \`${skill.name}\` - ${skill.description}${skill.recommended ? ' [recommended]' : ''}`,
  );
  const recommendedSkillNumbers = skillOptions
    .map((skill, index) => (skill.recommended ? index + 1 : null))
    .filter((value): value is number => value !== null)
    .join(',');

  return [
    'Selectable runtime tools for a new secondary group:',
    ...toolLines,
    '',
    `Recommended tool numbers for most secondary groups: ${recommendedToolNumbers}`,
    '',
    'Selectable runtime skills for a new secondary group:',
    ...(skillLines.length > 0
      ? skillLines
      : ['(No runtime skills were discovered in this install.)']),
    '',
    `Recommended skill numbers for most secondary groups: ${recommendedSkillNumbers || '(none)'}`,
    '',
    'Ask the user to reply with exact selections like:',
    'tools: 1,2,3',
    'skills: 1,2,3',
  ].join('\n');
}
