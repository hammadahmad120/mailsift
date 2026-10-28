import { extractText, getDocumentProxy } from 'unpdf';
import type { ParsedAttachment } from './index.js';

/**
 * PDF text layer via unpdf (pdf.js). A document whose pages yield no text is
 * a scan: empty text with NO_TEXT_LAYER. OCR is out of scope (brief section 11).
 *
 * `verbosity: 0` matters: pdf.js otherwise prints warnings with console.log,
 * which would corrupt the stdio transport where stdout is the protocol channel.
 * pdf.js transfers the buffer it is given to its worker, which detaches the
 * caller's array (byteLength becomes 0), so it gets a copy.
 */
export async function parsePdf(bytes: Uint8Array): Promise<ParsedAttachment> {
  const document = await getDocumentProxy(bytes.slice(), { verbosity: 0 });
  const { totalPages, text } = await extractText(document, { mergePages: false });
  const joined = text
    .map((page) => page.trim())
    .filter((page) => page !== '')
    .join('\n\n');

  if (joined === '') return { text: '', pages: totalPages, skipped_reason: 'NO_TEXT_LAYER' };
  return { text: joined, pages: totalPages, skipped_reason: null };
}
