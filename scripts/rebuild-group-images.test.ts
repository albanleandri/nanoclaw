// Pins which groups get their per-group image rebuilt after a base build. A
// group missed here silently keeps the previous runtime (that is how two
// groups stayed on Claude Code 2.1.197 after the 2.1.285 bump).
import { describe, expect, it, vi } from 'vitest';

vi.mock('../src/container-runner.js', () => ({ buildAgentGroupImage: vi.fn() }));

import { groupsNeedingImages } from './rebuild-group-images.js';

describe('groupsNeedingImages', () => {
  it('selects groups with apt or npm packages and skips empty or malformed lists', () => {
    expect(
      groupsNeedingImages([
        { agent_group_id: 'apt', packages_apt: '["poppler-utils"]', packages_npm: '[]' },
        { agent_group_id: 'npm', packages_apt: '[]', packages_npm: '["tsx"]' },
        { agent_group_id: 'none', packages_apt: '[]', packages_npm: '[]' },
        { agent_group_id: 'broken', packages_apt: 'not json', packages_npm: '' },
      ]),
    ).toEqual(['apt', 'npm']);
  });
});
