import mammoth from 'mammoth';

/** Word document paragraphs as raw text via mammoth. Styling, images and headers are dropped. */
export async function parseDocx(bytes: Uint8Array): Promise<string> {
  const result = await mammoth.extractRawText({ buffer: Buffer.from(bytes) });
  return result.value.replace(/\n{3,}/g, '\n\n').trim();
}
