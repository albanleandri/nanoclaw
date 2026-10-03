import {
  fetchFamilyAgenda,
  loadFamilyAgendaCredential,
  type FamilyAgendaEvent,
  type FamilyAgendaResult,
} from '../../integrations/family-agenda.js';
import { registerResource } from '../crud.js';
import type { CallerContext } from '../frame.js';

function requireAuthorizedCaller(ctx: CallerContext, allowedAgentGroupId: string): void {
  if (ctx.caller === 'host') return;
  if (ctx.agentGroupId !== allowedAgentGroupId) throw new Error('Family agenda is not configured for this agent group');
}

function localDate(): string {
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Europe/Paris',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

function eventLine(event: FamilyAgendaEvent): string {
  const time = event.start ? `${event.start}${event.end ? `–${event.end}` : ''}` : 'Toute la journée';
  const context = [event.activity, event.location].filter(Boolean).join(' — ');
  const detail = event.detail && event.detail !== event.title ? ` — ${event.detail}` : '';
  return `  ${time} — ${event.title}${context ? ` (${context})` : ''}${detail}`;
}

function formatAgenda(data: unknown): string {
  const result = data as FamilyAgendaResult;
  if (result.events.length === 0) return `No family agenda events from ${result.from} through ${result.through}.`;
  const sections = new Map<string, FamilyAgendaEvent[]>();
  for (const event of result.events) {
    const events = sections.get(event.date) ?? [];
    events.push(event);
    sections.set(event.date, events);
  }
  return [...sections.entries()].map(([date, events]) => `${date}\n${events.map(eventLine).join('\n')}`).join('\n\n');
}

registerResource({
  name: 'family agenda',
  plural: 'family-agenda',
  table: 'not_applicable',
  description:
    'Read-only, host-mediated access to the configured family agenda. Credentials, cookies, raw portal data, and action URLs never leave the host.',
  idColumn: 'not_applicable',
  columns: [],
  operations: {},
  customOperations: {
    show: {
      access: 'open',
      description: 'Show normalized agenda events for a date window (1–31 days).',
      args: [
        {
          name: 'from',
          type: 'string',
          description: 'First date in YYYY-MM-DD form; defaults to today in Europe/Paris.',
        },
        { name: 'days', type: 'number', description: 'Number of days to include (1–31).', default: 3 },
      ],
      examples: ['ncl family-agenda show --days 3', 'ncl family-agenda show --from 2026-10-03 --days 7 --json'],
      handler: async (args, ctx) => {
        const credential = loadFamilyAgendaCredential();
        requireAuthorizedCaller(ctx, credential.agentGroupId);
        return fetchFamilyAgenda(credential, {
          from: args.from === undefined ? localDate() : String(args.from),
          days: Number(args.days),
        });
      },
      formatHuman: formatAgenda,
    },
  },
});
