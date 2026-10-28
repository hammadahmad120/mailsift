import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { htmlToText } from '../src/parse/html-to-text.js';

function fixture(name: string): string {
  return readFileSync(new URL(`./fixtures/bodies/${name}.html`, import.meta.url), 'utf8');
}

describe('htmlToText', () => {
  it('converts a simple message: headings as written, links as text (url), no style or script', () => {
    const text = htmlToText(fixture('simple'));

    expect(text).toBe(
      [
        'Project update',
        '',
        'Hi team,',
        '',
        'The build is green again. Details are on the CI page (https://example.com/ci/42) and the raw log is at https://example.com/log.',
        '',
        'Next steps:',
        '1. Tag the release',
        '2. Notify support',
        '',
        ' * Owner: Alice',
        ' * Due: Friday',
        '',
        'Thanks,',
        'Alice',
      ].join('\n'),
    );
    expect(text).not.toContain('Ignored title');
    expect(text).not.toContain('color');
    expect(text).not.toContain('trackOpen');
  });

  it('drops the Gmail quoted block from a reply and keeps the new text', () => {
    const text = htmlToText(fixture('gmail-reply'));

    expect(text).toBe(
      ['Sounds good, I will send the signed copy tomorrow.', '', 'Best,', 'Jane'].join('\n'),
    );
    expect(text).not.toContain('wrote:');
    expect(text).not.toContain('contract attached');
  });

  it('flattens a newsletter: layout tables collapse, data tables keep columns, images vanish', () => {
    const text = htmlToText(fixture('newsletter'));

    expect(text).toContain('October product news');
    expect(text).toContain('Three things shipped this month.');
    expect(text).toContain('Read the post (https://example.com/blog/search)');
    expect(text).toContain('Upgrade now (https://example.com/upgrade)');
    expect(text).toContain('Unsubscribe (https://example.com/unsubscribe?u=123)');

    expect(text).toMatch(/Plan\s+Seats\s+Price/);
    expect(text).toMatch(/Starter\s+5\s+\$10/);
    expect(text).toMatch(/Team\s+25\s+\$40/);

    expect(text).not.toContain('logo.png');
    expect(text).not.toContain('open.gif');
    expect(text).not.toContain('Example Co logo');
    expect(text).not.toContain('background');
    expect(text).not.toMatch(/<[a-z]+/i);
    expect(text).not.toMatch(/\n{3,}/);
  });

  it('drops the Gmail signature block', () => {
    const html =
      '<div dir="ltr">See you Monday.</div><div><br></div>' +
      '<div class="gmail_signature" dir="ltr"><div>Alice Example</div><div>Head of Ops</div></div>';
    expect(htmlToText(html)).toBe('See you Monday.');
  });

  it('does not wrap long lines', () => {
    const long = 'word '.repeat(60).trim();
    expect(htmlToText(`<p>${long}</p>`)).toBe(long);
  });

  it('keeps a plain blockquote as > lines for quotes.ts to strip later', () => {
    const text = htmlToText('<p>Reply.</p><blockquote>Old text<br>more</blockquote>');
    expect(text).toBe('Reply.\n\n> Old text\n> more');
  });

  it('decodes entities and trims', () => {
    expect(htmlToText('  <p>Fish &amp; chips &lt;3 &#8212; caf&eacute;</p>  ')).toBe(
      'Fish & chips <3 — café',
    );
  });

  it('returns empty for empty or whitespace input', () => {
    expect(htmlToText('')).toBe('');
    expect(htmlToText('   \n ')).toBe('');
    expect(htmlToText('<div></div>')).toBe('');
  });
});
