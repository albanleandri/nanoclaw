import { describe, expect, it } from 'bun:test';

import { buildCompactInstructions } from './compact-instructions.js';

describe('buildCompactInstructions', () => {
  it('preserves both scheduled and current task times across compaction', () => {
    const instructions = buildCompactInstructions(['ops']);

    expect(instructions).toContain('<task from="..." time="..." current_time="...">');
    expect(instructions).toContain('Available destinations: `ops`');
  });
});
