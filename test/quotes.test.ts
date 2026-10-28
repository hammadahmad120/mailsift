import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  MAX_SIGNATURE_LINES,
  MIN_BODY_AFTER_SIGNATURE,
  cleanBody,
  findQuoteStart,
  findSignatureStart,
  normalizeWhitespace,
  stripQuotes,
  stripSignature,
} from '../src/parse/quotes.js';

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

/** A body comfortably over the 200-char guard. */
const LONG_BODY =
  'Hi team,\n\n' +
  'Following up on the review: the migration finished overnight without errors, ' +
  'the dashboards are back, and the on-call rota is unchanged for this week. ' +
  'Please check your own services once more before the Thursday freeze.\n\n' +
  'One open item is the backup verification, which I will run on Wednesday.';

describe('stripSignature', () => {
  it('removes everything below the exact "-- " delimiter', () => {
    const text = `${LONG_BODY}\n\n-- \nAlice Example\nHead of Ops\n+971 50 000 0000`;
    expect(stripSignature(text)).toBe(LONG_BODY);
  });

  it('ignores "--" without the trailing space, "---" dividers, and dashes mid-sentence', () => {
    const text = `${LONG_BODY}\n\n--\nnot a delimiter\n---\nalso not -- fine`;
    expect(stripSignature(text)).toBe(text);
  });

  it('removes a sign-off line and what follows', () => {
    for (const signOff of ['Thanks,', 'Kind regards', 'Best', 'Cheers!', 'Sent from my iPhone']) {
      const text = `${LONG_BODY}\n\n${signOff}\nAlice\nExample Co`;
      expect(stripSignature(text), signOff).toBe(LONG_BODY);
    }
  });

  it('keeps the signature when the remainder would be under 200 chars', () => {
    const short = 'Thanks for the update, see you Monday.\n\nRegards,\nAlice';
    expect(stripSignature(short)).toBe(short);
    expect(short.indexOf('Regards')).toBeLessThan(MIN_BODY_AFTER_SIGNATURE);
  });

  it('strips once the remainder reaches 200 chars', () => {
    const body = 'x'.repeat(MIN_BODY_AFTER_SIGNATURE);
    expect(stripSignature(`${body}\n\nRegards,\nAlice`)).toBe(body);
    const justUnder = 'x'.repeat(MIN_BODY_AFTER_SIGNATURE - 1);
    expect(stripSignature(`${justUnder}\n\nRegards,\nAlice`)).toBe(
      `${justUnder}\n\nRegards,\nAlice`,
    );
  });

  it('does not treat a sign-off word inside a sentence as a marker', () => {
    const text = `${LONG_BODY}\n\nThanks for checking the rota, and best of luck with the freeze.\n\nOne more paragraph of real content follows here.`;
    expect(stripSignature(text)).toBe(text);
  });

  it('ignores a "-- " line followed by more than the signature limit of lines', () => {
    const tail = Array.from({ length: MAX_SIGNATURE_LINES + 1 }, (_, i) => `line ${i}`).join('\n');
    const text = `${LONG_BODY}\n\n-- \n${tail}`;
    expect(stripSignature(text)).toBe(text);
    expect(findSignatureStart(text.split('\n'))).toBe(-1);
  });

  it('cuts at the earliest marker in the tail so "Thanks" plus "Sent from my iPhone" both go', () => {
    const text = `${LONG_BODY}\n\nThanks,\nAlice\n\nSent from my iPhone`;
    expect(stripSignature(text)).toBe(LONG_BODY);
  });

  it('leaves text with no signature untouched apart from trimming', () => {
    expect(stripSignature(`${LONG_BODY}\n\n`)).toBe(LONG_BODY);
  });
});

describe('normalizeWhitespace', () => {
  it('collapses blank-line runs, strips trailing spaces, converts CRLF and nbsp, trims', () => {
    const text = '  a  \r\n\r\n\r\n\r\nb\u00a0c\t\n\n\n';
    expect(normalizeWhitespace(text)).toBe('a\n\nb c');
  });
});

describe('cleanBody', () => {
  it('runs quotes, then signature, then whitespace', () => {
    const text = `${LONG_BODY}\n\n\n\nRegards,\nAlice\n\nOn Mon, 13 Oct 2026, Bob wrote:\n> old\n> text`;
    expect(cleanBody(text)).toBe(LONG_BODY);
  });

  it('keeps a short message whole even with a sign-off and a quote', () => {
    const text = 'Yes, Monday works.\n\nThanks,\nAlice\n\nOn Mon, Bob wrote:\n> Monday?';
    expect(cleanBody(text)).toBe('Yes, Monday works.\n\nThanks,\nAlice');
  });
});
