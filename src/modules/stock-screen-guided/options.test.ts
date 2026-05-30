import { describe, expect, it } from 'vitest';

import { GUIDED_QUESTIONS, labelsForStep, mergeAnswersToParams, normalizeStepSelection } from './options.js';

describe('stock screen guided options', () => {
  it('has unique labels per question', () => {
    for (const question of Object.values(GUIDED_QUESTIONS)) {
      expect(new Set(question.options.map((option) => option.label)).size).toBe(question.options.length);
    }
  });

  it('normalizes all-option and empty selections to omitted params', () => {
    expect(normalizeStepSelection('market_cap', ['All cap tiers', 'Mega Cap'])).toEqual([]);
    expect(normalizeStepSelection('sector', [])).toEqual([]);
    expect(mergeAnswersToParams({ market_cap: [], sector: [], geography: [], currency: [] })).toEqual({});
  });

  it('expands real estate and utilities sector grouping', () => {
    expect(mergeAnswersToParams({ sector: ['Real Estate & Utilities'] })).toEqual({
      sectors: ['Real Estate', 'Utilities'],
    });
  });

  it('maps guided geographies to approved markets', () => {
    expect(mergeAnswersToParams({ geography: ['Developed Asia', 'China', 'Australia + NZ'] })).toEqual({
      countries: ['Hong Kong', 'Singapore', 'South Korea', 'Taiwan', 'China', 'Australia', 'New Zealand'],
    });
    expect(mergeAnswersToParams({ geography: ['US (NASDAQ + NYSE)'] })).toEqual({ exchanges: ['nasdaq', 'nyse'] });
  });

  it('keeps China separate from developed Asia', () => {
    const developedAsia = mergeAnswersToParams({ geography: ['Developed Asia'] });
    expect(developedAsia.countries).not.toContain('China');
    expect(labelsForStep('geography')).toContain('China');
  });

  it('merges selected answers into stock screen params', () => {
    expect(
      mergeAnswersToParams({
        market_cap: ['Mega Cap', 'Large Cap'],
        sector: ['Information Technology'],
        geography: ['Europe Core', 'Nordics'],
        currency: ['EUR (Euro)', 'CHF (Swiss Franc)'],
      }),
    ).toEqual({
      marketCaps: ['Mega Cap', 'Large Cap'],
      sectors: ['Information Technology'],
      countries: [
        'France',
        'Germany',
        'Netherlands',
        'Switzerland',
        'Belgium',
        'Spain',
        'Italy',
        'Austria',
        'Portugal',
        'Sweden',
        'Denmark',
        'Finland',
        'Norway',
      ],
      currencies: ['EUR', 'CHF'],
    });
  });
});
