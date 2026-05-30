import { describe, expect, it } from 'vitest';

import { buildPreviewArgs, summarizeParams } from './resolver.js';

describe('screen market guided preview resolver helpers', () => {
  it('builds market_tickers preview arguments from guided params', () => {
    expect(
      buildPreviewArgs({
        marketCaps: ['Large Cap', 'Mid Cap'],
        sectors: ['Financials'],
        countries: ['Canada'],
        exchanges: ['nasdaq'],
        currencies: ['CAD'],
      }),
    ).toEqual([
      'container/skills/custom/stock-market-investing/market_tickers.py',
      '--market-cap',
      'Large Cap',
      'Mid Cap',
      '--sector',
      'Financials',
      '--countries',
      'Canada',
      '--exchanges',
      'nasdaq',
      '--currency',
      'CAD',
      '--preview',
      '5',
    ]);
  });

  it('summarizes empty filters as all-market coverage', () => {
    expect(summarizeParams({})).toBe('All markets, sectors, currencies, and cap tiers');
  });
});
