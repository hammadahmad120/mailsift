import type { Readable, Writable } from 'node:stream';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

export interface StdioStreams {
  stdin?: Readable;
  stdout?: Writable;
}

/**
 * Serve MCP over stdio: the client launches us as a child process and speaks
 * newline-delimited JSON-RPC on stdin/stdout.
 *
 * stdout is the protocol channel. Nothing else may ever write to it, which is
 * why eslint forbids `console.log` project-wide and logs go to stderr.
 *
 * Streams are injectable so tests can drive the real transport in memory.
 * Resolves once the transport is listening; the process then stays alive
 * until stdin closes.
 */
export async function runStdio(server: McpServer, streams: StdioStreams = {}): Promise<void> {
  const transport = new StdioServerTransport(streams.stdin, streams.stdout);
  await server.connect(transport);
}
