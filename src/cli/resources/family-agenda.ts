import type { FamilyAgendaEvent, FamilyAgendaResult } from '../../integrations/family-agenda.js';
import { hostIntegrationInvoker, type HostIntegrationInvocationResult } from '../../integrations/invoker.js';
import { registerResource } from '../crud.js';
import type { CallerContext } from '../frame.js';

const PROFILE_NAME = 'family-agenda';
const OPERATION_NAME = 'agenda.read';
const DAY_MS = 24 * 60 * 60 * 1000;

const RANGE_FORMAT = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  timeZone: 'UTC',
});
const DAY_FORMAT = new Intl.DateTimeFormat('en-GB', {
  weekday: 'short',
  day: 'numeric',
  month: 'short',
  timeZone: 'UTC',
});
const COMPACT_DAY_FORMAT = new Intl.DateTimeFormat('en-GB', {
  weekday: 'short',
  day: 'numeric',
  timeZone: 'UTC',
});
const WEEK_FORMAT = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'short',
  timeZone: 'UTC',
});

interface DisplayEvent {
  line: string;
  sortKey: number;
}

function localDate(): string {
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Europe/Paris',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

function parseDate(value: string): Date {
  return new Date(`${value}T12:00:00Z`);
}

function dateRangeLabel(from: string, through: string): string {
  return RANGE_FORMAT.formatRange(parseDate(from), parseDate(through)).replace(/\s*–\s*/u, '–');
}

function dateWindowDays(from: string, through: string): number {
  return Math.round((parseDate(through).valueOf() - parseDate(from).valueOf()) / DAY_MS) + 1;
}

function addDays(value: string, days: number): string {
  const date = parseDate(value);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function mondayOf(value: string): string {
  const date = parseDate(value);
  const day = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() - day + 1);
  return date.toISOString().slice(0, 10);
}

function isWeekday(value: string): boolean {
  const day = parseDate(value).getUTCDay();
  return day >= 1 && day <= 5;
}

function normalized(value: string | null): string {
  return (value ?? '')
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase();
}

function activityLabel(value: string | null): string | null {
  const key = normalized(value);
  if (/\bperiscolaire\b/.test(key)) return 'After-school care';
  if (/\brestauration scolaire\b/.test(key)) return 'Canteen';
  if (/\baccueils? de loisirs\b/.test(key)) return 'Leisure centre';
  return value?.replace(/\s+VLG$/i, '').trim() || null;
}

function cleanTitle(value: string): string {
  return value
    .replace(/[-\s]*R[ée]sa(?:ervation)?\s*$/i, '')
    .replace(/^menu\s+/i, '')
    .trim();
}

function timeRange(event: FamilyAgendaEvent): string | null {
  if (event.start) return `${event.start}${event.end ? `–${event.end}` : ''}`;
  for (const value of [event.detail, event.title]) {
    const match = value?.match(/\b([01]?\d|2[0-3])(?:h|:)([0-5]\d)\s*[-–]\s*([01]?\d|2[0-3])(?:h|:)([0-5]\d)\b/i);
    if (!match) continue;
    return `${match[1].padStart(2, '0')}:${match[2]}–${match[3].padStart(2, '0')}:${match[4]}`;
  }
  return null;
}

function timeSortKey(range: string | null): number {
  if (!range) return 24 * 60;
  const match = range.match(/^(\d{2}):(\d{2})/);
  return match ? Number(match[1]) * 60 + Number(match[2]) : 24 * 60;
}

function menuLabel(event: FamilyAgendaEvent): string | null {
  const match = event.detail?.match(/\bmenu\s+(.+?)(?:\s+post\s+facturation|$)/i);
  const value = match?.[1]?.trim() || cleanTitle(event.title);
  if (!value || /^(repas|d[ée]jeuner)$/i.test(value)) return null;
  if (normalized(value) === 'classique') return 'classic menu';
  return value.toLocaleLowerCase('en-GB');
}

function safeText(value: string): string {
  // Event values originate outside the trust boundary. Keep them as literal
  // text when the final response is parsed as Telegram Markdown.
  return value
    .replace(/[\\`*_[\]]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function locationLabel(value: string): string {
  const safe = safeText(value);
  if (safe !== safe.toLocaleUpperCase('fr-FR')) return safe;
  const particles = new Set(['de', 'des', 'du', 'la', 'le', 'les']);
  return safe
    .toLocaleLowerCase('fr-FR')
    .split(' ')
    .map((word, index) =>
      index > 0 && particles.has(word) ? word : `${word.slice(0, 1).toLocaleUpperCase('fr-FR')}${word.slice(1)}`,
    )
    .join(' ');
}

function displayEvent(event: FamilyAgendaEvent, includeLocation: boolean): DisplayEvent {
  const activity = activityLabel(event.activity);
  const activityKey = normalized(event.activity);
  const titleKey = normalized(event.title);
  const range = timeRange(event);
  const location = includeLocation && event.location ? ` · ${safeText(event.location)}` : '';

  if (/\brestauration scolaire\b/.test(activityKey)) {
    const menu = menuLabel(event);
    return {
      line: `🍽 Canteen${menu ? ` · ${safeText(menu)}` : ''}${location}`,
      sortKey: 12 * 60,
    };
  }

  if (/\bperiscolaire\b/.test(activityKey)) {
    return {
      line: `🕒 ${range ? `${range} · ` : ''}After-school care${location}`,
      sortKey: timeSortKey(range),
    };
  }

  if (/\baccueils? de loisirs\b/.test(activityKey)) {
    if (/\b(menu|repas|dejeuner)\b/.test(titleKey)) {
      const menu = menuLabel(event);
      return {
        line: `🍽 Leisure centre lunch${menu ? ` · ${safeText(menu)}` : ''}${location}`,
        sortKey: 12 * 60,
      };
    }
    if (/\bmatin\b/.test(titleKey)) {
      return { line: `Morning · Leisure centre${location}`, sortKey: 8 * 60 };
    }
    if (/apres[- ]?midi/.test(titleKey)) {
      return { line: `Afternoon · Leisure centre${location}`, sortKey: 13 * 60 };
    }
  }

  const title = safeText(cleanTitle(event.title)) || 'Agenda event';
  const detail = event.detail && normalized(event.detail) !== normalized(event.title) ? safeText(event.detail) : '';
  const parts = [range, title, activity ? safeText(activity) : null, detail || null].filter(Boolean);
  return {
    line: `${range ? '🕒 ' : ''}${parts.join(' · ')}${location}`,
    sortKey: timeSortKey(range),
  };
}

function commonLocation(events: FamilyAgendaEvent[]): string | null {
  const locations = [
    ...new Set(events.map((event) => event.location?.trim()).filter((value): value is string => !!value)),
  ];
  return locations.length === 1 ? locations[0] : null;
}

function dateEvents(events: FamilyAgendaEvent[], location: string | null): Map<string, string[]> {
  const grouped = new Map<string, DisplayEvent[]>();
  for (const event of events) {
    const items = grouped.get(event.date) ?? [];
    items.push(displayEvent(event, location === null));
    grouped.set(event.date, items);
  }
  return new Map(
    [...grouped].map(([date, items]) => [
      date,
      items.sort((a, b) => a.sortKey - b.sortKey || a.line.localeCompare(b.line, 'en')).map((item) => item.line),
    ]),
  );
}

function shortWindowSections(result: FamilyAgendaResult, eventsByDate: Map<string, string[]>): string[] {
  const sections: string[] = [];
  const days = dateWindowDays(result.from, result.through);
  for (let offset = 0; offset < days; offset++) {
    const date = addDays(result.from, offset);
    const events = eventsByDate.get(date);
    if (!isWeekday(date) && !events) continue;
    sections.push(
      `**${DAY_FORMAT.format(parseDate(date))}**\n${events?.map((line) => `• ${line}`).join('\n') ?? '• Nothing scheduled'}`,
    );
  }
  return sections;
}

function longWindowSections(eventsByDate: Map<string, string[]>): string[] {
  const weeks = new Map<string, Map<string, { dates: string[]; events: string[] }>>();
  for (const [date, events] of [...eventsByDate].sort(([a], [b]) => a.localeCompare(b))) {
    const week = mondayOf(date);
    const schedules = weeks.get(week) ?? new Map<string, { dates: string[]; events: string[] }>();
    const signature = JSON.stringify(events);
    const schedule = schedules.get(signature) ?? { dates: [], events };
    schedule.dates.push(date);
    schedules.set(signature, schedule);
    weeks.set(week, schedules);
  }

  const sections: string[] = [];
  for (const [week, schedules] of weeks) {
    const groups = [...schedules.values()].map((schedule) => {
      const dates = schedule.dates.map((date) => COMPACT_DAY_FORMAT.format(parseDate(date))).join(' · ');
      return `**${dates}**\n${schedule.events.map((line) => `• ${line}`).join('\n')}`;
    });
    sections.push(`**Week of ${WEEK_FORMAT.format(parseDate(week))}**\n\n${groups.join('\n\n')}`);
  }
  return sections;
}

export function formatAgenda(data: unknown): string {
  const result = (data as HostIntegrationInvocationResult).data as FamilyAgendaResult;
  const location = commonLocation(result.events);
  const heading = [`📅 **Family agenda · ${dateRangeLabel(result.from, result.through)}**`];
  if (location) heading.push(`📍 ${locationLabel(location)}`);

  if (result.events.length === 0) return `${heading.join('\n')}\n\n• Nothing scheduled in this window`;

  const eventsByDate = dateEvents(result.events, location);
  const sections =
    dateWindowDays(result.from, result.through) <= 7
      ? shortWindowSections(result, eventsByDate)
      : longWindowSections(eventsByDate);
  return `${heading.join('\n')}\n\n${sections.join('\n\n')}`;
}

export async function invokeFamilyAgendaFacade(
  args: Record<string, unknown>,
  ctx: CallerContext,
): Promise<HostIntegrationInvocationResult> {
  const input = {
    from: args.from === undefined ? localDate() : String(args.from),
    days: Number(args.days),
  };

  return hostIntegrationInvoker.invoke({
    caller: ctx,
    profile: PROFILE_NAME,
    operation: OPERATION_NAME,
    input,
  });
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
      handler: invokeFamilyAgendaFacade,
      formatHuman: formatAgenda,
    },
  },
});
