import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { closeSessionDb, getInboundDb, initTestSessionDb } from './db/connection.js';
import { buildDestinationsSection, buildSystemPromptAddendum } from './destinations.js';

beforeEach(() => {
  initTestSessionDb();
});

afterEach(() => {
  closeSessionDb();
});

function seedDestination(name: string, displayName: string, channelType: string, platformId: string): void {
  getInboundDb()
    .prepare(
      `INSERT INTO destinations (name, display_name, type, channel_type, platform_id, agent_group_id)
       VALUES (?, ?, 'channel', ?, ?, NULL)`,
    )
    .run(name, displayName, channelType, platformId);
}

interface SeedDestinationSpec {
  name: string;
  type: 'channel' | 'agent';
  channel_type?: string;
  platform_id?: string;
  target_id?: string;
  display_name?: string;
}

function seedDestinations(specs: SeedDestinationSpec[]): void {
  const stmt = getInboundDb().prepare(
    `INSERT INTO destinations (name, display_name, type, channel_type, platform_id, agent_group_id)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  for (const spec of specs) {
    stmt.run(
      spec.name,
      spec.display_name ?? null,
      spec.type,
      spec.channel_type ?? null,
      spec.platform_id ?? null,
      spec.type === 'agent' ? (spec.target_id ?? null) : null,
    );
  }
}

// Regression: a task fire must name its destination explicitly (Task 21), so
// the destination list an agent reads has to disambiguate destinations that
// share a local name across channel types. Without the label, two
// same-named destinations render identically and a fire targets the wrong one.
describe('destinationLabel — channel type + display name labeling', () => {
  it('labels a destination with its channel type and display name', () => {
    seedDestinations([
      { name: 'boss', type: 'channel', channel_type: 'telegram', platform_id: 'chat-1', display_name: 'Ops Room' },
    ]);
    expect(buildDestinationsSection()).toContain('`boss` (telegram · Ops Room)');
  });

  it('omits the display name when it duplicates the local name', () => {
    seedDestinations([{ name: 'boss', type: 'channel', channel_type: 'telegram', platform_id: 'c', display_name: 'boss' }]);
    expect(buildDestinationsSection()).toContain('`boss` (telegram)');
  });

  it('renders a bare name when neither label is known', () => {
    seedDestinations([{ name: 'boss', type: 'agent', target_id: 'ag-2' }]);
    const section = buildDestinationsSection();
    expect(section).toContain('`boss`');
    // Scoped to the destination's own line — the section's boilerplate
    // guidance text legitimately contains unrelated parens (e.g. "(e.g., ...)").
    const bossLine = section.split('\n').find((line) => line.includes('`boss`'));
    expect(bossLine).not.toContain('(');
  });
});

describe('buildSystemPromptAddendum — multi-destination routing guidance', () => {
  it('includes default-routing nudge when there are >1 destinations', () => {
    seedDestination('casa', 'Casa', 'whatsapp', 'group-1@g.us');
    seedDestination('whatsapp-mg-17780', 'whatsapp-mg-17780', 'whatsapp', 'phone-2@s.whatsapp.net');

    const prompt = buildSystemPromptAddendum('Casa');

    expect(prompt).toContain('default to addressing the destination it came `from`');
    expect(prompt).toContain('from="name"');
    expect(prompt).toContain('`casa`');
    expect(prompt).toContain('`whatsapp-mg-17780`');
  });

  it('describes message wrapping for a single destination', () => {
    seedDestination('casa', 'Casa', 'whatsapp', 'group-1@g.us');

    const prompt = buildSystemPromptAddendum('Casa');

    expect(prompt).toContain('Wrap each delivered message');
    expect(prompt).toContain('<message to="name">');
    expect(prompt).toContain('do not send a separate visible confirmation');
    expect(prompt).toContain('Only report delivery status when delivery failed');
    expect(prompt).toContain('`casa`');
  });

  it('handles the no-destination case without crashing', () => {
    const prompt = buildSystemPromptAddendum('Casa');

    expect(prompt).toContain('no configured destinations');
    expect(prompt).not.toContain('default to addressing');
  });

  it('includes default-routing and wrapping instructions for single destination', () => {
    seedDestination('casa', 'Casa', 'whatsapp', 'group-1@g.us');

    const prompt = buildSystemPromptAddendum('Casa');

    expect(prompt).toContain('Wrap each delivered message');
    expect(prompt).toContain('<message to="name">');
    expect(prompt).toContain('do not send a separate visible confirmation');
    expect(prompt).toContain('Only report delivery status when delivery failed');
    expect(prompt).toContain('default to addressing the destination it came `from`');
    expect(prompt).toContain('`casa`');
  });
});
