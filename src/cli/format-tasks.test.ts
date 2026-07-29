import { describe, expect, it } from 'vitest';

import { formatTasksTable } from './format-tasks.js';

const NOW = Date.parse('2026-07-28T12:00:00.000Z');

describe('formatTasksTable', () => {
  it('reports the empty case in words, not an empty table', () => {
    expect(formatTasksTable([], NOW)).toBe('No tasks.');
  });

  it('renders relative last/next times and an aligned header', () => {
    const out = formatTasksTable(
      [
        {
          series_id: 'daily-1a2b',
          schedule: '0 9 * * *',
          runs: 12,
          failed_runs: 1,
          last_run: '2026-07-28T09:00:00.000Z',
          next_run: '2026-07-29T09:00:00.000Z',
          status: 'pending',
          created_at: '2026-07-01T09:00:00.000Z',
          prompt: 'Send the weekday sales briefing',
        },
      ],
      NOW,
    );
    const [header, row] = out.split('\n');
    expect(header).toContain('SERIES');
    expect(header).toContain('NEXT RUN');
    expect(row).toContain('daily-1a2b');
    expect(row).toContain('3h ago');
    expect(row).toContain('in 21h');
  });

  it('marks an overdue next run as due', () => {
    const out = formatTasksTable([{ series_id: 'x-0000', next_run: '2026-07-28T11:00:00.000Z' }], NOW);
    expect(out).toContain('due');
  });

  it('falls back to "once" for a series with no recurrence', () => {
    expect(formatTasksTable([{ series_id: 'x-0000' }], NOW)).toContain('once');
  });

  // Regression for the ncl-tasks port — process_after is stored naive-UTC in
  // some legacy rows. Treating a bare timestamp as local would shift every
  // relative time by the instance offset.
  //
  // The delta below (45 min) is deliberately off the exact-hour boundary:
  // duration()'s `s < 3600` check buckets a *precisely* 3600s gap as "1h ago",
  // not "60m ago", regardless of timezone. A round-number gap here would fail
  // on that rounding rule alone and could be mistaken for a UTC-parsing bug.
  it('treats an offset-less timestamp as UTC', () => {
    const out = formatTasksTable([{ series_id: 'x-0000', last_run: '2026-07-28 11:15:00' }], NOW);
    expect(out).toContain('45m ago');
  });
});
