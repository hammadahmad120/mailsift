import type { Document, DocumentAttachment } from '../providers/types.js';

/**
 * Document -> markdown (brief section 12, resource templates). Pure.
 *
 * This is the reading form of a Document: the subject as the title, a short
 * header list, the clean body, the attachments. It is what a client gets when
 * it opens `mail://message/{id}` or `mail://thread/{id}`. The JSON form that
 * the tools return is unchanged; this is a view over it, never a new shape.
 */

/** Human size: 183221 -> "179 kB". */
export function formatBytes(size: number): string {
  if (!Number.isFinite(size) || size < 0) return 'unknown size';
  if (size < 1024) return `${size} B`;
  const kb = size / 1024;
  if (kb < 1024) return `${Math.round(kb)} kB`;
  return `${(kb / 1024).toFixed(1)} MB`;
}

function headerLine(label: string, value: string | readonly string[]): string | null {
  const text = Array.isArray(value) ? value.join(', ') : (value as string);
  return text ? `- ${label}: ${text}` : null;
}

/** Title line: the subject, or a placeholder; newlines removed so the heading stays one line. */
function title(subject: string): string {
  const oneLine = subject.replace(/\s+/g, ' ').trim();
  return `# ${oneLine || '(no subject)'}`;
}

function body(text: string, truncated: boolean): string[] {
  const lines = [text.trim() || '_(no body)_'];
  if (truncated) lines.push('', '_Body truncated at the configured limit._');
  return lines;
}

function attachmentLines(attachments: readonly DocumentAttachment[]): string[] {
  if (attachments.length === 0) return [];
  const lines = ['', '## Attachments', ''];
  for (const a of attachments) {
    let line = `- ${a.filename || '(unnamed)'} (${a.mime || 'unknown type'}, ${formatBytes(a.size)})`;
    if (a.skipped_reason) line += `, not extracted: ${a.skipped_reason}`;
    lines.push(line);
  }
  for (const a of attachments) {
    if (a.text === null) continue;
    lines.push('', `### ${a.filename || '(unnamed)'}`, '', ...body(a.text, a.truncated));
  }
  return lines;
}

/**
 * One message as markdown. `thread_text`, when present on the document, is
 * rendered after the body under its own heading so `get_email`'s
 * `include_thread` form reads the same way as the thread resource.
 */
export function documentToMarkdown(document: Document): string {
  const h = document.headers;
  const lines = [
    title(h.subject),
    '',
    ...[
      headerLine('From', h.from),
      headerLine('To', h.to),
      headerLine('Cc', h.cc),
      headerLine('Date', h.date),
      headerLine('Message id', `\`${document.reference.message_id}\``),
      headerLine('Thread id', `\`${document.reference.thread_id}\``),
      headerLine('Link', document.reference.link),
    ].filter((l): l is string => l !== null),
    '',
    '## Body',
    '',
    ...body(document.text, document.truncated),
  ];

  if (document.thread_text !== undefined) {
    lines.push('', '## Thread', '', document.thread_text.trim() || '_(empty thread)_');
  }

  lines.push(...attachmentLines(document.attachments));
  return lines.join('\n') + '\n';
}

/** Sort key: the ISO date header, or the start of time when missing or unparseable. */
function dateKey(document: Document): number {
  const ms = Date.parse(document.headers.date);
  return Number.isNaN(ms) ? Number.NEGATIVE_INFINITY : ms;
}

/**
 * A whole conversation as one markdown page: the oldest message's subject as
 * the title, then one numbered section per message, oldest first (stable, so
 * equal dates keep the given order). Each section has the sender and date in
 * its heading, the remaining headers as a list, then the clean body and the
 * attachment list. Documents are expected to share a `thread_id`.
 */
export function threadToMarkdown(threadId: string, documents: readonly Document[]): string {
  const ordered = [...documents].sort((a, b) => dateKey(a) - dateKey(b));
  const first = ordered[0];
  const lines = [
    title(first?.headers.subject ?? ''),
    '',
    `- Thread id: \`${threadId}\``,
    `- Messages: ${ordered.length}`,
  ];
  if (first) lines.push(`- Link: ${first.reference.link}`);

  if (ordered.length === 0) lines.push('', '_(no messages)_');

  ordered.forEach((document, index) => {
    const h = document.headers;
    lines.push(
      '',
      `## ${index + 1}. From ${h.from || 'unknown'} on ${h.date || 'unknown date'}`,
      '',
      ...[
        headerLine('To', h.to),
        headerLine('Cc', h.cc),
        headerLine('Message id', `\`${document.reference.message_id}\``),
      ].filter((l): l is string => l !== null),
      '',
      ...body(document.text, document.truncated),
      ...attachmentLines(document.attachments),
    );
  });

  return lines.join('\n') + '\n';
}
