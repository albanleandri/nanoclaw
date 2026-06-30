const MAX_DOCUMENT_CHARS = 32_000;

function clean(value: string): string | undefined {
  const withoutControls = [...value]
    .map((character) => {
      const code = character.charCodeAt(0);
      return (code >= 0 && code <= 8) || code === 11 || code === 12 || (code >= 14 && code <= 31) || code === 127
        ? ' '
        : character;
    })
    .join('');
  const normalized = withoutControls.replace(/\s+/g, ' ').trim();
  return normalized ? normalized.slice(0, MAX_DOCUMENT_CHARS) : undefined;
}

export function normalizeSessionText(input: {
  direction: 'inbound' | 'outbound';
  kind: string;
  channelType?: string | null;
  content: string;
}): { role: 'user' | 'assistant'; text: string } | undefined {
  if (input.kind !== 'chat' && input.kind !== 'chat-sdk') return undefined;
  if (input.direction === 'outbound' && input.channelType === 'agent') return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(input.content);
  } catch {
    // Malformed historical rows are not searchable documents.
    return undefined;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
  const record = parsed as Record<string, unknown>;
  const value =
    typeof record.text === 'string'
      ? record.text
      : typeof record.message === 'string'
        ? record.message
        : typeof record.content === 'string'
          ? record.content
          : undefined;
  if (!value) return undefined;
  const text = clean(value);
  return text ? { role: input.direction === 'inbound' ? 'user' : 'assistant', text } : undefined;
}
