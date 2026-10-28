/**
 * Body cleaning (brief section 11): quoted-reply stripping, signature
 * stripping, whitespace. Pure, plain text in and out. `cleanBody` composes them.
 *
 * --- Quotes ---
 *
 * Three markers are recognised; everything from the first one found to the
 * end of the text is removed, because mail clients always put the quoted
 * history below the new text:
 *   1. `On <date>, <name> wrote:` (Gmail, Apple Mail, webmail; wrapped onto
 *      two lines; a few common non-English variants)
 *   2. Outlook header blocks: `From: ... Sent|Date: ... To|Subject: ...`,
 *      optionally preceded by `-----Original Message-----`
 *   3. `>` quoted lines, removed wherever they appear
 *
 * Gmail's HTML `.gmail_quote` block is removed by `htmlToText` before this runs.
 * Forwarded-message markers are deliberately left alone: a forward's content
 * is usually the point of the message.
 *
 * Guard: if stripping would leave nothing, the original text is returned.
 *
 * --- Signatures ---
 *
 * Two markers: the exact `-- ` delimiter line (dash, dash, space) and a
 * sign-off phrase on its own line ("Regards", "Thanks", "Sent from my ...").
 * Both only count near the end: at most MAX_SIGNATURE_LINES may follow.
 * The signature is kept when the remaining text would be under
 * MIN_BODY_AFTER_SIGNATURE characters (brief: 200).
 * Gmail's HTML `.gmail_signature` block is removed by `htmlToText`.
 */

/** "On ..., X wrote:" and common localised forms, possibly with a trailing space. */
const WROTE_LINE = /^(On|Le|Am|El|Op)\b.*\b(wrote|a écrit|schrieb|escribió|schreef).*:\s*$/i;
/** First line of a wrapped "On ... wrote:" header. */
const WROTE_START = /^(On|Le|Am|El|Op)\s\S/;
/** Second line of a wrapped header. */
const WROTE_END = /\b(wrote|a écrit|schrieb|escribió|schreef)\s*:\s*$/i;

/** A forward's header block looks like Outlook's; this marker protects it. */
const FORWARDED_MESSAGE =
  /^\s*[-_]{2,}\s*(Forwarded message|Weitergeleitete Nachricht|Message transféré|Mensaje reenviado|Doorgestuurd bericht)[^-_]*[-_]{2,}\s*$/i;

const ORIGINAL_MESSAGE =
  /^\s*[-_]{2,}\s*(Original|Ursprüngliche|Message d'origine|Mensaje original|Oorspronkelijk)[^-_]*[-_]{2,}\s*$/i;

/** Outlook header lines, allowing the `*From:*` form left by bold-to-text conversion. */
const HDR_FROM = /^\W{0,2}(From|Von|De|Van)\s*:\W{0,2}\s/i;
const HDR_SENT = /^\W{0,2}(Sent|Date|Gesendet|Envoyé|Enviado|Verzonden|Datum)\s*:\W{0,2}\s/i;
const HDR_TO_OR_SUBJECT =
  /^\W{0,2}(To|Subject|An|Betreff|À|Objet|Para|Asunto|Aan|Onderwerp)\s*:\W{0,2}\s/i;

const QUOTED_LINE = /^\s*>/;

/** Index of the first line that starts the quoted history, or -1. */
export function findQuoteStart(lines: readonly string[]): number {
  let forwardedAt = -Infinity;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;
    const trimmed = line.trim();

    if (FORWARDED_MESSAGE.test(trimmed)) {
      forwardedAt = i;
      continue;
    }

    if (WROTE_LINE.test(trimmed)) return i;

    if (WROTE_START.test(trimmed)) {
      const next = (lines[i + 1] ?? '').trim();
      if (next !== '' && !trimmed.endsWith(':') && WROTE_END.test(next)) return i;
    }

    if (ORIGINAL_MESSAGE.test(trimmed)) return i;

    const afterForward = i - forwardedAt <= 3;
    if (!afterForward && HDR_FROM.test(trimmed) && isOutlookHeaderBlock(lines, i)) return i;
  }
  return -1;
}

/** A `From:` line counts only when a Sent/Date and a To/Subject line follow within four lines. */
function isOutlookHeaderBlock(lines: readonly string[], fromIndex: number): boolean {
  let sent = false;
  let toOrSubject = false;
  for (let j = fromIndex + 1; j <= fromIndex + 4 && j < lines.length; j++) {
    const t = (lines[j] as string).trim();
    if (HDR_SENT.test(t)) sent = true;
    else if (HDR_TO_OR_SUBJECT.test(t)) toOrSubject = true;
  }
  return sent && toOrSubject;
}

export function stripQuotes(text: string): string {
  const original = text.replace(/\r\n?/g, '\n');
  const lines = original.split('\n');

  const start = findQuoteStart(lines);
  const kept = (start === -1 ? lines : lines.slice(0, start)).filter((l) => !QUOTED_LINE.test(l));

  const result = kept.join('\n').trim();
  return result === '' ? original.trim() : result;
}

// ---------------------------------------------------------------------------
// Signatures
// ---------------------------------------------------------------------------

/** Below this many remaining characters the signature is kept (brief section 11). */
export const MIN_BODY_AFTER_SIGNATURE = 200;
/** A marker only counts if no more than this many lines follow it. */
export const MAX_SIGNATURE_LINES = 15;

/** The Usenet delimiter: exactly dash, dash, space. Never trimmed before matching. */
const SIG_DELIMITER = /^-- $/;

const SIGN_OFF =
  /^(thanks|thank you|many thanks|thanks again|thanks in advance|regards|best regards|kind regards|warm regards|warmest regards|best|all the best|best wishes|cheers|sincerely|yours sincerely|yours truly|yours faithfully|take care|talk soon|speak soon|sent from my .+|sent from outlook.*|get outlook for .+)[,.!]?\s*$/i;

/** Index of the line where the signature starts, or -1. */
export function findSignatureStart(lines: readonly string[]): number {
  const lastIndex = lines.length - 1;
  const earliest = Math.max(0, lines.length - MAX_SIGNATURE_LINES - 1);

  for (let i = earliest; i <= lastIndex; i++) {
    if (SIG_DELIMITER.test(lines[i] as string)) return i;
  }
  for (let i = earliest; i <= lastIndex; i++) {
    if (SIGN_OFF.test((lines[i] as string).trim())) return i;
  }
  return -1;
}

export function stripSignature(text: string): string {
  const original = text.replace(/\r\n?/g, '\n').replace(/\s+$/, '');
  const lines = original.split('\n');

  const start = findSignatureStart(lines);
  if (start === -1) return original.trim();

  const kept = lines.slice(0, start).join('\n').trim();
  return kept.length < MIN_BODY_AFTER_SIGNATURE ? original.trim() : kept;
}

// ---------------------------------------------------------------------------
// Whitespace and composition
// ---------------------------------------------------------------------------

/** CRLF to LF, no-break spaces to spaces, no trailing spaces, at most one blank line, trimmed. */
export function normalizeWhitespace(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** The whole plain-text pipeline: quotes, then signature, then whitespace. */
export function cleanBody(text: string): string {
  return normalizeWhitespace(stripSignature(stripQuotes(text)));
}
