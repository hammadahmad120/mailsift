import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { findQuoteStart, stripQuotes } from '../src/parse/quotes.js';

function fixture(name: string): string {
  return readFileSync(new URL(`./fixtures/bodies/${name}.txt`, import.meta.url), 'utf8');
}

/** Each pattern has an input and an expected file; the pair is the spec. */
const PAIRS = [
  ['quote-gt', '> quoted lines, including nested'],
  ['quote-on-wrote', '"On <date>, <name> wrote:" header'],
  ['quote-on-wrote-wrapped', '"On ... wrote:" header wrapped onto two lines'],
  ['quote-outlook', 'Outlook From/Sent/To/Subject block'],
  ['quote-outlook-dashes', '-----Original Message----- line'],
] as const;

describe('stripQuotes fixtures', () => {
  it.each(PAIRS)('%s: strips %s', (name) => {
    expect(stripQuotes(fixture(name))).toBe(fixture(`${name}.expected`).trim());
  });
});

describe('stripQuotes rules', () => {
  it('leaves text with no quote markers untouched apart from trimming', () => {
    const text = 'Hello,\n\nJust checking in.\n\nFrom my side all good.\n';
    expect(stripQuotes(text)).toBe(text.trim());
  });

  it('keeps the original when stripping would remove everything', () => {
    const allQuoted = '> only quoted\n> lines here';
    expect(stripQuotes(allQuoted)).toBe(allQuoted);
    const onlyHeader = 'On Mon, 1 Jan 2026, Bob wrote:\n> hi';
    expect(stripQuotes(onlyHeader)).toBe(onlyHeader);
  });

  it('keeps inline replies between quoted lines', () => {
    const text = '> Can you do Monday?\nYes.\n> And Tuesday?\nNo, Tuesday is out.';
    expect(stripQuotes(text)).toBe('Yes.\nNo, Tuesday is out.');
  });

  it('recognises common non-English headers', () => {
    expect(stripQuotes('Oui.\n\nLe 14 oct. 2026 à 09:30, Alice a écrit :\n> Bonjour')).toBe('Oui.');
    expect(stripQuotes('Ja.\n\nAm 14.10.2026 um 09:30 schrieb Alice:\n> Hallo')).toBe('Ja.');
    expect(stripQuotes('Sí.\n\nEl 14 oct 2026, Alice escribió:\n> Hola')).toBe('Sí.');
    expect(stripQuotes('Ja.\n\nOp 14 okt. 2026 schreef Alice:\n> Hoi')).toBe('Ja.');
  });

  it('does not treat a sentence starting with On as a header', () => {
    const text = 'On Monday we ship.\nOn balance I agree with the plan.';
    expect(stripQuotes(text)).toBe(text);
  });

  it('does not treat a lone From: line as an Outlook block', () => {
    const text = 'From: the top, the view is great.\n\nSee you there.';
    expect(stripQuotes(text)).toBe(text);
    expect(findQuoteStart(text.split('\n'))).toBe(-1);
  });

  it('accepts the *From:* form that bold-to-text conversion leaves behind', () => {
    const text = 'Done.\n\n*From:* Dave\n*Sent:* Monday\n*To:* Carol\n*Subject:* PO\n\nold text';
    expect(stripQuotes(text)).toBe('Done.');
  });

  it('leaves a forwarded message and its header block alone', () => {
    const text =
      'FYI, see below.\n\n---------- Forwarded message ---------\nFrom: Eve\nDate: Mon\nSubject: Offer\nTo: me\n\nThe offer details.';
    expect(stripQuotes(text)).toBe(text);
  });

  it('normalises CRLF line endings', () => {
    expect(stripQuotes('New text.\r\n\r\nOn Mon, Bob wrote:\r\n> old')).toBe('New text.');
  });
});
