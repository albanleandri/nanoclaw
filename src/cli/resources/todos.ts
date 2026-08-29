import { getContainerConfig } from '../../db/container-configs.js';
import { addTodo, completeTodo, listTodos, removeTodo, type TodoItem } from '../../todos.js';
import { registerResource } from '../crud.js';
import type { CallerContext } from '../frame.js';

function authorize(ctx: CallerContext): void {
  if (ctx.caller === 'host') return;
  const config = getContainerConfig(ctx.agentGroupId);
  const resources = config ? (JSON.parse(config.shared_resources) as unknown) : [];
  if (!Array.isArray(resources) || !resources.includes('knowledge')) {
    throw new Error('the calling agent is not granted the shared knowledge resource');
  }
}

function formatItem(item: TodoItem): string {
  return `- [${item.completed ? 'x' : ' '}] ${item.text}${item.due ? ` 📅 ${item.due}` : ''}`;
}

const textArg = { name: 'text', type: 'string' as const, description: 'Exact text for the new to-do.', required: true };
const matchArg = {
  name: 'match',
  type: 'string' as const,
  description: 'Case-insensitive unique substring of an active to-do.',
  required: true,
};

registerResource({
  name: 'todo',
  plural: 'todos',
  table: 'todos_host_managed',
  description:
    'Shared host-managed to-do list. Both Claude and Codex are equal clients; neither writes TODO.md directly.',
  idColumn: 'text',
  columns: [
    textArg,
    { name: 'due', type: 'string', description: 'Optional deadline in YYYY-MM-DD form.' },
    { name: 'completed', type: 'boolean', description: 'Whether the item is complete.' },
  ],
  operations: {},
  customOperations: {
    list: {
      access: 'open',
      description: 'List active and completed to-dos.',
      handler: async (_args, ctx) => {
        authorize(ctx);
        return listTodos();
      },
      formatHuman: (data) => (data as TodoItem[]).map(formatItem).join('\n') || 'No to-dos.',
    },
    add: {
      access: 'open',
      description: 'Add an active to-do. Use --text and optionally --due YYYY-MM-DD.',
      args: [textArg, { name: 'due', type: 'string', description: 'Optional deadline in YYYY-MM-DD form.' }],
      handler: async (args, ctx) => {
        authorize(ctx);
        return addTodo(args.text, args.due);
      },
      formatHuman: (data) => `Added ${formatItem(data as TodoItem)}`,
    },
    complete: {
      access: 'open',
      description: 'Move one uniquely matched active to-do to Done. Use --match.',
      args: [matchArg],
      handler: async (args, ctx) => {
        authorize(ctx);
        return completeTodo(args.match);
      },
      formatHuman: (data) => `Completed ${formatItem(data as TodoItem)}`,
    },
    remove: {
      access: 'open',
      description: 'Remove one uniquely matched active to-do. Use --match.',
      args: [matchArg],
      handler: async (args, ctx) => {
        authorize(ctx);
        return removeTodo(args.match);
      },
      formatHuman: (data) => `Removed ${formatItem(data as TodoItem)}`,
    },
  },
});
