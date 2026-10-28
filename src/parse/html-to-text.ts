import { convert } from 'html-to-text';
import type { HtmlToTextOptions } from 'html-to-text';

/**
 * HTML body -> plain text (brief section 11): no images, links kept as
 * `text (url)`, tables flattened, headings as written, no line wrapping. Pure.
 *
 * Gmail wraps the quoted previous message in `.gmail_quote` and the sender's
 * signature in `.gmail_signature`; both are dropped here because the HTML
 * element is the only reliable marker. Plain-text
 * quote markers (`>` lines, "On ... wrote:") are handled by `quotes.ts`.
 */

const headings = ['h1', 'h2', 'h3', 'h4', 'h5', 'h6'].map((selector) => ({
  selector,
  options: { uppercase: false },
}));

const OPTIONS: HtmlToTextOptions = {
  wordwrap: false,
  preserveNewlines: false,
  selectors: [
    ...headings,
    { selector: 'a', options: { linkBrackets: ['(', ')'], hideLinkHrefIfSameAsText: true } },
    { selector: 'img', format: 'skip' },
    { selector: 'style', format: 'skip' },
    { selector: 'script', format: 'skip' },
    { selector: 'title', format: 'skip' },
    {
      selector: 'table',
      format: 'dataTable',
      options: { colSpacing: 2, uppercaseHeaderCells: false, maxColumnWidth: 100_000 },
    },
    { selector: '.gmail_quote', format: 'skip' },
    { selector: '.gmail_signature', format: 'skip' },
  ],
};

export function htmlToText(html: string): string {
  if (html.trim() === '') return '';
  // Empty <div><br></div> runs (Gmail's blank lines) convert to 3+ newlines; keep at most one blank line.
  return convert(html, OPTIONS)
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
