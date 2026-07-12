import { describe, expect, it } from 'vitest';

import { parseTextStyles } from './text-styles.js';

describe('parseTextStyles — headings with inline emphasis (telegram)', () => {
  // Regression: `### 7. **Title**` used to become `*7. *Title**` — the bold
  // pair nested inside the heading's own `*...*` wrapper. The Telegram
  // adapter re-parses that as nested emphasis and renders MarkdownV2
  // `_7\. _Title__`, which Telegram rejects ("can't find end of Underline
  // entity") and the reply is dropped after retries.
  it('unwraps bold inside a heading instead of nesting delimiters', () => {
    expect(parseTextStyles('### 7. **Hypey token-saving claims**', 'telegram')).toBe(
      '*7. Hypey token-saving claims*',
    );
  });

  it('unwraps multiple bold spans inside one heading', () => {
    expect(parseTextStyles('## **RTK** vs **context offloading**', 'telegram')).toBe(
      '*RTK vs context offloading*',
    );
  });

  it('unwraps italic underscores inside a heading', () => {
    expect(parseTextStyles('## a _quiet_ note', 'telegram')).toBe('*a quiet note*');
  });

  it('keeps plain headings bold-wrapped', () => {
    expect(parseTextStyles('## Most relevant to NanoClaw', 'telegram')).toBe('*Most relevant to NanoClaw*');
  });

  it('preserves snake_case identifiers in headings', () => {
    expect(parseTextStyles('## config_file layout', 'telegram')).toBe('*config_file layout*');
  });

  it('leaves non-heading bold conversion unchanged', () => {
    expect(parseTextStyles('**bold** and *ital*', 'telegram')).toBe('*bold* and _ital_');
  });
});
