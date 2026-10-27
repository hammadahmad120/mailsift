import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

/**
 * Every successful tool reply has the same shape (brief section 8):
 * one JSON text block the app can parse, then one short human summary line.
 */
export function toolResult(data: unknown, summary: string): CallToolResult {
  return {
    content: [
      { type: 'text', text: JSON.stringify(data) },
      { type: 'text', text: summary },
    ],
  };
}
