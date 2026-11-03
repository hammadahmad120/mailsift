import type { Variables } from '@modelcontextprotocol/sdk/shared/uriTemplate.js';
import { MailError } from '../errors.js';

/**
 * One variable out of a matched resource template URI, as a non-empty string.
 * The SDK types every variable as `string | string[]`; our templates have one
 * simple `{name}` each, so a list or a blank value means the URI is not one of
 * ours and reads as NOT_FOUND, the same answer the provider gives for an id
 * it does not know.
 */
export function templateVariable(variables: Variables, name: string): string {
  const value = variables[name];
  const text = typeof value === 'string' ? decodeURIComponent(value).trim() : '';
  if (!text) {
    throw new MailError(
      'NOT_FOUND',
      `The URI has no ${name}.`,
      `Use mail://.../{${name}} with an id from a search_mail result.`,
    );
  }
  return text;
}
