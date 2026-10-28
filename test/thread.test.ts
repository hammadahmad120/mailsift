import { describe, expect, it } from 'vitest';
import { bodyToText, flattenThread, threadSeparator } from '../src/parse/thread.js';
import type { RawMessage } from '../src/providers/types.js';

type MessageOverrides = Omit<Partial<RawMessage>, 'headers'> & {
  headers?: Partial<RawMessage['headers']>;
};

function message(overrides: MessageOverrides): RawMessage {
  const { headers, ...rest } = overrides;
  return {
    message_id: 'm',
    thread_id: 't',
    headers: {
      date: '2026-10-13T09:00:00.000Z',
      from: 'Alice <alice@example.com>',
      to: ['bob@example.com'],
      cc: [],
      subject: 'Meeting',
      ...headers,
    },
    link: 'https://mail.google.com/mail/u/0/#all/m',
    body: { kind: 'text', content: 'Body.' },
    attachments: [],
    ...rest,
  };
}

const first = message({
  message_id: 'm1',
  body: { kind: 'text', content: 'Can we move the meeting to Thursday?\n\nThanks,\nAlice' },
});

const second = message({
  message_id: 'm2',
  headers: { date: '2026-10-13T10:15:00.000Z', from: 'Bob <bob@example.com>' },
  body: {
    kind: 'html',
    content:
      '<div dir="ltr">Thursday works. 3pm?</div><br>' +
      '<div class="gmail_quote">On Mon, 13 Oct 2026 at 09:00, Alice wrote:<br>' +
      '<blockquote class="gmail_quote">Can we move the meeting to Thursday?</blockquote></div>',
  },
});

const third = message({
  message_id: 'm3',
  headers: { date: '2026-10-13T10:20:00.000Z' },
  body: {
    kind: 'text',
    content:
      '3pm it is. I will book the room.\n\nOn Mon, 13 Oct 2026 at 10:15, Bob wrote:\n> Thursday works. 3pm?\n> > Can we move the meeting to Thursday?',
  },
});

describe('flattenThread', () => {
  it('orders three out-of-order messages by date, separates them, and strips every quote', () => {
    expect(flattenThread([third, first, second])).toBe(
      [
        '--- From Alice <alice@example.com> on 2026-10-13T09:00:00.000Z ---',
        'Can we move the meeting to Thursday?\n\nThanks,\nAlice',
        '',
        '--- From Bob <bob@example.com> on 2026-10-13T10:15:00.000Z ---',
        'Thursday works. 3pm?',
        '',
        '--- From Alice <alice@example.com> on 2026-10-13T10:20:00.000Z ---',
        '3pm it is. I will book the room.',
      ].join('\n'),
    );
  });

  it('never repeats the first message inside later ones', () => {
    const text = flattenThread([first, second, third]);
    expect(text.match(/Can we move the meeting to Thursday\?/g)).toHaveLength(1);
    expect(text).not.toContain('wrote:');
    expect(text).not.toMatch(/^\s*>/m);
  });

  it('keeps provider order for equal dates and puts undated messages first', () => {
    const a = message({
      message_id: 'a',
      headers: { date: '' },
      body: { kind: 'text', content: 'A' },
    });
    const b = message({ message_id: 'b', body: { kind: 'text', content: 'B' } });
    const c = message({ message_id: 'c', body: { kind: 'text', content: 'C' } });
    const text = flattenThread([b, c, a]);
    expect(text.indexOf('--- From Alice <alice@example.com> on unknown date ---\nA')).toBe(0);
    expect(text.indexOf('\nB')).toBeLessThan(text.indexOf('\nC'));
  });

  it('keeps the separator for a message with no body', () => {
    expect(flattenThread([message({ body: null })])).toBe(
      '--- From Alice <alice@example.com> on 2026-10-13T09:00:00.000Z ---\n',
    );
  });

  it('returns an empty string for an empty thread and does not mutate the input', () => {
    expect(flattenThread([])).toBe('');
    const input = [third, first];
    flattenThread(input);
    expect(input.map((m) => m.message_id)).toEqual(['m3', 'm1']);
  });
});

describe('bodyToText', () => {
  it('converts html then cleans, cleans plain text directly, and gives empty for no body', () => {
    expect(bodyToText(second)).toBe('Thursday works. 3pm?');
    expect(bodyToText(third)).toBe('3pm it is. I will book the room.');
    expect(bodyToText(message({ body: null }))).toBe('');
  });
});

describe('threadSeparator', () => {
  it('falls back to placeholders', () => {
    expect(threadSeparator(message({ headers: { from: '', date: '' } }))).toBe(
      '--- From unknown on unknown date ---',
    );
  });
});
