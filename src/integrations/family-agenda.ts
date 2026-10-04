export interface FamilyAgendaEvent {
  date: string;
  start: string | null;
  end: string | null;
  title: string;
  activity: string | null;
  location: string | null;
  detail: string | null;
}

export interface FamilyAgendaResult {
  from: string;
  through: string;
  events: FamilyAgendaEvent[];
}

export function normalizeAgenda(payload: unknown): FamilyAgendaEvent[] {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('Family agenda calendar response has an invalid shape');
  }
  const root = payload as Record<string, unknown>;
  const groupValues = eventCollection(root, 'EvenementsGroupes');
  const eventValues = eventCollection(root, 'EvenementSystemes');

  const groups = new Map<string, { activity: string | null; location: string | null }>();
  for (const value of groupValues) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const group = value as Record<string, unknown>;
    const id = scalar(group.IdGroupeEvt);
    if (!id) continue;
    groups.set(id, {
      activity: cleanText(group.LibNomGroupeEvt),
      location: cleanText(group.LibComplementGroupeEvt),
    });
  }

  const events: FamilyAgendaEvent[] = [];
  for (const value of eventValues) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const event = value as Record<string, unknown>;
    const date = normalizePortalDate(event.DateEvenement);
    const title = cleanText(event.LibEvenement);
    if (!date || !title) continue;
    const group = groups.get(scalar(event.IdGroupeEvt) ?? '') ?? { activity: null, location: null };
    events.push({
      date,
      start: normalizePortalTime(event.HeureDebutEvenement),
      end: normalizePortalTime(event.HeureFinEvenement),
      title,
      activity: group.activity,
      location: group.location,
      detail: cleanText(event.LibCorpsEvenement),
    });
  }
  return events.sort((a, b) =>
    [a.date, a.start ?? '', a.activity ?? '', a.title]
      .join('\0')
      .localeCompare([b.date, b.start ?? '', b.activity ?? '', b.title].join('\0'), 'fr'),
  );
}

function eventCollection(root: Record<string, unknown>, name: string): unknown[] {
  const value = root[name];
  if (value === null) return [];
  if (!Array.isArray(value)) throw new Error('Family agenda calendar response is missing event collections');
  return value;
}

function scalar(value: unknown): string | null {
  return typeof value === 'string' || typeof value === 'number' ? String(value) : null;
}

function cleanText(value: unknown): string | null {
  const text = scalar(value);
  if (!text) return null;
  const cleaned = decodeEntities(text.replace(/<[^>]*>/g, ' '))
    .replace(/\p{Cc}/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned ? cleaned.slice(0, 500) : null;
}

function decodeEntities(value: string): string {
  const named: Record<string, string> = { amp: '&', apos: "'", gt: '>', lt: '<', nbsp: ' ', quot: '"' };
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, entity: string) => {
    if (entity.startsWith('#')) {
      const codePoint = Number.parseInt(
        entity.slice(entity[1]?.toLowerCase() === 'x' ? 2 : 1),
        entity[1]?.toLowerCase() === 'x' ? 16 : 10,
      );
      return Number.isInteger(codePoint) && codePoint >= 0 && codePoint <= 0x10ffff
        ? String.fromCodePoint(codePoint)
        : whole;
    }
    return named[entity.toLowerCase()] ?? whole;
  });
}

function normalizePortalDate(value: unknown): string | null {
  const raw = scalar(value);
  if (!raw || !/^\d{8}$/.test(raw)) return null;
  const iso = `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`;
  return isIsoDate(iso) ? iso : null;
}

function normalizePortalTime(value: unknown): string | null {
  let raw = scalar(value)?.trim() ?? '';
  if (!raw) return null;
  if (/^\d{3}$/.test(raw)) raw = `0${raw}`;
  if (!/^\d{4}$/.test(raw)) return null;
  const hour = Number(raw.slice(0, 2));
  const minute = Number(raw.slice(2));
  if (hour > 23 || minute > 59) return null;
  return `${raw.slice(0, 2)}:${raw.slice(2)}`;
}

function isIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value;
}
