import { z } from 'zod';

/**
 * Optional tool arguments. MCP Inspector and some clients send "" for a text
 * field the user left blank, so optional strings must accept it and treat it
 * as absent. `present()` is the normaliser every handler applies.
 */

export const optionalText = (description: string) => z.string().optional().describe(description);

/** A trimmed non-empty string, or undefined for missing, blank, or whitespace. */
export function present(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/** Trimmed non-empty entries only; undefined when nothing is left. */
export function presentList(values: readonly string[] | undefined): string[] | undefined {
  const kept = (values ?? []).map((v) => v.trim()).filter((v) => v !== '');
  return kept.length > 0 ? kept : undefined;
}
