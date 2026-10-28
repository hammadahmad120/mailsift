import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { detectKind, parseAttachment } from '../src/parse/attachments/index.js';

function fixture(name: string): Uint8Array {
  return new Uint8Array(readFileSync(new URL(`./fixtures/attachments/${name}`, import.meta.url)));
}

const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const opts = { maxBytes: 10_485_760 };

afterEach(() => {
  vi.restoreAllMocks();
});

describe('parseAttachment: supported types', () => {
  it('extracts known sentences and the page count from a PDF', async () => {
    const result = await parseAttachment(
      { mime: 'application/pdf', filename: 'report.pdf', bytes: fixture('sample.pdf') },
      opts,
    );
    expect(result.skipped_reason).toBeNull();
    expect(result.pages).toBe(2);
    expect(result.text).toContain('Quarterly report for Example Co.');
    expect(result.text).toContain('Revenue grew by twelve percent.');
    expect(result.text).toContain('Page two: headcount is now forty.');
    expect(result.text.indexOf('Quarterly')).toBeLessThan(result.text.indexOf('Page two'));
  });

  it('leaves the input bytes intact so they can be parsed again', async () => {
    const bytes = fixture('sample.pdf');
    const before = bytes.byteLength;
    await parseAttachment({ mime: 'application/pdf', filename: 'a.pdf', bytes }, opts);
    expect(bytes.byteLength).toBe(before);
    const again = await parseAttachment(
      { mime: 'application/pdf', filename: 'a.pdf', bytes },
      opts,
    );
    expect(again.pages).toBe(2);
  });

  it('extracts known sentences from a DOCX', async () => {
    const result = await parseAttachment(
      { mime: DOCX, filename: 'offer.docx', bytes: fixture('sample.docx') },
      opts,
    );
    expect(result).toEqual({
      text: 'Employment offer for Jane Doe.\n\nStart date is the first of November.',
      pages: null,
      skipped_reason: null,
    });
  });

  it('returns csv and markdown as text, whitespace-normalised', async () => {
    const csv = await parseAttachment(
      { mime: 'text/csv', filename: 'data.csv', bytes: fixture('sample.csv') },
      opts,
    );
    expect(csv).toEqual({
      text: 'name,qty,price\nApples,3,10\n"Pears, ripe",12,40',
      pages: null,
      skipped_reason: null,
    });

    const md = await parseAttachment(
      { mime: 'text/markdown', filename: 'notes.md', bytes: fixture('sample.md') },
      opts,
    );
    expect(md.text).toBe('# Notes\n\nThe meeting moved to **Thursday**.');
  });

  it('converts html attachments and drops a UTF-8 BOM from text', async () => {
    const html = await parseAttachment(
      {
        mime: 'text/html',
        filename: 'page.html',
        bytes: new TextEncoder().encode('<h1>Title</h1><p>Hello <a href="https://x.y">x</a></p>'),
      },
      opts,
    );
    expect(html.text).toBe('Title\n\nHello x (https://x.y)');

    const bom = new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode('plain')]);
    const txt = await parseAttachment({ mime: 'text/plain', filename: 'a.txt', bytes: bom }, opts);
    expect(txt.text).toBe('plain');
  });
});

describe('parseAttachment: skips, never throws', () => {
  it('reports NO_TEXT_LAYER for a PDF with no extractable text', async () => {
    const result = await parseAttachment(
      { mime: 'application/pdf', filename: 'scan.pdf', bytes: fixture('scanned.pdf') },
      opts,
    );
    expect(result).toEqual({ text: '', pages: 1, skipped_reason: 'NO_TEXT_LAYER' });
  });

  it('reports ATTACHMENT_UNSUPPORTED for a zip and for an image', async () => {
    const zip = await parseAttachment(
      { mime: 'application/zip', filename: 'all.zip', bytes: new Uint8Array(10) },
      opts,
    );
    expect(zip).toEqual({ text: '', pages: null, skipped_reason: 'ATTACHMENT_UNSUPPORTED' });
    const png = await parseAttachment(
      { mime: 'image/png', filename: 'logo.png', bytes: new Uint8Array(10) },
      opts,
    );
    expect(png.skipped_reason).toBe('ATTACHMENT_UNSUPPORTED');
  });

  it('reports ATTACHMENT_UNSUPPORTED for an 11 MB file without parsing it', async () => {
    const big = new Uint8Array(11 * 1024 * 1024);
    const result = await parseAttachment(
      { mime: 'application/pdf', filename: 'big.pdf', bytes: big },
      opts,
    );
    expect(result.skipped_reason).toBe('ATTACHMENT_UNSUPPORTED');
  });

  it('reports PARSE_FAILED for a corrupt PDF and a non-zip DOCX', async () => {
    const pdf = await parseAttachment(
      { mime: 'application/pdf', filename: 'bad.pdf', bytes: fixture('corrupt.pdf') },
      opts,
    );
    expect(pdf).toEqual({ text: '', pages: null, skipped_reason: 'PARSE_FAILED' });

    const docx = await parseAttachment(
      { mime: DOCX, filename: 'bad.docx', bytes: new TextEncoder().encode('not a zip') },
      opts,
    );
    expect(docx.skipped_reason).toBe('PARSE_FAILED');
  });

  it('never writes to stdout while parsing, even a corrupt PDF (stdio safety)', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    await parseAttachment(
      { mime: 'application/pdf', filename: 'bad.pdf', bytes: fixture('corrupt.pdf') },
      opts,
    );
    await parseAttachment(
      { mime: 'application/pdf', filename: 'ok.pdf', bytes: fixture('sample.pdf') },
      opts,
    );
    expect(log).not.toHaveBeenCalled();
    expect(out).not.toHaveBeenCalled();
  });
});

describe('detectKind', () => {
  it('uses the mime type first and the extension as fallback', () => {
    expect(detectKind('application/pdf', 'x.bin')).toBe('pdf');
    expect(detectKind('application/octet-stream', 'offer.DOCX')).toBe('docx');
    expect(detectKind('text/plain; charset=utf-8', 'a')).toBe('txt');
    expect(detectKind('', 'README.md')).toBe('md');
    expect(detectKind('', 'index.htm')).toBe('html');
    expect(detectKind('application/octet-stream', 'archive.zip')).toBeNull();
    expect(detectKind('image/png', 'photo.pdf')).toBeNull();
  });
});
