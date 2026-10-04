import { describe, expect, it } from 'vitest';

import { normalizeAgenda } from './family-agenda.js';

describe('family agenda normalization', () => {
  it('treats explicit null collections as a valid empty agenda', () => {
    expect(normalizeAgenda({ EvenementsGroupes: null, EvenementSystemes: null })).toEqual([]);
  });

  it('keeps only inert normalized event fields and strips markup', () => {
    const result = normalizeAgenda({
      EvenementsGroupes: [
        { IdGroupeEvt: 9, LibNomGroupeEvt: 'Accueil &amp; loisirs', LibComplementGroupeEvt: '<b>École</b>' },
      ],
      EvenementSystemes: [
        {
          DateEvenement: '20261005',
          IdGroupeEvt: 9,
          HeureDebutEvenement: '730',
          HeureFinEvenement: '1800',
          LibEvenement: '<strong>Présence</strong>',
          LibCorpsEvenement: 'Confirmée&nbsp;!',
          ListeActions: [{ UrlAction: '/dangerous/mutation', LibAction: 'Cancel' }],
        },
      ],
    });
    expect(result).toEqual([
      {
        date: '2026-10-05',
        start: '07:30',
        end: '18:00',
        title: 'Présence',
        activity: 'Accueil & loisirs',
        location: 'École',
        detail: 'Confirmée !',
      },
    ]);
    expect(JSON.stringify(result)).not.toContain('dangerous');
  });
});
